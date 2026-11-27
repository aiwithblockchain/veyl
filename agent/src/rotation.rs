//! Port selection, password generation, and the rotate / desired-state apply /
//! upgrade pipelines. Every side effect goes through `Host` + `ControlApi`, so
//! the failure paths are unit-tested without root or network.

use std::collections::BTreeSet;
#[cfg(feature = "dev")]
#[cfg(feature = "dev")]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering};
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
use crate::state::{AgentState, PendingRotationReport, StateStore, StoredDesired};

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
    /// Stable cause for the tool envelope when the kind alone cannot tell two
    /// failures apart. Only `agent_busy` today.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
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
            reason: None,
        }
    }

    pub fn fatal(message: impl Into<String>) -> Self {
        Self {
            kind: RotateErrorKind::Fatal,
            message: message.into(),
            status: None,
            reason: None,
        }
    }

    /// Another write operation (rotation / upgrade / apply) holds the lock.
    /// The kind alone cannot say this, so the envelope carries `agent_busy`.
    pub fn busy() -> Self {
        Self {
            kind: RotateErrorKind::Retryable,
            message: "another node operation is already running".into(),
            status: None,
            reason: Some("agent_busy"),
        }
    }

    pub fn public_message(&self) -> String {
        truncate(&redact_sensitive(&self.message), 300)
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
            reason: None,
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
            reason: None,
        }
    }
}

#[async_trait]
pub trait Rotator: Send + Sync {
    async fn rotate(&self, reason: Option<String>) -> Result<u16, RotateError>;
    /// Install whatever sing-box the control plane currently ships, restart and
    /// self-check. The target is read with the agent's own server token: a
    /// caller can never choose which binary lands on the node.
    async fn upgrade_singbox(&self) -> Result<UpgradeOutcome, RotateError>;
    /// Best-effort `active` announcement, run before every tool call. The
    /// control plane treats an already-active machine as a no-op, so this heals
    /// an `active` report that never landed without persisting a dirty flag.
    async fn reannounce_active(&self);
}

/// What `upgrade_singbox` did. `installed` is the version the node ran before
/// the call ("unknown" when it could not be read), `target` what the control
/// plane ships, `upgraded` whether a binary swap happened at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpgradeOutcome {
    pub installed: String,
    pub target: String,
    pub upgraded: bool,
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

    async fn upgrade_singbox(&self) -> Result<UpgradeOutcome, RotateError> {
        Ok(UpgradeOutcome {
            installed: "0.0.0-dev".into(),
            target: "0.0.0-dev".into(),
            upgraded: false,
        })
    }

    async fn reannounce_active(&self) {}
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

/// The control plane answered and refused this request, so nothing was
/// committed. Timeouts and rate limits are answers too, but they say nothing
/// about whether the write happened.
fn explicitly_rejected(e: &ControlError) -> bool {
    matches!(
        e,
        ControlError::Status { status, .. }
            if (400..500).contains(status) && *status != 408 && *status != 429
    )
}

pub struct RotationEngine {
    cfg: Arc<AgentConfig>,
    singbox: Arc<SingBox>,
    control: Arc<dyn ControlApi>,
    state: Arc<Mutex<AgentState>>,
    store: StateStore,
    busy: Arc<tokio::sync::Mutex<()>>,
    identity: Arc<Identity>,
    /// Whether the control plane has acknowledged this node as active since
    /// this process started. In memory only: it exists so a failed upgrade
    /// never reports `failed` for a machine the control plane still considers
    /// mid-install (that report would destroy it).
    active_confirmed: AtomicBool,
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
            active_confirmed: AtomicBool::new(false),
        }
    }

    pub fn state_handle(&self) -> Arc<Mutex<AgentState>> {
        self.state.clone()
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

    /// Tail of the on-disk log, attached to `failed` reports. The control plane
    /// destroys the instance right after, so this is the only copy that
    /// survives; both the excerpt and `error` are redacted first.
    fn recent_log_excerpt(&self) -> Option<String> {
        let path = self.cfg.log.file.as_ref()?;
        let bytes = std::fs::read(path).ok()?;
        // A UTF-8 boundary may be crossed; from_utf8_lossy replaces the split
        // character instead of dropping the whole tail.
        let tail = if bytes.len() > 8192 {
            &bytes[bytes.len() - 8192..]
        } else {
            &bytes[..]
        };
        let text = String::from_utf8_lossy(tail);
        let lines: Vec<&str> = text.lines().collect();
        let start = lines.len().saturating_sub(30);
        let joined = lines[start..].join("\n");
        let excerpt = truncate(&redact_sensitive(&joined), 2000);
        if excerpt.trim().is_empty() {
            None
        } else {
            Some(excerpt)
        }
    }

    async fn report_failed(&self, port: u16, control_port: u16, error: &(impl std::fmt::Display + ?Sized)) {
        let mut body = self
            .report(Stage::Failed, port, control_port)
            .with_error(error.to_string());
        // An unreadable version is left out rather than sent as "unknown": the
        // control plane keeps the last real value (empty strings are skipped).
        if let Some(version) = self.singbox.installed_version().await.ok().flatten() {
            body = body.with_singbox_version(version);
        }
        if let Some(excerpt) = self.recent_log_excerpt() {
            body = body.with_log_excerpt(excerpt);
        }
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
        // `rotated`. The report is frozen on disk *before* it leaves: if the
        // response is lost the control plane may already have committed these
        // credentials, and only a resend of this exact pair can heal that.
        let frozen = PendingRotationReport {
            port,
            password: password.clone(),
            control_port,
            singbox_version: version.clone(),
            at_unix: crate::auth::now_unix(),
        };
        // A previous rotation may still be unconfirmed. Its config is what
        // `old_config` holds, so a rejection below must put its freeze back
        // instead of dropping both records.
        let previous = self.freeze_rotation_report(&frozen);

        let rotated = self
            .report(Stage::Rotated, port, control_port)
            .with_singbox_version(version.clone())
            .with_password(password.clone());
        match self.control.report(&rotated).await {
            Ok(()) => {}
            Err(e) if explicitly_rejected(&e) => {
                // The control plane answered and refused: nothing was
                // committed, so the node goes back to the config it served.
                tracing::warn!(
                    from = ?current_port,
                    to = port,
                    stage = "rotated",
                    error = %e,
                    "control plane rejected the rotation; rolling back"
                );
                self.roll_back_freeze(&frozen, previous);
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
            Err(e) => {
                // No answer (transport error / timeout) or a 5xx: whether the
                // control plane committed is unknown. Rolling back here is how
                // both sides end up on different credentials — the node keeps
                // the new config and the frozen report is resent as-is on the
                // next call.
                tracing::warn!(
                    from = ?current_port,
                    to = port,
                    stage = "rotated",
                    error = %e,
                    "rotation report was not confirmed; keeping the new credentials and the frozen report"
                );
                return Err(RotateError::retryable(format!(
                    "rotation applied locally, but the control plane did not confirm it ({e}); \
                     the same credentials will be reported again on the next call"
                )));
            }
        }
        tracing::info!(
            from = ?current_port,
            to = port,
            stage = "rotated",
            status = 200,
            "control plane accepted the rotation"
        );

        self.accept_rotation_report(&frozen);
        tracing::info!(from = ?current_port, to = port, "rotation complete");
        Ok(port)
    }

    /// Freeze the report that is about to be sent, returning the freeze it
    /// replaces (if any). A disk error is logged but never blocks the rotation:
    /// the in-memory copy still covers this process.
    fn freeze_rotation_report(
        &self,
        report: &PendingRotationReport,
    ) -> Option<PendingRotationReport> {
        let mut state = self.state.lock().expect("state poisoned");
        let previous = state.pending_rotation_report.replace(report.clone());
        if let Err(e) = self.store.save(&state) {
            tracing::error!(error = %e, "failed to persist the frozen rotation report");
        }
        previous
    }

    /// The control plane refused `rejected`, so the node is rolled back to the
    /// config its predecessor froze: that freeze becomes the pending record
    /// again, because it is exactly what the rollback serves.
    fn roll_back_freeze(
        &self,
        rejected: &PendingRotationReport,
        previous: Option<PendingRotationReport>,
    ) {
        let mut state = self.state.lock().expect("state poisoned");
        if state.pending_rotation_report.as_ref() != Some(rejected) {
            return;
        }
        state.pending_rotation_report = previous;
        if let Err(e) = self.store.save(&state) {
            tracing::error!(error = %e, "failed to restore the previous rotation freeze");
        }
    }

    /// The control plane accepted `report`: it becomes the acknowledged state
    /// and the freeze is cleared.
    fn accept_rotation_report(&self, report: &PendingRotationReport) {
        let now = crate::auth::now_unix();
        let mut state = self.state.lock().expect("state poisoned");
        state.remember_port(report.port, self.cfg.recent_ports_keep);
        let stored = state
            .last_desired
            .clone()
            .map(|mut d| {
                d.port = report.port;
                d.password = report.password.clone();
                d.singbox_version = report.singbox_version.clone();
                d.at_unix = now;
                d
            })
            .unwrap_or_else(|| StoredDesired {
                port: report.port,
                password: report.password.clone(),
                control_port: report.control_port,
                singbox_version: report.singbox_version.clone(),
                singbox_sha256: String::new(),
                singbox_url: String::new(),
                at_unix: now,
            });
        state.last_desired = Some(stored);
        if state.pending_rotation_report.as_ref() == Some(report) {
            state.pending_rotation_report = None;
        }
        if let Err(e) = self.store.save(&state) {
            tracing::error!(error = %e, "failed to persist the accepted rotation");
        }
    }

    fn clear_pending_rotation(&self, report: &PendingRotationReport) {
        let mut state = self.state.lock().expect("state poisoned");
        if state.pending_rotation_report.as_ref() == Some(report) {
            state.pending_rotation_report = None;
            if let Err(e) = self.store.save(&state) {
                tracing::error!(error = %e, "failed to clear the frozen rotation report");
            }
        }
    }

    /// Resend a `rotated` report whose response was lost. Best effort once per
    /// call and on the metering tick, never a timer of its own: the credentials
    /// were already applied and verified locally, so the only missing piece is
    /// the control plane's copy. With nothing frozen it makes no request at all.
    pub(crate) async fn flush_pending_rotation(&self) {
        // Rotation / upgrade / apply hold this lock while they change the
        // credentials; a concurrent flush could report a pair that is about to
        // be replaced.
        let Ok(_guard) = self.busy.try_lock() else {
            return;
        };
        let Some(pending) = self
            .state
            .lock()
            .expect("state poisoned")
            .pending_rotation_report
            .clone()
        else {
            return;
        };

        // Never report credentials the node does not serve: a restart may have
        // re-applied the control plane's desired state, which makes the freeze
        // stale rather than pending. A read error says nothing about the node,
        // so the freeze stays.
        let applied = match self.singbox.applied().await {
            Ok(applied) => applied,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "cannot read the running config; keeping the frozen rotation report"
                );
                return;
            }
        };
        let serving = applied
            .as_ref()
            .map(|a| a.port == pending.port && a.password == pending.password)
            .unwrap_or(false);
        if !serving {
            tracing::warn!(
                port = pending.port,
                "dropping a frozen rotation report the node no longer serves"
            );
            self.clear_pending_rotation(&pending);
            return;
        }

        let body = self
            .report(Stage::Rotated, pending.port, pending.control_port)
            .with_singbox_version(pending.singbox_version.clone())
            .with_password(pending.password.clone());
        match self.control.report(&body).await {
            Ok(()) => {
                tracing::info!(
                    port = pending.port,
                    "the frozen rotation report was accepted on resend"
                );
                self.accept_rotation_report(&pending);
            }
            Err(e) if explicitly_rejected(&e) => {
                // Refused after all: put the last acknowledged credentials back
                // so both sides hold the same, older pair.
                tracing::error!(
                    port = pending.port,
                    error = %e,
                    "the control plane rejected the frozen rotation; restoring the acknowledged config"
                );
                self.clear_pending_rotation(&pending);
                self.restore_acknowledged().await;
            }
            Err(e) => tracing::warn!(
                port = pending.port,
                error = %e,
                "the frozen rotation report is still unconfirmed; retrying on the next call"
            ),
        }
    }

    /// Apply the last acknowledged credentials. Only used when the control
    /// plane explicitly refuses the frozen rotation.
    async fn restore_acknowledged(&self) {
        let Some(desired) = self.last_desired() else {
            tracing::error!("no acknowledged credentials to restore after the rejection");
            return;
        };
        match self.singbox.apply(desired.port, &desired.password).await {
            Ok(()) => tracing::info!(
                port = desired.port,
                "restored the acknowledged credentials"
            ),
            Err(e) => tracing::error!(
                port = desired.port,
                error = %e.message,
                "restoring the acknowledged credentials failed"
            ),
        }
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

    /// Say `active` again with the credentials the node actually serves.
    ///
    /// Run once at startup and before every tool call: `apply_desired` can
    /// succeed while its `active` report never lands, and the control plane
    /// would then keep the machine in installing/verifying and sweep it. The
    /// endpoint is idempotent for an already-active machine (`already_active`),
    /// and a failure here never fails the caller.
    ///
    /// A frozen `rotated` report is resent first: once it lands, the resumed
    /// credentials become the acknowledged state, which is what makes the
    /// `active` announcement below match the running config again.
    pub async fn reannounce_active(&self) {
        self.flush_pending_rotation().await;
        self.announce_active(None).await;
    }

    /// `version` overrides the version to report; `None` uses the persisted
    /// desired state. Only announced when the node really serves that config.
    async fn announce_active(&self, version: Option<String>) {
        let Some(desired) = self.last_desired() else {
            return;
        };
        // A read error is not "the node serves nothing": swallowing it here
        // means `active` is never re-announced and the control plane can sit in
        // installing/verifying until it is swept. Say so and keep going.
        let applied = match self.singbox.applied().await {
            Ok(applied) => applied,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "could not read the applied sing-box config; not announcing active"
                );
                return;
            }
        };
        if !applied.map(|a| a.matches(&desired)).unwrap_or(false) {
            return;
        }
        if !matches!(self.singbox.is_active().await, Ok(true)) {
            return;
        }
        let version = version.unwrap_or_else(|| desired.singbox.version.clone());
        let body = self
            .report(Stage::Active, desired.port, desired.control_port)
            .with_singbox_version(version);
        match self.control.report(&body).await {
            Ok(()) => {
                self.active_confirmed.store(true, Ordering::SeqCst);
                tracing::debug!(port = desired.port, "active re-announced");
            }
            Err(e) => tracing::warn!(
                error = %e,
                "active re-announce failed; the node keeps serving"
            ),
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
        state.last_desired = Some(StoredDesired::from_desired(
            desired,
            crate::auth::now_unix(),
        ));
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
        self.report_with_retries(&body).await.map(|()| {
            self.active_confirmed.store(true, Ordering::SeqCst);
        })
    }

    /// Apply the control plane's desired state when it differs, and announce
    /// `active` even when nothing changed. Called once at startup: nothing in
    /// the agent applies a desired state on a timer any more.
    pub async fn apply_if_needed(&self, desired: &DesiredState) -> Result<(), RotateError> {
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
            if let Err(e) = self.report_active(desired, false).await {
                tracing::warn!(error = %e.public_message(), "active report failed");
            }
            return Ok(());
        }
        tracing::info!(
            desired_port = desired.port,
            "desired state changed, applying"
        );
        self.apply_desired(desired, false).await
    }

    /// Install the sing-box version the control plane currently ships.
    ///
    /// The desired state is fetched here with the agent's own server token, so
    /// the caller cannot pick a version, URL or checksum. Credentials are not
    /// touched: the existing config is restarted as it is and has to pass the
    /// liveness probe again. A failure leaves the machine serving and never
    /// reports `failed` (the control plane would treat that as a dead node).
    async fn upgrade_inner(&self) -> Result<UpgradeOutcome, RotateError> {
        let desired = self
            .control
            .desired_state()
            .await
            .map_err(RotateError::from)?;
        let target = desired.singbox.version.trim_start_matches('v').to_string();
        let current = self.singbox.installed_version().await.ok().flatten();
        let installed = current.clone().unwrap_or_else(|| "unknown".into());
        if current.as_deref() == Some(target.as_str()) {
            tracing::info!(version = %target, "sing-box is already at the desired version");
            // The control plane's version column can be stale after an `active`
            // report that never landed; saying it again is how it catches up.
            self.announce_active(Some(target.clone())).await;
            return Ok(UpgradeOutcome {
                installed,
                target,
                upgraded: false,
            });
        }

        // The port comes from the config on disk: the binary swap must not
        // require a new config, and the self-check has to prove the existing
        // one still serves.
        let applied = self
            .singbox
            .applied()
            .await
            .map_err(|e| RotateError::fatal(format!("read current config: {e}")))?;
        let Some(applied) = applied else {
            return Err(RotateError::fatal(
                "this node has no sing-box config; rebuild it instead of upgrading",
            ));
        };

        tracing::info!(from = %installed, to = %target, "upgrading sing-box");
        // Keep the binary that is about to be replaced: a version that does not
        // start must not take the node down for good.
        let backup = self
            .singbox
            .backup_binary()
            .await
            .map_err(|e| RotateError::fatal(e.message))?;

        let applied_ok: Result<(), ApplyError> = async {
            self.singbox
                .ensure_binary(&desired.singbox, &self.cfg.download_dir)
                .await?;
            self.singbox.restart().await?;
            self.singbox
                .verify(
                    applied.port,
                    self.cfg.egress_probe.parse().expect("validated"),
                )
                .await
        }
        .await;

        if let Err(e) = applied_ok {
            let mut err = RotateError::fatal(e.message);
            if let Some(backup) = &backup {
                let after = self.singbox.installed_version().await.ok().flatten();
                match (&current, &after) {
                    // Provably the same binary: the upgrade never replaced it,
                    // so the backup is a redundant copy.
                    (Some(before), Some(now)) if before == now => {
                        self.singbox.discard_binary_backup(backup).await;
                    }
                    // Neither side could name a version. There is nothing to
                    // compare, so this is the conservative choice: keep the
                    // backup (it may be the only good binary left) and do not
                    // restart a node we cannot judge.
                    (None, None) => tracing::warn!(
                        backup = %backup.display(),
                        "cannot tell whether the binary changed; keeping the backup"
                    ),
                    // A different version, or a binary that used to identify
                    // itself and no longer can: the swap happened.
                    _ => {
                        tracing::warn!(
                            from = %installed,
                            "the upgrade failed; restoring the previous binary"
                        );
                        match self.singbox.restore_binary(backup).await {
                            Ok(()) => {
                                if let Err(restart) = self.singbox.restart().await {
                                    tracing::error!(
                                        error = %restart.message,
                                        "the previous binary is back but sing-box did not restart"
                                    );
                                }
                                self.singbox.discard_binary_backup(backup).await;
                            }
                            Err(restore) => {
                                // Keep the backup: it is the only good binary
                                // left, and `backup_binary` reuses it next time
                                // instead of copying whatever is installed now.
                                tracing::error!(
                                    error = %restore.message,
                                    backup = %backup.display(),
                                    "restoring the previous sing-box binary failed; the backup is kept"
                                );
                                err.message = format!(
                                    "{}; restoring the previous binary failed, the backup is kept at {}",
                                    err.message,
                                    backup.display()
                                );
                            }
                        }
                    }
                }
            }
            // `failed` destroys a machine the control plane still considers
            // mid-install, so it only goes out for a node that has already been
            // acknowledged as active. Anything else gets the tool error alone.
            if self.active_confirmed.load(Ordering::SeqCst) {
                self.report_failed(applied.port, desired.control_port, &err)
                    .await;
            } else {
                tracing::warn!(
                    error = %err.public_message(),
                    "upgrade failed before the control plane confirmed this node as active; reporting the error only"
                );
            }
            return Err(err);
        }
        if let Some(backup) = &backup {
            self.singbox.discard_binary_backup(backup).await;
        }

        // Only the version moved; the control plane refreshes `singbox_version`
        // from this report. A failed report is not an upgrade failure: the node
        // already serves the new binary.
        let body = self
            .report(Stage::Active, applied.port, desired.control_port)
            .with_singbox_version(target.clone());
        if let Err(e) = self.report_with_retries(&body).await {
            tracing::error!(
                error = %e.public_message(),
                "upgraded, but the active report failed; the control plane keeps the old version"
            );
        } else {
            self.active_confirmed.store(true, Ordering::SeqCst);
        }

        let mut state = self.state.lock().expect("state poisoned");
        state.last_desired = Some(StoredDesired::from_desired(
            &desired,
            crate::auth::now_unix(),
        ));
        if let Err(e) = self.store.save(&state) {
            tracing::error!(error = %e, "failed to persist the upgraded desired state");
        }
        drop(state);

        tracing::info!(from = %installed, to = %target, "sing-box upgraded");
        Ok(UpgradeOutcome {
            installed,
            target,
            upgraded: true,
        })
    }
}

#[async_trait]
impl Rotator for RotationEngine {
    async fn rotate(&self, _reason: Option<String>) -> Result<u16, RotateError> {
        let _guard = self.busy.try_lock().map_err(|_| RotateError::busy())?;
        self.rotate_inner().await
    }

    async fn upgrade_singbox(&self) -> Result<UpgradeOutcome, RotateError> {
        let _guard = self.busy.try_lock().map_err(|_| RotateError::busy())?;
        self.upgrade_inner().await
    }

    async fn reannounce_active(&self) {
        RotationEngine::reannounce_active(self).await;
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
        lose_rotated: Mutex<bool>,
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
            // The request arrived, the response never came back.
            if body.stage == Stage::Rotated && *self.lose_rotated.lock().unwrap() {
                return Err(ControlError::Transport("response lost".into()));
            }
            Ok(())
        }

        async fn desired_state(&self) -> Result<DesiredState, ControlError> {
            Ok(self.desired.lock().unwrap().clone())
        }

        async fn traffic(&self, _seq: u64, _delta_bytes: u64) -> Result<(), ControlError> {
            Ok(())
        }
    }

    fn config(dir: &Path) -> Arc<AgentConfig> {
        Arc::new(AgentConfig {
            control_plane_url: "https://control.example.com".into(),
            enrollment_token: None,
            enroll_url: None,
            fail_url: None,
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
            egress_probe: "1.1.1.1:443".into(),
            traffic: Default::default(),
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
        engine_with(dir, host, control, cfg)
    }

    fn engine_with(
        dir: &Path,
        host: Arc<FakeHost>,
        control: Arc<FakeControl>,
        cfg: Arc<AgentConfig>,
    ) -> (RotationEngine, Arc<AgentConfig>) {
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
        crate::cert::ensure_dev_certs(&dir.join("certs"), &[]).unwrap();
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
    async fn a_failed_report_carries_the_redacted_log_tail() {
        let dir = tmpdir("failed-excerpt");
        let log_path = dir.join("agent.log");
        std::fs::write(&log_path, "INFO boot\nDEBUG password=hunter2\n").unwrap();
        let mut cfg = (*config(&dir)).clone();
        cfg.log.file = Some(log_path);

        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, _cfg) = engine_with(&dir, host, control.clone(), Arc::new(cfg));

        engine.report_failed(30412, 32100, "install failed").await;

        let reports = control.reports.lock().unwrap();
        let last = reports.last().expect("failed report");
        assert_eq!(last.stage, Stage::Failed);
        let excerpt = last.log_excerpt.as_deref().expect("log excerpt");
        assert!(excerpt.contains("INFO boot"));
        assert!(!excerpt.contains("hunter2"), "excerpt must stay redacted");
        std::fs::remove_dir_all(&dir).ok();
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
            lose_rotated: Mutex::new(false),
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
            lose_rotated: Mutex::new(false),
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
        // A rejected rotation must not persist the new port history, and the
        // freeze has to be gone: the node and the control plane both keep the
        // old pair.
        let state = StateStore::new(cfg.state_path()).load().unwrap();
        assert_eq!(state.pending_rotation_report, None);
        assert_eq!(state.applied_port, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_lost_rotated_response_keeps_the_frozen_credentials() {
        let dir = tmpdir("rotated-lost");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(true),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());

        let err = engine.rotate(None).await.unwrap_err();
        assert_eq!(err.kind, RotateErrorKind::Retryable);

        let frozen = engine
            .state_handle()
            .lock()
            .unwrap()
            .pending_rotation_report
            .clone()
            .expect("the report is frozen before it is sent");
        let sent = control.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(sent.stage, Stage::Rotated);
        assert_eq!(sent.port, frozen.port);
        assert_eq!(sent.password.as_deref(), Some(frozen.password.as_str()));

        // The node keeps serving the new pair; rolling back here is what leaves
        // the control plane and the node holding different credentials.
        let applied = engine.singbox.applied().await.unwrap().unwrap();
        assert_eq!(applied.port, frozen.port);
        assert_eq!(applied.password, frozen.password);

        // Frozen on disk too, so a restart resends the same pair.
        let on_disk = StateStore::new(cfg.state_path()).load().unwrap();
        assert_eq!(on_disk.pending_rotation_report, Some(frozen));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn the_resend_carries_the_exact_same_credentials() {
        let dir = tmpdir("rotated-resend");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(true),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        engine.rotate(None).await.unwrap_err();
        let frozen = engine
            .state_handle()
            .lock()
            .unwrap()
            .pending_rotation_report
            .clone()
            .expect("frozen");

        // The control plane is reachable again; the next call resends.
        *control.lose_rotated.lock().unwrap() = false;
        engine.reannounce_active().await;

        let reports = control.reports.lock().unwrap().clone();
        let rotated: Vec<&ReportRequest> = reports
            .iter()
            .filter(|r| r.stage == Stage::Rotated)
            .collect();
        assert_eq!(rotated.len(), 2, "the retry resends, it does not rotate again");
        for resent in rotated {
            assert_eq!(resent.port, frozen.port);
            assert_eq!(resent.password.as_deref(), Some(frozen.password.as_str()));
        }
        drop(reports);

        let state = engine.state_handle().lock().unwrap().clone();
        assert_eq!(state.pending_rotation_report, None);
        let stored = state.last_desired.expect("acknowledged after the resend");
        assert_eq!(stored.port, frozen.port);
        assert_eq!(stored.password, frozen.password);
        let on_disk = StateStore::new(cfg.state_path()).load().unwrap();
        assert_eq!(on_disk.pending_rotation_report, None);
        assert_eq!(on_disk.last_desired.map(|d| d.port), Some(frozen.port));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_stale_freeze_is_dropped_when_the_node_serves_other_credentials() {
        let dir = tmpdir("rotated-stale");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        // A restart re-applied the control plane's desired state: the freeze is
        // stale, and resending it would report credentials nobody serves.
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, "from-control-plane", "aes-256-gcm").into_bytes(),
        );
        *engine.state_handle().lock().unwrap() = AgentState {
            last_desired: Some(StoredDesired::from_desired(&desired(30412, "1.14.4"), 0)),
            pending_rotation_report: Some(PendingRotationReport {
                port: 30555,
                password: "frozen-but-not-served".into(),
                control_port: 32100,
                singbox_version: "1.14.4".into(),
                at_unix: 0,
            }),
            ..Default::default()
        };

        engine.reannounce_active().await;

        let reports = control.reports.lock().unwrap();
        assert!(!reports.iter().any(|r| r.stage == Stage::Rotated));
        drop(reports);
        let state = engine.state_handle().lock().unwrap().clone();
        assert_eq!(state.pending_rotation_report, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_flush_without_a_freeze_makes_no_request() {
        let dir = tmpdir("flush-idle");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, _cfg) = engine(&dir, host, control.clone());

        engine.flush_pending_rotation().await;

        assert!(control.reports.lock().unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_accepted_rotation_clears_the_freeze() {
        let dir = tmpdir("rotated-accepted");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());

        let port = engine.rotate(None).await.unwrap();

        let state = engine.state_handle().lock().unwrap().clone();
        assert_eq!(state.pending_rotation_report, None);
        let stored = state.last_desired.expect("acknowledged state");
        assert_eq!(stored.port, port);
        let sent = control.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(sent.password.as_deref(), Some(stored.password.as_str()));
        let on_disk = StateStore::new(cfg.state_path()).load().unwrap();
        assert_eq!(on_disk.pending_rotation_report, None);
        assert_eq!(on_disk.last_desired.map(|d| d.port), Some(port));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_resend_the_control_plane_rejects_restores_the_acknowledged_pair() {
        let dir = tmpdir("rotated-resend-reject");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(true),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, "from-control-plane", "aes-256-gcm").into_bytes(),
        );
        *engine.state_handle().lock().unwrap() = AgentState {
            last_desired: Some(StoredDesired::from_desired(&desired(30412, "1.14.4"), 0)),
            ..Default::default()
        };

        engine.rotate(None).await.unwrap_err();
        assert!(engine
            .state_handle()
            .lock()
            .unwrap()
            .pending_rotation_report
            .is_some());

        // The retry gets an explicit refusal: both sides go back to the pair
        // the control plane still holds.
        *control.lose_rotated.lock().unwrap() = false;
        *control.reject_rotated.lock().unwrap() = true;
        engine.reannounce_active().await;

        let applied = engine.singbox.applied().await.unwrap().unwrap();
        assert_eq!(applied.port, 30412);
        assert_eq!(applied.password, "from-control-plane");
        let state = engine.state_handle().lock().unwrap().clone();
        assert_eq!(state.pending_rotation_report, None);
        assert_eq!(state.last_desired.map(|d| d.port), Some(30412));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_rejected_rotation_keeps_the_unconfirmed_freeze_it_rolled_back_to() {
        let dir = tmpdir("rotated-chain");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(true),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());

        // Rotation A: applied locally, its response was lost.
        engine.rotate(None).await.unwrap_err();
        let a = engine
            .state_handle()
            .lock()
            .unwrap()
            .pending_rotation_report
            .clone()
            .expect("A is frozen");

        // Rotation B: the control plane refuses it, so the node rolls back to
        // A's config — and A's freeze must come back with it, or the node ends
        // up serving credentials nobody has a pending record of.
        *control.lose_rotated.lock().unwrap() = false;
        *control.reject_rotated.lock().unwrap() = true;
        let err = engine.rotate(None).await.unwrap_err();
        assert_eq!(err.kind, RotateErrorKind::Fatal);

        let state = engine.state_handle().lock().unwrap().clone();
        assert_eq!(state.pending_rotation_report, Some(a.clone()));
        let applied = engine.singbox.applied().await.unwrap().unwrap();
        assert_eq!(applied.port, a.port);
        assert_eq!(applied.password, a.password);
        let on_disk = StateStore::new(cfg.state_path()).load().unwrap();
        assert_eq!(on_disk.pending_rotation_report, Some(a));
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
            lose_rotated: Mutex::new(false),
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
            lose_rotated: Mutex::new(false),
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

        engine
            .apply_if_needed(&desired(30412, "1.14.4"))
            .await
            .unwrap();
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
            lose_rotated: Mutex::new(false),
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
            lose_rotated: Mutex::new(false),
        });
        let (engine, _cfg) = engine(&dir, host, control);
        let guard = engine.busy().try_lock_owned().unwrap();
        let err = engine.rotate(None).await.unwrap_err();
        assert_eq!(err.kind, RotateErrorKind::Retryable);
        drop(guard);
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
    async fn upgrade_returns_a_dead_server_token_without_installing() {
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

            async fn traffic(&self, _seq: u64, _delta_bytes: u64) -> Result<(), ControlError> {
                Ok(())
            }
        }

        let dir = tmpdir("upgrade-terminal");
        let cfg = config(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let host = Arc::new(FakeHost::new());
        let singbox = Arc::new(SingBox::new(cfg.singbox.clone(), host.clone()));
        crate::cert::ensure_dev_certs(&dir.join("certs"), &[]).unwrap();
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
        let err = engine.upgrade_singbox().await.unwrap_err();
        assert_eq!(err.status, Some(409));
        // A node the control plane no longer knows must not be touched.
        assert!(!host.commands().iter().any(|(p, _)| p == "install"));
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
            lose_rotated: Mutex::new(false),
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

        let outcome = engine.apply_if_needed(&d).await;
        assert!(outcome.is_ok());
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
            lose_rotated: Mutex::new(false),
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

        let err = engine.apply_if_needed(&d).await.unwrap_err();
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
    async fn upgrade_installs_the_desired_version_and_reports_active() {
        let dir = tmpdir("upgrade-ok");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.15.0")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, "current-password", "aes-256-gcm").into_bytes(),
        );
        host.set_download(vec![0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
        host.set_hash(&"f".repeat(64));
        host.set_command_output("tar", 0, "-rwxr-xr-x 0/0 3 2024-01-01 00:00 sing-box\n", "");
        host.put_file(
            &cfg.download_dir.join("extract-1.15.0/sing-box"),
            b"elf".to_vec(),
        );
        // `version` answers 1.14.4 twice (before the upgrade and again inside
        // `ensure_binary`) and 1.15.0 after the install.
        host.queue_command_outputs(
            cfg.singbox.binary_path.to_str().unwrap(),
            &[
                (0, "sing-box version 1.14.4\n", ""),
                (0, "sing-box version 1.14.4\n", ""),
                (0, "sing-box version 1.15.0\n", ""),
            ],
        );

        let outcome = engine.upgrade_singbox().await.unwrap();
        assert_eq!(
            outcome,
            UpgradeOutcome {
                installed: "1.14.4".into(),
                target: "1.15.0".into(),
                upgraded: true,
            }
        );
        let stages: Vec<Stage> = control
            .reports
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.stage)
            .collect();
        assert_eq!(stages, vec![Stage::Active]);
        let report = &control.reports.lock().unwrap()[0];
        assert_eq!(report.singbox_version, "1.15.0");
        // The config (and therefore the password) is untouched by an upgrade.
        assert_eq!(report.port, 30412);
        assert!(report.password.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn upgrade_is_a_no_op_when_the_version_already_matches() {
        let dir = tmpdir("upgrade-current");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.14.4")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, "current-password", "aes-256-gcm").into_bytes(),
        );
        let commands_before = host.commands().len();

        let outcome = engine.upgrade_singbox().await.unwrap();
        assert_eq!(
            outcome,
            UpgradeOutcome {
                installed: "1.14.4".into(),
                target: "1.14.4".into(),
                upgraded: false,
            }
        );
        // Only the version read may run: no download, install or restart.
        let commands = host.commands();
        assert_eq!(commands.len(), commands_before + 1);
        assert!(!commands
            .iter()
            .any(|(p, _)| p == "install" || p == "systemctl" || p == "tar"));
        assert!(control.reports.lock().unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn upgrade_is_refused_while_another_operation_holds_the_lock() {
        let dir = tmpdir("upgrade-busy");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.15.0")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, _cfg) = engine(&dir, host, control);
        let guard = engine.busy().try_lock_owned().unwrap();
        let err = engine.upgrade_singbox().await.unwrap_err();
        assert_eq!(err.kind, RotateErrorKind::Retryable);
        // The envelope needs to say *why* it is retryable.
        assert_eq!(err.reason, Some("agent_busy"));
        drop(guard);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_failed_upgrade_puts_the_previous_binary_back_and_reports_failed() {
        let dir = tmpdir("upgrade-rollback");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.15.0")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, "current-password", "aes-256-gcm").into_bytes(),
        );
        // The control plane already knows this node as active.
        *engine.state_handle().lock().unwrap() = AgentState {
            last_desired: Some(StoredDesired::from_desired(
                &DesiredState {
                    password: "current-password".into(),
                    ..desired(30412, "1.14.4")
                },
                0,
            )),
            ..Default::default()
        };
        engine.reannounce_active().await;
        control.reports.lock().unwrap().clear();
        // The running binary and the one that will replace it differ, so the
        // rollback is visible on disk.
        host.put_file(&cfg.singbox.binary_path, b"old-elf".to_vec());
        host.set_download(vec![0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
        host.set_hash(&"f".repeat(64));
        host.set_command_output("tar", 0, "-rwxr-xr-x 0/0 3 2024-01-01 00:00 sing-box\n", "");
        host.put_file(
            &cfg.download_dir.join("extract-1.15.0/sing-box"),
            b"new-elf".to_vec(),
        );
        // before, inside `ensure_binary`, after the install, and again when
        // deciding whether the swap actually happened.
        host.queue_command_outputs(
            cfg.singbox.binary_path.to_str().unwrap(),
            &[
                (0, "sing-box version 1.14.4\n", ""),
                (0, "sing-box version 1.14.4\n", ""),
                (0, "sing-box version 1.15.0\n", ""),
                (0, "sing-box version 1.15.0\n", ""),
            ],
        );
        // The new binary does not come up.
        host.set_command_output("systemctl", 1, "", "restart failed");

        let err = engine.upgrade_singbox().await.unwrap_err();
        assert_eq!(err.kind, RotateErrorKind::Fatal);

        let binary_str = cfg.singbox.binary_path.to_string_lossy().to_string();
        let backup = cfg.singbox.binary_path.with_extension("bak");
        let backup_str = backup.to_string_lossy().to_string();
        let backup_tmp = format!("{backup_str}.tmp");
        let commands = host.commands();
        // A copy of the running binary was staged next to the backup …
        assert!(commands
            .iter()
            .any(|(p, args)| p == "install"
                && args.get(2) == Some(&binary_str)
                && args.get(3) == Some(&backup_tmp)));
        // … and put back once the new one refused to start.
        assert!(commands
            .iter()
            .any(|(p, args)| p == "install" && args.get(2) == Some(&backup_str)));
        assert_eq!(
            host.file(&cfg.singbox.binary_path),
            Some(b"old-elf".to_vec()),
            "the previous binary is back on disk"
        );

        let reports = control.reports.lock().unwrap();
        let failed = reports.last().expect("a failed report");
        assert_eq!(failed.stage, Stage::Failed);
        // The report carries the version that is really installed, not the
        // target, so `singbox_version` never jumps ahead of reality.
        assert_eq!(failed.singbox_version, "1.14.4");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_failed_upgrade_before_the_node_is_active_reports_nothing() {
        let dir = tmpdir("upgrade-rollback-unconfirmed");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.15.0")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, "current-password", "aes-256-gcm").into_bytes(),
        );
        host.set_download(vec![0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
        host.set_hash(&"f".repeat(64));
        host.set_command_output("tar", 0, "-rwxr-xr-x 0/0 3 2024-01-01 00:00 sing-box\n", "");
        host.put_file(
            &cfg.download_dir.join("extract-1.15.0/sing-box"),
            b"elf".to_vec(),
        );
        host.queue_command_outputs(
            cfg.singbox.binary_path.to_str().unwrap(),
            &[
                (0, "sing-box version 1.14.4\n", ""),
                (0, "sing-box version 1.14.4\n", ""),
                (0, "sing-box version 1.15.0\n", ""),
                (0, "sing-box version 1.15.0\n", ""),
            ],
        );
        host.set_command_output("systemctl", 1, "", "restart failed");

        let err = engine.upgrade_singbox().await.unwrap_err();
        assert_eq!(err.kind, RotateErrorKind::Fatal);

        // The control plane still considers this node mid-install: a `failed`
        // report would destroy it, so the tool error is all that goes out.
        assert!(control.reports.lock().unwrap().is_empty());
        // The previous binary is still put back.
        let backup = cfg
            .singbox
            .binary_path
            .with_extension("bak")
            .to_string_lossy()
            .to_string();
        assert!(host
            .commands()
            .iter()
            .any(|(p, args)| p == "install" && args.get(2) == Some(&backup)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn only_the_on_demand_upgrade_fetches_the_desired_state() {
        use std::sync::atomic::AtomicUsize;

        struct CountingControl {
            desired: DesiredState,
            calls: Arc<AtomicUsize>,
        }
        #[async_trait]
        impl ControlApi for CountingControl {
            async fn report(&self, _body: &ReportRequest) -> Result<(), ControlError> {
                Ok(())
            }
            async fn desired_state(&self) -> Result<DesiredState, ControlError> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(self.desired.clone())
            }

            async fn traffic(&self, _seq: u64, _delta_bytes: u64) -> Result<(), ControlError> {
                Ok(())
            }
        }

        let dir = tmpdir("no-polling");
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = config(&dir);
        let host = Arc::new(FakeHost::new());
        host.put_file(&cfg.singbox.binary_path, b"elf".to_vec());
        host.set_command_output(
            &cfg.singbox.binary_path.to_string_lossy(),
            0,
            "sing-box version 1.14.4\n",
            "",
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let control = Arc::new(CountingControl {
            desired: desired(30412, "1.14.4"),
            calls: calls.clone(),
        });
        let singbox = Arc::new(SingBox::new(cfg.singbox.clone(), host.clone()));
        crate::cert::ensure_dev_certs(&dir.join("certs"), &[]).unwrap();
        let identity =
            Arc::new(crate::identity::Identity::load(&dir.join("certs"), &[], None).unwrap());
        let engine = RotationEngine::new(
            cfg.clone(),
            singbox,
            control,
            Arc::new(Mutex::new(AgentState::default())),
            StateStore::new(cfg.state_path()),
            identity,
        );
        let d = desired(30412, "1.14.4");

        // None of the startup / rotation / re-announce paths may fetch the
        // desired state; only the on-demand upgrade does, once.
        engine.apply_if_needed(&d).await.unwrap();
        engine.reannounce_active().await;
        engine.rotate(None).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        let outcome = engine.upgrade_singbox().await.unwrap();
        assert!(!outcome.upgraded);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_upgrade_that_is_already_current_announces_active() {
        let dir = tmpdir("upgrade-current-announce");
        let host = Arc::new(FakeHost::new());
        let d = desired(30412, "1.14.4");
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(d.clone()),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, &d.password, "aes-256-gcm").into_bytes(),
        );
        *engine.state_handle().lock().unwrap() = AgentState {
            last_desired: Some(StoredDesired::from_desired(&d, 0)),
            ..Default::default()
        };

        let outcome = engine.upgrade_singbox().await.unwrap();
        assert!(!outcome.upgraded);
        // A lost `active` report must not leave `singbox_version` stale forever.
        let reports = control.reports.lock().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].stage, Stage::Active);
        assert_eq!(reports[0].singbox_version, "1.14.4");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_failed_restore_keeps_the_backup_for_the_next_attempt() {
        let dir = tmpdir("upgrade-keep-backup");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.15.0")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control);
        let backup = cfg.singbox.binary_path.with_extension("bak");
        // A backup left by an earlier attempt is the only good binary left.
        host.put_file(&cfg.singbox.binary_path, b"old-elf".to_vec());
        host.put_file(&backup, b"old-elf".to_vec());
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, "current-password", "aes-256-gcm").into_bytes(),
        );
        host.set_download(vec![0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
        host.set_hash(&"f".repeat(64));
        host.set_command_output("tar", 0, "-rwxr-xr-x 0/0 3 2024-01-01 00:00 sing-box\n", "");
        host.put_file(
            &cfg.download_dir.join("extract-1.15.0/sing-box"),
            b"new-elf".to_vec(),
        );
        host.queue_command_outputs(
            cfg.singbox.binary_path.to_str().unwrap(),
            &[
                (0, "sing-box version 1.14.4\n", ""),
                (0, "sing-box version 1.14.4\n", ""),
                (0, "sing-box version 1.15.0\n", ""),
                (0, "sing-box version 1.15.0\n", ""),
            ],
        );
        host.set_command_output("systemctl", 1, "", "restart failed");
        // Installing the new binary works; putting the backup back does not.
        host.queue_command_outputs("install", &[(0, "", ""), (1, "", "restore failed")]);

        let err = engine.upgrade_singbox().await.unwrap_err();
        assert!(
            err.public_message().contains("backup is kept"),
            "the error must say the backup survived: {err:?}"
        );
        assert_eq!(host.file(&backup), Some(b"old-elf".to_vec()));
        // An existing `.bak` is reused, never overwritten by the new binary.
        assert!(
            !host.commands().iter().any(|(p, args)| p == "install"
                && args
                    .get(3)
                    .map(|dest| dest.ends_with("sing-box.bak.tmp"))
                    .unwrap_or(false)),
            "an existing backup must be reused, not replaced"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_unreadable_version_on_both_sides_keeps_the_backup_without_restarting() {
        let dir = tmpdir("upgrade-unknown-version");
        let host = Arc::new(FakeHost::new());
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(desired(30412, "1.15.0")),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control);
        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, "current-password", "aes-256-gcm").into_bytes(),
        );
        // `version` never answers, so neither the old nor the new binary can
        // identify itself and there is nothing to compare.
        host.set_command_output(
            cfg.singbox.binary_path.to_str().unwrap(),
            1,
            "",
            "version failed",
        );
        host.set_download(vec![0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
        // The download never gets past the checksum check, so nothing is
        // installed and nothing should be restarted.
        host.set_hash("0000");

        let err = engine.upgrade_singbox().await.unwrap_err();
        assert!(err.public_message().contains("sha256 mismatch"), "{err:?}");
        assert!(!host.commands().iter().any(|(p, args)| p == "systemctl"
            && args.iter().any(|a| a == "restart")));
        // The backup stays for the next attempt.
        assert!(host
            .file(&cfg.singbox.binary_path.with_extension("bak"))
            .is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn reannounce_active_only_fires_when_the_node_serves_the_state() {
        let dir = tmpdir("reannounce");
        let host = Arc::new(FakeHost::new());
        let d = desired(30412, "1.14.4");
        let control = Arc::new(FakeControl {
            reports: Mutex::new(vec![]),
            desired: Mutex::new(d.clone()),
            fail_report: Mutex::new(false),
            reject_rotated: Mutex::new(false),
            lose_rotated: Mutex::new(false),
        });
        let (engine, cfg) = engine(&dir, host.clone(), control.clone());
        *engine.state_handle().lock().unwrap() = AgentState {
            last_desired: Some(StoredDesired::from_desired(&d, 0)),
            ..Default::default()
        };

        // The config does not carry the persisted credentials: reporting
        // `active` here would activate a node that serves something else.
        engine.reannounce_active().await;
        assert!(control.reports.lock().unwrap().is_empty());

        host.put_file(
            &cfg.singbox.config_path,
            crate::singbox::render_config(30412, &d.password, "aes-256-gcm").into_bytes(),
        );
        engine.reannounce_active().await;
        let reports = control.reports.lock().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].stage, Stage::Active);
        assert_eq!(reports[0].singbox_version, "1.14.4");
        std::fs::remove_dir_all(&dir).ok();
    }
}
