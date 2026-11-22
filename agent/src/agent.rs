//! Production run loop: enroll → install/apply → serve MCP → poll desired state.

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
use crate::control::{ControlApi, ControlPlane, ControlSession, DesiredState};
use crate::host::{Host, RealHost};
use crate::identity::Identity;
use crate::logging::{self, redact_sensitive};
use crate::rotation::{PollOutcome, RotationEngine, Rotator};
use crate::singbox::SingBox;
use crate::state::{AgentState, StateStore, StoredDesired};
use crate::{start_agent_with_certs, AgentHandle};

/// Production builds compile the control plane's Ed25519 public key in.
const BUILTIN_SIGNER_PUBKEY: Option<&str> = option_env!("VEYL_AGENT_SIGNER_PUBKEY");

pub async fn run(config_path: &Path, log_level_override: Option<String>) -> Result<()> {
    let mut cfg = AgentConfig::load(config_path)?;
    logging::init(
        log_level_override
            .as_deref()
            .unwrap_or(cfg.log_level.as_str()),
    );

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        config = %config_path.display(),
        "starting veyl agent"
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

    let plane = ControlPlane::new(&cfg.control_plane_url)?.with_enroll_url(cfg.enroll_url.clone());
    let store = StateStore::new(cfg.state_path());
    let mut state = store.load()?;
    if state.cert_fingerprint.as_deref() != Some(leaf_fp.as_str()) {
        state.cert_fingerprint = Some(leaf_fp.clone());
        store.save(&state)?;
    }

    let (server_id, server_token, enrolled_desired, token_public_key) =
        ensure_identity(&cfg, &plane, &mut state, &store).await?;
    let signer = resolve_signer_pubkey(&cfg, token_public_key.as_deref())?;
    tracing::info!(server_id = %server_id, "identity ready");

    let control: Arc<dyn ControlApi> =
        Arc::new(ControlSession::new(plane, server_token));
    let desired = match enrolled_desired {
        Some(desired) => Some(desired),
        None => match fetch_desired_with_retries(control.as_ref()).await {
            Some(desired) => Some(desired),
            None => {
                let fallback = state.last_desired.as_ref().map(StoredDesired::to_desired);
                if fallback.is_some() {
                    tracing::warn!(
                        "control plane unreachable; using the persisted desired state"
                    );
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

    let host: Arc<dyn Host> = Arc::new(RealHost::new()?);
    let singbox = Arc::new(SingBox::new(cfg.singbox.clone(), host));
    let engine = Arc::new(RotationEngine::new(
        Arc::new(cfg.clone()),
        singbox,
        control,
        Arc::new(Mutex::new(state)),
        store,
        identity.clone(),
    ));

    if let Some(desired) = &desired {
        tracing::info!(port = desired.port, "checking desired state on startup");
        if let Err(e) = engine.apply_if_needed(desired, true).await {
            // Keep running: the control endpoint must stay reachable.
            tracing::error!(kind = ?e.kind, error = %e.public_message(), "startup apply failed");
        }
    } else {
        tracing::warn!("no desired state at startup; waiting for the poll loop");
    }

    let bind_ip: IpAddr = cfg.control_bind.parse().context("control_bind")?;
    let addr = SocketAddr::new(bind_ip, cfg.control_port);
    if cfg.public_host.is_none() && cfg.allowed_hosts.is_empty() {
        tracing::warn!(
            "no public_host/allowed_hosts configured; the MCP endpoint will reject non-localhost Host headers"
        );
    }
    let rotator: Arc<dyn Rotator> = engine.clone();
    let handle: AgentHandle = start_agent_with_certs(
        addr,
        identity.clone(),
        &server_id,
        signer,
        rotator,
        false,
    )
    .await?;

    let mut interval = tokio::time::interval(Duration::from_secs(cfg.poll_interval_secs));
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("shutting down");
                break;
            }
            _ = interval.tick() => {
                // The public IP may have been unavailable at startup. Retry the
                // metadata probe; on success re-sign the leaf and refresh the
                // registration so the control plane hands out the new fingerprint.
                if identity.public_host().is_none() && cfg.detect_public_ip {
                    if let Some(ip) = detect_public_ip(&cfg.metadata_url).await {
                        match identity.set_public_host(&ip) {
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
                            Err(e) => {
                                tracing::warn!(error = %e, "failed to re-sign the leaf")
                            }
                        }
                    }
                }
                match engine.poll_once().await {
                    Ok(PollOutcome::Unchanged { port }) => {
                        tracing::debug!(port, "desired state unchanged");
                    }
                    Ok(PollOutcome::Applied { port }) => {
                        tracing::info!(port, "desired state applied");
                    }
                    Err(e) => {
                        tracing::warn!(kind = ?e.kind, error = %e.public_message(), "desired-state poll failed");
                    }
                }
            }
        }
    }

    handle.shutdown().await;
    Ok(())
}

fn resolve_signer_pubkey(cfg: &AgentConfig, jwk: Option<&str>) -> Result<VerifyingKey> {
    if let Some(jwk) = jwk {
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

    let mut last = String::new();
    for attempt in 1..=3 {
        match plane.enroll(enrollment_token).await {
            Ok(enrollment) => {
                tracing::info!(server_id = %enrollment.server_id, "enrolled");
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
            Err(e) => {
                last = redact_sensitive(&e.to_string());
                tracing::warn!(attempt, error = %last, "enrollment failed");
                if attempt < 3 {
                    tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
                }
            }
        }
    }
    bail!("enrollment failed after 3 attempts: {last}")
}

async fn fetch_desired_with_retries(control: &dyn ControlApi) -> Option<DesiredState> {
    for attempt in 1..=3 {
        match control.desired_state().await {
            Ok(desired) => return Some(desired),
            Err(e) => {
                tracing::warn!(attempt, error = %e, "desired-state fetch failed");
                if attempt < 3 {
                    tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
                }
            }
        }
    }
    None
}
