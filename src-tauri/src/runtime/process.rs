use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::{Child, Command};

use super::error::{IoContext, RuntimeError, RuntimeResult};
use super::fsutil;

#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub binary: PathBuf,
    pub config: PathBuf,
    pub work_dir: PathBuf,
    pub log_path: PathBuf,
}

/// 运行时日志超过这个大小就轮转。
pub(crate) const RUNTIME_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// 轮转时保留的末尾字节数。
pub(crate) const RUNTIME_LOG_KEEP_BYTES: u64 = 512 * 1024;

/// 日志太大就只留末尾。
///
/// **必须在 spawn 之前调用**：sing-box 运行中截断它正在写的文件会写坏内容。
/// 保留尾部而不是整体改名成 `.1`：连接失败时 `read_log_tail` 要读这个文件，
/// 轮转成空文件等于把失败原因丢了。
pub(crate) fn rotate_if_oversized(path: &Path) -> RuntimeResult<bool> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Ok(false);
    };
    if meta.len() <= RUNTIME_LOG_MAX_BYTES {
        return Ok(false);
    }

    let mut file = std::fs::File::open(path).io_ctx(path)?;
    let start = meta.len().saturating_sub(RUNTIME_LOG_KEEP_BYTES);
    file.seek(SeekFrom::Start(start)).io_ctx(path)?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).io_ctx(path)?;
    // 从中间切进来的第一行可能是半截，丢掉。
    if start > 0 {
        if let Some(newline) = tail.iter().position(|byte| *byte == b'\n') {
            tail.drain(..=newline);
        }
    }

    std::fs::write(path, &tail).io_ctx(path)?;
    Ok(true)
}

pub async fn spawn(options: &SpawnOptions) -> RuntimeResult<Child> {
    if let Some(parent) = options.log_path.parent() {
        fsutil::ensure_dir(parent)?;
    }

    // 每次拉起新进程之前看一眼：sing-box 自己不会轮转，INFO 级别下
    // 正常浏览一天就是几十 MB。失败不阻塞连接——日志大一点总比连不上强。
    match rotate_if_oversized(&options.log_path) {
        Ok(true) => log::info!("运行时日志超过上限，已只保留末尾"),
        Ok(false) => {}
        Err(error) => log::warn!("运行时日志轮转失败，继续启动：{error}"),
    }

    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&options.log_path)
        .io_ctx(&options.log_path)?;
    let stderr = log.try_clone().io_ctx(&options.log_path)?;

    let mut command = Command::new(&options.binary);
    command
        .arg("run")
        .arg("-c")
        .arg(&options.config)
        .current_dir(&options.work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .kill_on_drop(true);

    command.spawn().map_err(|e| {
        RuntimeError::Process(format!(
            "failed to spawn {}: {e}",
            options.binary.display()
        ))
    })
}

/// 先发 SIGTERM 等 `grace`，超时再强杀。
///
/// 2026-11-02 实测 sing-box 1.14.4：Clash API 没有 `POST /close`（返回 404），
/// 优雅停止只能靠信号；SIGTERM 实测 0.02s 内退出，退出码 0。
///
/// Windows 没有可靠的控制台信号通道，直接 TerminateProcess；优雅停止留到 TUN 阶段处理。
pub async fn terminate(child: &mut Child, grace: Duration) -> RuntimeResult<()> {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            // 进程可能已经退出，ESRCH 无需处理。
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        if tokio::time::timeout(grace, child.wait()).await.is_ok() {
            return Ok(());
        }
    }

    #[cfg(not(unix))]
    {
        let _ = grace;
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
    Ok(())
}

/// `None` 表示仍在运行。
pub fn try_exit(child: &mut Child) -> Option<String> {
    match child.try_wait() {
        Ok(Some(status)) => Some(format!("process exited with {status}")),
        Ok(None) => None,
        Err(e) => Some(format!("failed to query process state: {e}")),
    }
}


/// 进程是否还活着。`kill(pid, 0)` 不发送信号，只做存在性检查。
pub fn is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output();
        match output {
            Ok(output) => String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()),
            Err(_) => false,
        }
    }
}

/// 取进程命令行，用于确认「这个 pid 还是我们的 sing-box」。
pub fn command_line(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("ps")
            .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!text.is_empty()).then_some(text)
    }
    #[cfg(windows)]
    {
        // Windows 没有 ps：tasklist 只能给镜像名，拿不到配置路径，
        // 因此永远无法满足 `matches_launch` 的回收校验，`reclaim_stale` 会一律跳过。
        // 已知限制：不按镜像名放宽——用户机器上可能装着别的 sing-box 客户端，
        // 只匹配镜像名会误杀别人的进程，比留一个孤儿严重得多。
        // 完整实现需要用 PowerShell/CIM（Win32_Process.CommandLine）取完整命令行。
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            return None;
        }
        // 明确告知：这次启动不会回收遗留进程，原因是 Windows 上无法确认身份。
        log::warn!(
            "Windows 只能取得进程镜像名、无法确认完整命令行，本次启动跳过遗留进程回收（pid={pid}）"
        );
        Some(text)
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let _ = pid;
        None
    }
}

/// 命令行是否就是我们 spawn 的那个进程。
///
/// 必须同时成立：argv[0] 与 spawn 时用的绝对路径完全一致，且命令行里带着配置路径。
/// 不做子串匹配——`tail -f sing-box.log`、`vim sing-box.conf` 这类用户进程必须跳过，
/// 认错就会误杀别人的工作。
pub fn matches_launch(command_line: &str, binary: &str, config: &str) -> bool {
    let binary = binary.trim();
    let config = config.trim();
    if binary.is_empty() || config.is_empty() {
        return false;
    }

    // argv[0] 本身可能含空格（macOS 的 Application Support），不能按空白切第一个 token。
    let Some(rest) = command_line.trim_start().strip_prefix(binary) else {
        return false;
    };
    let argv0_ends = rest.chars().next().map_or(true, char::is_whitespace);
    if !argv0_ends {
        return false;
    }

    command_line.contains(config)
}

/// 按 pid 优雅终止：SIGTERM → 等 `grace` → SIGKILL。返回是否确实已经退出。
pub async fn terminate_pid(pid: u32, grace: Duration) -> bool {    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + grace;
        while std::time::Instant::now() < deadline {
            if !is_alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        !is_alive(pid)
    }
    #[cfg(not(unix))]
    {
        let _ = grace;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output();
        !is_alive(pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_log(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "veyl-runtime-log-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        dir.join("runtime-1.14.4.log")
    }

    #[test]
    fn a_small_runtime_log_is_left_alone() {
        let path = temp_log("small");
        std::fs::write(&path, "FATAL something\n").unwrap();
        assert!(!rotate_if_oversized(&path).unwrap());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "FATAL something\n"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_missing_runtime_log_is_not_an_error() {
        let path = temp_log("missing");
        assert!(!rotate_if_oversized(&path).unwrap());
    }

    /// 超过上限只保留末尾：连接失败时 `read_log_tail` 还要靠它读原因，
    /// 轮转成空文件等于把失败原因丢了。
    #[test]
    fn an_oversized_runtime_log_keeps_only_its_tail() {
        let path = temp_log("oversized");
        let mut text = String::new();
        for index in 0..400_000 {
            text.push_str(&format!("line {index} padding\n"));
        }
        std::fs::write(&path, &text).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > RUNTIME_LOG_MAX_BYTES);

        assert!(rotate_if_oversized(&path).unwrap());

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(
            (after.len() as u64) <= RUNTIME_LOG_KEEP_BYTES,
            "轮转后还有 {} 字节",
            after.len()
        );
        assert!(after.contains("line 399999"), "必须保留最后一行：{}", &after[..160.min(after.len())]);
        assert!(!after.contains("line 0 padding"), "开头应该被丢掉");
        assert!(
            after.starts_with("line "),
            "从中间切进来的半截行要丢掉：{}",
            &after[..40.min(after.len())]
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn launch_match_requires_the_same_argv0_and_config() {
        let binary = "/Applications/Veyl App/sing-box";
        let config = "/Users/x/Library/Application Support/veyl/config.json";

        assert!(matches_launch(
            &format!("{binary} run -c {config}"),
            binary,
            config
        ));

        // 命令行里含 sing-box，但不是我们启动的那个进程。
        assert!(!matches_launch("tail -f sing-box.log", binary, config));
        assert!(!matches_launch("vim /tmp/sing-box.conf", binary, config));

        // 同一个二进制，但配置不是我们那份。
        assert!(!matches_launch(
            &format!("{binary} run -c /tmp/other.json"),
            binary,
            config
        ));

        // 路径前缀相同但 argv[0] 不是同一个文件。
        assert!(!matches_launch(
            &format!("{binary}-other run -c {config}"),
            binary,
            config
        ));

        assert!(!matches_launch("", binary, config));
    }

    #[tokio::test]
    async fn terminates_a_long_running_child() {
        #[cfg(unix)]
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        #[cfg(windows)]
        let mut child = Command::new("cmd").args(["/C", "ping -n 30 127.0.0.1"]).spawn().unwrap();

        assert!(try_exit(&mut child).is_none());
        terminate(&mut child, Duration::from_secs(2)).await.unwrap();
        assert!(try_exit(&mut child).is_some());
    }
}
