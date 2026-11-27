//! End-to-end demo: self-signed TLS + one-time Ed25519 bearer token + one
//! stub `rotate_credentials` call.
//!
//! Run with `cargo run --example demo`. Exit code 0 means every scenario
//! matched its expectation.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use ed25519_dalek::SigningKey;
use rand_core::OsRng;
use veyl_agent::auth;
use veyl_agent::client::{self, SessionOutcome};
use veyl_agent::identity::Identity;
use veyl_agent::rotation::StubRotator;
use veyl_agent::server::ServerState;
use veyl_agent::{cert, init_crypto_provider, start_agent_with_certs};

const SERVER_ID: &str = "srv_demo_001";
const TOKEN_TTL: Duration = Duration::from_secs(60);
const RMCP_TIMEOUT: Duration = Duration::from_secs(15);

struct Check {
    name: &'static str,
    ok: bool,
    detail: String,
}

fn short(s: &str, max: usize) -> String {
    let one_line = s.lines().next().unwrap_or("").trim().to_string();
    if one_line.chars().count() <= max {
        one_line
    } else {
        format!("{}…", one_line.chars().take(max).collect::<String>())
    }
}

fn execs(state: &ServerState) -> u64 {
    state.executions.load(Ordering::SeqCst)
}

async fn timed_session(
    url: &str,
    client: reqwest::Client,
    token: Option<&str>,
    call: bool,
) -> Result<SessionOutcome> {
    match tokio::time::timeout(
        RMCP_TIMEOUT,
        client::run_session(url, client, token, call),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => bail!("timed out after {}s", RMCP_TIMEOUT.as_secs()),
    }
}

fn ok_outcome(o: &SessionOutcome) -> bool {
    let tool_ok = o
        .tool_result
        .as_ref()
        .and_then(|v| v.get("ok"))
        .and_then(|v| v.as_bool())
        == Some(true);
    let port_ok = o
        .tool_result
        .as_ref()
        .and_then(|v| v.get("port"))
        .and_then(|v| v.as_u64())
        .map(|p| (30000..=30999).contains(&p))
        == Some(true);
    o.tools == ["rotate_credentials", "upgrade_singbox"] && tool_ok && port_ok
}

async fn happy(
    name: &'static str,
    url: &str,
    client: reqwest::Client,
    state: &Arc<ServerState>,
    signing: &SigningKey,
) -> Check {
    let before = execs(state);
    let token = auth::mint_token(
        signing,
        SERVER_ID,
        &auth::random_jti(),
        auth::ttl_now(TOKEN_TTL),
    );
    match timed_session(url, client, Some(&token), true).await {
        Ok(outcome) => {
            let after = execs(state);
            let ok = ok_outcome(&outcome) && after == before + 1;
            Check {
                name,
                ok,
                detail: format!(
                    "tools={:?} result={} executions={}",
                    outcome.tools,
                    outcome
                        .tool_result
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "<none>".into()),
                    after
                ),
            }
        }
        Err(e) => Check {
            name,
            ok: false,
            detail: format!("unexpected error: {}", short(&format!("{e:#}"), 160)),
        },
    }
}

async fn rejected(
    name: &'static str,
    url: &str,
    client: reqwest::Client,
    state: &Arc<ServerState>,
    token: Option<&str>,
    expected_reason: &str,
) -> Check {
    let before = execs(state);
    let rmcp_err = timed_session(url, client.clone(), token, true).await.err();
    let raw = client::raw_tool_call(&client, url, token).await;
    let after = execs(state);

    let rmcp_rejected = rmcp_err.is_some();
    let (http_ok, reason) = match raw {
        Ok((status, body)) => (
            status == 401,
            serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_string))
                .unwrap_or_else(|| short(&body, 80)),
        ),
        Err(e) => (false, format!("raw POST error: {}", short(&format!("{e:#}"), 100))),
    };
    let tool_not_run = after == before;
    Check {
        name,
        ok: rmcp_rejected && http_ok && reason == expected_reason && tool_not_run,
        detail: format!(
            "rmcp={} HTTP=401 reason={reason} executions {}->{}",
            if rmcp_rejected { "rejected" } else { "UNEXPECTEDLY OK" },
            before,
            after
        ),
    }
}

async fn replay(
    url: &str,
    client: reqwest::Client,
    state: &Arc<ServerState>,
    signing: &SigningKey,
) -> Check {
    let before = execs(state);
    let token = auth::mint_token(
        signing,
        SERVER_ID,
        "jti-replay-demo",
        auth::ttl_now(TOKEN_TTL),
    );
    let first = timed_session(url, client.clone(), Some(&token), true).await;
    let mid = execs(state);
    let second = timed_session(url, client.clone(), Some(&token), true).await;
    let raw = client::raw_tool_call(&client, url, Some(&token)).await;
    let after = execs(state);

    let first_ok = first.map(|o| ok_outcome(&o)).unwrap_or(false) && mid == before + 1;
    let second_rejected = second.is_err();
    let raw_reason = raw
        .as_ref()
        .ok()
        .and_then(|(status, body)| {
            (*status == 401).then(|| {
                serde_json::from_str::<serde_json::Value>(body)
                    .ok()
                    .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_string))
                    .unwrap_or_default()
            })
        });
    let raw_ok = raw_reason.as_deref() == Some("replayed");
    let tool_not_run = after == mid;

    Check {
        name: "replayed jti (same token, second tools/call)",
        ok: first_ok && second_rejected && raw_ok && tool_not_run,
        detail: format!(
            "first=ok executions {}->{}, second={}, HTTP=401 reason={}, executions={}",
            before,
            mid,
            if second_rejected { "rejected" } else { "UNEXPECTEDLY OK" },
            raw_reason.unwrap_or_else(|| "<none>".into()),
            after
        ),
    }
}

async fn tls_fails(
    name: &'static str,
    url: &str,
    client: reqwest::Client,
    state: &Arc<ServerState>,
    signing: &SigningKey,
    expected_in_diag: &str,
) -> Check {
    let before = execs(state);
    let token = auth::mint_token(
        signing,
        SERVER_ID,
        &auth::random_jti(),
        auth::ttl_now(TOKEN_TTL),
    );
    let rmcp_err = timed_session(url, client.clone(), Some(&token), false).await.err();
    let diag = client::tls_diag(&client, url).await;
    let after = execs(state);
    let diag_lower = diag.to_ascii_lowercase();
    Check {
        name,
        ok: rmcp_err.is_some()
            && diag_lower.contains(&expected_in_diag.to_ascii_lowercase())
            && after == before,
        detail: format!(
            "rmcp={} diag={}",
            if rmcp_err.is_some() { "handshake failed" } else { "UNEXPECTEDLY OK" },
            short(&diag, 120)
        ),
    }
}

fn print_checks(title: &str, checks: &[Check]) {
    println!("\n=== {title} ===");
    for c in checks {
        println!(
            "[{}] {:<46} {}",
            if c.ok { "PASS" } else { "FAIL" },
            c.name,
            c.detail
        );
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    init_crypto_provider();

    let scratch = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/demo");
    if scratch.exists() {
        std::fs::remove_dir_all(&scratch)?;
    }
    std::fs::create_dir_all(&scratch)?;
    let cert_dir = scratch.join("certs");
    let wrong_ca_dir = scratch.join("wrong-ca");

    // The control plane's signing keypair. In production only the public half
    // is compiled into the agent; here both halves live in the demo process.
    let signing = SigningKey::generate(&mut OsRng);
    let attacker = SigningKey::generate(&mut OsRng);
    println!("Ed25519 verifying key (agent's built-in public key):");
    println!("  {}", cert::hex(signing.verifying_key().as_bytes()));

    let identity = Arc::new(Identity::load(&cert_dir, &[], None)?);
    let agent = start_agent_with_certs(
        "127.0.0.1:0".parse()?,
        identity.clone(),
        SERVER_ID,
        signing.verifying_key(),
        Arc::new(StubRotator::default()),
        false,
        None,
        // The demo exercises auth and rotation, not metering.
        None,
    )
    .await?;
    let url = agent.mcp_url();
    println!("MCP endpoint:      {url}");

    // A second, unrelated CA for the "wrong CA" case.
    let wrong_ca = cert::generate(&wrong_ca_dir)?;

    let leaf_fp = cert::leaf_fingerprint(&agent.certs.leaf_cert)?;
    let ca_fp = cert::sha256_hex(
        cert::load_certs(&agent.certs.ca_cert)?
            .into_iter()
            .next()
            .unwrap()
            .as_ref(),
    );
    println!("CA   SHA-256:       {ca_fp}");
    println!("leaf SHA-256:       {leaf_fp}");

    let root = client::root_client(&agent.certs.ca_cert)?;
    let pinned = client::pinned_client(&agent.certs.ca_cert, cert::parse_fingerprint(&leaf_fp)?)?;
    let mut wrong_fp = cert::parse_fingerprint(&leaf_fp)?;
    wrong_fp[0] ^= 0xff;
    let wrong_pin = client::pinned_client(&agent.certs.ca_cert, wrong_fp)?;
    let wrong_ca_client = client::root_client(&wrong_ca.ca_cert)?;
    let bare = client::default_client();

    let state = agent.state.clone();

    // 1. Happy path: valid token + trusted CA, and valid token + pinned leaf.
    let happy_checks = vec![
        happy("root CA trust + valid token", &url, root.clone(), &state, &signing).await,
        happy("fingerprint pin + valid token", &url, pinned.clone(), &state, &signing).await,
    ];

    // 2. Token gate.
    let expired = auth::mint_token(
        &signing,
        SERVER_ID,
        "jti-expired-demo",
        auth::now_unix().saturating_sub(5),
    );
    let forged = auth::mint_token(
        &attacker,
        SERVER_ID,
        "jti-forged-demo",
        auth::ttl_now(TOKEN_TTL),
    );
    let wrong_server = auth::mint_token(
        &signing,
        "srv_someone_else",
        "jti-wrong-server",
        auth::ttl_now(TOKEN_TTL),
    );
    let token_checks = vec![
        rejected(
            "no Authorization header",
            &url,
            root.clone(),
            &state,
            None,
            "missing_token",
        )
        .await,
        rejected(
            "expired token",
            &url,
            root.clone(),
            &state,
            Some(&expired),
            "expired",
        )
        .await,
        replay(&url, root.clone(), &state, &signing).await,
        rejected(
            "wrong signature (attacker key)",
            &url,
            root.clone(),
            &state,
            Some(&forged),
            "bad_signature",
        )
        .await,
        rejected(
            "token for another server_id",
            &url,
            root.clone(),
            &state,
            Some(&wrong_server),
            "wrong_server",
        )
        .await,
    ];

    // 3. TLS trust failures.
    let tls_checks = vec![
        tls_fails(
            "default trust (no CA): handshake fails",
            &url,
            bare.clone(),
            &state,
            &signing,
            "certificate",
        )
        .await,
        tls_fails(
            "wrong CA: handshake fails",
            &url,
            wrong_ca_client.clone(),
            &state,
            &signing,
            "certificate",
        )
        .await,
        tls_fails(
            "wrong fingerprint pin: handshake fails",
            &url,
            wrong_pin.clone(),
            &state,
            &signing,
            "pin mismatch",
        )
        .await,
    ];

    agent.shutdown().await;

    print_checks("1. happy path", &happy_checks);
    print_checks("2. token gate", &token_checks);
    print_checks("3. TLS trust", &tls_checks);

    let all: Vec<&Check> = happy_checks
        .iter()
        .chain(token_checks.iter())
        .chain(tls_checks.iter())
        .collect();
    let passed = all.iter().filter(|c| c.ok).count();
    println!("\n=== summary ===");
    println!("{passed}/{} checks passed", all.len());
    println!(
        "final tool executions: {} (expected 3: CA + pin + replay-first-call)",
        execs(&state)
    );

    if passed == all.len() {
        println!(
            "PASS: self-signed TLS + offline Ed25519 token gate + one \
             rotate_credentials tools/call all work end to end."
        );
        Ok(())
    } else {
        bail!("{}/{} checks failed; see the table above", all.len() - passed, all.len());
    }
}
