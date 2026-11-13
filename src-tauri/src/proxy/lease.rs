//! 代理租约与恢复报告：`~/.veyl` 下的三个文件 + 一把存活锁。
//!
//! - `proxy-lease.json`：App 在 `enable()` 里、`apply()` 之前写的写穿副本；
//! - `proxy-lease.lock`：App 全程 `flock(LOCK_EX)` 独占；进程一死内核立刻释放，
//!   看门狗用「能不能拿到锁」判断 App 死没死（不看 pid，pid 复用不会误判）；
//! - `proxy-recovery-report.json`：看门狗 / 信号清理写的恢复结果，App 启动读一次后删除。
//!
//! 本文件同时被看门狗二进制用 `#[path]` 引入，必须自包含：只用 `std` / `serde` /
//! `libc`，不引用 crate 内其它模块。

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const LEASE_SCHEMA: u32 = 1;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_lease_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

/// 租约里的进程信息：**只用于日志和报告**，不参与「死没死」的判定。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaseOwner {
    pub pid: u32,
    pub started_at: i64,
    pub exe: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyLease {
    pub schema: u32,
    pub lease_id: String,
    pub platform: String,
    pub endpoint: String,
    pub payload: serde_json::Value,
    pub owner: LeaseOwner,
    pub created_at: i64,
}

impl ProxyLease {
    pub fn new(
        platform: impl Into<String>,
        endpoint: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        let created_at = now_ms();
        Self {
            schema: LEASE_SCHEMA,
            lease_id: new_lease_id(),
            platform: platform.into(),
            endpoint: endpoint.into(),
            payload,
            owner: LeaseOwner {
                pid: std::process::id(),
                // 只用于日志：这里取的是租约创建时刻，不是进程启动时刻。
                started_at: created_at,
                exe: std::env::current_exe()
                    .map(|path| path.display().to_string())
                    .unwrap_or_default(),
            },
            created_at,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStatus {
    Restored,
    AlreadyRestored,
    LeftAlone,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoverySource {
    Watchdog,
    Startup,
    Signal,
}

/// 一次自动还原的结果。字段与 `commands.md` §7.13 的 `ProxyRecoveryReportData` 一一对应。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryReport {
    pub status: RecoveryStatus,
    /// 我们写进去的端点，`server:port`。
    pub endpoint: String,
    /// 还原后（失败时为失败那刻）读到的系统代理。
    pub current: Option<String>,
    /// 仅 `failed` 非空。
    pub error: Option<String>,
    /// epoch ms。
    pub at: i64,
    pub source: RecoverySource,
}

impl RecoveryReport {
    pub fn new(
        status: RecoveryStatus,
        endpoint: impl Into<String>,
        current: Option<String>,
        error: Option<String>,
        source: RecoverySource,
    ) -> Self {
        Self {
            status,
            endpoint: endpoint.into(),
            current,
            error,
            at: now_ms(),
            source,
        }
    }
}

/// `~/.veyl` 下的文件布局。看门狗与 App 用同一份路径计算。
#[derive(Debug, Clone)]
pub struct LeasePaths {
    dir: PathBuf,
}

impl LeasePaths {
    pub fn in_dir(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn lease(&self) -> PathBuf {
        self.dir.join("proxy-lease.json")
    }

    pub fn lease_lock(&self) -> PathBuf {
        self.dir.join("proxy-lease.lock")
    }

    pub fn report(&self) -> PathBuf {
        self.dir.join("proxy-recovery-report.json")
    }

    pub fn guard_lock(&self) -> PathBuf {
        self.dir.join("proxy-guard.lock")
    }

    /// `LeftAlone` 时旧备份的去处：留证据，不再参与任何还原。
    pub fn left_alone(&self) -> PathBuf {
        self.dir.join("proxy-backup-left-alone.json")
    }
}

/// 独占 flock。持有者一死（含 `kill -9`）内核自动释放。
pub struct FileLock {
    _file: File,
}

impl FileLock {
    /// 非阻塞独占：拿到返回 `Some`，被占用返回 `None`。
    pub fn try_exclusive(path: &Path) -> io::Result<Option<Self>> {
        let file = open_lock_file(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if rc == 0 {
                return Ok(Some(Self { _file: file }));
            }
            let error = io::Error::last_os_error();
            if matches!(
                error.raw_os_error(),
                Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN
            ) {
                return Ok(None);
            }
            return Err(error);
        }
        #[cfg(not(unix))]
        {
            let _ = file;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "flock is not available on this platform",
            ))
        }
    }

    /// 在 `timeout` 内反复尝试；超时返回 `None`。
    pub fn exclusive_with_timeout(path: &Path, timeout: Duration) -> io::Result<Option<Self>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(lock) = Self::try_exclusive(path)? {
                return Ok(Some(lock));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn open_lock_file(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .mode(0o600)
                .open(path)?
        }
        #[cfg(not(unix))]
        {
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .open(path)?
        }
    };
    // 已存在的旧文件可能权限更宽（早期版本），统一收紧。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(file)
}

/// 临时文件创建时就是 0600，避免「先写后 chmod」的读取窗口。
pub fn write_atomic_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(parent)?;

    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "state".to_string());
    let tmp = parent.join(format!(".{file_name}.tmp-{:016x}", rand::random::<u64>()));

    let result = (|| -> io::Result<()> {
        #[cfg(unix)]
        let mut file = {
            use std::os::unix::fs::OpenOptionsExt;
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?
        };
        #[cfg(not(unix))]
        let mut file = File::create(&tmp)?;

        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn write_lease(path: &Path, lease: &ProxyLease) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(lease)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_atomic_private(path, &bytes)
}

pub fn read_lease(path: &Path) -> io::Result<Option<ProxyLease>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn write_report(path: &Path, report: &RecoveryReport) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(report)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_atomic_private(path, &bytes)
}

/// 读一次报告并删除：同一份结果只消费一次。
pub fn take_report(path: &Path) -> io::Result<Option<RecoveryReport>> {
    let report = match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(report) => Some(report),
            Err(error) => {
                // 原子写不会产生半截文件；解析失败说明文件被改坏或磁盘出问题。
                // 删掉它，避免每次启动都重复同一条错误。
                let _ = remove_if_exists(path);
                return Err(io::Error::new(io::ErrorKind::InvalidData, error));
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    if report.is_some() {
        remove_if_exists(path)?;
    }
    Ok(report)
}

pub fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("veyl-{tag}-{:016x}", rand::random::<u64>()))
    }

    #[test]
    fn a_lease_round_trips_with_0600() {
        let dir = temp_dir("lease-roundtrip");
        let paths = LeasePaths::in_dir(&dir);
        let lease = ProxyLease::new("macos", "127.0.0.1:2080", serde_json::json!({ "services": [] }));
        write_lease(&paths.lease(), &lease).unwrap();

        let read = read_lease(&paths.lease()).unwrap().unwrap();
        assert_eq!(read.lease_id, lease.lease_id);
        assert_eq!(read.endpoint, "127.0.0.1:2080");
        assert_eq!(read.schema, LEASE_SCHEMA);
        assert_eq!(read.owner.pid, std::process::id());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(paths.lease()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        remove_if_exists(&paths.lease()).unwrap();
        assert!(read_lease(&paths.lease()).unwrap().is_none());
        remove_if_exists(&paths.lease()).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_report_is_consumed_once() {
        let dir = temp_dir("report-once");
        let paths = LeasePaths::in_dir(&dir);
        let report = RecoveryReport::new(
            RecoveryStatus::Restored,
            "127.0.0.1:2080",
            None,
            None,
            RecoverySource::Watchdog,
        );
        write_report(&paths.report(), &report).unwrap();

        let taken = take_report(&paths.report()).unwrap().unwrap();
        assert_eq!(taken.status, RecoveryStatus::Restored);
        assert!(take_report(&paths.report()).unwrap().is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_report_is_removed_so_it_does_not_repeat_every_startup() {
        let dir = temp_dir("report-corrupt");
        fs::create_dir_all(&dir).unwrap();
        let paths = LeasePaths::in_dir(&dir);
        fs::write(paths.report(), b"not json").unwrap();
        assert!(take_report(&paths.report()).is_err());
        assert!(!paths.report().exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn report_status_and_source_use_contract_names() {
        let report = RecoveryReport::new(
            RecoveryStatus::AlreadyRestored,
            "127.0.0.1:2080",
            Some("corp-proxy:8080".into()),
            None,
            RecoverySource::Signal,
        );
        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["status"], "already_restored");
        assert_eq!(value["source"], "signal");
        assert!(value["error"].is_null());
    }

    #[test]
    fn the_lock_is_released_when_its_holder_dies() {
        // 同一进程内 macOS 的 flock 会“转换/复用”已有锁，测不出争用；
        // 用一个子进程持有锁，验证「持有者一死内核立刻释放」这条判据。
        let dir = temp_dir("flock");
        fs::create_dir_all(&dir).unwrap();
        let lock_path = dir.join("proxy-lease.lock");

        let mut child = match std::process::Command::new("python3")
            .arg("-c")
            .arg(
                "import fcntl,sys,time\n\
                 f=open(sys.argv[1],'w')\n\
                 fcntl.flock(f, fcntl.LOCK_EX)\n\
                 print('locked', flush=True)\n\
                 time.sleep(1.2)",
            )
            .arg(&lock_path)
            .stdout(std::process::Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                eprintln!("跳过：没有 python3，无法验证跨进程 flock（{error}）");
                return;
            }
        };

        // 等子进程打印 locked，确保锁已经拿到。
        {
            use std::io::{BufRead, BufReader};
            let stdout = child.stdout.take().unwrap();
            let mut line = String::new();
            BufReader::new(stdout).read_line(&mut line).unwrap();
            assert_eq!(line.trim(), "locked");
        }

        assert!(
            FileLock::try_exclusive(&lock_path).unwrap().is_none(),
            "持有者活着时必须拿不到锁"
        );
        child.wait().unwrap();
        assert!(
            FileLock::try_exclusive(&lock_path).unwrap().is_some(),
            "持有者退出后锁必须立刻可拿"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
