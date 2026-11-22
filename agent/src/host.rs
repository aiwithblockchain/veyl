//! Thin host abstraction so the install/rotate pipeline can be unit-tested
//! without touching systemd, the network, or `/usr/local`.

use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CmdOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl CmdOutput {
    pub fn success(&self) -> bool {
        self.status == Some(0)
    }

    pub fn summary(&self) -> String {
        let mut text = String::new();
        if !self.stdout.trim().is_empty() {
            text.push_str(self.stdout.trim());
        }
        if !self.stderr.trim().is_empty() {
            if !text.is_empty() {
                text.push_str(" | ");
            }
            text.push_str(self.stderr.trim());
        }
        if text.is_empty() {
            format!("exit={:?}", self.status)
        } else {
            text
        }
    }
}

#[async_trait]
pub trait Host: Send + Sync {
    async fn run(&self, program: &str, args: &[String]) -> Result<CmdOutput>;
    async fn read(&self, path: &Path) -> Result<Option<Vec<u8>>>;
    async fn write(&self, path: &Path, bytes: &[u8], mode: u32) -> Result<()>;
    async fn rename(&self, from: &Path, to: &Path) -> Result<()>;
    async fn remove(&self, path: &Path) -> Result<()>;
    async fn create_dir_all(&self, path: &Path) -> Result<()>;
    async fn is_file(&self, path: &Path) -> Result<bool>;
    async fn connect(&self, addr: SocketAddr, timeout: Duration) -> Result<()>;
    async fn download(&self, url: &str, dest: &Path) -> Result<()>;
    async fn sha256_file(&self, path: &Path) -> Result<String>;
}

pub struct RealHost {
    http: reqwest::Client,
}

impl RealHost {
    pub fn new() -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .user_agent(crate::control::USER_AGENT)
            .build()?;
        Ok(Self { http })
    }
}

#[async_trait]
impl Host for RealHost {
    async fn run(&self, program: &str, args: &[String]) -> Result<CmdOutput> {
        tracing::debug!(program, ?args, "exec");
        let output = tokio::process::Command::new(program)
            .args(args)
            .output()
            .await
            .with_context(|| format!("run {program} {}", args.join(" ")))?;
        Ok(CmdOutput {
            status: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    async fn read(&self, path: &Path) -> Result<Option<Vec<u8>>> {
        match tokio::fs::read(path).await {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
        }
    }

    async fn write(&self, path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("create dir {}", parent.display()))?;
        }
        let existed = tokio::fs::metadata(path).await.is_ok();
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(mode);
        {
            use tokio::io::AsyncWriteExt;
            let mut file = options
                .open(path)
                .await
                .with_context(|| format!("create {}", path.display()))?;
            file.write_all(bytes)
                .await
                .with_context(|| format!("write {}", path.display()))?;
            file.flush().await?;
        }
        // Existing files keep their old mode; tighten them if needed.
        if existed {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
                    .await
                    .with_context(|| format!("chmod {mode:o} {}", path.display()))?;
            }
        }
        #[cfg(not(unix))]
        let _ = mode;
        Ok(())
    }

    async fn rename(&self, from: &Path, to: &Path) -> Result<()> {
        tokio::fs::rename(from, to)
            .await
            .with_context(|| format!("rename {} -> {}", from.display(), to.display()))
    }

    async fn remove(&self, path: &Path) -> Result<()> {
        match tokio::fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e).with_context(|| format!("remove {}", path.display())),
        }
    }

    async fn create_dir_all(&self, path: &Path) -> Result<()> {
        tokio::fs::create_dir_all(path)
            .await
            .with_context(|| format!("create dir {}", path.display()))
    }

    async fn is_file(&self, path: &Path) -> Result<bool> {
        Ok(tokio::fs::metadata(path)
            .await
            .map(|m| m.is_file())
            .unwrap_or(false))
    }

    async fn connect(&self, addr: SocketAddr, timeout: Duration) -> Result<()> {
        match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(anyhow::anyhow!("connect {addr}: {e}")),
            Err(_) => Err(anyhow::anyhow!("connect {addr}: timed out after {timeout:?}")),
        }
    }

    async fn download(&self, url: &str, dest: &Path) -> Result<()> {
        tracing::debug!(url, dest = %dest.display(), "download");
        let mut resp = self
            .http
            .get(url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?
            .error_for_status()
            .with_context(|| format!("GET {url}"))?;
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut file = tokio::fs::File::create(dest)
            .await
            .with_context(|| format!("create {}", dest.display()))?;
        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = resp.chunk().await.context("read download body")? {
            file.write_all(&chunk).await.context("write download")?;
        }
        file.flush().await.context("flush download")?;
        Ok(())
    }

    async fn sha256_file(&self, path: &Path) -> Result<String> {
        let mut file = tokio::fs::File::open(path)
            .await
            .with_context(|| format!("open {}", path.display()))?;
        use tokio::io::AsyncReadExt;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(crate::cert::hex(hasher.finalize().as_slice()))
    }
}
