//! 运行时可自测入口：下载 → 校验 → 安装 → 生成配置 → check → 启动 → running → 停止。

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use veyl_lib::config::{self, BuildInput, NodeDescriptor, ProtocolConfig};
use veyl_lib::proxy::{ProxyController, RecoveryOutcome};
use veyl_lib::catalog::CatalogClient;
use veyl_lib::tools::services::WiredServices;
use veyl_lib::tools::{CatalogQuery, VpnToolServices};
use veyl_lib::runtime::{
    current_release, default_app_data_dir, ClashApi, Installer, RuntimeConfig, RuntimeEvent,
    RuntimeManager,
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
        "fault" => run_fault(&args).await,
        "catalog" => run_catalog(&args).await,
        "proxy-status" => run_proxy_status(&args),
        "proxy-recover" => run_proxy_recover(&args),
        "proxy-enable" => run_proxy_enable(&args),
        "proxy-disable" => run_proxy_disable(&args),
        other => {
            eprintln!("unknown command: {other}");
            eprintln!(
                "commands: e2e | install | status | fault | catalog | proxy-status | proxy-enable | proxy-disable | proxy-recover"
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
        requested_port: None,
        fallback_reason: None,
        config_id: Some("selftest".into()),
        config_name: None,
        node_id: Some("selftest".into()),
        node_name: None,
        applied_route_revision: None,
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

/// 目录联调：走真实 `WiredServices`，验证「无 token 自动注册 → 落盘 → 列表成功」。
async fn run_catalog(args: &Args) -> StepResult {
    let base = std::env::var("VEYL_CATALOG_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:18090/v1".to_string());

    let dir = args.data_dir.join("catalog");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    veyl_lib::secrets::install(&dir);

    let store = std::sync::Arc::new(
        veyl_lib::store::Store::open(veyl_lib::store::default_db_path(&dir))
            .map_err(|e| e.to_string())?,
    );
    let manager = veyl_lib::runtime::RuntimeManager::new(
        veyl_lib::runtime::RuntimeConfig::new(&dir),
    );
    let proxy = std::sync::Arc::new(veyl_lib::proxy::ProxyController::new(Box::new(
        veyl_lib::proxy::SqliteBackupStore::new(std::sync::Arc::clone(&store)),
    )));
    let catalog = std::sync::Arc::new(CatalogClient::new(base.clone()));
    let services = WiredServices::new(
        std::sync::Arc::clone(&store),
        manager,
        proxy,
        catalog,
        &dir,
    );

    println!("目录服务：{base}");
    step(1, "初始状态：本地不应有设备 token");
    println!(
        "    device_token: {:?}",
        veyl_lib::secrets::get_device_token().map(|token| token.is_some())
    );

    step(2, "调用 catalog_search（无 token 时应自动注册）");
    let response = services
        .catalog_search(CatalogQuery::default())
        .await
        .map_err(|e| format!("目录查询失败：{e}"))?;
    let nodes = response
        .get("nodes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    println!("    {} 个节点", nodes.len());
    if nodes.is_empty() {
        return Err("目录返回空列表".to_string());
    }
    println!(
        "    首个节点：{}",
        nodes[0].get("id").and_then(|v| v.as_str()).unwrap_or("?")
    );

    step(3, "确认 token 已落到 secrets.enc");
    let token = veyl_lib::secrets::get_device_token().map_err(|e| e.to_string())?;
    if token.is_none() {
        return Err("注册后仍没有 device_token".to_string());
    }
    let secrets_path = dir.join(veyl_lib::secrets::SECRETS_FILE);
    let raw = std::fs::read_to_string(&secrets_path).map_err(|e| e.to_string())?;
    if !raw.contains("device_token") {
        return Err("secrets.enc 里没有 device_token 字段".to_string());
    }
    if let Some(value) = &token {
        if raw.contains(value) {
            return Err("secrets.enc 里出现了明文 token".to_string());
        }
    }
    println!("    {} 已写入，且为密文", secrets_path.display());

    step(4, "再次查询：应复用 token，不重复注册");
    let again = services
        .catalog_search(CatalogQuery::default())
        .await
        .map_err(|e| format!("第二次查询失败：{e}"))?;
    println!(
        "    {} 个节点",
        again
            .get("nodes")
            .and_then(|value| value.as_array())
            .map(|nodes| nodes.len())
            .unwrap_or(0)
    );

    println!("\nCATALOG PASSED");
    Ok(())
}

/// 故障注入：假 sing-box 提供 `/version` 后自杀，验证
/// 「running → crash → 退避重启 → 重试耗尽 → failed」整条链路。
async fn run_fault(args: &Args) -> StepResult {
    let dir = args.data_dir.join("fault");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let clash_port = config::pick_free_port().map_err(|e| e.to_string())?;
    let mixed_port = config::pick_free_port().map_err(|e| e.to_string())?;
    let secret = config::random_secret();

    let config_path = dir.join("config.json");
    let config = serde_json::json!({
        "log": { "level": "error" },
        "inbounds": [],
        "outbounds": [{ "type": "direct", "tag": "direct" }],
        "route": { "final": "direct" },
        "experimental": {
            "clash_api": {
                "external_controller": format!("127.0.0.1:{clash_port}"),
                "secret": secret,
            }
        },
    });
    std::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&config).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;

    let fake = dir.join("fake-sing-box");
    std::fs::write(&fake, FAKE_SING_BOX).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }

    let mut cfg = RuntimeConfig::new(&dir);
    cfg.startup_timeout = Duration::from_secs(5);
    cfg.max_restarts = 2;
    cfg.health_interval = Duration::from_secs(30);
    cfg.data_plane_probe = None;

    let manager = RuntimeManager::new(cfg);
    let mut events = manager.subscribe();
    let plan = StartPlan {
        version: "fake".into(),
        binary: fake,
        config_path,
        work_dir: dir.clone(),
        log_path: dir.join("runtime.log"),
        clash_addr: format!("127.0.0.1:{clash_port}"),
        clash_secret: secret,
        mixed_port,
        requested_port: None,
        fallback_reason: None,
        config_id: Some("fault".into()),
        config_name: None,
        node_id: None,
        node_name: None,
        applied_route_revision: None,
    };

    step(1, "启动假 sing-box（2 秒后自杀）");
    let status = manager.start(plan).await.map_err(|e| e.to_string())?;
    println!("    state: {}", status.state.as_str());
    if status.state != RuntimeState::Running {
        return Err(format!("expected running, got {}", status.state.as_str()));
    }

    let pid_file = dir.join("runtime.pid");
    if !pid_file.is_file() {
        return Err("进入 running 后应写出 runtime.pid".to_string());
    }
    println!("    runtime.pid: {}", std::fs::read_to_string(&pid_file).unwrap_or_default());

    step(2, "等待重启预算耗尽");
    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    loop {
        let current = manager.status().await;
        if current.state == RuntimeState::Failed {
            break;
        }
        if std::time::Instant::now() > deadline {
            return Err(format!(
                "still {} after 40s (restart_count={})",
                current.state.as_str(),
                current.restart_count
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    step(3, "校验失败状态与重启次数");
    let status = manager.status().await;
    println!(
        "    state={} restart_count={} last_error={:?}",
        status.state.as_str(),
        status.restart_count,
        status.last_error
    );
    if status.restart_count != 2 {
        return Err(format!(
            "expected restart_count=2, got {}",
            status.restart_count
        ));
    }

    let mut restarting_events = 0;
    while let Ok(event) = events.try_recv() {
        if let RuntimeEvent::StateChanged(payload) = event {
            if payload.to == RuntimeState::Restarting {
                restarting_events += 1;
            }
        }
    }
    println!("    restarting events: {restarting_events}");
    if restarting_events != 2 {
        return Err(format!(
            "expected 2 restarting events, got {restarting_events}"
        ));
    }

    if pid_file.exists() {
        return Err("进入 failed 后应清理 runtime.pid".to_string());
    }

    println!("\nFAULT INJECTION PASSED");
    Ok(())
}

const FAKE_SING_BOX: &str = r#"#!/usr/bin/env python3
import json, sys, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

argv = sys.argv[1:]
config_path = argv[argv.index("-c") + 1]
with open(config_path, encoding="utf-8") as fh:
    config = json.load(fh)
clash = config["experimental"]["clash_api"]
port = int(clash["external_controller"].rsplit(":", 1)[1])
secret = clash["secret"]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/version" and self.headers.get("Authorization") == f"Bearer {secret}":
            body = b'{"version":"fake-1.0.0"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", port), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
time.sleep(2)
sys.exit(1)
"#;

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
