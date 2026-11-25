//! sing-box install + config + systemd lifecycle.
//!
//! Ported from the cloud-init script (`cloudflare/control-plane/src/cloud_init.ts`)
//! so the agent produces exactly the same layout the existing machines have:
//! binary in `/usr/local/bin`, config in `/usr/local/etc/sing-box/config.json`,
//! unit `sing-box.service`, method `aes-256-gcm`.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
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

/// Map a host error to ApplyError: a stuck command is retryable, everything
/// else (bad path, non-zero exit) is fatal.
fn from_host(err: anyhow::Error, context: &str) -> ApplyError {
    let message = format!(
        "{context}: {}",
        crate::logging::redact_sensitive(&err.to_string())
    );
    if crate::host::is_timeout(&err) {
        ApplyError::retryable(message)
    } else {
        ApplyError::fatal(message)
    }
}

/// `^[0-9A-Za-z._-]{1,32}$`, minus the strings that would traverse a path.
pub fn is_safe_singbox_version(version: &str) -> bool {
    let v = version;
    !v.is_empty()
        && v.len() <= 32
        && !v.contains("..")
        && v != "."
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// `<dir>/<name>.tmp`: a sibling of the target, so the rename that installs it
/// is atomic and never crosses a filesystem.
fn temp_sibling(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    dest.with_file_name(name)
}

/// Reject a desired state that could escape the download dir or fetch over
/// plaintext before any host side effect happens.
fn validate_desired(want: &SingBoxDesired) -> Result<(), ApplyError> {
    if !is_safe_singbox_version(&want.version) {
        return Err(ApplyError::fatal(format!(
            "unsafe sing-box version {:?}",
            want.version
        )));
    }
    if !is_sha256_hex(want.sha256.trim()) {
        return Err(ApplyError::fatal("desired sing-box sha256 is not 64 hex chars"));
    }
    let url = want.url.trim();
    if !url.starts_with("https://") {
        return Err(ApplyError::fatal(
            "desired sing-box URL must be https://",
        ));
    }
    Ok(())
}

/// `tar -tvzf` line -> (type char, name). GNU and BSD both print
/// `perm links owner size date time name`; the name may contain spaces.
fn parse_tar_verbose(line: &str) -> Option<(char, String)> {
    let kind = line.chars().next()?;
    let bytes = line.as_bytes();
    let mut pos = 0;
    for _ in 0..5 {
        while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        while pos < bytes.len() && !bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
    }
    while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    if pos >= bytes.len() {
        return None;
    }
    Some((kind, line[pos..].to_string()))
}

/// Absolute paths, `..` components and backslashes are rejected; only plain
/// relative paths inside the archive are extracted.
fn validate_tar_entry(name: &str) -> Result<()> {
    if name.is_empty() {
        anyhow::bail!("archive contains an empty entry name");
    }
    if name.starts_with('/') {
        anyhow::bail!("archive entry {name:?} is an absolute path");
    }
    if name.contains('\\') {
        anyhow::bail!("archive entry {name:?} contains a backslash");
    }
    if name.split('/').any(|component| component == "..") {
        anyhow::bail!("archive entry {name:?} traverses out of the extraction dir");
    }
    Ok(())
}

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
        validate_desired(want)?;
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
        tracing::info!(
            sha256 = %&got[..got.len().min(8)],
            version = want_version,
            "sing-box archive sha256 verified"
        );

        let bytes = self
            .host
            .read(&archive)
            .await
            .map_err(|e| ApplyError::fatal(format!("read downloaded archive: {e}")))?
            .unwrap_or_default();
        if bytes.starts_with(&[0x1f, 0x8b]) {
            self.install_from_targz(&archive, download_dir, want_version)
                .await
                .map_err(|e| from_host(e, "unpack sing-box"))?;
        } else if bytes.starts_with(b"\x7fELF") {
            self.install_file(&archive)
                .await
                .map_err(|e| from_host(e, "install sing-box"))?;
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
        // Verbose listing carries the entry type, so a symlink cannot be
        // extracted as if it were the binary.
        let list = self
            .host
            .run(
                &self.cfg.tar,
                &[
                    "-tvzf".to_string(),
                    archive.to_string_lossy().into_owned(),
                ],
            )
            .await?;
        if !list.success() {
            anyhow::bail!(
                "tar -tvzf failed: {}",
                crate::logging::truncate(&crate::logging::redact_sensitive(&list.summary()), 300)
            );
        }

        let mut entry: Option<String> = None;
        for line in list.stdout.lines() {
            let Some((kind, name)) = parse_tar_verbose(line) else {
                continue;
            };
            validate_tar_entry(&name)?;
            let basename = name.rsplit('/').next().unwrap_or(&name);
            if basename != "sing-box" {
                continue;
            }
            if kind != '-' {
                anyhow::bail!("archive entry {name:?} is not a regular file");
            }
            if entry.is_none() {
                entry = Some(name.to_string());
            }
        }
        let entry = entry.ok_or_else(|| anyhow::anyhow!("archive has no sing-box binary"))?;
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

        // Belt and braces: even with validated entry names, confirm the
        // extracted path is still inside the temp dir (no symlink hop).
        let canon_dir = self.host.canonicalize(&extract_dir).await?;
        let extracted = extract_dir.join(&entry);
        let canon_file = self.host.canonicalize(&extracted).await?;
        anyhow::ensure!(
            canon_file.starts_with(&canon_dir),
            "extracted {entry:?} resolved outside the extraction dir"
        );
        anyhow::ensure!(
            self.host.is_file(&canon_file).await?,
            "extracted {entry:?} is not a regular file"
        );
        self.install_file(&canon_file).await?;
        Ok(())
    }

    async fn install_file(&self, source: &Path) -> Result<()> {
        self.install_path(source, &self.cfg.binary_path).await
    }

    /// Put `source` at `dest` atomically: `install` into a sibling temp file,
    /// then rename it over the target. Writing the target directly fails with
    /// ETXTBSY while the old binary is running, and `install` removing it first
    /// would leave a window with no binary on disk at all.
    async fn install_path(&self, source: &Path, dest: &Path) -> Result<()> {
        let tmp = temp_sibling(dest);
        let out = self
            .host
            .run(
                &self.cfg.install,
                &[
                    "-m".to_string(),
                    "0755".to_string(),
                    source.to_string_lossy().into_owned(),
                    tmp.to_string_lossy().into_owned(),
                ],
            )
            .await?;
        if !out.success() {
            let _ = self.host.remove(&tmp).await;
            anyhow::bail!(
                "install failed: {}",
                crate::logging::truncate(&crate::logging::redact_sensitive(&out.summary()), 300)
            );
        }
        if let Err(e) = self.host.rename(&tmp, dest).await {
            let _ = self.host.remove(&tmp).await;
            anyhow::bail!("replace {}: {e}", dest.display());
        }
        Ok(())
    }

    /// Copy the installed binary next to itself so a failed upgrade can put the
    /// previous version back. `None` when there is no binary yet: a fresh
    /// install has nothing to roll back to.
    ///
    /// An existing `.bak` is reused and never overwritten: it is the last known
    /// good binary, and the installed one may be exactly the version that just
    /// failed.
    pub async fn backup_binary(&self) -> Result<Option<PathBuf>, ApplyError> {
        let backup = self.binary_backup_path();
        if self
            .host
            .is_file(&backup)
            .await
            .map_err(|e| ApplyError::fatal(format!("look for the sing-box backup: {e}")))?
        {
            tracing::info!(backup = %backup.display(), "reusing the existing sing-box backup");
            return Ok(Some(backup));
        }
        if !self
            .host
            .is_file(&self.cfg.binary_path)
            .await
            .map_err(|e| ApplyError::fatal(format!("look for the sing-box binary: {e}")))?
        {
            return Ok(None);
        }
        self.install_path(&self.cfg.binary_path, &backup)
            .await
            .map_err(|e| from_host(e, "back up the installed sing-box"))?;
        Ok(Some(backup))
    }

    /// Put a backup taken by `backup_binary` back where the unit expects it.
    /// The caller restarts the unit afterwards.
    pub async fn restore_binary(&self, backup: &Path) -> Result<(), ApplyError> {
        self.install_path(backup, &self.cfg.binary_path)
            .await
            .map_err(|e| from_host(e, "restore the previous sing-box"))?;
        Ok(())
    }

    pub async fn discard_binary_backup(&self, backup: &Path) {
        let _ = self.host.remove(backup).await;
    }

    fn binary_backup_path(&self) -> PathBuf {
        self.cfg.binary_path.with_extension("bak")
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

    /// `systemctl is-active --quiet`: cheap liveness probe for the poll loop.
    pub async fn is_active(&self) -> Result<bool> {
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
            .await?;
        Ok(out.success())
    }

    /// Restart the unit and wait until it reports active.
    pub async fn restart(&self) -> Result<(), ApplyError> {
        let out = self
            .host
            .run(
                &self.cfg.systemctl,
                &["restart".to_string(), self.cfg.unit_name.clone()],
            )
            .await
            .map_err(|e| from_host(e, "systemctl restart"))?;
        if !out.success() {
            return Err(ApplyError::retryable(format!(
                "systemctl restart failed: {}",
                crate::logging::truncate(
                    &crate::logging::redact_sensitive(&out.summary()),
                    300
                )
            )));
        }
        self.wait_active().await
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
            .map_err(|e| from_host(e, "run sing-box check"))?;
        if !check.success() {
            let _ = self.host.remove(&tmp).await;
            tracing::warn!(
                output = %crate::logging::truncate(&crate::logging::redact_sensitive(&check.summary()), 300),
                "sing-box config check failed"
            );
            return Err(ApplyError::fatal(format!(
                "sing-box check failed: {}",
                crate::logging::truncate(
                    &crate::logging::redact_sensitive(&check.summary()),
                    300
                )
            )));
        }
        tracing::info!(
            output = %crate::logging::truncate(&crate::logging::redact_sensitive(&check.summary()), 200),
            "sing-box config check passed"
        );

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
                .map_err(|e| from_host(e, &format!("systemctl {}", args.join(" "))))?;
            tracing::info!(
                command = %format!("systemctl {}", args.join(" ")),
                ok = out.success(),
                "systemctl step"
            );
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
        for attempt in 1..=15 {
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
                tracing::info!(unit = %self.cfg.unit_name, attempt, "sing-box is active");
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
        tracing::info!(port, "sing-box is listening locally");

        let mut egress_err = String::new();
        for _ in 0..2 {
            match self
                .host
                .connect(egress_probe, Duration::from_secs(5))
                .await
            {
                Ok(()) => {
                    tracing::info!(
                        port,
                        egress = %egress_probe,
                        "liveness check passed (listener + egress)"
                    );
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
            sha256: "f".repeat(64),
            url: "https://example.com/sb.tar.gz".into(),
        };
        let err = sb.ensure_binary(&want, Path::new("/tmp/dl")).await.unwrap_err();
        assert!(err.to_string().contains("sha256 mismatch"));
        assert!(!host
            .commands()
            .iter()
            .any(|(p, _)| p == "install"));
    }

    #[test]
    fn version_whitelist_rejects_traversal_and_odd_characters() {
        assert!(is_safe_singbox_version("1.14.4"));
        assert!(is_safe_singbox_version("v1.14.4-beta_1"));
        assert!(!is_safe_singbox_version(".."));
        assert!(!is_safe_singbox_version("1.14/../x"));
        assert!(!is_safe_singbox_version("a b"));
        assert!(!is_safe_singbox_version("1.14.4\n"));
        assert!(!is_safe_singbox_version(&"1".repeat(33)));
        assert!(!is_safe_singbox_version(""));
    }

    #[tokio::test]
    async fn an_unsafe_desired_state_never_downloads() {
        let host = Arc::new(FakeHost::new());
        let sb = SingBox::new(cfg(), host.clone());
        for want in [
            SingBoxDesired {
                version: "../../etc".into(),
                sha256: "f".repeat(64),
                url: "https://example.com/sb.tar.gz".into(),
            },
            SingBoxDesired {
                version: "1.14.4".into(),
                sha256: "not-hex".into(),
                url: "https://example.com/sb.tar.gz".into(),
            },
            SingBoxDesired {
                version: "1.14.4".into(),
                sha256: "f".repeat(64),
                url: "http://example.com/sb.tar.gz".into(),
            },
        ] {
            let err = sb.ensure_binary(&want, Path::new("/tmp/dl")).await.unwrap_err();
            assert_eq!(err.kind, ApplyErrorKind::Fatal, "{err:?}");
        }
        assert!(host.commands().is_empty(), "no command may run for a bad desired state");
    }

    fn gzip_bytes() -> Vec<u8> {
        vec![0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]
    }

    #[tokio::test]
    async fn tar_entries_with_traversal_are_rejected() {
        let host = Arc::new(FakeHost::new());
        host.set_download(gzip_bytes());
        host.set_hash(&"f".repeat(64));
        host.set_command_output(
            "tar",
            0,
            "-rwxr-xr-x 0/0 3 2024-01-01 00:00 ../sing-box\n",
            "",
        );
        let sb = SingBox::new(cfg(), host.clone());
        let want = SingBoxDesired {
            version: "1.14.4".into(),
            sha256: "f".repeat(64),
            url: "https://example.com/sb.tar.gz".into(),
        };
        let err = sb.ensure_binary(&want, Path::new("/tmp/dl")).await.unwrap_err();
        assert!(err.to_string().contains("traverses"), "{err}");
        assert!(!host.commands().iter().any(|(p, _)| p == "install"));
    }

    #[tokio::test]
    async fn a_symlinked_binary_entry_is_rejected() {
        let host = Arc::new(FakeHost::new());
        host.set_download(gzip_bytes());
        host.set_hash(&"f".repeat(64));
        host.set_command_output(
            "tar",
            0,
            "lrwxrwxrwx 0/0 7 2024-01-01 00:00 bin/sing-box\n",
            "",
        );
        let sb = SingBox::new(cfg(), host.clone());
        let want = SingBoxDesired {
            version: "1.14.4".into(),
            sha256: "f".repeat(64),
            url: "https://example.com/sb.tar.gz".into(),
        };
        let err = sb.ensure_binary(&want, Path::new("/tmp/dl")).await.unwrap_err();
        assert!(err.to_string().contains("not a regular file"), "{err}");
    }

    #[test]
    fn tar_verbose_lines_expose_type_and_name() {
        let (kind, name) =
            parse_tar_verbose("-rwxr-xr-x 0/0 12345 2024-01-01 12:34 sing-box-1.14.4-linux-amd64/sing-box")
                .unwrap();
        assert_eq!(kind, '-');
        assert_eq!(name, "sing-box-1.14.4-linux-amd64/sing-box");
        assert!(validate_tar_entry("/etc/passwd").is_err());
        assert!(validate_tar_entry("a\\b").is_err());
        assert!(validate_tar_entry("ok/sing-box").is_ok());
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
