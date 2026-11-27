//! Production run loop: enroll → install/apply → serve MCP. The desired state
//! is fetched once at startup; after that, version upgrades happen only when the
//! desktop calls `upgrade_singbox` on the MCP endpoint.

use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use ed25519_dalek::VerifyingKey;
use tokio::time::MissedTickBehavior;

use crate::auth;
use crate::cert;
use crate::config::AgentConfig;
use crate::control::{ControlApi, ControlError, ControlPlane, ControlSession, DesiredState};
use crate::host::{Host, RealHost};
use crate::identity::Identity;
use crate::logging::{self, redact_sensitive, FileLogConfig};
use crate::rotation::{RotationEngine, Rotator};
use crate::singbox::SingBox;
use crate::state::{AgentState, StateStore, StoredDesired};
use crate::traffic::{self, TrafficMeter};
use crate::{start_agent_with_certs, AgentHandle};

/// Production builds compile the control plane's Ed25519 public key in.
const BUILTIN_SIGNER_PUBKEY: Option<&str> = option_env!("VEYL_AGENT_SIGNER_PUBKEY");

/// How long to wait before touching the control plane again after a 409.
const TERMINAL_BACKOFF: Duration = Duration::from_secs(600);

/// Readiness signal for cloud-init. With `Type=exec` the unit is "active" at
/// `execve`, before the metering probe has run, so cloud-init waits for this
/// file instead (see `cloud_init.ts`).
const READY_FILE: &str = "/run/veyl-agent/ready";

/// How often to retry the metadata-service IP probe when it failed at startup.
/// Converges on the first success and never talks to the control plane before.
const IP_RETRY_INTERVAL: Duration = Duration::from_secs(60);
/// The probe is not retried forever: after these attempts the operator has to
/// set `public_host` (or `allowed_hosts`) in the config.
const IP_RETRY_ATTEMPTS: usize = 3;

/// Bound for resending a frozen `rotated` report on the metering tick. It runs
/// only when a report is frozen, so an idle machine never talks to the control
/// plane on this path.
const ROTATION_FLUSH_BUDGET: Duration = Duration::from_secs(10);

enum DesiredFetch {
    Found(DesiredState),
    Unavailable,
    /// 409: the token is dead or the server was destroyed.
    Terminal(String),
}

fn is_terminal_control_error(err: &ControlError) -> bool {
    matches!(err, ControlError::Status { status: 409, .. })
}

/// The control plane puts the machine-readable cause in the body
/// (`destroyed`, `expired`, …); keep it verbatim in the log.
fn terminal_reason(err: &ControlError) -> String {
    match err {
        ControlError::Status { status, body } => format!(
            "HTTP {status}: {}",
            crate::logging::truncate(&redact_sensitive(body.trim()), 120)
        ),
        other => other.to_string(),
    }
}

pub async fn run(config_path: &Path, log_level_override: Option<String>) -> Result<()> {
    let mut cfg = AgentConfig::load(config_path)?;
    let log_file = logging::init(
        log_level_override
            .as_deref()
            .unwrap_or(cfg.log_level.as_str()),
        cfg.log.file.as_ref().map(|path| FileLogConfig {
            path: path.clone(),
            max_bytes: cfg.log.max_bytes,
            keep_files: cfg.log.keep_files,
        }),
    );

    // Load the persisted state first: the startup banner must say whether this
    // process is enrolling for the first time or resuming an existing node
    // (after a console password reset / reboot, that is the first thing to
    // check).
    let store = StateStore::new(cfg.state_path());
    let mut state = store.load_or_recover();
    let restored = state.server_id.is_some() && state.server_token.is_some();
    // Only builds an HTTP client; the metering probe needs it before enrollment.
    let host: Arc<dyn Host> = Arc::new(RealHost::new()?);
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        config = %config_path.display(),
        state_file = %cfg.state_path().display(),
        log_file = %log_file
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "disabled".to_string()),
        control_plane = %control_host(&cfg.control_plane_url),
        control_port = cfg.control_port,
        mode = if restored { "restored" } else { "cold" },
        persisted_desired = state.last_desired.is_some(),
        "veyl-agent starting"
    );

    // The desktop connects to `https://<public-ip>:32100`; the leaf SAN and the
    // MCP Host allow-list both need that address. cloud-init does not pass it,
    // so ask the droplet metadata service unless the config says otherwise.
    if cfg.public_host.is_none() && cfg.detect_public_ip {
        match detect_public_ip(&cfg.metadata_url).await {
            Some(ip) => cfg.public_host = Some(ip),
            None => tracing::warn!(
                "could not detect the public IP; set public_host in the config"
            ),
        }
    }

    // Identity owns the leaf/CA and the dynamic Host allow-list. If the public
    // IP is still unknown, it keeps the previous leaf SANs instead of dropping
    // the IP; the poll loop retries detection and re-signs.
    let identity = Arc::new(Identity::load(
        &cfg.cert_dir,
        &cfg.allowed_hosts,
        cfg.public_host.clone(),
    )?);
    let leaf_fp = identity.leaf_fingerprint();
    let ca_fp = cert::ca_fingerprint(&identity.certs().ca_cert)?;
    tracing::info!(ca_fingerprint = %ca_fp, leaf_fingerprint = %leaf_fp, "TLS identity ready");

    let plane = ControlPlane::new(&cfg.control_plane_url)?
        .with_enroll_url(cfg.enroll_url.clone())
        .with_fail_url(cfg.fail_url.clone());
    if state.cert_fingerprint.as_deref() != Some(leaf_fp.as_str()) {
        state.cert_fingerprint = Some(leaf_fp.clone());
        store.save(&state)?;
    }

    // A unit with `Type=exec` is active as soon as `execve` succeeds — long
    // before the probe answers — so cloud-init cannot use `is-active` to learn
    // whether this node can meter. `/run/veyl-agent/ready` is that signal.
    clear_ready(host.as_ref()).await;

    // Prove that metering works before enrolling: `/v1/agent/fail` only accepts
    // an unconsumed enrollment token, so a cold node that cannot read the
    // counter has to report before `ensure_identity` spends that token.
    //
    // A restored node is never failed this way: exiting would crash-loop it and
    // the desktop could no longer repair it, while under-counting is the safe
    // direction.
    match traffic::probe(host.as_ref()).await {
        Ok(_) => mark_ready(host.as_ref()).await,
        Err(e) if restored => tracing::error!(
            error = %e,
            "metering probe failed; continuing, this node will under-count traffic"
        ),
        Err(e) => {
            tracing::error!(error = %e, "metering probe failed; the build cannot meter");
            plane
                .report_install_failure(cfg.enrollment_token.as_deref(), e)
                .await;
            std::process::exit(1);
        }
    }

    let (server_id, server_token, enrolled_desired, token_public_key) =
        ensure_identity(&cfg, &plane, &mut state, &store).await?;
    let signer = resolve_signer_pubkey(&cfg, token_public_key.as_deref())?;
    tracing::info!(server_id = %server_id, "identity ready");

    let control: Arc<dyn ControlApi> =
        Arc::new(ControlSession::new(plane, server_token));
    // A 409 means the token is no longer valid for this server (consumed,
    // expired, or the server was destroyed). Nothing else can be done locally:
    // say what the operator has to do and serve whatever was persisted.
    let desired = match enrolled_desired {
        Some(desired) => Some(desired),
        None => match fetch_desired_with_retries(control.as_ref()).await {
            DesiredFetch::Found(desired) => Some(desired),
            DesiredFetch::Unavailable => {
                let fallback = state.last_desired.as_ref().map(StoredDesired::to_desired);
                if fallback.is_some() {
                    tracing::warn!(
                        "control plane unreachable; using the persisted desired state"
                    );
                }
                fallback
            }
            DesiredFetch::Terminal(message) => {
                tracing::error!(
                    status = 409,
                    reason = %message,
                    error = %message,
                    "control plane rejected the server token (expired or the server was destroyed); this node must be rebuilt"
                );
                let fallback = state.last_desired.as_ref().map(StoredDesired::to_desired);
                if fallback.is_some() {
                    tracing::warn!("serving the persisted desired state until the node is rebuilt");
                }
                fallback
            }
        },
    };

    // The desired state is authoritative for the control port. Reject a control
    // port inside the SS band (the shared firewall only opens 32100).
    let configured_control_port = cfg.control_port;
    let control_port = desired
        .as_ref()
        .map(|d| d.control_port)
        .unwrap_or(configured_control_port);
    if (cfg.port_band[0]..=cfg.port_band[1]).contains(&control_port) {
        tracing::error!(
            control_port,
            "desired control_port is inside the SS band; using configured port"
        );
    } else if control_port != configured_control_port {
        cfg.control_port = control_port;
    }
    if let Some(d) = &desired {
        tracing::info!(
            port = d.port,
            control_port = d.control_port,
            singbox_version = %d.singbox.version.trim_start_matches('v'),
            singbox_sha256 = %short_sha(&d.singbox.sha256),
            "desired state resolved"
        );
    }
    tracing::info!(
        control_port = cfg.control_port,
        configured = configured_control_port,
        source = if desired.is_some() { "desired" } else { "config" },
        "control port"
    );

    let singbox = Arc::new(SingBox::new(cfg.singbox.clone(), host.clone()));
    // Outbound metering is independent of everything below: it logs its own
    // errors and never delays sing-box, credentials or the MCP endpoint.
    let meter = Arc::new(TrafficMeter::new(
        host.clone(),
        control.clone(),
        cfg.state_dir.join("traffic.json"),
        cfg.traffic.clone(),
    ));
    let engine = Arc::new(RotationEngine::new(
        Arc::new(cfg.clone()),
        singbox,
        control,
        Arc::new(Mutex::new(state)),
        store,
        identity.clone(),
    ));

    let bind_ip: IpAddr = cfg.control_bind.parse().context("control_bind")?;
    let addr = SocketAddr::new(bind_ip, cfg.control_port);
    if cfg.public_host.is_none() && cfg.allowed_hosts.is_empty() {
        tracing::warn!(
            "no public_host/allowed_hosts configured; the MCP endpoint will reject non-localhost Host headers"
        );
    }
    let rotator: Arc<dyn Rotator> = engine.clone();
    // Bind the MCP endpoint *before* the first apply: install/download can take
    // minutes and the desktop must be able to reach the agent meanwhile.
    let replay_path = cfg.state_dir.join("jtis.json");
    let mut handle: AgentHandle = start_agent_with_certs(
        addr,
        identity.clone(),
        &server_id,
        signer,
        rotator,
        false,
        Some(replay_path),
    )
    .await?;

    tracing::info!(
        bind = %addr,
        public_host = %cfg.public_host.as_deref().unwrap_or("<unknown>"),
        "agent ready"
    );

    // On a cold node the startup probe has already created the counter table,
    // before enrollment. This first tick either seeds the baseline from the
    // current counter (no state file) or accumulates the delta since the last
    // save. Neither path can fail here — every error is a log line.
    meter.tick_now().await;

    if let Some(desired) = &desired {
        tracing::info!(
            port = desired.port,
            singbox_version = %desired.singbox.version.trim_start_matches('v'),
            singbox_sha256 = %short_sha(&desired.singbox.sha256),
            "checking desired state on startup"
        );
        if let Err(e) = engine.apply_if_needed(desired).await {
            // Keep running: the control endpoint must stay reachable, and an
            // upgrade / rebuild can still fix the node from the desktop.
            tracing::error!(kind = ?e.kind, error = %e.public_message(), "startup apply failed");
        }
    } else {
        tracing::warn!(
            "no desired state at startup; the node serves nothing until an upgrade or a rebuild"
        );
    }

    // An `active` report can be lost even though the apply worked (the control
    // plane would then keep the machine in installing/verifying and sweep it).
    // Say it again; the endpoint is idempotent for an already-active machine.
    engine.reannounce_active().await;

    // The desired state is never polled again. The remaining timers repair a
    // public IP the metadata service did not answer for at startup and meter
    // outbound traffic.
    let mut ip_retries_left = IP_RETRY_ATTEMPTS;
    let mut ip_retry = tokio::time::interval(IP_RETRY_INTERVAL);
    ip_retry.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ip_retry.tick().await;

    let mut traffic_tick = tokio::time::interval(Duration::from_secs(cfg.traffic.read_secs));
    traffic_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    traffic_tick.tick().await;

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("shutting down");
                break;
            }
            // If the MCP task dies the process must die too, or the unit stays
            // "active" with nothing listening on 32100.
            stopped = crate::supervise_mcp(&mut handle.task) => {
                match stopped {
                    Ok(()) => tracing::error!(
                        "MCP server task exited; exiting so systemd restarts the agent"
                    ),
                    Err(e) => tracing::error!(
                        error = %e,
                        "MCP server task stopped; exiting so systemd restarts the agent"
                    ),
                }
                std::process::exit(1);
            }
            // The public IP may have been unavailable at startup. Retry the
            // metadata probe a few times; on success re-sign the leaf and
            // refresh the registration so the control plane hands out the new
            // fingerprint. Three misses and the config has to say the host.
            _ = ip_retry.tick(),
                if ip_retries_left > 0
                    && identity.public_host().is_none()
                    && cfg.detect_public_ip =>
            {
                ip_retries_left -= 1;
                match detect_public_ip(&cfg.metadata_url).await {
                    Some(ip) => match identity.set_public_host(&ip) {
                        Ok(true) => {
                            let fingerprint = identity.leaf_fingerprint();
                            tracing::info!(
                                public_ip = %ip,
                                fingerprint = %fingerprint,
                                "re-signed the leaf with the detected public IP"
                            );
                            engine.record_cert_fingerprint(&fingerprint);
                            engine.report_registration().await;
                        }
                        Ok(false) => {}
                        Err(e) => tracing::warn!(error = %e, "failed to re-sign the leaf"),
                    },
                    None if ip_retries_left == 0 => tracing::error!(
                        attempts = IP_RETRY_ATTEMPTS,
                        "the public IP is still unknown; set public_host or allowed_hosts in the config"
                    ),
                    None => {}
                }
            }
            // Metering: read the counter, accumulate, report when due. Every
            // error inside `tick` is a log line, never a process event.
            _ = traffic_tick.tick() => {
                meter.tick_now().await;
                // A `rotated` report whose response was lost converges here
                // without waiting for the next tool call; nothing is sent when
                // no report is frozen. Bounded so a hung control plane cannot
                // starve the meter, and run after it so metering never waits.
                if tokio::time::timeout(
                    ROTATION_FLUSH_BUDGET,
                    engine.flush_pending_rotation(),
                )
                .await
                .is_err()
                {
                    tracing::warn!(
                        "the frozen rotation report timed out; retrying on the next tick"
                    );
                }
            }
        }
    }

    handle.shutdown().await;
    Ok(())
}

/// Drop any readiness file left by a previous boot: `/run` is a tmpfs that
/// survives `systemctl restart`, and cloud-init must not read last boot's
/// signal for this one.
async fn clear_ready(host: &dyn Host) {
    if let Err(e) = host.remove(Path::new(READY_FILE)).await {
        tracing::warn!(error = %e, "could not remove a stale readiness file");
    }
}

/// Tell cloud-init the metering probe passed. Written on a restored node too —
/// harmless, and it keeps one code path. A failure is only logged: the node can
/// still serve, and cloud-init's own timeout is the backstop.
async fn mark_ready(host: &dyn Host) {
    if let Err(e) = host.write(Path::new(READY_FILE), b"ok\n", 0o644).await {
        tracing::error!(error = %e, "could not write the readiness file");
    }
}

/// Scheme host and port only: never log the path or query of a control-plane
/// URL (they can carry one-time tokens).
fn control_host(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(parsed) => {
            let host = parsed.host_str().unwrap_or("<no-host>");
            match parsed.port_or_known_default() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            }
        }
        Err(_) => "<invalid>".to_string(),
    }
}

fn short_sha(sha: &str) -> String {
    let sha = sha.trim();
    if sha.is_empty() {
        "<none>".to_string()
    } else {
        sha.chars().take(8).collect()
    }
}

fn resolve_signer_pubkey(cfg: &AgentConfig, jwk: Option<&str>) -> Result<VerifyingKey> {    if let Some(jwk) = jwk {
        match auth::parse_verifying_key_jwk(jwk) {
            Ok(key) => return Ok(key),
            Err(e) => tracing::warn!(error = %e, "invalid token_public_key from enroll"),
        }
    }
    let hex = BUILTIN_SIGNER_PUBKEY
        .or(cfg.signer_pubkey.as_deref())
        .context(
            "no token public key: enroll did not return one, and neither signer_pubkey nor VEYL_AGENT_SIGNER_PUBKEY is set",
        )?;
    auth::parse_verifying_key_hex(hex)
}

async fn detect_public_ip(metadata_url: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    let resp = client.get(metadata_url).send().await.ok()?;
    if !resp.status().is_success() {
        tracing::debug!(status = %resp.status(), "metadata public IP request failed");
        return None;
    }
    let text = resp.text().await.ok()?;
    let ip = text.trim();
    if ip.parse::<IpAddr>().is_err() {
        tracing::warn!(value = %ip, "metadata public IP is not an IP address");
        return None;
    }
    tracing::info!(public_ip = %ip, "detected public IP from metadata");
    Some(ip.to_string())
}

async fn ensure_identity(
    cfg: &AgentConfig,
    plane: &ControlPlane,
    state: &mut AgentState,
    store: &StateStore,
) -> Result<(String, String, Option<DesiredState>, Option<String>)> {
    if let (Some(id), Some(token)) = (&state.server_id, &state.server_token) {
        return Ok((
            id.clone(),
            token.clone(),
            None,
            state.agent_token_public_key.clone(),
        ));
    }
    let Some(enrollment_token) = cfg.enrollment_token.as_deref() else {
        bail!("not enrolled and no enrollment_token in the config");
    };

    // A 409 is terminal for this token: it was already consumed, its TTL
    // expired, or the server was destroyed. Retrying quickly (and letting
    // systemd restart every 10 s) only burns requests, so back off for 10
    // minutes and say what the operator has to do.
    'enroll: loop {
        let mut last = String::new();
        for attempt in 1..=3 {
            match plane.enroll(enrollment_token).await {
                Ok(enrollment) => {
                    tracing::info!(
                        server_id = %enrollment.server_id,
                        port = enrollment.desired.port,
                        control_port = enrollment.desired.control_port,
                        singbox_version = %enrollment.desired.singbox.version.trim_start_matches('v'),
                        singbox_sha256 = %short_sha(&enrollment.desired.singbox.sha256),
                        token_public_key = enrollment.token_public_key.is_some(),
                        "enrolled with the control plane"
                    );
                    state.server_id = Some(enrollment.server_id.clone());
                    state.server_token = Some(enrollment.server_token.clone());
                    if let Some(jwk) = &enrollment.token_public_key {
                        state.agent_token_public_key = Some(jwk.clone());
                    }
                    // The password is only guaranteed to be in this response; keep
                    // it so a restart survives a control-plane outage.
                    state.last_desired = Some(StoredDesired::from_desired(
                        &enrollment.desired,
                        auth::now_unix(),
                    ));
                    store.save(state)?;
                    return Ok((
                        enrollment.server_id,
                        enrollment.server_token,
                        Some(enrollment.desired),
                        enrollment.token_public_key,
                    ));
                }
                Err(e) if is_terminal_control_error(&e) => {
                    tracing::error!(
                        status = 409,
                        reason = %terminal_reason(&e),
                        error = %e,
                        "enrollment returned 409: the token expired or the server was destroyed; rebuild this node; retrying in 10 minutes"
                    );
                    tokio::time::sleep(TERMINAL_BACKOFF).await;
                    continue 'enroll;
                }
                Err(e) => {
                    last = redact_sensitive(&e.to_string());
                    tracing::warn!(attempt, error = %last, "enrollment failed");
                    if attempt < 3 {
                        tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
                    }
                }
            }
        }
        bail!("enrollment failed after 3 attempts: {last}");
    }
}

async fn fetch_desired_with_retries(control: &dyn ControlApi) -> DesiredFetch {
    for attempt in 1..=3 {
        match control.desired_state().await {
            Ok(desired) => return DesiredFetch::Found(desired),
            Err(e) if is_terminal_control_error(&e) => {
                return DesiredFetch::Terminal(terminal_reason(&e));
            }
            Err(e) => {
                tracing::warn!(attempt, error = %e, "desired-state fetch failed");
                if attempt < 3 {
                    tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
                }
            }
        }
    }
    DesiredFetch::Unavailable
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_reason_keeps_the_control_plane_body() {
        let destroyed = ControlError::Status {
            status: 409,
            body: "destroyed".into(),
        };
        assert!(is_terminal_control_error(&destroyed));
        assert_eq!(terminal_reason(&destroyed), "HTTP 409: destroyed");

        let expired = ControlError::Status {
            status: 409,
            body: "expired".into(),
        };
        assert!(is_terminal_control_error(&expired));
        assert_eq!(terminal_reason(&expired), "HTTP 409: expired");

        let other = ControlError::Status {
            status: 410,
            body: "gone".into(),
        };
        assert!(!is_terminal_control_error(&other));
    }

    #[tokio::test]
    async fn the_readiness_file_is_cleared_then_written() {
        use crate::test_support::FakeHost;

        let host = FakeHost::new();
        let path = Path::new(READY_FILE);
        host.put_file(path, b"stale\n".to_vec());

        clear_ready(&host).await;
        assert!(host.file(path).is_none(), "a stale file must not survive");

        mark_ready(&host).await;
        assert_eq!(
            host.file(path).as_deref(),
            Some(b"ok\n".as_slice()),
            "cloud-init waits for exactly this file"
        );
    }
}
