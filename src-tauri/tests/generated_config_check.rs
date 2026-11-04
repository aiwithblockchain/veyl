//! 用**真实的** `sing-box` 二进制校验我们生成的配置。
//!
//! 这两个 P0 就是这么发现的：旧 DNS 写法在 1.14 被删除、缺
//! `route.default_domain_resolver` 是 FATAL——单元测试只断言了形状，
//! 谁也没真跑过 `check`。
//!
//! 没有二进制时整组跳过（CI 上不装它）。手动跑：
//!
//! ```sh
//! VEYL_SING_BOX=/path/to/sing-box cargo test --test generated_config_check
//! ```

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use veyl_lib::config::{
    build_routed_multi, BuildInput, ConnectMode, NodeDescriptor, ProtocolConfig,
};
use veyl_lib::rules::plan::RoutePlan;

fn sing_box() -> Option<PathBuf> {
    let from_env = std::env::var("VEYL_SING_BOX").ok().map(PathBuf::from);
    let from_path = std::env::var("PATH").ok().and_then(|path| {
        path.split(':')
            .map(|dir| Path::new(dir).join("sing-box"))
            .find(|candidate| candidate.is_file())
    });
    from_env
        .filter(|path| path.is_file())
        .or(from_path)
        .map(|path| path.canonicalize().unwrap_or(path))
}

fn node() -> NodeDescriptor {
    NodeDescriptor {
        id: "jp-01".into(),
        name: "东京 01".into(),
        server: "203.0.113.10".into(),
        server_port: 8388,
        protocol: ProtocolConfig::Shadowsocks {
            password: "p@ss".into(),
            method: "aes-256-gcm".into(),
        },
    }
}

/// 规则集置空：这里只验证**我们生成的骨架**，不拉真实 `.srs`。
/// 规则文件本身缺失是另一类问题（数据没装），不该挡住这部分回归。
fn plan(route_final: &'static str, outbound_local: Option<&'static str>) -> RoutePlan {
    RoutePlan {
        rule_sets: vec![],
        route_rules: vec![
            json!({ "ip_is_private": true, "action": "route", "outbound": "direct" }),
            json!({ "action": "route", "outbound": "direct" }),
        ],
        route_final,
        dns: json!({
            "servers": [
                {"type": "udp", "tag": "dns-local-1", "server": "223.5.5.5", "detour": "direct"},
                {"type": "udp", "tag": "dns-local-2", "server": "119.29.29.29", "detour": "direct"},
                {"type": "https", "tag": "dns-remote-1", "server": "1.1.1.1", "detour": "proxy"},
                {"type": "https", "tag": "dns-remote-2", "server": "dns.google", "detour": "proxy"}
            ],
            "rules": [],
            "final": "dns-remote-1",
            "strategy": "prefer_ipv4"
        }),
        outbound_local,
        referenced: vec![],
    }
}

fn input(mode: ConnectMode) -> BuildInput {
    BuildInput::new(node(), 2080, 19090, "secret".into()).with_connect_mode(mode)
}

fn assert_passes(binary: &Path, name: &str, config: &Value) {
    let dir = std::env::temp_dir().join(format!("veyl-check-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("建临时目录");
    let path = dir.join("config.json");
    std::fs::write(&path, serde_json::to_vec_pretty(config).unwrap()).expect("写配置");

    let output = Command::new(binary)
        .arg("check")
        .arg("-c")
        .arg(&path)
        .output()
        .expect("跑 sing-box check");

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let _ = std::fs::remove_dir_all(&dir);

    assert!(
        output.status.success(),
        "{name} 没通过 sing-box check（{}）：\n{stderr}\n\n配置：\n{}",
        binary.display(),
        serde_json::to_string_pretty(config).unwrap()
    );
}

#[test]
fn system_proxy_config_passes_sing_box_check() {
    let Some(binary) = sing_box() else {
        eprintln!("没有 sing-box 二进制，跳过（设 VEYL_SING_BOX 指向它）");
        return;
    };
    let config = build_routed_multi(
        &input(ConnectMode::SystemProxy),
        &[node()],
        "jp-01",
        &plan("proxy", Some("direct")),
    )
    .expect("生成 proxy 配置");
    assert_passes(&binary, "proxy-routed", &config);
}

#[test]
fn tun_config_passes_sing_box_check() {
    let Some(binary) = sing_box() else {
        eprintln!("没有 sing-box 二进制，跳过（设 VEYL_SING_BOX 指向它）");
        return;
    };
    let tun = BuildInput::new(node(), 2080, 19090, "secret".into())
        .with_tun_excludes(veyl_lib::tun::excludes(&[], &[]));

    for (name, route_final, local) in [
        ("tun-direct", "proxy", Some("direct")),
        ("tun-proxy-all", "proxy", Some("proxy")),
        ("tun-selected", "direct", None),
    ] {
        let config = build_routed_multi(&tun, &[node()], "jp-01", &plan(route_final, local))
            .expect("生成 tun 配置");
        assert_passes(&binary, name, &config);
    }
}
