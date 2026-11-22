//! Agent configuration file. Loaded from `--config`; every path is explicit so
//! the same binary can run in dev with temp directories and in production with
//! `/usr/local` + `/var/lib/veyl-agent`.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

fn default_control_bind() -> String {
    "0.0.0.0".into()
}

fn default_control_port() -> u16 {
    32100
}

fn default_cert_dir() -> PathBuf {
    PathBuf::from("/var/lib/veyl-agent/certs")
}

fn default_state_dir() -> PathBuf {
    PathBuf::from("/var/lib/veyl-agent")
}

fn default_download_dir() -> PathBuf {
    PathBuf::from("/var/lib/veyl-agent/downloads")
}

fn default_band() -> [u16; 2] {
    [30000, 30999]
}

fn default_recent_ports_keep() -> usize {
    20
}

fn default_poll_interval_secs() -> u64 {
    30
}

fn default_egress_probe() -> String {
    "1.1.1.1:443".into()
}

fn default_log_level() -> String {
    "info".into()
}

fn default_log_file() -> Option<PathBuf> {
    Some(PathBuf::from("/var/log/veyl-agent/agent.log"))
}

fn default_log_max_bytes() -> u64 {
    5 * 1024 * 1024
}

fn default_log_keep_files() -> usize {
    3
}

/// On-disk log sink for console troubleshooting. Every key has a default so
/// the existing cloud-init config (`control_url` / `enroll_url` /
/// `enroll_token` only) keeps starting unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogConfig {
    /// Log file path; `null` disables file logging.
    #[serde(default = "default_log_file")]
    pub file: Option<PathBuf>,
    /// Rotate when the current file would exceed this size.
    #[serde(default = "default_log_max_bytes")]
    pub max_bytes: u64,
    /// Number of rotated backups to keep (`agent.log.1` … `agent.log.N`).
    #[serde(default = "default_log_keep_files")]
    pub keep_files: usize,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            file: default_log_file(),
            max_bytes: default_log_max_bytes(),
            keep_files: default_log_keep_files(),
        }
    }
}

fn default_sb_binary() -> PathBuf {
    PathBuf::from("/usr/local/bin/sing-box")
}

fn default_sb_config() -> PathBuf {
    PathBuf::from("/usr/local/etc/sing-box/config.json")
}

fn default_unit_name() -> String {
    "sing-box".into()
}

fn default_unit_path() -> PathBuf {
    PathBuf::from("/etc/systemd/system/sing-box.service")
}

fn default_systemctl() -> String {
    "systemctl".into()
}

fn default_tar() -> String {
    "tar".into()
}

fn default_install() -> String {
    "install".into()
}

fn default_journalctl() -> String {
    "journalctl".into()
}

fn default_ss_method() -> String {
    "aes-256-gcm".into()
}

fn default_true() -> bool {
    true
}

fn default_metadata_url() -> String {
    "http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingBoxConfig {
    #[serde(default = "default_sb_binary")]
    pub binary_path: PathBuf,
    #[serde(default = "default_sb_config")]
    pub config_path: PathBuf,
    #[serde(default = "default_unit_name")]
    pub unit_name: String,
    #[serde(default = "default_unit_path")]
    pub unit_path: PathBuf,
    #[serde(default = "default_systemctl")]
    pub systemctl: String,
    #[serde(default = "default_tar")]
    pub tar: String,
    #[serde(default = "default_install")]
    pub install: String,
    #[serde(default = "default_journalctl")]
    pub journalctl: String,
    /// Shadowsocks 加密方式，与现有 cloud-init 生成的一致。
    #[serde(default = "default_ss_method")]
    pub method: String,
}

impl Default for SingBoxConfig {
    fn default() -> Self {
        Self {
            binary_path: default_sb_binary(),
            config_path: default_sb_config(),
            unit_name: default_unit_name(),
            unit_path: default_unit_path(),
            systemctl: default_systemctl(),
            tar: default_tar(),
            install: default_install(),
            journalctl: default_journalctl(),
            method: default_ss_method(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Control-plane base URL. cloud-init writes it as `control_url`.
    #[serde(alias = "control_url")]
    pub control_plane_url: String,
    /// One-time token written by cloud-init (`enroll_token`). Only used until
    /// enrollment succeeds.
    #[serde(default, alias = "enroll_token")]
    pub enrollment_token: Option<String>,
    /// Full enroll URL. cloud-init writes it; when present it is used verbatim.
    #[serde(default)]
    pub enroll_url: Option<String>,
    /// Control-plane Ed25519 public key (hex). Production gets the JWK from the
    /// enroll response instead; this is the fallback.
    #[serde(default)]
    pub signer_pubkey: Option<String>,
    /// Ask the droplet metadata service for the public IPv4 at startup so the
    /// leaf SAN and Host allow-list match the address the desktop uses.
    #[serde(default = "default_true")]
    pub detect_public_ip: bool,
    #[serde(default = "default_metadata_url")]
    pub metadata_url: String,
    #[serde(default = "default_control_bind")]
    pub control_bind: String,
    /// Fallback when the desired state cannot be fetched at startup.
    #[serde(default = "default_control_port")]
    pub control_port: u16,
    /// Extra `Host` values accepted by the MCP endpoint (the node's public IP).
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    /// Convenience: added to `allowed_hosts` when set.
    #[serde(default)]
    pub public_host: Option<String>,
    #[serde(default = "default_cert_dir")]
    pub cert_dir: PathBuf,
    #[serde(default = "default_state_dir")]
    pub state_dir: PathBuf,
    #[serde(default = "default_download_dir")]
    pub download_dir: PathBuf,
    #[serde(default)]
    pub singbox: SingBoxConfig,
    #[serde(default = "default_band")]
    pub port_band: [u16; 2],
    #[serde(default = "default_recent_ports_keep")]
    pub recent_ports_keep: usize,
    #[serde(default = "default_poll_interval_secs")]
    pub poll_interval_secs: u64,
    #[serde(default = "default_egress_probe")]
    pub egress_probe: String,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default)]
    pub log: LogConfig,
    /// Dev only: allow `http://` control-plane URLs. Production must be HTTPS.
    #[serde(default)]
    pub allow_insecure_control_plane: bool,
}

/// Plaintext control-plane URLs are a dev convenience. Release binaries
/// compile the escape hatch out; a config that sets it refuses to start.
pub fn insecure_control_plane_allowed() -> bool {
    cfg!(debug_assertions) || cfg!(feature = "dev")
}

/// `{:?}` never prints the enrollment token.
impl std::fmt::Debug for AgentConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentConfig")
            .field("control_plane_url", &self.control_plane_url)
            .field("enrollment_token", &self.enrollment_token.as_ref().map(|_| "***"))
            .field("enroll_url", &self.enroll_url)
            .field("signer_pubkey", &self.signer_pubkey)
            .field("detect_public_ip", &self.detect_public_ip)
            .field("control_bind", &self.control_bind)
            .field("control_port", &self.control_port)
            .field("public_host", &self.public_host)
            .field("allowed_hosts", &self.allowed_hosts)
            .field("cert_dir", &self.cert_dir)
            .field("state_dir", &self.state_dir)
            .field("log_level", &self.log_level)
            .field("log", &self.log)
            .field("allow_insecure_control_plane", &self.allow_insecure_control_plane)
            .finish_non_exhaustive()
    }
}

impl AgentConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("read config {}", path.display()))?;
        let cfg: Self = serde_json::from_str(&text)
            .with_context(|| format!("parse config {}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> Result<()> {
        self.validate_with_policy(insecure_control_plane_allowed())
    }

    /// `allow_insecure` is the build's policy; tests pass false to prove a
    /// release build refuses the dev escape hatch.
    pub fn validate_with_policy(&self, allow_insecure: bool) -> Result<()> {
        if self.allow_insecure_control_plane && !allow_insecure {
            bail!(
                "allow_insecure_control_plane is a dev-only option and is disabled in release builds"
            );
        }
        let insecure_ok = self.allow_insecure_control_plane && allow_insecure;
        let url = self.control_plane_url.trim();
        if !(url.starts_with("https://") || (insecure_ok && url.starts_with("http://"))) {
            bail!(
                "control_plane_url must be https:// (set allow_insecure_control_plane for dev only)"
            );
        }
        if let Some(enroll_url) = &self.enroll_url {
            if !(enroll_url.starts_with("https://")
                || (insecure_ok && enroll_url.starts_with("http://")))
            {
                bail!("enroll_url must be https://");
            }
        }
        let [lo, hi] = self.port_band;
        if !(1..=65535).contains(&lo) || !(1..=65535).contains(&hi) || lo >= hi {
            bail!("port_band must be [low, high] with 1 <= low < high <= 65535");
        }
        if (lo..=hi).contains(&self.control_port) {
            bail!("control_port {} must be outside the SS port band {lo}-{hi}", self.control_port);
        }
        if self.recent_ports_keep < 1 || usize::from(hi - lo + 1) <= self.recent_ports_keep {
            bail!(
                "recent_ports_keep must leave enough free ports in the band"
            );
        }
        if !(5..=3600).contains(&self.poll_interval_secs) {
            bail!("poll_interval_secs must be 5..=3600");
        }
        self.egress_probe
            .parse::<SocketAddr>()
            .with_context(|| format!("egress_probe must be host:port, got {}", self.egress_probe))?;
        self.control_bind
            .parse::<std::net::IpAddr>()
            .with_context(|| format!("control_bind must be an IP address, got {}", self.control_bind))?;
        if self.log.file.is_some() {
            if self.log.max_bytes < 4096 {
                bail!("log.max_bytes must be at least 4096");
            }
            if !(1..=50).contains(&self.log.keep_files) {
                bail!("log.keep_files must be 1..=50");
            }
        }
        Ok(())
    }

    pub fn state_path(&self) -> PathBuf {
        self.state_dir.join("state.json")
    }

    /// Hosts clients use to reach the control endpoint. Their SANs go into the
    /// leaf certificate; a missing public IP makes webpki reject the name even
    /// when the CA is trusted.
    pub fn tls_hosts(&self) -> Vec<String> {
        let mut hosts = Vec::new();
        if let Some(host) = &self.public_host {
            hosts.push(host.clone());
        }
        hosts.extend(self.allowed_hosts.iter().cloned());
        hosts
    }

    pub fn mcp_allowed_hosts(&self, control_port: u16) -> Vec<String> {
        let mut hosts = vec!["localhost".to_string(), "127.0.0.1".to_string(), "::1".to_string()];
        if let Some(host) = &self.public_host {
            hosts.push(host.clone());
            // A request to the public IP carries `Host: IP:port`.
            hosts.push(format!("{host}:{control_port}"));
        }
        for host in &self.allowed_hosts {
            hosts.push(host.clone());
        }
        let mut seen = std::collections::BTreeSet::new();
        hosts.retain(|h| !h.is_empty() && seen.insert(h.clone()));
        hosts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> AgentConfig {
        AgentConfig {
            control_plane_url: "https://control.example.com".into(),
            enrollment_token: None,
            enroll_url: None,
            signer_pubkey: None,
            detect_public_ip: true,
            metadata_url: default_metadata_url(),
            control_bind: default_control_bind(),
            control_port: default_control_port(),
            allowed_hosts: vec![],
            public_host: None,
            cert_dir: default_cert_dir(),
            state_dir: default_state_dir(),
            download_dir: default_download_dir(),
            singbox: SingBoxConfig::default(),
            port_band: default_band(),
            recent_ports_keep: default_recent_ports_keep(),
            poll_interval_secs: default_poll_interval_secs(),
            egress_probe: default_egress_probe(),
            log_level: default_log_level(),
            log: LogConfig::default(),
            allow_insecure_control_plane: false,
        }
    }

    #[test]
    fn https_is_required_by_default() {
        let mut cfg = base();
        cfg.control_plane_url = "http://control.example.com".into();
        assert!(cfg.validate().is_err());
        cfg.allow_insecure_control_plane = true;
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn control_port_must_be_outside_the_band() {
        let mut cfg = base();
        cfg.control_port = 30500;
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn allowed_hosts_include_localhost_and_public_ip() {
        let mut cfg = base();
        cfg.public_host = Some("203.0.113.7".into());
        cfg.allowed_hosts = vec!["node.example.com".into(), "127.0.0.1".into()];
        let hosts = cfg.mcp_allowed_hosts(32100);
        assert!(hosts.contains(&"localhost".to_string()));
        assert!(hosts.contains(&"203.0.113.7".to_string()));
        assert!(hosts.contains(&"203.0.113.7:32100".to_string()));
        assert!(hosts.contains(&"node.example.com".to_string()));
        assert_eq!(
            hosts.iter().filter(|h| h.as_str() == "127.0.0.1").count(),
            1
        );
    }

    #[test]
    fn parses_the_minimal_cloud_init_config() {
        let text = r#"{
            "control_url": "https://control.example.com",
            "enroll_url": "https://control.example.com/v1/agent/enroll",
            "enroll_token": "enr_abc"
        }"#;
        let cfg: AgentConfig = serde_json::from_str(text).unwrap();
        assert_eq!(cfg.control_plane_url, "https://control.example.com");
        assert_eq!(cfg.enrollment_token.as_deref(), Some("enr_abc"));
        assert_eq!(
            cfg.enroll_url.as_deref(),
            Some("https://control.example.com/v1/agent/enroll")
        );
        assert_eq!(cfg.control_port, 32100);
        assert_eq!(cfg.port_band, [30000, 30999]);
        assert_eq!(
            cfg.log.file.as_deref(),
            Some(std::path::Path::new("/var/log/veyl-agent/agent.log"))
        );
        assert_eq!(cfg.log.max_bytes, 5 * 1024 * 1024);
        assert_eq!(cfg.log.keep_files, 3);
        cfg.validate().unwrap();
    }

    #[test]
    fn release_build_refuses_the_insecure_escape_hatch() {
        let mut cfg = base();
        cfg.control_plane_url = "http://control.example.com".into();
        cfg.allow_insecure_control_plane = true;
        // Dev policy: allowed. Release policy: rejected outright, even if the
        // URL happens to be https.
        assert!(cfg.validate_with_policy(true).is_ok());
        assert!(cfg.validate_with_policy(false).is_err());
        cfg.control_plane_url = "https://control.example.com".into();
        assert!(cfg.validate_with_policy(false).is_err());
    }

    #[test]
    fn debug_output_hides_the_enrollment_token() {
        let mut cfg = base();
        cfg.enrollment_token = Some("enr_secret_value".into());
        let debug = format!("{cfg:?}");
        assert!(!debug.contains("enr_secret_value"));
        assert!(debug.contains("control.example.com"));
    }

    #[test]
    fn log_sink_can_be_disabled_and_has_defaults() {
        let text = r#"{
            "control_url": "https://control.example.com",
            "log": { "file": null }
        }"#;
        let cfg: AgentConfig = serde_json::from_str(text).unwrap();
        assert!(cfg.log.file.is_none());
        assert_eq!(cfg.log.keep_files, 3);
        cfg.validate().unwrap();
        // A bogus size is rejected only while the file sink is enabled.
        let text = r#"{
            "control_url": "https://control.example.com",
            "log": { "max_bytes": 1 }
        }"#;
        let cfg: AgentConfig = serde_json::from_str(text).unwrap();
        assert!(cfg.validate().is_err());
    }
}
