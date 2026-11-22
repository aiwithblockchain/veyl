//! sing-box install + config + systemd lifecycle.
//!
//! Ported from the cloud-init script (`cloudflare/control-plane/src/cloud_init.ts`)
//! so the agent produces exactly the same layout the existing machines have:
//! binary in `/usr/local/bin`, config in `/usr/local/etc/sing-box/config.json`,
//! unit `sing-box.service`, method `aes-256-gcm`.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde_json::json;

use crate::config::SingBoxConfig;
use crate::control::SingBoxDesired;
use crate::host::Host;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyErrorKind {
    Fatal,
    Retryable,
}

#[derive(Debug, Clone)]
pub struct ApplyError {
    pub kind: ApplyErrorKind,
    pub message: String,
}

impl ApplyError {
    pub fn fatal(message: impl Into<String>) -> Self {
        Self {
            kind: ApplyErrorKind::Fatal,
            message: message.into(),
        }
    }

    pub fn retryable(message: impl Into<String>) -> Self {
        Self {
            kind: ApplyErrorKind::Retryable,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ApplyError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedConfig {
    pub port: u16,
    pub password: String,
}

impl AppliedConfig {
    pub fn matches(&self, desired: &crate::control::DesiredState) -> bool {
        self.port == desired.port && self.password == desired.password
    }
}

pub struct SingBox {
    cfg: SingBoxConfig,
    host: Arc<dyn Host>,
}

impl SingBox {
    pub fn new(cfg: SingBoxConfig, host: Arc<dyn Host>) -> Self {
        Self { cfg, host }
    }

    pub fn config(&self) -> &SingBoxConfig {
        &self.cfg
    }

    /// Raw current config, so a rotation can be rolled back if the control
    /// plane rejects the new port/password.
    pub async fn raw_config(&self) -> Result<Option<Vec<u8>>> {
        self.host.read(&self.cfg.config_path).await
    }

    /// Restore a previous config and wait for the service to come back.
    pub async fn restore(&self, old: Option<Vec<u8>>) -> Result<(), ApplyError> {
        self.rollback(old).await;
        self.wait_active().await
    }

    pub async fn installed_version(&self) -> Result<Option<String>> {
        if !self.host.is_file(&self.cfg.binary_path).await? {
            return Ok(None);
        }
        let out = self
            .host
            .run(
                &self.cfg.binary_path.to_string_lossy(),
                &["version".to_string()],
            )
            .await?;
        if !out.success() {
            tracing::warn!(output = %out.summary(), "sing-box version failed");
            return Ok(None);
        }
        Ok(parse_version(&out.stdout))
    }

    /// Download, verify sha256, and install the requested version. Skips the
    /// work when the installed version already matches. Network errors are
    /// retryable; checksum/install errors are fatal.
    pub async fn ensure_binary(
        &self,
        want: &SingBoxDesired,
        download_dir: &Path,
    ) -> Result<(), ApplyError> {
        let want_version = want.version.trim_start_matches('v');
        match self.installed_version().await {
            Ok(Some(version)) if version == want_version => {
                tracing::debug!(version = want_version, "sing-box already installed");
                return Ok(());
            }
            Ok(_) => {}
            Err(e) => {
                return Err(ApplyError::fatal(format!(
                    "read installed sing-box version: {e}"
                )))
            }
        }
        self.host
            .create_dir_all(download_dir)
            .await
            .map_err(|e| ApplyError::retryable(format!("create download dir: {e}")))?;
        let archive = download_dir.join(format!("sing-box-{want_version}.download"));
        tracing::info!(version = want_version, url = %want.url, "downloading sing-box");
        self.host
            .download(&want.url, &archive)
            .await
            .map_err(|e| ApplyError::retryable(format!("download sing-box: {e}")))?;

        let got = self
            .host
            .sha256_file(&archive)
            .await
            .map_err(|e| ApplyError::fatal(format!("hash downloaded archive: {e}")))?;
        if !got.eq_ignore_ascii_case(want.sha256.trim()) {
            let _ = self.host.remove(&archive).await;
            return Err(ApplyError::fatal(format!(
                "sha256 mismatch for {}: got {got}, expected {}",
                want.url, want.sha256
            )));
        }
        tracing::debug!(sha256 = %got, "sing-box download verified");

        let bytes = self
            .host
            .read(&archive)
            .await
            .map_err(|e| ApplyError::fatal(format!("read downloaded archive: {e}")))?
            .unwrap_or_default();
        if bytes.starts_with(&[0x1f, 0x8b]) {
            self.install_from_targz(&archive, download_dir, want_version)
                .await
                .map_err(|e| ApplyError::fatal(e.to_string()))?;
        } else if bytes.starts_with(b"\x7fELF") {
            self.install_file(&archive)
                .await
                .map_err(|e| ApplyError::fatal(e.to_string()))?;
        } else {
            return Err(ApplyError::fatal(format!(
                "downloaded artifact is neither gzip nor ELF (first bytes: {})",
                bytes
                    .iter()
                    .take(4)
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            )));
        }

        let installed = self
            .installed_version()
            .await
            .map_err(|e| ApplyError::fatal(format!("verify installed version: {e}")))?;
        if installed.as_deref() != Some(want_version) {
            return Err(ApplyError::fatal(format!(
                "installed sing-box version is {:?}, expected {want_version}",
                installed
            )));
        }
        let _ = self.host.remove(&archive).await;
        Ok(())
    }

    async fn install_from_targz(
        &self,
        archive: &Path,
        download_dir: &Path,
        version: &str,
    ) -> Result<()> {
        let list = self
            .host
            .run(
                &self.cfg.tar,
                &[
                    "-tzf".to_string(),
                    archive.to_string_lossy().into_owned(),
                ],
            )
            .await?;
        if !list.success() {
            anyhow::bail!(
                "tar -tzf failed: {}",
                crate::logging::truncate(&crate::logging::redact_sensitive(&list.summary()), 300)
            );
        }
        let entry = list
            .stdout
            .lines()
            .map(str::trim)
            .find(|line| !line.ends_with('/') && line.rsplit('/').next() == Some("sing-box"))
            .ok_or_else(|| anyhow::anyhow!("archive has no sing-box binary"))?
            .to_string();
        tracing::debug!(entry, "extracting sing-box");

        let extract_dir = download_dir.join(format!("extract-{version}"));
        self.host.create_dir_all(&extract_dir).await?;
        let extract = self
            .host
            .run(
                &self.cfg.tar,
                &[
                    "-xzf".to_string(),
                    archive.to_string_lossy().into_owned(),
                    "-C".to_string(),
                    extract_dir.to_string_lossy().into_owned(),
                    entry.clone(),
                ],
            )
            .await?;
        if !extract.success() {
            anyhow::bail!(
                "tar -xzf failed: {}",
                crate::logging::truncate(&crate::logging::redact_sensitive(&extract.summary()), 300)
            );
        }
        self.install_file(&extract_dir.join(entry)).await?;
        Ok(())
    }

    async fn install_file(&self, source: &Path) -> Result<()> {
        let out = self
            .host
            .run(
                &self.cfg.install,
                &[
                    "-m".to_string(),
                    "0755".to_string(),
                    source.to_string_lossy().into_owned(),
                    self.cfg.binary_path.to_string_lossy().into_owned(),
                ],
            )
            .await?;
        if !out.success() {
            anyhow::bail!(
                "install failed: {}",
                crate::logging::truncate(&crate::logging::redact_sensitive(&out.summary()), 300)
            );
        }
        Ok(())
    }

    /// Current port/password read back from config.json.
    pub async fn applied(&self) -> Result<Option<AppliedConfig>> {
        let Some(bytes) = self.host.read(&self.cfg.config_path).await? else {
            return Ok(None);
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            tracing::warn!(path = %self.cfg.config_path.display(), "config is not valid JSON");
            return Ok(None);
        };
        let Some(inbound) = value
            .get("inbounds")
            .and_then(|v| v.as_array())
            .and_then(|inbounds| {
                inbounds
                    .iter()
                    .find(|i| i.get("type").and_then(|t| t.as_str()) == Some("shadowsocks"))
            })
        else {
            return Ok(None);
        };
        let Some(port) = inbound
            .get("listen_port")
            .and_then(|v| v.as_u64())
            .and_then(|p| u16::try_from(p).ok())
        else {
            return Ok(None);
        };
        let Some(password) = inbound.get("password").and_then(|v| v.as_str()) else {
            return Ok(None);
        };
        Ok(Some(AppliedConfig {
            port,
            password: password.to_string(),
        }))
    }

    /// Write config (checked first), install the unit, enable + restart, wait
    /// for `systemctl is-active`. Any failure rolls back the previous config.
    pub async fn apply(&self, port: u16, password: &str) -> Result<(), ApplyError> {
        let old_config = self
            .host
            .read(&self.cfg.config_path)
            .await
            .map_err(|e| ApplyError::fatal(e.to_string()))?;
        let rendered = render_config(port, password, &self.cfg.method);
        let tmp = self.cfg.config_path.with_extension("json.tmp");

        self.host
            .write(&tmp, rendered.as_bytes(), 0o600)
            .await
            .map_err(|e| ApplyError::fatal(format!("write temp config: {e}")))?;

        let check = self
            .host
            .run(
                &self.cfg.binary_path.to_string_lossy(),
                &[
                    "check".to_string(),
                    "-c".to_string(),
                    tmp.to_string_lossy().into_owned(),
                ],
            )
            .await
            .map_err(|e| ApplyError::fatal(format!("run sing-box check: {e}")))?;
        if !check.success() {
            let _ = self.host.remove(&tmp).await;
            return Err(ApplyError::fatal(format!(
                "sing-box check failed: {}",
                crate::logging::truncate(
                    &crate::logging::redact_sensitive(&check.summary()),
                    300
                )
            )));
        }

        self.host
            .rename(&tmp, &self.cfg.config_path)
            .await
            .map_err(|e| ApplyError::fatal(format!("replace config: {e}")))?;

        let unit = render_unit(&self.cfg);
        if let Err(e) = self
            .host
            .write(&self.cfg.unit_path, unit.as_bytes(), 0o644)
            .await
        {
            self.rollback(old_config).await;
            return Err(ApplyError::fatal(format!("write unit: {e}")));
        }

        for (args, fatal) in [
            (vec!["daemon-reload"], true),
            (vec!["enable", self.cfg.unit_name.as_str()], true),
            (vec!["restart", self.cfg.unit_name.as_str()], false),
        ] {
            let args: Vec<String> = args.into_iter().map(str::to_string).collect();
            let out = self
                .host
                .run(&self.cfg.systemctl, &args)
                .await
                .map_err(|e| ApplyError::fatal(format!("systemctl {}: {e}", args.join(" "))))?;
            if !out.success() {
                let err = if fatal {
                    ApplyError::fatal(format!(
                        "systemctl {} failed: {}",
                        args.join(" "),
                        crate::logging::truncate(
                            &crate::logging::redact_sensitive(&out.summary()),
                            300
                        )
                    ))
                } else {
                    ApplyError::retryable(format!(
                        "systemctl {} failed: {}",
                        args.join(" "),
                        crate::logging::truncate(
                            &crate::logging::redact_sensitive(&out.summary()),
                            300
                        )
                    ))
                };
                self.rollback(old_config).await;
                return Err(err);
            }
        }

        if let Err(e) = self.wait_active().await {
            self.rollback(old_config).await;
            return Err(e);
        }
        tracing::info!(port, "sing-box restarted");
        Ok(())
    }

    async fn rollback(&self, old_config: Option<Vec<u8>>) {
        tracing::warn!("rolling back sing-box config");
        match old_config {
            Some(bytes) => {
                if let Err(e) = self.host.write(&self.cfg.config_path, &bytes, 0o600).await {
                    tracing::error!(error = %e, "rollback write failed");
                }
            }
            None => {
                let _ = self.host.remove(&self.cfg.config_path).await;
            }
        }
        let _ = self
            .host
            .run(
                &self.cfg.systemctl,
                &["restart".to_string(), self.cfg.unit_name.clone()],
            )
            .await;
    }

    async fn wait_active(&self) -> Result<(), ApplyError> {
        for _ in 0..15 {
            let out = self
                .host
                .run(
                    &self.cfg.systemctl,
                    &[
                        "is-active".to_string(),
                        "--quiet".to_string(),
                        self.cfg.unit_name.clone(),
                    ],
                )
                .await
                .map_err(|e| ApplyError::retryable(format!("systemctl is-active: {e}")))?;
            if out.success() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        let logs = self
            .host
            .run(
                &self.cfg.journalctl,
                &[
                    "-u".to_string(),
                    self.cfg.unit_name.clone(),
                    "-n".to_string(),
                    "20".to_string(),
                    "--no-pager".to_string(),
                    "-o".to_string(),
                    "cat".to_string(),
                ],
            )
            .await
            .map(|o| o.summary())
            .unwrap_or_else(|e| e.to_string());
        Err(ApplyError::retryable(format!(
            "sing-box did not become active: {}",
            crate::logging::truncate(&crate::logging::redact_sensitive(&logs), 400)
        )))
    }

    /// Local listener + one outbound TCP probe. The outbound probe proves the
    /// host still has egress after the restart; it is not a through-tunnel
    /// check (that needs a local SS client and is deferred).
    pub async fn verify(&self, port: u16, egress_probe: SocketAddr) -> Result<(), ApplyError> {
        let local = SocketAddr::from(([127, 0, 0, 1], port));
        let mut last = String::new();
        for _ in 0..50 {
            match self.host.connect(local, Duration::from_secs(1)).await {
                Ok(()) => {
                    last.clear();
                    break;
                }
                Err(e) => {
                    last = e.to_string();
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
        if !last.is_empty() {
            return Err(ApplyError::retryable(format!(
                "sing-box is not listening on {port}: {last}"
            )));
        }

        let mut egress_err = String::new();
        for _ in 0..2 {
            match self
                .host
                .connect(egress_probe, Duration::from_secs(5))
                .await
            {
                Ok(()) => {
                    tracing::debug!(port, probe = %egress_probe, "local listener + egress probe passed");
                    return Ok(());
                }
                Err(e) => {
                    egress_err = e.to_string();
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
        Err(ApplyError::retryable(format!(
            "egress probe to {egress_probe} failed: {egress_err}"
        )))
    }
}

pub fn parse_version(stdout: &str) -> Option<String> {
    let tokens: Vec<&str> = stdout.split_whitespace().collect();
    tokens
        .windows(2)
        .find(|w| w[0].eq_ignore_ascii_case("version"))
        .map(|w| w[1].trim_start_matches('v').to_string())
        .or_else(|| tokens.get(1).map(|t| t.trim_start_matches('v').to_string()))
}

pub fn render_config(port: u16, password: &str, method: &str) -> String {
    let value = json!({
        "log": { "level": "info" },
        "inbounds": [
            {
                "type": "shadowsocks",
                "listen": "0.0.0.0",
                "listen_port": port,
                "method": method,
                "password": password
            }
        ],
        "outbounds": [{ "type": "direct" }]
    });
    serde_json::to_string_pretty(&value).expect("config serializes")
}

pub fn render_unit(cfg: &SingBoxConfig) -> String {
    format!(
        "[Unit]\n\
         Description=sing-box service\n\
         After=network.target nss-lookup.target network-online.target\n\
         \n\
         [Service]\n\
         CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE\n\
         AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE\n\
         ExecStart={} run -c {}\n\
         Restart=on-failure\n\
         RestartSec=10s\n\
         LimitNOFILE=infinity\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n",
        cfg.binary_path.display(),
        cfg.config_path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::FakeHost;
    use std::path::PathBuf;

    fn cfg() -> SingBoxConfig {
        SingBoxConfig {
            binary_path: PathBuf::from("/usr/local/bin/sing-box"),
            config_path: PathBuf::from("/etc/sing-box/config.json"),
            unit_path: PathBuf::from("/etc/systemd/system/sing-box.service"),
            ..SingBoxConfig::default()
        }
    }

    #[test]
    fn config_is_valid_shadowsocks_json() {
        let text = render_config(30412, "deadbeef", "aes-256-gcm");
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let inbound = &v["inbounds"][0];
        assert_eq!(inbound["type"], "shadowsocks");
        assert_eq!(inbound["listen"], "0.0.0.0");
        assert_eq!(inbound["listen_port"], 30412);
        assert_eq!(inbound["method"], "aes-256-gcm");
        assert_eq!(inbound["password"], "deadbeef");
        assert_eq!(v["outbounds"][0]["type"], "direct");
    }

    #[test]
    fn unit_points_at_the_installed_binary_and_config() {
        let unit = render_unit(&cfg());
        assert!(unit.contains("ExecStart=/usr/local/bin/sing-box run -c /etc/sing-box/config.json"));
        assert!(unit.contains("WantedBy=multi-user.target"));
    }

    #[test]
    fn version_parsing_handles_v_prefix() {
        assert_eq!(
            parse_version("sing-box version 1.14.4\n"),
            Some("1.14.4".into())
        );
        assert_eq!(parse_version("sing-box version v1.14.4"), Some("1.14.4".into()));
        assert_eq!(parse_version(""), None);
    }

    #[tokio::test]
    async fn sha_mismatch_never_installs() {
        let host = Arc::new(FakeHost::new());
        host.set_download(b"not-the-real-artifact".to_vec());
        host.set_hash("0000");
        let sb = SingBox::new(cfg(), host.clone());
        let want = SingBoxDesired {
            version: "1.14.4".into(),
            sha256: "ffff".into(),
            url: "https://example.com/sb.tar.gz".into(),
        };
        let err = sb.ensure_binary(&want, Path::new("/tmp/dl")).await.unwrap_err();
        assert!(err.to_string().contains("sha256 mismatch"));
        assert!(!host
            .commands()
            .iter()
            .any(|(p, _)| p == "install"));
    }

    #[tokio::test]
    async fn config_check_failure_is_fatal_and_skips_restart() {
        let host = Arc::new(FakeHost::new());
        host.set_command_output("/usr/local/bin/sing-box", 1, "", "bad config");
        let sb = SingBox::new(cfg(), host.clone());
        let err = sb.apply(30412, "secret").await.unwrap_err();
        assert_eq!(err.kind, ApplyErrorKind::Fatal);
        assert!(err.message.contains("sing-box check failed"));
        assert!(!host
            .commands()
            .iter()
            .any(|(p, args)| p == "systemctl" && args.iter().any(|a| a == "restart")));
    }

    #[tokio::test]
    async fn applied_reads_port_and_password_back() {
        let host = Arc::new(FakeHost::new());
        host.put_file(
            Path::new("/etc/sing-box/config.json"),
            render_config(30555, "pw", "aes-256-gcm").into_bytes(),
        );
        let sb = SingBox::new(cfg(), host);
        let applied = sb.applied().await.unwrap().unwrap();
        assert_eq!(applied.port, 30555);
        assert_eq!(applied.password, "pw");
    }
}
