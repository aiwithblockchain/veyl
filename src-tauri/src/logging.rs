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

struct FileLogger {
    file: Mutex<Option<File>>,
    level: LevelFilter,
}

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let line = format!(
            "{} {:<5} {} {}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            record.level(),
            record.target(),
            record.args()
        );

        // 锁中毒、写入失败、文件被删——全部忽略，绝不 panic。
        if let Ok(mut guard) = self.file.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = file.write_all(line.as_bytes());
                let _ = file.flush();
            }
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

    if log::set_boxed_logger(Box::new(FileLogger {
        file: Mutex::new(file),
        level,
    }))
    .is_err()
    {
        return None;
    }

    log::set_max_level(level);
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
    chrono::NaiveDate::parse_from_str(stem, "%Y-%m-%d").ok()
}

/// 支持 `debug`、`veyl=debug`、`veyl=debug,tauri=info` 三种写法；默认 `info`。
pub fn level_from_env() -> LevelFilter {
    match std::env::var("RUST_LOG") {
        Ok(raw) => parse_level(&raw).unwrap_or(LevelFilter::Info),
        Err(_) => LevelFilter::Info,
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

    #[test]
    fn level_filtering_is_honoured() {
        let logger = FileLogger {
            file: Mutex::new(None),
            level: LevelFilter::Warn,
        };
        assert!(!logger.enabled(record(Level::Info).metadata()));
        assert!(logger.enabled(record(Level::Warn).metadata()));
        assert!(logger.enabled(record(Level::Error).metadata()));
    }

    #[test]
    fn a_failed_file_never_panics() {
        // 文件打不开时 logger 仍然工作，只是丢弃写入。
        let logger = FileLogger {
            file: Mutex::new(None),
            level: LevelFilter::Trace,
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
}
