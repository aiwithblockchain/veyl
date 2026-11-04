//! 最小文件日志。
//!
//! ## 脱敏边界（这是刻意的，不是遗漏）
//!
//! 能保证的：
//! - **敏感字段**（`password` / `key` / `secret` / `token` / `credential`…）整值变 `***`；
//! - **自由文本**（`text` / `prompt` / `content` / `message`）**一个字符都不留**，只记长度；
//! - **普通字符串**里形态明显的凭据会被掩掉：`sk-` 前缀令牌、≥16 位的 base64/hex 长串、
//!   URL 里的 `user:pass@`。
//!
//! 做不到的：
//! - 一段**短**的、没有形态特征的密码（比如 12 位的 `hunter2abc12`）如果被塞进
//!   `name` / `url` / `error` 这类普通字符串字段里，**不会被识别**，会原样进日志。
//!
//! 不打算解决：不知道哪一段是密码时，「识别」只能靠猜，猜错就会把正常内容也吃掉。
//! 真正的防线是**调用方把密码放进敏感字段**。写日志时如果需要带用户输入或凭据，
//! 用 `redact_text` 或 `truncate_for_log`，不要直接 `{}` 展开。
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
///
/// 这个上限对**长期不重启**的进程也成立：跨天时会先清理一次过期日志，
/// 所以不会出现「开着几周、每天的轮转文件都堆着」的情况。
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
        if inner.date != today {
            // 只在跨天时清一次：这样「连续开几周不重启」也不会无限涨，
            // 7 天上限才是真的上限，而不是「每次重启后的上限」。
            cleanup_old_logs(&inner.dir.join("logs"), LOG_KEEP_DAYS);
        }
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
        dir: data_dir.to_path_buf(),
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
    // release 构建恒为 Off，**没有覆盖开关**。
    // 打包后的 GUI 应用 stderr 往往没有归宿，让它有机会被环境变量重新打开
    // 只会制造「日志写到不知道哪里去了」这一类问题。
    #[cfg(not(debug_assertions))]
    {
        LevelFilter::Off
    }
    #[cfg(debug_assertions)]
    {
        match std::env::var("RUST_LOG") {
            Ok(raw) => parse_level(&raw).unwrap_or(CONSOLE_LEVEL),
            Err(_) => CONSOLE_LEVEL,
        }
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

/// **自由文本不记内容，只记长度。**
///
/// 用户输入、提示词、模型返回的自由文本里可能夹着密码；截断会把 24 字以内的
/// 短密码原样留下，所以这一类**一个字符都不留**。
pub fn redact_text(value: &str) -> String {
    format!("「共 {} 字」", value.chars().count())
}

/// 标识类字符串（名字、id、url、错误信息）：先掩掉像密钥的片段，再截断。
///
/// 名字叫 `truncate_for_log` 而不是 `redact_str`：它**不是**脱敏函数，
/// 只是把长文本压短并顺手处理明显的密钥形态。真正的保证来自
/// `redact_text`（自由文本）与 `is_secret_key`（敏感字段）。
pub fn truncate_for_log(value: &str) -> String {
    let masked = mask_secret_like(value);
    let count = masked.chars().count();
    if count <= 48 {
        return masked;
    }
    let head: String = masked.chars().take(40).collect();
    format!("{head}…（共 {count} 字）")
}

/// 把「看起来像凭据」的片段换成 `***`：
/// - `scheme://user:pass@host` 里的 userinfo
/// - `sk-` 开头的令牌
/// - 长度 ≥16 且几乎只由 base64/hex 字符组成的一整段（API Key、订阅 token 的典型形态）
fn mask_secret_like(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut token = String::new();

    let flush = |token: &mut String, out: &mut String| {
        if token.is_empty() {
            return;
        }
        if looks_like_secret(token) {
            out.push_str("***");
        } else {
            out.push_str(token);
        }
        token.clear();
    };

    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=' | '-' | '_') {
            token.push(ch);
        } else {
            flush(&mut token, &mut out);
            out.push(ch);
        }
    }
    flush(&mut token, &mut out);

    mask_url_userinfo(&out)
}

fn looks_like_secret(token: &str) -> bool {
    if token.starts_with("sk-") {
        return true;
    }
    if token.len() < 16 {
        return false;
    }
    let has_lower = token.chars().any(|c| c.is_ascii_lowercase());
    let has_upper = token.chars().any(|c| c.is_ascii_uppercase());
    let has_digit = token.chars().any(|c| c.is_ascii_digit());
    // 纯小写单词（比如一句英文）不算凭据；要求混了大小写或数字。
    (has_lower && has_upper) || (has_lower && has_digit) || (has_upper && has_digit)
}

/// `https://user:pass@host/...` → `https://***@host/...`
fn mask_url_userinfo(text: &str) -> String {
    let Some(scheme) = text.find("://") else {
        return text.to_string();
    };
    let after = scheme + 3;
    let rest = &text[after..];
    let end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..end];
    match authority.rfind('@') {
        Some(at) => format!("{}***{}{}", &text[..after], &authority[at..], &rest[end..]),
        None => text.to_string(),
    }
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
                        // 自由文本：只留长度，一个字符都不留。
                        Value::String(text) => Value::String(redact_text(text)),
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
        Value::String(text) => Value::String(truncate_for_log(text)),
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

    /// 交叉检查抓到的真问题：12 个字符的密码短于旧的 24 字阈值，会原样进日志。
    /// 现在自由文本**一个字符都不留**，只有长度。
    #[test]
    fn a_short_password_in_free_text_is_never_written() {
        let value = serde_json::json!({ "text": "我的密码是 abc12345xyz" });
        let redacted = redact_json(&value).to_string();
        assert!(!redacted.contains("abc12345xyz"), "密码进日志了：{redacted}");
        assert!(redacted.contains("共"), "自由文本应只留长度：{redacted}");
    }

    /// 敏感字段无论长短都掩掉。
    #[test]
    fn short_secrets_behind_a_secret_key_are_masked() {
        let value = serde_json::json!({ "password": "abc12345xyz" });
        let redacted = redact_json(&value).to_string();
        assert!(!redacted.contains("abc12345xyz"), "{redacted}");
        assert!(redacted.contains("***"));
    }

    /// 普通字段里夹带的凭据形态也要认出来：URL userinfo、sk- 令牌、长 base64。
    #[test]
    fn secret_shaped_fragments_are_masked_anywhere() {
        for (text, leaked) in [
            ("https://user:hunter2@example.com/sub", "hunter2"),
            ("token sk-abcdefghijklmnopqrst", "sk-abcdefghijklmnopqrst"),
            ("key AKIAIOSFODNN7EXAMPLE0123456789", "AKIAIOSFODNN7EXAMPLE0123456789"),
        ] {
            let out = truncate_for_log(text);
            assert!(!out.contains(leaked), "{text} 泄漏了 {leaked}：{out}");
        }
    }

    /// `Inner.dir` 是**数据目录**，不是 logs 目录——否则 `log_path_for`
    /// 会拼成 `<data>/logs/logs/app-….log`。
    #[test]
    fn the_file_lands_directly_under_logs() {
        let data = std::env::temp_dir().join(format!("veyl-dir-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(data.join("logs")).unwrap();

        let mut inner = Inner {
            dir: data.clone(),
            date: chrono::Local::now().date_naive(),
            file: None,
            written: 0,
            max_bytes: MAX_FILE_BYTES,
        };
        inner.open(chrono::Local::now().date_naive());

        assert!(log_path(&data).exists(), "应写在 <data>/logs/ 下");
        assert!(!data.join("logs").join("logs").exists(), "不能重复拼 logs");

        let _ = std::fs::remove_dir_all(&data);
    }
}
