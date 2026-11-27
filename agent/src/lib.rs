//! Veyl node agent.
//!
//! Two halves live here:
//! - the MCP control endpoint (self-signed TLS + one-time Ed25519 bearer
//!   tokens + `rotate_credentials` / `upgrade_singbox`), shared by the demo and
//!   production;
//! - the machine manager (`agent::run`): enroll, install sing-box, report and
//!   rotate.

pub mod agent;
pub mod auth;
pub mod cert;
pub mod client;
pub mod config;
pub mod control;
pub mod health;
pub mod host;
pub mod identity;
pub mod logging;
pub mod rotation;
pub mod server;
pub mod singbox;
pub mod state;
pub mod traffic;

#[cfg(test)]
mod test_support;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use ed25519_dalek::VerifyingKey;
use tokio_util::sync::CancellationToken;

use crate::auth::AuthState;
use crate::cert::CertPaths;
use crate::identity::Identity;
use crate::rotation::Rotator;
use crate::server::ServerState;
use crate::traffic::MeteringView;

/// reqwest is built with `rustls-no-provider`; install the process provider
/// before constructing any TLS client or server.
pub fn init_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// When this process started. `get_status` reports it as `uptime_secs` because
/// the in-memory health table is cleared by a restart: without the uptime, an
/// empty table reads as "always healthy" rather than "healthy since restart".
static PROCESS_START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Record the start time. Call first thing in `main`; later calls are ignored.
pub fn mark_process_start() {
    PROCESS_START.get_or_init(std::time::Instant::now);
}

pub fn uptime_secs() -> u64 {
    PROCESS_START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs()
}

pub struct AgentHandle {
    pub addr: SocketAddr,
    pub state: Arc<ServerState>,
    pub certs: CertPaths,
    pub ct: CancellationToken,
    pub task: tokio::task::JoinHandle<Result<()>>,
}

/// Start the MCP endpoint on an existing TLS identity. `replay_path` persists
/// used jtis (production); dev helpers pass None. `metering` is the read-only
/// view `get_status` reports — `None` when there is no meter (dev `serve`).
// Each parameter is a distinct dependency of a one-shot bootstrap; bundling
// them into a struct would only move the list somewhere else.
#[allow(clippy::too_many_arguments)]
pub async fn start_agent_with_certs(
    addr: SocketAddr,
    identity: Arc<Identity>,
    server_id: &str,
    verifying_key: VerifyingKey,
    rotator: Arc<dyn Rotator>,
    announce: bool,
    replay_path: Option<std::path::PathBuf>,
    metering: Option<Arc<dyn MeteringView>>,
) -> Result<AgentHandle> {
    let listener = server::bind(addr).await?;
    let addr = listener.local_addr()?;
    let auth = match replay_path {
        Some(path) => AuthState::with_store(verifying_key, server_id, path),
        None => AuthState::new(verifying_key, server_id),
    };
    let state = ServerState::new(Arc::new(auth), rotator, identity.clone(), metering);
    let certs = identity.certs().clone();
    let ct = CancellationToken::new();
    let task = tokio::spawn(server::serve(listener, state.clone(), ct.clone()));
    if announce {
        println!("MCP endpoint:     https://{addr}/mcp");
    } else {
        tracing::info!(%addr, "MCP endpoint listening");
    }

    Ok(AgentHandle {
        addr,
        state,
        certs,
        ct,
        task,
    })
}

impl AgentHandle {
    pub fn mcp_url(&self) -> String {
        format!("https://{}/mcp", self.addr)
    }

    pub async fn shutdown(self) {
        self.ct.cancel();
        let _ = self.task.await;
    }
}

/// Await the MCP task. Any exit — clean return, error, panic — is fatal: the
/// caller logs and exits non-zero so systemd restarts the process. Otherwise
/// the unit stays "active" while port 32100 is dead.
pub async fn supervise_mcp(task: &mut tokio::task::JoinHandle<Result<()>>) -> Result<()> {
    match task.await {
        Ok(Ok(())) => Err(anyhow::anyhow!("MCP server task exited unexpectedly")),
        Ok(Err(e)) => Err(e.context("MCP server task failed")),
        Err(e) if e.is_panic() => Err(anyhow::anyhow!("MCP server task panicked: {e}")),
        Err(e) => Err(anyhow::anyhow!("MCP server task stopped: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_finished_mcp_task_is_reported_as_fatal() {
        let mut task = tokio::spawn(async { Err(anyhow::anyhow!("bind lost")) });
        let err = supervise_mcp(&mut task).await.unwrap_err();
        assert!(err.to_string().contains("MCP server task failed"));
    }

    #[tokio::test]
    async fn a_cleanly_returning_mcp_task_is_also_fatal() {
        let mut task = tokio::spawn(async { Ok(()) });
        let err = supervise_mcp(&mut task).await.unwrap_err();
        assert!(err.to_string().contains("exited unexpectedly"));
    }
}
