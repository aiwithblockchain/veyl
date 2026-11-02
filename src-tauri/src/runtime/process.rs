use std::path::PathBuf;
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

pub async fn spawn(options: &SpawnOptions) -> RuntimeResult<Child> {
    if let Some(parent) = options.log_path.parent() {
        fsutil::ensure_dir(parent)?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
