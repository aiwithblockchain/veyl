//! 最小文件日志。
//!
//! 只做三件事：把 `log` 宏写进应用数据目录、遵守 `RUST_LOG`、**任何情况下都不 panic**。
//! 参考实现（TweetPilot）在 stderr 写入失败时会 panic，曾导致 SIGABRT；
//! 这里所有 IO 错误一律吞掉——日志失败不能拖垮应用。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use log::{LevelFilter, Log, Metadata, Record};

/// 文件里只放 INFO 及以上：磁盘要省，留给真正需要事后追溯的事件。
const FILE_LEVEL: LevelFilter = LevelFilter::Info;

/// 终端（仅 debug 构建）放 DEBUG 及以上：不写盘，详细也不占空间。
#[cfg(debug_assertions)]
const CONSOLE_LEVEL: LevelFilter = LevelFilter::Debug;
#[cfg(not(debug_assertions))]
const CONSOLE_LEVEL: LevelFilter = LevelFilter::Off;

/// 单个日志文件的写满阈值。
///
/// 最坏磁盘占用 = `LOG_KEEP_DAYS` × (1 + `MAX_ROTATED_PER_DAY`) × 本值
/// = 7 × 3 × 2 MiB = **42 MiB**。
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// 每天除当前文件外最多保留的轮转文件数。
pub const MAX_ROTATED_PER_DAY: u32 = 2;

struct Logger {
    inner: Mutex<Inner>,
    file_level: LevelFilter,
    console_level: LevelFilter,
}

struct Inner {
    dir: PathBuf,
    date: chrono::NaiveDate,
    file: Option<File>,
    written: u64,
    /// 测试里会调小；生产用 `MAX_FILE_BYTES`。
    max_bytes: u64,
}

impl Logger {
    fn write_file(&self, line: &str) {
        // 锁中毒、写入失败、文件被删——全部忽略，绝不 panic。
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };

        let today = chrono::Local::now().date_naive();
        if inner.date != today || inner.file.is_none() {
            inner.open(today);
        }

        // **写之前判断**：先轮转，别写完再截断。
        if inner.written + line.len() as u64 > inner.max_bytes {
            inner.rotate();
        }

        if let Some(file) = inner.file.as_mut() {
            if file.write_all(line.as_bytes()).is_ok() {
                let _ = file.flush();
                inner.written += line.len() as u64;
            }
        }
    }
}

impl Inner {
    fn open(&mut self, date: chrono::NaiveDate) {
        self.date = date;
        let path = log_path_for(&self.dir, date);
        self.file = OpenOptions::new().create(true).append(true).open(&path).ok();
        self.written = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    }

    fn rotate(&mut self) {
        // 关掉当前文件，否则 rename 之后还会往旧 inode 里写。
        self.file = None;

        // 丢掉最老的一份，其余依次后移。
        let _ = std::fs::remove_file(rotated_path_for(&self.dir, self.date, MAX_ROTATED_PER_DAY));
        for index in (1..MAX_ROTATED_PER_DAY).rev() {
            let from = rotated_path_for(&self.dir, self.date, index);
            let to = rotated_path_for(&self.dir, self.date, index + 1);
            let _ = std::fs::rename(from, to);
        }
        let _ = std::fs::rename(
            log_path_for(&self.dir, self.date),
            rotated_path_for(&self.dir, self.date, 1),
        );

        self.open(self.date);
        self.written = 0;
    }
}

impl Log for Logger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= self.file_level || metadata.level() <= self.console_level
    }

    fn log(&self, record: &Record<'_>) {
        let level = record.level();
        let write_file = level <= self.file_level;
        let write_console = level <= self.console_level;
        if !write_file && !write_console {
            return;
        }

        let line = format!(
            "{} {:<5} {} {}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            level,
            record.target(),
            record.args()
        );

        if write_file {
            self.write_file(&line);
        }

        // 同一行也写 stderr：`npm run app:dev 2>&1 | tee` 就能直接抓到应用日志。
        // 不用 stdout——它会被程序自己的输出和缓冲干扰。
        // 这条路不写盘，所以 DEBUG 全打也不占空间。
        if write_console {
            let _ = std::io::stderr().write_all(line.as_bytes());
        }
    }

    fn flush(&self) {}
}

/// 初始化文件日志；返回日志文件路径。
///
/// 已经初始化过（例如测试）或无法创建文件时返回 `None`，调用方无需处理。
pub fn init(data_dir: &Path) -> Option<PathBuf> {
    let level = level_from_env();
    let path = log_path(data_dir);
    let log_dir = path.parent()?.to_path_buf();

    let _ = std::fs::create_dir_all(&log_dir);
    // 按天轮转：只清 `app-*.log`，不碰 runtime-<版本>.log / runtime-events.log。
    cleanup_old_logs(&log_dir, LOG_KEEP_DAYS);

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok();

    static INSTALLED: Mutex<bool> = Mutex::new(false);
    let mut installed = INSTALLED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if *installed {
        return None;
    }

    let inner = Inner {
        dir: log_dir.clone(),
        date: chrono::Local::now().date_naive(),
        written: std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
        file,
        max_bytes: MAX_FILE_BYTES,
    };
    if log::set_boxed_logger(Box::new(Logger {
        inner: Mutex::new(inner),
        file_level: level,
        console_level: console_level(),
    }))
    .is_err()
    {
        return None;
    }

    // 取两路里更宽松的那个，否则 debug 级记录根本到不了 logger。
    log::set_max_level(if level > console_level() { level } else { console_level() });
    *installed = true;
    Some(path)
}

/// 需求 `phase-1-requirements.md` §6：按天轮转，最多保留 7 天。
pub const LOG_KEEP_DAYS: i64 = 7;

/// `<data_dir>/logs/app-YYYY-MM-DD.log`
pub fn log_path(data_dir: &Path) -> PathBuf {
    log_path_for(data_dir, chrono::Local::now().date_naive())
}

pub fn log_path_for(data_dir: &Path, date: chrono::NaiveDate) -> PathBuf {
    data_dir
        .join("logs")
        .join(format!("app-{}.log", date.format("%Y-%m-%d")))
}

/// 轮转文件路径：`app-YYYY-MM-DD.<n>.log`
pub fn rotated_path_for(data_dir: &Path, date: chrono::NaiveDate, index: u32) -> PathBuf {
    data_dir
        .join("logs")
        .join(format!("app-{}.{index}.log", date.format("%Y-%m-%d")))
}

/// 删除 `app-YYYY-MM-DD.log` 里早于 `keep_days` 的文件；返回删除数量。
/// 文件名解析不出来的一律不动（例如 `runtime-1.14.4.log`）。
pub fn cleanup_old_logs(dir: &Path, keep_days: i64) -> usize {
    let keep_days = keep_days.max(1);
    let cutoff = chrono::Local::now().date_naive() - chrono::Duration::days(keep_days - 1);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };

    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(date) = parse_log_date(&name) else {
            continue;
        };
        if date < cutoff && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn parse_log_date(name: &str) -> Option<chrono::NaiveDate> {
    let stem = name.strip_prefix("app-")?.strip_suffix(".log")?;
    // 轮转文件形如 `app-2026-11-04.1`：日期取最后一个点之前的部分。
    let date = stem.split('.').next().unwrap_or(stem);
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()
}

/// 终端那一路的级别。release 构建里没有终端日志。
fn console_level() -> LevelFilter {
    match std::env::var("RUST_LOG") {
        // 显式设了就听用户的（两路一起变）。
        Ok(raw) => parse_level(&raw).unwrap_or(CONSOLE_LEVEL),
        Err(_) => CONSOLE_LEVEL,
    }
}

/// 支持 `debug`、`veyl=debug`、`veyl=debug,tauri=info` 三种写法；默认 `info`。
pub fn level_from_env() -> LevelFilter {
    match std::env::var("RUST_LOG") {
        Ok(raw) => parse_level(&raw).unwrap_or(FILE_LEVEL),
        Err(_) => FILE_LEVEL,
    }
}

pub fn parse_level(raw: &str) -> Option<LevelFilter> {
    let mut result = None;
    for part in raw.split(',') {
        let candidate = part
            .split('=')
            .next_back()
            .unwrap_or(part)
            .trim()
            .to_ascii_lowercase();
        result = match candidate.as_str() {
            "off" => Some(LevelFilter::Off),
            "error" => Some(LevelFilter::Error),
            "warn" | "warning" => Some(LevelFilter::Warn),
            "info" => Some(LevelFilter::Info),
            "debug" => Some(LevelFilter::Debug),
            "trace" => Some(LevelFilter::Trace),
            _ => result,
        };
    }
    result
}

/// 敏感字段：命中就把整个值换成 `***`，不看内容。
///
/// 靠这个函数，**而不是靠写日志的人记得别写**——记不住的。
fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    ["key", "password", "passwd", "secret", "token", "credential", "authorization"]
        .iter()
        .any(|needle| key.contains(needle))
}

/// 自由文本（用户输入、提示词）：只记长度和开头一点点。
fn is_free_text_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    ["text", "prompt", "content", "message", "categories"]
        .iter()
        .any(|needle| key == *needle || key.ends_with(&format!("_{needle}")))
}

/// 字符串一律截断，避免整份配置/提示词进日志。
pub fn redact_str(value: &str) -> String {
    let count = value.chars().count();
    if count <= 24 {
        return value.to_string();
    }
    let head: String = value.chars().take(16).collect();
    format!("{head}…（共 {count} 字）")
}

/// 递归脱敏。深度上限 6，防止异常结构把日志撑爆。
pub fn redact_json(value: &serde_json::Value) -> serde_json::Value {
    redact_json_at(value, 0)
}

fn redact_json_at(value: &serde_json::Value, depth: usize) -> serde_json::Value {
    use serde_json::Value;
    if depth > 6 {
        return Value::String("…".into());
    }
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, item) in map {
                let redacted = if is_secret_key(key) {
                    Value::String("***".into())
                } else if is_free_text_key(key) {
                    match item {
                        Value::String(text) => Value::String(redact_str(text)),
                        other => redact_json_at(other, depth + 1),
                    }
                } else {
                    redact_json_at(item, depth + 1)
                };
                out.insert(key.clone(), redacted);
            }
            Value::Object(out)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| redact_json_at(item, depth + 1)).collect())
        }
        Value::String(text) => Value::String(redact_str(text)),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::{Level, LevelFilter, Record};

    fn record(level: Level) -> Record<'static> {
        Record::builder()
            .args(format_args!("probe"))
            .level(level)
            .target("veyl::test")
            .build()
    }

    fn dated(name: &str) -> chrono::NaiveDate {
        chrono::NaiveDate::parse_from_str(name, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn parses_the_common_rust_log_forms() {
        assert_eq!(parse_level("debug"), Some(LevelFilter::Debug));
        assert_eq!(parse_level("veyl=warn"), Some(LevelFilter::Warn));
        assert_eq!(parse_level("veyl=debug,tauri=info"), Some(LevelFilter::Info));
        assert_eq!(parse_level("nonsense"), None);
    }

    #[test]
    fn the_log_path_is_daily() {
        let dir = std::env::temp_dir();
        let date = dated("2026-11-02");
        assert_eq!(
            log_path_for(&dir, date),
            dir.join("logs").join("app-2026-11-02.log")
        );
    }

    #[test]
    fn only_dated_app_logs_are_parsed() {
        assert_eq!(parse_log_date("app-2026-11-02.log"), Some(dated("2026-11-02")));
        assert_eq!(parse_log_date("runtime-1.14.4.log"), None);
        assert_eq!(parse_log_date("runtime-events.log"), None);
        assert_eq!(parse_log_date("app-nonsense.log"), None);
        assert_eq!(parse_log_date("app-2026-11-02.1.log"), Some(dated("2026-11-02")));
    }

    #[test]
    fn cleanup_keeps_seven_days_and_leaves_runtime_logs_alone() {
        let dir = std::env::temp_dir().join(format!("veyl-log-{:016x}", rand::random::<u64>()));
        let logs = dir.join("logs");
        std::fs::create_dir_all(&logs).unwrap();

        let today = chrono::Local::now().date_naive();
        let mut kept = Vec::new();
        for offset in 0..7 {
            let date = today - chrono::Duration::days(offset);
            let path = log_path_for(&dir, date);
            std::fs::write(&path, "x").unwrap();
            kept.push(path);
        }
        for offset in [7, 30] {
            let date = today - chrono::Duration::days(offset);
            std::fs::write(log_path_for(&dir, date), "x").unwrap();
        }
        std::fs::write(logs.join("runtime-1.14.4.log"), "x").unwrap();
        std::fs::write(logs.join("runtime-events.log"), "x").unwrap();

        assert_eq!(cleanup_old_logs(&logs, LOG_KEEP_DAYS), 2);
        for path in kept {
            assert!(path.exists(), "{} 应保留", path.display());
        }
        assert!(!log_path_for(&dir, today - chrono::Duration::days(7)).exists());
        assert!(logs.join("runtime-1.14.4.log").exists());
        assert!(logs.join("runtime-events.log").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn test_logger(dir: &Path, file_level: LevelFilter, console: LevelFilter) -> Logger {
        Logger {
            inner: Mutex::new(Inner {
                dir: dir.to_path_buf(),
                date: chrono::Local::now().date_naive(),
                file: None,
                written: 0,
                max_bytes: MAX_FILE_BYTES,
            }),
            file_level,
            console_level: console,
        }
    }

    #[test]
    fn level_filtering_is_honoured() {
        let dir = std::env::temp_dir();
        let logger = test_logger(&dir, LevelFilter::Warn, LevelFilter::Off);
        assert!(!logger.enabled(record(Level::Info).metadata()));
        assert!(logger.enabled(record(Level::Warn).metadata()));
        assert!(logger.enabled(record(Level::Error).metadata()));
    }

    /// 核心要求：**文件 sparse、终端 verbose**。
    #[test]
    fn debug_goes_to_the_console_but_not_the_file() {
        let dir = std::env::temp_dir().join(format!("veyl-split-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        let logger = test_logger(&dir, FILE_LEVEL, LevelFilter::Debug);

        logger.log(&record(Level::Debug));
        let path = log_path(&dir);
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(!content.contains("probe"), "DEBUG 不该进文件：{content:?}");

        logger.log(&record(Level::Info));
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(content.contains("probe"), "INFO 应该进文件");
        assert!(content.contains("INFO"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 写之前判断大小：超阈值先轮转，当前文件重新开始。
    #[test]
    fn the_file_rotates_before_it_exceeds_the_cap() {
        let dir = std::env::temp_dir().join(format!("veyl-rot-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(dir.join("logs")).unwrap();

        let logger = test_logger(&dir, FILE_LEVEL, LevelFilter::Off);
        {
            let mut inner = logger.inner.lock().unwrap();
            inner.max_bytes = 200;
        }

        for _ in 0..20 {
            logger.log(&record(Level::Warn));
        }

        let base = log_path(&dir);
        assert!(base.exists(), "当前文件应存在");
        assert!(
            std::fs::metadata(&base).unwrap().len() <= 200,
            "当前文件超过阈值：{}",
            std::fs::metadata(&base).unwrap().len()
        );
        assert!(
            rotated_path_for(&dir, chrono::Local::now().date_naive(), 1).exists(),
            "应该产生 .1 轮转文件"
        );
        assert!(
            !rotated_path_for(&dir, chrono::Local::now().date_naive(), MAX_ROTATED_PER_DAY + 1).exists(),
            "轮转文件数不能超过上限"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_file_never_panics() {
        let logger = Logger {
            inner: Mutex::new(Inner {
                dir: std::env::temp_dir(),
                date: chrono::Local::now().date_naive(),
                file: None,
                written: 0,
                max_bytes: MAX_FILE_BYTES,
            }),
            file_level: LevelFilter::Trace,
            console_level: LevelFilter::Off,
        };
        logger.log(&record(Level::Error));
        logger.flush();
    }

    #[test]
    fn a_record_reaches_the_file() {
        let dir = std::env::temp_dir().join(format!("veyl-log-{:016x}", rand::random::<u64>()));
        let Some(path) = init(&dir) else {
            // 本进程已经装过 logger（并行测试），跳过。
            return;
        };

        log::warn!("日志自测：写入一条记录");
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(content.contains("日志自测"), "日志文件内容：{content:?}");
        assert!(content.contains("WARN"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 日志里绝不能出现密钥、密码、完整用户输入。
    #[test]
    fn secrets_never_reach_the_log() {
        let value = serde_json::json!({
            "api_key": "sk-abcdefghijklmnop",
            "password": "hunter2",
            "nested": { "secret": "topsecret", "name": "东京" },
            "text": "x".repeat(200),
            "port": 8388
        });
        let redacted = redact_json(&value).to_string();
        assert!(!redacted.contains("sk-abcdef"), "API Key 泄漏：{redacted}");
        assert!(!redacted.contains("hunter2"), "密码泄漏：{redacted}");
        assert!(!redacted.contains("topsecret"), "secret 泄漏：{redacted}");
        assert!(!redacted.contains(&"x".repeat(50)), "长文本没有截断：{redacted}");
        assert!(redacted.contains("8388"), "非敏感字段不该被吃掉");
        assert!(redacted.contains("东京"));
    }
}
