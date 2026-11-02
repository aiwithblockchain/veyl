//! 运行时可自测入口：下载 → 校验 → 安装 → 生成配置 → check → 启动 → running → 停止。

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use aivpn_lib::config::{self, BuildInput, NodeDescriptor, ProtocolConfig};
use aivpn_lib::proxy::{ProxyController, RecoveryOutcome};
use aivpn_lib::runtime::{
    current_release, default_app_data_dir, ClashApi, Installer, RuntimeConfig, RuntimeManager,
    RuntimeState, StartPlan,
};

struct Args {
    command: String,
    data_dir: PathBuf,
    probe_url: Option<String>,
    port: u16,
}

fn parse_args() -> Args {
    let mut command: Option<String> = None;
    let mut data_dir = std::env::temp_dir().join("aivpn-selftest");
    let mut probe_url = None;
    let mut port = 2080u16;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => {
                data_dir = PathBuf::from(args.next().expect("--data-dir needs a value"));
            }
            "--probe-url" => probe_url = args.next(),
            "--port" => {
                port = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .expect("--port needs a number");
            }
            other if other.starts_with("--") => {
                eprintln!("unknown flag: {other}");
            }
            other => {
                if command.is_none() {
                    command = Some(other.to_string());
                }
            }
        }
    }

    Args {
        command: command.unwrap_or_else(|| "e2e".to_string()),
        data_dir,
        probe_url,
        port,
    }
}

fn use_production_dir_hint() -> PathBuf {
    default_app_data_dir()
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = parse_args();
    let result = match args.command.as_str() {
        "e2e" => run_e2e(&args).await,
        "install" => run_install(&args).await,
        "status" => run_status(&args).await,
        "proxy-status" => run_proxy_status(&args),
        "proxy-recover" => run_proxy_recover(&args),
        "proxy-enable" => run_proxy_enable(&args),
        "proxy-disable" => run_proxy_disable(&args),
        other => {
            eprintln!("unknown command: {other}");
            eprintln!(
                "commands: e2e | install | status | proxy-status | proxy-enable | proxy-disable | proxy-recover"
            );
            return ExitCode::from(2);
        }
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("FAILED: {message}");
            ExitCode::FAILURE
        }
    }
}

type StepResult = Result<(), String>;

fn step(index: u32, message: &str) {
    println!("[{index}] {message}");
}

async fn run_install(args: &Args) -> StepResult {
    let release = current_release().map_err(|e| e.to_string())?;
    let installer = Installer::new(&args.data_dir);
    step(1, &format!("downloading {} from {}", release.upstream_version, release.artifact.url));
    let installed = installer.install(&release).await.map_err(|e| e.to_string())?;
    step(2, &format!("installed at {}", installed.binary.display()));
    Ok(())
}

async fn run_status(args: &Args) -> StepResult {
    let installer = Installer::new(&args.data_dir);
    match installer.active().map_err(|e| e.to_string())? {
        Some(rt) => println!(
            "installed: {} ({})",
            rt.version,
            rt.binary.display()
        ),
        None => println!("not installed in {}", args.data_dir.display()),
    }
    println!("production dir would be {}", use_production_dir_hint().display());
    Ok(())
}

fn run_proxy_status(args: &Args) -> StepResult {
    let controller = ProxyController::with_file_store(&args.data_dir);
    let status = controller.status().map_err(|e| e.to_string())?;
    println!("{}", serde_json::to_string_pretty(&status).unwrap());
    Ok(())
}

fn run_proxy_enable(args: &Args) -> StepResult {
    let controller = ProxyController::with_file_store(&args.data_dir);
    controller.enable(args.port).map_err(|e| e.to_string())?;
    let status = controller.status().map_err(|e| e.to_string())?;
    println!("enabled on port {}", args.port);
    println!("{}", serde_json::to_string_pretty(&status).unwrap());
    Ok(())
}

fn run_proxy_disable(args: &Args) -> StepResult {
    let controller = ProxyController::with_file_store(&args.data_dir);
    controller.disable().map_err(|e| e.to_string())?;
    let status = controller.status().map_err(|e| e.to_string())?;
    println!("disabled");
    println!("{}", serde_json::to_string_pretty(&status).unwrap());
    Ok(())
}

fn run_proxy_recover(args: &Args) -> StepResult {
    let controller = ProxyController::with_file_store(&args.data_dir);
    match controller.recover_stale().map_err(|e| e.to_string())? {
        RecoveryOutcome::Nothing => println!("nothing to recover"),
        RecoveryOutcome::Recovered { endpoint } => println!("recovered from {endpoint}"),
        RecoveryOutcome::LeftAlone { current, endpoint } => {
            println!("left alone: current={current}, ours={endpoint}")
        }
    }
    Ok(())
}

async fn run_e2e(args: &Args) -> StepResult {
    let mut cfg = RuntimeConfig::new(&args.data_dir);
    cfg.startup_timeout = Duration::from_secs(15);
    if let Some(url) = &args.probe_url {
        cfg.data_plane_probe = Some(url.clone());
    }

    step(1, "resolving the built-in manifest");
    let release = current_release().map_err(|e| e.to_string())?;
    println!(
        "    sing-box {} ({}/{})",
        release.upstream_version, release.platform, release.arch
    );

    let installer = Installer::new(&args.data_dir);
    step(2, "download → sha256 → extract → install");
    let installed = installer.install(&release).await.map_err(|e| e.to_string())?;
    println!("    binary: {}", installed.binary.display());

    step(3, "building the client config");
    let mixed_port = config::pick_free_port().map_err(|e| e.to_string())?;
    let clash_port = config::pick_free_port().map_err(|e| e.to_string())?;
    let secret = config::random_secret();
    let input = BuildInput::new(demo_node(), mixed_port, clash_port, secret.clone());
    let value = config::build(&input).map_err(|e| e.to_string())?;

    step(4, "sing-box check → activate");
    let config_dir = args.data_dir.join("config");
    let active = config::install(&installed.binary, &config_dir, &value)
        .await
        .map_err(|e| e.to_string())?;
    println!("    active config: {}", active.display());

    step(5, "starting the runtime");
    let manager = RuntimeManager::new(cfg);
    let mut events = manager.subscribe();
    let plan = StartPlan {
        version: installed.version.clone(),
        binary: installed.binary.clone(),
        config_path: active.clone(),
        work_dir: installed.dir.clone(),
        log_path: StartPlan::log_path(&manager.cfg, &installed.version),
        clash_addr: format!("127.0.0.1:{clash_port}"),
        clash_secret: secret.clone(),
        mixed_port,
        profile_id: Some("selftest".into()),
    };
    let status = manager.start(plan).await.map_err(|e| {
        let mut detail = e.to_string();
        if let Ok(log) = std::fs::read_to_string(&StartPlan::log_path(&manager.cfg, &installed.version)) {
            let tail: String = log.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            detail.push_str("\n--- runtime log tail ---\n");
            detail.push_str(&tail);
        }
        detail
    })?;

    while let Ok(event) = events.try_recv() {
        println!("    event: {event:?}");
    }
    println!("    state: {}", status.state.as_str());
    println!(
        "    snapshot: {}",
        serde_json::to_string(&status).unwrap_or_default()
    );
    if status.state != RuntimeState::Running {
        return Err(format!("expected running, got {}", status.state.as_str()));
    }

    step(6, "probing the clash api");
    let api = ClashApi::new(&format!("127.0.0.1:{clash_port}"), &secret);
    let version = api.version().await.map_err(|e| e.to_string())?;
    println!("    /version → {}", version.version);

    step(7, "stopping the runtime");
    let status = manager.stop().await.map_err(|e| e.to_string())?;
    println!("    state: {}", status.state.as_str());
    if status.state != RuntimeState::Idle {
        return Err(format!("expected idle, got {}", status.state.as_str()));
    }

    step(8, "re-listing the install state");
    let active = installer.active().map_err(|e| e.to_string())?;
    println!(
        "    active version: {}",
        active.map(|r| r.version).unwrap_or_else(|| "<none>".into())
    );

    println!("\nE2E PASSED");
    Ok(())
}

fn demo_node() -> NodeDescriptor {
    NodeDescriptor {
        id: "selftest".into(),
        name: "self test".into(),
        server: "127.0.0.1".into(),
        server_port: 9,
        protocol: ProtocolConfig::VlessReality {
            uuid: "b831381d-6324-4d53-ad4f-8cda48b30811".into(),
            flow: Some("xtls-rprx-vision".into()),
            server_name: "www.example.com".into(),
            public_key: "jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0".into(),
            short_id: "0123abcd".into(),
            fingerprint: None,
        },
    }
}
