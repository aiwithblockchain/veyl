//! Veyl node agent.
//!
//! Two halves live here:
//! - the MCP control endpoint (self-signed TLS + one-time Ed25519 bearer
//!   tokens + `rotate_credentials`), shared by the demo and production;
//! - the machine manager (`agent::run`): enroll, install sing-box, report,
//!   rotate, and poll the desired state.

pub mod agent;
pub mod auth;
pub mod cert;
pub mod client;
pub mod config;
pub mod control;
pub mod host;
pub mod identity;
pub mod logging;
pub mod rotation;
pub mod server;
pub mod singbox;
pub mod state;

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

/// reqwest is built with `rustls-no-provider`; install the process provider
/// before constructing any TLS client or server.
pub fn init_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub struct AgentHandle {
    pub addr: SocketAddr,
    pub state: Arc<ServerState>,
    pub certs: CertPaths,
    pub ct: CancellationToken,
    pub task: tokio::task::JoinHandle<Result<()>>,
}

/// Start the MCP endpoint on an existing TLS identity.
pub async fn start_agent_with_certs(
    addr: SocketAddr,
    identity: Arc<Identity>,
    server_id: &str,
    verifying_key: VerifyingKey,
    rotator: Arc<dyn Rotator>,
    announce: bool,
) -> Result<AgentHandle> {
    let listener = server::bind(addr).await?;
    let addr = listener.local_addr()?;
    let state = ServerState::new(
        Arc::new(AuthState::new(verifying_key, server_id)),
        rotator,
        identity.clone(),
    );
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
