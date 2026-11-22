//! Thin host abstraction so the install/rotate pipeline can be unit-tested
//! without touching systemd, the network, or `/usr/local`.

use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use sha2::{Digest, Sha256};

/// 200 MiB: large enough for any sing-box release, small enough that a hostile
/// or broken endpoint cannot fill the disk.
const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;
const CMD_TIMEOUT: Duration = Duration::from_secs(30);
/// Unpack/install read a whole archive; give them more room than systemctl.
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CmdOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Marker error so callers can map a stuck command to a retryable failure
/// instead of a fatal one.
#[derive(Debug)]
pub struct CommandTimeout {
    pub program: String,
    pub args: Vec<String>,
    pub timeout: Duration,
}

impl std::fmt::Display for CommandTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {} timed out after {:?}",
            self.program,
            crate::logging::redact_sensitive(&self.args.join(" ")),
            self.timeout
        )
    }
}

impl std::error::Error for CommandTimeout {}

/// True when an error came from the command timeout wrapper.
pub fn is_timeout(err: &anyhow::Error) -> bool {
    err.chain().any(|e| e.is::<CommandTimeout>())
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
    async fn canonicalize(&self, path: &Path) -> Result<std::path::PathBuf>;
    async fn connect(&self, addr: SocketAddr, timeout: Duration) -> Result<()>;
    async fn download(&self, url: &str, dest: &Path) -> Result<()>;
    async fn sha256_file(&self, path: &Path) -> Result<String>;
}

pub struct RealHost {
    http: reqwest::Client,
    cmd_timeout: Duration,
    archive_timeout: Duration,
}

impl RealHost {
    pub fn new() -> Result<Self> {
        Self::with_timeouts(CMD_TIMEOUT, ARCHIVE_TIMEOUT)
    }

    pub fn with_timeouts(cmd_timeout: Duration, archive_timeout: Duration) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .user_agent(crate::control::USER_AGENT)
            // Redirects must stay on https; a downgrade to http would let a
            // compromised mirror swap the binary on the wire.
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    attempt.error("too many redirects")
                } else if attempt.url().scheme() != "https" {
                    attempt.error("redirect to a non-https URL")
                } else {
                    attempt.follow()
                }
            }))
            .build()?;
        Ok(Self {
            http,
            cmd_timeout,
            archive_timeout,
        })
    }

    fn timeout_for(&self, program: &str) -> Duration {
        let base = Path::new(program)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(program);
        if base == "tar" || base == "install" {
            self.archive_timeout
        } else {
            self.cmd_timeout
        }
    }
}

/// Scheme + host only: URLs can carry one-time tokens in their query string.
fn url_host(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(parsed) => match parsed.host_str() {
            Some(host) => format!("{}://{host}", parsed.scheme()),
            None => "<no-host>".to_string(),
        },
        Err(_) => "<invalid-url>".to_string(),
    }
}

#[async_trait]
impl Host for RealHost {
    async fn run(&self, program: &str, args: &[String]) -> Result<CmdOutput> {
        let timeout = self.timeout_for(program);
        if let Some(base) = Path::new(program).file_name().and_then(|n| n.to_str()) {
            tracing::debug!(program = base, "exec");
        }
        let mut command = tokio::process::Command::new(program);
        command.args(args).kill_on_drop(true);
        let output = match tokio::time::timeout(timeout, command.output()).await {
            Ok(result) => result.with_context(|| {
                format!(
                    "run {} {}",
                    program,
                    crate::logging::redact_sensitive(&args.join(" "))
                )
            })?,
            Err(_) => {
                tracing::warn!(
                    program,
                    args = %crate::logging::redact_sensitive(&args.join(" ")),
                    timeout_secs = timeout.as_secs(),
                    "command timed out"
                );
                return Err(anyhow::Error::new(CommandTimeout {
                    program: program.to_string(),
                    args: args.to_vec(),
                    timeout,
                }));
            }
        };
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

    async fn canonicalize(&self, path: &Path) -> Result<std::path::PathBuf> {
        tokio::fs::canonicalize(path)
            .await
            .with_context(|| format!("canonicalize {}", path.display()))
    }

    async fn connect(&self, addr: SocketAddr, timeout: Duration) -> Result<()> {
        match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(anyhow::anyhow!("connect {addr}: {e}")),
            Err(_) => Err(anyhow::anyhow!("connect {addr}: timed out after {timeout:?}")),
        }
    }

    async fn download(&self, url: &str, dest: &Path) -> Result<()> {
        let parsed = reqwest::Url::parse(url).context("parse download URL")?;
        if parsed.scheme() != "https" {
            anyhow::bail!("download URL must be https");
        }
        tracing::debug!(host = %url_host(url), dest = %dest.display(), "download");
        let mut resp = self
            .http
            .get(parsed)
            .send()
            .await
            .with_context(|| format!("GET {}", url_host(url)))?
            .error_for_status()
            .with_context(|| format!("GET {}", url_host(url)))?;
        if let Some(len) = resp.content_length() {
            if len > MAX_DOWNLOAD_BYTES {
                anyhow::bail!(
                    "download from {} is {len} bytes, over the {MAX_DOWNLOAD_BYTES}-byte limit",
                    url_host(url)
                );
            }
        }
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut file = tokio::fs::File::create(dest)
            .await
            .with_context(|| format!("create {}", dest.display()))?;
        use tokio::io::AsyncWriteExt;
        let mut written: u64 = 0;
        loop {
            let chunk = resp.chunk().await.context("read download body")?;
            let Some(chunk) = chunk else {
                break;
            };
            written += chunk.len() as u64;
            if written > MAX_DOWNLOAD_BYTES {
                drop(file);
                let _ = tokio::fs::remove_file(dest).await;
                tracing::warn!(
                    host = %url_host(url),
                    limit_bytes = MAX_DOWNLOAD_BYTES,
                    "download exceeded the size limit; partial file removed"
                );
                anyhow::bail!("download from {} exceeded the size limit", url_host(url));
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_hung_command_times_out_with_a_marker_error() {
        crate::init_crypto_provider();
        let host = RealHost::with_timeouts(
            Duration::from_millis(100),
            Duration::from_millis(100),
        )
        .unwrap();
        let err = host
            .run("sh", &["-c".into(), "sleep 5".into()])
            .await
            .unwrap_err();
        assert!(is_timeout(&err), "expected a CommandTimeout: {err}");
        assert!(err.to_string().contains("timed out"));
    }

    #[test]
    fn archive_commands_get_the_longer_timeout() {
        crate::init_crypto_provider();
        let host = RealHost::with_timeouts(Duration::from_secs(30), Duration::from_secs(300))
            .unwrap();
        assert_eq!(host.timeout_for("/usr/bin/tar"), Duration::from_secs(300));
        assert_eq!(host.timeout_for("/usr/bin/install"), Duration::from_secs(300));
        assert_eq!(
            host.timeout_for("/usr/local/bin/sing-box"),
            Duration::from_secs(30)
        );
        assert_eq!(host.timeout_for("systemctl"), Duration::from_secs(30));
    }

    #[tokio::test]
    async fn download_rejects_plain_http_before_connecting() {
        crate::init_crypto_provider();
        let host = RealHost::new().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "veyl-agent-host-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let err = host
            .download("http://example.com/sing-box.tar.gz", &dir.join("x"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("must be https"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
