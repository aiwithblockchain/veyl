//! 服务日志。只写 `%ProgramData%\Veyl\logs\service.log`。
//!
//! 目录由安装器创建（SYSTEM/Administrators 可写，普通用户只读）；
//! 打不开时退回标准输出——调用方（`--console` 开发模式）能看见，
//! 正式服务里 SCM 会丢弃，但服务不会因此退出。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::sync::Mutex;

const MAX_LOG_BYTES: u64 = 1024 * 1024;

pub struct ServiceLog {
    file: Mutex<Option<File>>,
    echo: bool,
}

impl ServiceLog {
    pub fn open(echo: bool) -> Self {
        let path = super::logs_dir().join("service.log");
        let file = open_rotated(&path);
        Self {
            file: Mutex::new(file),
            echo,
        }
    }

    pub fn info(&self, message: impl AsRef<str>) {
        self.line("info", message.as_ref());
    }

    pub fn warn(&self, message: impl AsRef<str>) {
        self.line("warn", message.as_ref());
    }

    pub fn error(&self, message: impl AsRef<str>) {
        self.line("error", message.as_ref());
    }

    pub fn line(&self, level: &str, message: &str) {
        let stamp = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z");
        let text = format!("{stamp} [{level}] {message}");
        if self.echo {
            println!("{text}");
        }
        if let Ok(mut guard) = self.file.lock() {
            if let Some(file) = guard.as_mut() {
                if writeln!(file, "{text}").is_err() {
                    // 磁盘满 / 权限变化：不 panic，也别在每个请求上重复报错。
                }
            }
        }
    }
}

fn open_rotated(path: &std::path::Path) -> Option<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok()?;
    }
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > MAX_LOG_BYTES {
            let rotated = path.with_extension("log.1");
            let _ = fs::remove_file(&rotated);
            let _ = fs::rename(path, &rotated);
        }
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}
