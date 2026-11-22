//! Port selection, password generation, and the rotate / desired-state apply
//! pipelines. Every side effect goes through `Host` + `ControlApi`, so the
//! failure paths are unit-tested without root or network.

use std::collections::BTreeSet;
#[cfg(feature = "dev")]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rand_core::{OsRng, RngCore};
use serde::Serialize;

use crate::config::AgentConfig;
use crate::control::{ControlApi, ControlError, DesiredState, ReportRequest, Stage};
use crate::identity::Identity;
use crate::logging::{redact_sensitive, truncate};
use crate::singbox::{ApplyError, ApplyErrorKind, SingBox};
use crate::state::{AgentState, PendingRotation, StateStore, StoredDesired};

/// How long the agent keeps its own freshly rotated port when the control
/// plane's desired state has not caught up yet.
const PENDING_ROTATION_GRACE_SECS: u64 = 120;

/// Retry an apply once in-process before reporting `failed` (the control plane
/// destroys the machine on `failed`, so transient errors must not reach it).
const APPLY_ATTEMPTS: usize = 2;
const APPLY_RETRY_DELAY: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RotateErrorKind {
    Retryable,
    Fatal,
}

#[derive(Clone, Serialize)]
pub struct RotateError {
    pub kind: RotateErrorKind,
    pub message: String,
    /// HTTP status when the control plane answered; None for local failures.
    #[serde(skip)]
    pub status: Option<u16>,
}

/// `{:?}` redacts the message: it can embed a control-plane error body.
impl std::fmt::Debug for RotateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RotateError")
            .field("kind", &self.kind)
            .field("message", &truncate(&redact_sensitive(&self.message), 300))
            .field("status", &self.status)
            .finish()
    }
}

impl RotateError {
    pub fn retryable(message: impl Into<String>) -> Self {
        Self {
            kind: RotateErrorKind::Retryable,
            message: message.into(),
            status: None,
        }
    }

    pub fn fatal(message: impl Into<String>) -> Self {
        Self {
            kind: RotateErrorKind::Fatal,
            message: message.into(),
            status: None,
        }
    }

    pub fn public_message(&self) -> String {
        truncate(&redact_sensitive(&self.message), 300)
    }

    /// The control plane said this server is gone or the token is dead;
    /// retrying every 30 seconds will not help.
    pub fn is_terminal(&self) -> bool {
        self.status == Some(409)
    }
}

impl std::fmt::Display for RotateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.public_message())
    }
}

impl std::error::Error for RotateError {}

impl From<ApplyError> for RotateError {
    fn from(e: ApplyError) -> Self {
        // Decision 2026-11-21: any apply/verify step failure is fatal; only a
        // busy engine (another apply already running) is retryable.
        let _ = e.kind;
        Self {
            kind: RotateErrorKind::Fatal,
            message: e.message,
            status: None,
        }
    }
}

impl From<ControlError> for RotateError {
    fn from(e: ControlError) -> Self {
        let status = match &e {
            ControlError::Status { status, .. } => Some(*status),
            _ => None,
        };
        Self {
            kind: RotateErrorKind::Fatal,
            message: e.to_string(),
            status,
        }
    }
}

#[async_trait]
pub trait Rotator: Send + Sync {
    async fn rotate(&self, reason: Option<String>) -> Result<u16, RotateError>;
}

/// Demo / `serve` rotator: no side effects, returns a port in the band.
#[cfg(feature = "dev")]
pub struct StubRotator {
    next: AtomicU64,
}

#[cfg(feature = "dev")]
impl Default for StubRotator {
    fn default() -> Self {
        Self {
            next: AtomicU64::new(0),
        }
    }
}

#[cfg(feature = "dev")]
#[async_trait]
impl Rotator for StubRotator {
    async fn rotate(&self, _reason: Option<String>) -> Result<u16, RotateError> {
        let n = self.next.fetch_add(1, Ordering::SeqCst);
        Ok(30000 + (n * 7919) as u16 % 1000)
    }
}

pub fn pick_port(
    band: (u16, u16),
    exclude: &BTreeSet<u16>,
    rng: &mut impl RngCore,
) -> Option<u16> {
    let (lo, hi) = band;
    if lo > hi {
        return None;
    }
    let free: Vec<u16> = (lo..=hi).filter(|p| !exclude.contains(p)).collect();
    if free.is_empty() {
        return None;
    }
    let idx = (rng.next_u32() as usize) % free.len();
    Some(free[idx])
}

/// 16 random bytes as 32 lowercase hex chars.
pub fn generate_password(rng: &mut impl RngCore) -> String {
    let mut bytes = [0u8; 16];
    rng.fill_bytes(&mut bytes);
    crate::cert::hex(&bytes)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    Unchanged { port: u16 },
    Applied { port: u16 },
}

pub struct RotationEngine {
    cfg: Arc<AgentConfig>,
    singbox: Arc<SingBox>,
    control: Arc<dyn ControlApi>,
    state: Arc<Mutex<AgentState>>,
    store: StateStore,
    busy: Arc<tokio::sync::Mutex<()>>,
    identity: Arc<Identity>,
}

impl RotationEngine {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cfg: Arc<AgentConfig>,
        singbox: Arc<SingBox>,
        control: Arc<dyn ControlApi>,
        state: Arc<Mutex<AgentState>>,
        store: StateStore,
        identity: Arc<Identity>,
    ) -> Self {
        Self {
            cfg,
            singbox,
            control,
            state,
            store,
            busy: Arc::new(tokio::sync::Mutex::new(())),
            identity,
        }
    }

    pub fn state_handle(&self) -> Arc<Mutex<AgentState>> {
        self.state.clone()
    }

    pub fn is_active_unconfirmed(&self) -> bool {
        self.state.lock().expect("state poisoned").active_unconfirmed
    }

    fn set_active_unconfirmed(&self, unconfirmed: bool) {
        let mut state = self.state.lock().expect("state poisoned");
        if state.active_unconfirmed != unconfirmed {
            state.active_unconfirmed = unconfirmed;
            if let Err(e) = self.store.save(&state) {
                tracing::error!(error = %e, "failed to persist active confirmation flag");
            }
        }
    }

    pub fn record_cert_fingerprint(&self, fingerprint: &str) {
        let mut state = self.state.lock().expect("state poisoned");
        if state.cert_fingerprint.as_deref() != Some(fingerprint) {
            state.cert_fingerprint = Some(fingerprint.to_string());
            if let Err(e) = self.store.save(&state) {
                tracing::error!(error = %e, "failed to persist the new certificate fingerprint");
            }
        }
    }

    fn last_desired(&self) -> Option<DesiredState> {
        self.state
            .lock()
            .expect("state poisoned")
            .last_desired
            .as_ref()
            .map(StoredDesired::to_desired)
    }

    pub fn busy(&self) -> Arc<tokio::sync::Mutex<()>> {
        self.busy.clone()
    }

    fn report(&self, stage: Stage, port: u16, control_port: u16) -> ReportRequest {
        ReportRequest::new(
            stage,
            port,
            control_port,
            &self.identity.leaf_fingerprint(),
            &self.identity.ca_pem(),
        )
    }

    async fn current_version(&self) -> String {
        self.singbox
            .installed_version()
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| "unknown".into())
    }

    async fn report_failed(&self, port: u16, control_port: u16, error: &(impl std::fmt::Display + ?Sized)) {
        let body = self
            .report(Stage::Failed, port, control_port)
            .with_singbox_version(self.current_version().await)
            .with_error(error.to_string());
        if let Err(e) = self.control.report(&body).await {
            tracing::error!(error = %e, "failed to report failed stage");
        }
    }

    async fn rotate_inner(&self) -> Result<u16, RotateError> {
        let applied = self.singbox.applied().await.unwrap_or(None);
        let current_port = applied.as_ref().map(|a| a.port);
        let recent = {
            let state = self.state.lock().expect("state poisoned");
            state.recent_ports.clone()
        };
        let mut exclude: BTreeSet<u16> = recent.into_iter().collect();
        if let Some(port) = current_port {
            exclude.insert(port);
        }
        exclude.insert(self.cfg.control_port);

        let mut rng = OsRng;
        let port = pick_port(
            (self.cfg.port_band[0], self.cfg.port_band[1]),
            &exclude,
            &mut rng,
        )
        .ok_or_else(|| RotateError::fatal("port band has no free port"))?;
        let password = generate_password(&mut rng);
        let control_port = self.cfg.control_port;
        tracing::info!(port, from = ?current_port, "rotating sing-box credentials");

        self.control
            .report(
                &self
                    .report(Stage::Installing, port, control_port)
                    .with_singbox_version(self.current_version().await),
            )
            .await
            .map_err(RotateError::from)?;

        let version = self.current_version().await;
        let old_config = self
            .singbox
            .raw_config()
            .await
            .map_err(|e| RotateError::fatal(format!("read current config: {e}")))?;
        let mut last: Option<RotateError> = None;
        for attempt in 1..=APPLY_ATTEMPTS {
            match self
                .apply_and_verify(port, &password, control_port, &version)
                .await
            {
                Ok(()) => {
                    last = None;
                    break;
                }
                Err((retryable, e)) => {
                    tracing::warn!(
                        attempt,
                        error = %e.public_message(),
                        "rotation apply failed"
                    );
                    last = Some(e);
                    if !retryable || attempt == APPLY_ATTEMPTS {
                        break;
                    }
                    tokio::time::sleep(APPLY_RETRY_DELAY).await;
                }
            }
        }
        if let Some(e) = last {
            // Do not report `failed` for a rotation: `apply` has rolled back
            // to the previous config and the node keeps serving. The caller
            // gets the error and decides; the machine state stays untouched.
            return Err(e);
        }

        // The control plane updates node_port and re-seals the credential on
        // `rotated`. Only a 200 means the rotation is committed; anything else
        // rolls back to the pre-rotation config, so we never leave a half state.
        let rotated = self
            .report(Stage::Rotated, port, control_port)
            .with_singbox_version(version.clone())
            .with_password(password.clone());
        if let Err(e) = self.control.report(&rotated).await {
            let status = match &e {
                ControlError::Status { status, .. } => Some(*status),
                _ => None,
            };
            tracing::warn!(
                from = ?current_port,
                to = port,
                stage = "rotated",
                status = ?status,
                error = %e,
                "control plane rejected the rotation; rolling back"
            );
            match self.singbox.restore(old_config).await {
                Ok(()) => tracing::info!(
                    port = current_port.unwrap_or(0),
                    "rolled back to the previous config"
                ),
                Err(rollback) => {
                    tracing::error!(error = %rollback, "rollback after rejected rotation failed")
                }
            }
            return Err(RotateError::fatal(format!(
                "rotation rejected by the control plane: {e}"
            )));
        }
        tracing::info!(
            from = ?current_port,
            to = port,
            stage = "rotated",
            status = 200,
            "control plane accepted the rotation"
        );

        self.confirm_desired(port, &password).await;

        let now = crate::auth::now_unix();
        let mut state = self.state.lock().expect("state poisoned");
        state.remember_port(port, self.cfg.recent_ports_keep);
        state.pending_rotation = Some(PendingRotation {
            port,
            at_unix: now,
        });
        let stored = state
            .last_desired
            .clone()
            .map(|mut d| {
                d.port = port;
                d.password = password.clone();
                d.at_unix = now;
                d
            })
            .unwrap_or_else(|| StoredDesired {
                port,
                password: password.clone(),
                control_port,
                singbox_version: version.clone(),
                singbox_sha256: String::new(),
                singbox_url: String::new(),
                at_unix: now,
            });
        state.last_desired = Some(stored);
        if let Err(e) = self.store.save(&state) {
            tracing::error!(error = %e, "failed to persist port history");
        }
        drop(state);

        tracing::info!(from = ?current_port, to = port, "rotation complete");
        Ok(port)
    }

    /// Refresh the registration fields (cert fingerprint, CA PEM) without
    /// changing the server state. The control plane updates those before it
    /// handles the stage, and `verifying` is ignored unless the server is
    /// installing.
    pub async fn report_registration(&self) {
        let Some(desired) = self.last_desired() else {
            return;
        };
        let body = self
            .report(Stage::Verifying, desired.port, desired.control_port)
            .with_singbox_version(desired.singbox.version);
        if let Err(e) = self.control.report(&body).await {
            tracing::warn!(error = %e, "registration refresh report failed");
        }
    }

    /// Best-effort check that desired-state now reflects the rotation. The
    /// `rotated` report is already committed; a lag only means the pending
    /// marker keeps protecting the new port.
    async fn confirm_desired(&self, port: u16, password: &str) {
        match self.control.desired_state().await {
            Ok(desired) if desired.port == port && desired.password == password => {
                tracing::info!(port, "control plane confirmed the rotated credentials");
            }
            Ok(desired) => tracing::warn!(
                desired_port = desired.port,
                port,
                "desired-state has not caught up with the rotation yet; pending_rotation protects it"
            ),
            Err(e) => tracing::warn!(error = %e, "desired-state check after rotation failed"),
        }
    }

    async fn report_with_retries(&self, body: &ReportRequest) -> Result<(), RotateError> {
        let mut last = None;
        for attempt in 0..5 {
            match self.control.report(body).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last = Some(e);
                    if attempt < 4 {
                        let delay = 500u64 * (1 << attempt);
                        tracing::warn!(
                            attempt = attempt + 1,
                            error = %last.as_ref().unwrap(),
                            "report failed, retrying in {delay}ms"
                        );
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    }
                }
            }
        }
        Err(RotateError::fatal(format!(
            "applied locally but report failed: {}",
            last.map(|e| e.to_string()).unwrap_or_default()
        )))
    }

    async fn ensure_binary_for(
        &self,
        desired: &DesiredState,
    ) -> Result<(), (bool, RotateError)> {
        self.singbox
            .ensure_binary(&desired.singbox, &self.cfg.download_dir)
            .await
            .map_err(|e| {
                (
                    e.kind == ApplyErrorKind::Retryable,
                    RotateError::fatal(e.message),
                )
            })
    }

    /// Apply + `verifying` report + verify. The bool is whether the failure is
    /// worth one in-process retry.
    async fn apply_and_verify(
        &self,
        port: u16,
        password: &str,
        control_port: u16,
        version: &str,
    ) -> Result<(), (bool, RotateError)> {
        if let Err(e) = self.singbox.apply(port, password).await {
            return Err((
                e.kind == ApplyErrorKind::Retryable,
                RotateError::fatal(e.message),
            ));
        }
        if let Err(e) = self
            .control
            .report(
                &self
                    .report(Stage::Verifying, port, control_port)
                    .with_singbox_version(version),
            )
            .await
        {
            tracing::warn!(error = %e, "verifying report failed");
        }
        if let Err(e) = self
            .singbox
            .verify(port, self.cfg.egress_probe.parse().expect("validated"))
            .await
        {
            return Err((
                e.kind == ApplyErrorKind::Retryable,
                RotateError::fatal(e.message),
            ));
        }
        Ok(())
    }

    /// Apply a control-plane-provided desired state. `upload_password` is only
    /// true when the agent itself generated the password.
    pub async fn apply_desired(
        &self,
        desired: &DesiredState,
        upload_password: bool,
    ) -> Result<(), RotateError> {
        let _guard = self
            .busy
            .try_lock()
            .map_err(|_| RotateError::retryable("another apply is already running"))?;
        let control_port = desired.control_port;
        self.control
            .report(
                &self
                    .report(Stage::Installing, desired.port, control_port)
                    .with_singbox_version(desired.singbox.version.clone()),
            )
            .await
            .map_err(RotateError::from)?;

        let mut last: Option<RotateError> = None;
        for attempt in 1..=APPLY_ATTEMPTS {
            let result = async {
                self.ensure_binary_for(desired).await?;
                self.apply_and_verify(
                    desired.port,
                    &desired.password,
                    control_port,
                    &desired.singbox.version,
                )
                .await
            }
            .await;
            match result {
                Ok(()) => {
                    last = None;
                    break;
                }
                Err((retryable, e)) => {
                    tracing::warn!(attempt, error = %e.public_message(), "apply failed");
                    last = Some(e);
                    if !retryable || attempt == APPLY_ATTEMPTS {
                        break;
                    }
                    tokio::time::sleep(APPLY_RETRY_DELAY).await;
                }
            }
        }
        if let Some(e) = last {
            // The control plane records `failed` on an active machine (it no
            // longer destroys it), but a machine that never became active is
            // still destroyed. Only report after the in-process retry.
            self.report_failed(desired.port, control_port, &e).await;
            return Err(e);
        }

        let active = self.report_active(desired, upload_password).await;

        let mut state = self.state.lock().expect("state poisoned");
        state.remember_port(desired.port, self.cfg.recent_ports_keep);
        state.pending_rotation = None;
        state.last_desired = Some(StoredDesired::from_desired(
            desired,
            crate::auth::now_unix(),
        ));
        // Persist the "active not confirmed" flag so the poll loop keeps
        // re-reporting even across restarts.
        state.active_unconfirmed = active.is_err();
        if let Err(e) = self.store.save(&state) {
            tracing::error!(error = %e, "failed to persist applied port");
        }
        drop(state);
        tracing::info!(
            port = desired.port,
            singbox_version = %desired.singbox.version.trim_start_matches('v'),
            active = active.is_ok(),
            "desired state applied"
        );
        active?;
        Ok(())
    }

    async fn desired_matches(&self, desired: &DesiredState) -> bool {
        let applied = self.singbox.applied().await.unwrap_or(None);
        let installed = self.singbox.installed_version().await.ok().flatten();
        let version_ok = installed
            .as_deref()
            .map(|v| v == desired.singbox.version.trim_start_matches('v'))
            .unwrap_or(false);
        let config_ok = applied.as_ref().map(|a| a.matches(desired)).unwrap_or(false);
        config_ok && version_ok
    }

    async fn report_active(
        &self,
        desired: &DesiredState,
        upload_password: bool,
    ) -> Result<(), RotateError> {
        let mut body = self
            .report(Stage::Active, desired.port, desired.control_port)
            .with_singbox_version(desired.singbox.version.clone());
        if upload_password {
            body = body.with_password(desired.password.clone());
        }
        self.report_with_retries(&body).await
    }

    /// Apply the desired state only when it differs. `report_when_unchanged`
    /// makes a startup announce `active` without restarting sing-box.
    pub async fn apply_if_needed(
        &self,
        desired: &DesiredState,
        report_when_unchanged: bool,
    ) -> Result<PollOutcome, RotateError> {
        if self.desired_matches(desired).await {
            // The config can match while the unit is dead (OOM, manual stop,
            // crash). Check before reporting active and retry once.
            if !matches!(self.singbox.is_active().await, Ok(true)) {
                tracing::warn!(
                    port = desired.port,
                    "sing-box is not active although the config matches; restarting once"
                );
                if let Err(e) = self.singbox.restart().await {
                    let message = format!(
                        "sing-box is not running: {}",
                        truncate(&redact_sensitive(&e.message), 300)
                    );
                    tracing::error!(error = %message, "sing-box did not come back after a restart");
                    self.report_failed(desired.port, desired.control_port, &message)
                        .await;
                    return Err(RotateError::retryable(message));
                }
                tracing::info!(port = desired.port, "sing-box restarted after a liveness check");
            }
            if report_when_unchanged {
                match self.report_active(desired, false).await {
                    Ok(()) => self.set_active_unconfirmed(false),
                    Err(e) => {
                        tracing::warn!(
                            error = %e.public_message(),
                            "active report failed; the poll loop will retry it"
                        );
                        self.set_active_unconfirmed(true);
                    }
                }
            }
            return Ok(PollOutcome::Unchanged {
                port: desired.port,
            });
        }
        tracing::info!(
            desired_port = desired.port,
            "desired state changed, applying"
        );
        self.apply_desired(desired, false).await?;
        Ok(PollOutcome::Applied {
            port: desired.port,
        })
    }

    pub async fn poll_once(&self) -> Result<PollOutcome, RotateError> {
        let desired = match self.control.desired_state().await {
            Ok(desired) => desired,
            Err(e) => {
                if matches!(&e, ControlError::Status { status: 409, .. }) {
                    // Terminal: the token is dead or the server was destroyed.
                    // Let the caller pause polls instead of hammering every
                    // 30 seconds.
                    return Err(e.into());
                }
                match self.last_desired() {
                    Some(last) => {
                        tracing::warn!(
                            error = %e,
                            "desired-state fetch failed; using the persisted credentials"
                        );
                        last
                    }
                    None => return Err(e.into()),
                }
            }
        };

        // Earlier `active` reports may never have landed; re-report until the
        // control plane acknowledges, otherwise the node is swept while serving.
        if self.is_active_unconfirmed() {
            let body = self
                .report(Stage::Active, desired.port, desired.control_port)
                .with_singbox_version(desired.singbox.version.clone());
            match self.control.report(&body).await {
                Ok(()) => {
                    tracing::info!("control plane confirmed active");
                    self.set_active_unconfirmed(false);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "active re-report failed; will retry next poll");
                }
            }
        }

        // A rotation just changed the port; keep it until the control plane's
        // desired state catches up (or the grace period expires).
        let pending = {
            let state = self.state.lock().expect("state poisoned");
            state.pending_rotation.clone()
        };
        if let Some(pending) = pending {
            let applied_port = self.singbox.applied().await.ok().flatten().map(|a| a.port);
            let age = crate::auth::now_unix().saturating_sub(pending.at_unix);
            if applied_port == Some(pending.port)
                && desired.port != pending.port
                && age <= PENDING_ROTATION_GRACE_SECS
            {
                tracing::warn!(
                    rotated_port = pending.port,
                    desired_port = desired.port,
                    "desired state has not caught up with the rotation yet; keeping the rotated port"
                );
                return Ok(PollOutcome::Unchanged {
                    port: pending.port,
                });
            }
            let mut state = self.state.lock().expect("state poisoned");
            state.pending_rotation = None;
            if let Err(e) = self.store.save(&state) {
                tracing::error!(error = %e, "failed to clear pending rotation");
            }
        }

        self.apply_if_needed(&desired, false).await
    }
}

#[async_trait]
impl Rotator for RotationEngine {
    async fn rotate(&self, _reason: Option<String>) -> Result<u16, RotateError> {
        let _guard = self
            .busy
            .try_lock()
            .map_err(|_| RotateError::retryable("rotation already in progress"))?;
        self.rotate_inner().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SingBoxConfig;
    use crate::control::{ControlApi, ReportRequest, SingBoxDesired};
    use crate::singbox::SingBox;
    use crate::test_support::FakeHost;
    use std::path::{Path, PathBuf};

    struct StepRng(u64);

    impl RngCore for StepRng {
        fn next_u32(&mut self) -> u32 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1);
            (self.0 >> 33) as u32
        }
        fn next_u64(&mut self) -> u64 {
            ((self.next_u32() as u64) << 32) | self.next_u32() as u64
        }
        fn fill_bytes(&mut self, dest: &mut [u8]) {
            for chunk in dest.chunks_mut(4) {
                let bytes = self.next_u32().to_le_bytes();
                chunk.copy_from_slice(&bytes[..chunk.len()]);
            }
        }
        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
            self.fill_bytes(dest);
            Ok(())
        }
    }

    #[test]
    fn picks_only_ports_inside_the_band() {
        let mut rng = StepRng(7);
        let exclude = BTreeSet::new();
        for _ in 0..200 {
            let port = pick_port((30000, 30999), &exclude, &mut rng).unwrap();
            assert!((30000..=30999).contains(&port));
        }
    }

    #[test]
    fn never_picks_excluded_ports() {
        let mut rng = StepRng(11);
        let exclude: BTreeSet<u16> = (30000..30999).collect();
        for _ in 0..100 {
            assert_eq!(pick_port((30000, 30999), &exclude, &mut rng), Some(30999));
        }
    }

    #[test]
    fn returns_none_when_band_is_exhausted() {
        let mut rng = StepRng(1);
        let exclude: BTreeSet<u16> = (30000..=30999).collect();
        assert_eq!(pick_port((30000, 30999), &exclude, &mut rng), None);
        assert_eq!(pick_port((31000, 30999), &exclude, &mut rng), None);
    }

    #[test]
    fn password_is_32_hex_chars() {
        let mut rng = StepRng(3);
        let pw = generate_password(&mut rng);
        assert_eq!(pw.len(), 32);
        assert!(pw.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(pw, generate_password(&mut rng));
    }

    struct FakeControl {
        reports: Mutex<Vec<ReportRequest>>,
        desired: Mutex<DesiredState>,
        fail_report: Mutex<bool>,
        reject_rotated: Mutex<bool>,
    }

    #[async_trait]
    impl ControlApi for FakeControl {
        async fn report(&self, body: &ReportRequest) -> Result<(), ControlError> {
            if *self.fail_report.lock().unwrap() {
                return Err(ControlError::Transport("offline".into()));
            }
            self.reports.lock().unwrap().push(body.clone());
            if body.stage == Stage::Rotated && *self.reject_rotated.lock().unwrap() {
                return Err(ControlError::Status {
                    status: 409,
                    body: r#"{"reason":"port_taken"}"#.into(),
                });
            }
            Ok(())
        }

        async fn desired_state(&self) -> Result<DesiredState, ControlError> {
            Ok(self.desired.lock().unwrap().clone())
        }
    }

    fn config(dir: &Path) -> Arc<AgentConfig> {
        Arc::new(AgentConfig {
            control_plane_url: "https://control.example.com".into(),
            enrollment_token: None,
            enroll_url: None,
            signer_pubkey: None,
            detect_public_ip: false,
            metadata_url: "http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address".into(),
            control_bind: "127.0.0.1".into(),
            control_port: 32100,
            allowed_hosts: vec![],
            public_host: None,
            cert_dir: dir.join("certs"),
            state_dir: dir.join("state"),
            download_dir: dir.join("downloads"),
            singbox: SingBoxConfig {
                binary_path: PathBuf::from("/usr/local/bin/sing-box"),
                config_path: dir.join("sing-box/config.json"),
                unit_path: dir.join("sing-box/sing-box.service"),
                ..SingBoxConfig::default()
            },
            port_band: [30000, 30999],
            recent_ports_keep: 20,
            poll_interval_secs: 30,
            egress_probe: "1.1.1.1:443".into(),
            log_level: "debug".into(),
            log: Default::default(),
            allow_insecure_control_plane: false,
        })
    }

    fn desired(port: u16, version: &str) -> DesiredState {
        DesiredState {
            port,
            password: "from-control-plane".into(),
            control_port: 32100,
            singbox: SingBoxDesired {
                version: version.into(),
                sha256: "f".repeat(64),
                url: "https://example.com/sing-box.tar.gz".into(),
            },
        }
    }

    fn engine(
        dir: &Path,
        host: Arc<FakeHost>,
        control: Arc<FakeControl>,
    ) -> (RotationEngine, Arc<AgentConfig>) {
        let cfg = config(dir);
        std::fs::create_dir_all(dir).unwrap();
        host.put_file(&cfg.singbox.binary_path, b"elf".to_vec());
        host.set_command_output(
            &cfg.singbox.binary_path.to_string_lossy(),
            0,
            "sing-box version 1.14.4\n",
            "",
        );
        let singbox = Arc::new(SingBox::new(cfg.singbox.clone(), host.clone()));
        let store = StateStore::new(cfg.state_path());
        let state = Arc::new(Mutex::new(AgentState::default()));
        let identity = Arc::new(
            crate::identity::Identity::load(&dir.join("certs"), &[], None).unwrap(),
        );
        let engine = RotationEngine::new(
            cfg.clone(),
            singbox,
            control,
            state,
            store,
            identity,
        );
        (engine, cfg)
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "veyl-agent-rotation-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn rotate_success_reports_active_with_the_new_password() {
        let dir = tmpdir("ok");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
        });
        let (engine, _cfg) = engine(&dir, host.clone(), control.clone());
        let port = engine.rotate(Some("user".into())).await.unwrap();
        assert!((30000..=30999).contains(&port));
        let reports = control.reports.lock().unwrap();
        let stages: Vec<Stage> = reports.iter().map(|r| r.stage).collect();
        assert_eq!(
            stages,
            vec![Stage::Installing, Stage::Verifying, Stage::Rotated]
        );
        assert!(reports[2].password.is_some());
        assert_eq!(reports[2].port, port);
        assert!(!reports[2].ca_pem.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn rotated_rejection_rolls_back_the_old_config() {
        let dir = tmpdir("rotated-reject");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(true),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        let old = crate::singbox::render_config(30412, "old-password", "aes-256-gcm");
        host.put_file(&cfg.singbox.config_path, old.clone().into_bytes());

        let err = engine.rotate(None).await.unwrap_err();
        assert_eq!(err.kind, RotateErrorKind::Fatal);
        assert!(err.public_message().contains("rotation rejected"));
        // The old config is restored byte-for-byte, so the node keeps serving.
        assert_eq!(host.file(&cfg.singbox.config_path), Some(old.into_bytes()));
        let stages: Vec<Stage> = control
            .reports
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.stage)
            .collect();
        assert_eq!(
            stages,
            vec![Stage::Installing, Stage::Verifying, Stage::Rotated]
        );
        // A rejected rotation must not persist the new port history.
        assert!(!cfg.state_path().exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn rotation_check_failure_returns_fatal_without_reporting_failed() {
        let dir = tmpdir("check-fail");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
        });
        let (engine, _cfg) = engine(&dir, host.clone(), control.clone());
        host.set_command_output("/usr/local/bin/sing-box", 1, "", "bad config");
        let err = engine.rotate(None).await.unwrap_err();
        assert_eq!(err.kind, RotateErrorKind::Fatal);
        // A rotation failure must not report `failed`: the control plane would
        // destroy a machine that still serves the rolled-back config.
        let stages: Vec<Stage> = control
            .reports
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.stage)
            .collect();
        assert_eq!(stages, vec![Stage::Installing]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn apply_desired_retries_a_restart_failure_once() {
        let dir = tmpdir("retry-ok");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
        });
        let (engine, _cfg) = engine(&dir, host.clone(), control.clone());
        // Attempt 1: daemon-reload/enable ok, restart fails, rollback restart ok.
        // Attempt 2: daemon-reload/enable/restart/is-active ok.
        host.queue_command_outputs(
            "systemctl",
            &[
                (0, "", ""),
                (0, "", ""),
                (1, "", "restart failed"),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
            ],
        );

        let outcome = engine
            .apply_if_needed(&desired(30412, "1.14.4"), false)
            .await
            .unwrap();
        assert_eq!(outcome, PollOutcome::Applied { port: 30412 });
        let stages: Vec<Stage> = control
            .reports
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.stage)
            .collect();
        assert_eq!(
            stages,
            vec![Stage::Installing, Stage::Verifying, Stage::Active]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn apply_desired_reports_failed_only_after_two_failed_attempts() {
        let dir = tmpdir("retry-fail");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
        });
        let (engine, _cfg) = engine(&dir, host.clone(), control.clone());
        host.queue_command_outputs(
            "systemctl",
            &[
                (0, "", ""),
                (0, "", ""),
                (1, "", "restart failed"),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
                (1, "", "restart failed"),
                (0, "", ""),
            ],
        );

        let err = engine
            .apply_desired(&desired(30412, "1.14.4"), false)
            .await
            .unwrap_err();
        assert_eq!(err.kind, RotateErrorKind::Fatal);
        let stages: Vec<Stage> = control
            .reports
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.stage)
            .collect();
        assert_eq!(stages, vec![Stage::Installing, Stage::Failed]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn busy_engine_returns_retryable() {
        let dir = tmpdir("busy");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
        });
        let (engine, _cfg) = engine(&dir, host, control);
        let guard = engine.busy().try_lock_owned().unwrap();
        let err = engine.rotate(None).await.unwrap_err();
        assert_eq!(err.kind, RotateErrorKind::Retryable);
        drop(guard);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn poll_applies_only_when_desired_differs() {
        let dir = tmpdir("poll");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());

        // No config yet -> apply.
        assert_eq!(
            engine.poll_once().await.unwrap(),
            PollOutcome::Applied { port: 30412 }
        );
        // After apply, the same desired state is a no-op.
        assert_eq!(
            engine.poll_once().await.unwrap(),
            PollOutcome::Unchanged { port: 30412 }
        );
        assert_eq!(
            host.file(&cfg.singbox.config_path),
            Some(crate::singbox::render_config(30412, "from-control-plane", "aes-256-gcm").into_bytes())
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn poll_keeps_a_fresh_rotation_until_desired_catches_up() {
        let dir = tmpdir("pending");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());

        let port = engine.rotate(None).await.unwrap();

        // The control plane still shows a pre-rotation port: do not undo it.
        let stale = if port == 30412 { 30413 } else { 30412 };
        *control.desired.lock().unwrap() = desired(stale, "1.14.4");
        assert_eq!(
            engine.poll_once().await.unwrap(),
            PollOutcome::Unchanged { port }
        );

        // Once the control plane echoes the rotation (same port + password),
        // polling is a no-op and clears the pending marker.
        let config = host.file(&cfg.singbox.config_path).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&config).unwrap();
        let password = v["inbounds"][0]["password"].as_str().unwrap().to_string();
        *control.desired.lock().unwrap() = DesiredState {
            port,
            password,
            ..desired(port, "1.14.4")
        };
        assert_eq!(
            engine.poll_once().await.unwrap(),
            PollOutcome::Unchanged { port }
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotate_error_debug_hides_secrets() {        let err = RotateError::fatal("rejected: password=abc123 token=tok-9");
        let debug = format!("{err:?}");
        assert!(!debug.contains("abc123"));
        assert!(!debug.contains("tok-9"));
        assert!(debug.contains("Fatal"));
    }

    #[tokio::test]
    async fn a_409_from_desired_state_is_terminal() {
        struct TerminalControl;
        #[async_trait]
        impl ControlApi for TerminalControl {
            async fn report(&self, _body: &ReportRequest) -> Result<(), ControlError> {
                Ok(())
            }
            async fn desired_state(&self) -> Result<DesiredState, ControlError> {
                Err(ControlError::Status {
                    status: 409,
                    body: r#"{"reason":"server_destroyed"}"#.into(),
                })
            }
        }

        let dir = tmpdir("terminal-409");
        let cfg = config(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let host: Arc<dyn crate::host::Host> = Arc::new(FakeHost::new());
        let singbox = Arc::new(SingBox::new(cfg.singbox.clone(), host));
        let identity =
            Arc::new(crate::identity::Identity::load(&dir.join("certs"), &[], None).unwrap());
        let engine = RotationEngine::new(
            cfg.clone(),
            singbox,
            Arc::new(TerminalControl),
            Arc::new(Mutex::new(AgentState::default())),
            StateStore::new(cfg.state_path()),
            identity,
        );
        let err = engine.poll_once().await.unwrap_err();
        assert_eq!(err.status, Some(409));
        assert!(err.is_terminal());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn startup_restarts_a_dead_singbox_once() {
        let dir = tmpdir("dead-restart");
        let host = Arc::new(FakeHost::new());
        let d = desired(30412, "1.14.4");
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(d.clone()),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, &d.password, "aes-256-gcm").into_bytes(),
        );
        // is-active fails, restart succeeds, is-active succeeds.
        host.queue_command_outputs(
            "systemctl",
            &[(1, "", "inactive"), (0, "", ""), (0, "", "")],
        );

        let outcome = engine.apply_if_needed(&d, true).await.unwrap();
        assert_eq!(outcome, PollOutcome::Unchanged { port: 30412 });
        let stages: Vec<Stage> = control
            .reports
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.stage)
            .collect();
        assert_eq!(stages, vec![Stage::Active]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn startup_reports_failed_when_singbox_stays_down() {
        let dir = tmpdir("dead-failed");
        let host = Arc::new(FakeHost::new());
        let d = desired(30412, "1.14.4");
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(d.clone()),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, &d.password, "aes-256-gcm").into_bytes(),
        );
        // is-active fails, restart fails.
        host.queue_command_outputs(
            "systemctl",
            &[(1, "", "inactive"), (1, "", "restart failed")],
        );

        let err = engine.apply_if_needed(&d, true).await.unwrap_err();
        assert_eq!(err.kind, RotateErrorKind::Retryable);
        let reports = control.reports.lock().unwrap();
        assert_eq!(reports.last().map(|r| r.stage), Some(Stage::Failed));
        assert!(reports
            .last()
            .and_then(|r| r.error.as_deref())
            .unwrap_or("")
            .contains("not running"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn poll_re_reports_active_while_unconfirmed() {
        let dir = tmpdir("active-retry");
        let host = Arc::new(FakeHost::new());
        let d = desired(30412, "1.14.4");
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(d.clone()),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, &d.password, "aes-256-gcm").into_bytes(),
        );
        *engine.state_handle().lock().unwrap() = AgentState {
            active_unconfirmed: true,
            last_desired: Some(StoredDesired::from_desired(&d, 0)),
            ..Default::default()
        };

        let outcome = engine.poll_once().await.unwrap();
        assert_eq!(outcome, PollOutcome::Unchanged { port: 30412 });
        let stages: Vec<Stage> = control
            .reports
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.stage)
            .collect();
        assert_eq!(stages, vec![Stage::Active]);
        assert!(!engine.state_handle().lock().unwrap().active_unconfirmed);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn poll_keeps_the_marker_when_the_active_re_report_fails() {
        let dir = tmpdir("active-retry-fail");
        let host = Arc::new(FakeHost::new());
        let d = desired(30412, "1.14.4");
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(d.clone()),
            fail_report: Mutex::new(true),
            reject_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, &d.password, "aes-256-gcm").into_bytes(),
        );
        *engine.state_handle().lock().unwrap() = AgentState {
            active_unconfirmed: true,
            last_desired: Some(StoredDesired::from_desired(&d, 0)),
            ..Default::default()
        };

        let outcome = engine.poll_once().await.unwrap();
        assert_eq!(outcome, PollOutcome::Unchanged { port: 30412 });
        assert!(engine.state_handle().lock().unwrap().active_unconfirmed);
        std::fs::remove_dir_all(&dir).ok();
    }
}
