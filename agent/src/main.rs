//! `veyl-agent` CLI.
//!
//! Production (cloud-init unit): `veyl-agent --config /etc/veyl-agent.json`.
//! `serve`, `gen-certs` and `mint-token` are dev helpers behind the `dev`
//! feature and are not compiled into the production binary.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use veyl_agent::{agent, init_crypto_provider};

#[cfg(feature = "dev")]
use {
    anyhow::bail,
    std::net::SocketAddr,
    std::sync::Arc,
    std::time::Duration,
    veyl_agent::identity::Identity,
    veyl_agent::rotation::StubRotator,
    veyl_agent::{auth, cert, start_agent_with_certs},
};

#[derive(Parser)]
#[command(about = "Veyl node agent")]
struct Cli {
    /// Production config. With no subcommand this runs the agent (cloud-init).
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    /// Overrides the config file's log_level.
    #[arg(long, global = true)]
    log_level: Option<String>,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Enroll, install sing-box, serve MCP, and poll the desired state.
    Run,
    /// Dev only: serve MCP with a stub rotator (no sing-box, no control plane).
    #[cfg(feature = "dev")]
    Serve {
        #[arg(long, default_value = "127.0.0.1:32100")]
        addr: SocketAddr,
        #[arg(long, default_value = "agent-certs")]
        cert_dir: PathBuf,
        #[arg(long, default_value = "srv_local")]
        server_id: String,
        /// Ed25519 verifying key, 64 hex chars.
        #[arg(long)]
        signer_pubkey: String,
        /// Leaf SAN host(s)/IP(s), also accepted as the Host header.
        #[arg(long = "host")]
        hosts: Vec<String>,
    },
    /// Dev only: generate a CA + leaf and print both fingerprints.
    #[cfg(feature = "dev")]
    GenCerts {
        #[arg(long, default_value = "agent-certs")]
        dir: PathBuf,
        /// Hosts/IPs clients will use (repeatable); they become leaf SANs.
        #[arg(long = "host")]
        hosts: Vec<String>,
    },
    /// Dev only: mint one bearer token.
    #[cfg(feature = "dev")]
    MintToken {
        /// Ed25519 signing key seed, 64 hex chars.
        #[arg(long)]
        signing_key: String,
        #[arg(long, default_value = "srv_local")]
        server_id: String,
        #[arg(long, default_value_t = 60)]
        ttl_secs: u64,
        /// jti; random when omitted.
        #[arg(long)]
        jti: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    init_crypto_provider();
    let cli = Cli::parse();

    match cli.cmd {
        Some(Cmd::Run) | None => {
            let config = cli
                .config
                .context("--config is required (e.g. /etc/veyl-agent.json)")?;
            agent::run(&config, cli.log_level).await
        }
        #[cfg(feature = "dev")]
        Some(Cmd::Serve {
            addr,
            cert_dir,
            server_id,
            signer_pubkey,
            hosts,
        }) => {
            let verifying_key = auth::parse_verifying_key_hex(&signer_pubkey)?;
            let identity = Arc::new(Identity::load(&cert_dir, &hosts, None)?);
            println!("server_id:        {server_id}");
            println!("cert dir:         {}", cert_dir.display());
            println!(
                "CA cert SHA-256:  {}",
                cert::ca_fingerprint(&identity.certs().ca_cert)?
            );
            println!("leaf cert SHA-256:{}", identity.leaf_fingerprint());
            let handle = start_agent_with_certs(
                addr,
                identity,
                &server_id,
                verifying_key,
                Arc::new(StubRotator::default()),
                true,
                None,
            )
            .await?;
            eprintln!("press Ctrl-C to stop {}", handle.mcp_url());
            tokio::signal::ctrl_c().await?;
            handle.shutdown().await;
            Ok(())
        }
        #[cfg(feature = "dev")]
        Some(Cmd::GenCerts { dir, hosts }) => {
            let p = cert::generate_with_hosts(&dir, &hosts)?;
            println!("CA:      {}", p.ca_cert.display());
            println!("leaf:    {}", p.leaf_cert.display());
            println!("key:     {}", p.leaf_key.display());
            println!("CA   SHA-256: {}", cert::ca_fingerprint(&p.ca_cert)?);
            println!("leaf SHA-256: {}", cert::leaf_fingerprint(&p.leaf_cert)?);
            Ok(())
        }
        #[cfg(feature = "dev")]
        Some(Cmd::MintToken {
            signing_key,
            server_id,
            ttl_secs,
            jti,
        }) => {
            let sk = auth::parse_signing_key_hex(&signing_key)?;
            if !matches!(ttl_secs, 1..=3600) {
                bail!("--ttl-secs must be 1..=3600");
            }
            let jti = jti.unwrap_or_else(auth::random_jti);
            let token = auth::mint_token(
                &sk,
                &server_id,
                &jti,
                auth::now_unix() + Duration::from_secs(ttl_secs).as_secs(),
            );
            println!("{token}");
            Ok(())
        }
    }
}
