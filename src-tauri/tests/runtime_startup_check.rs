//! 用真实 `sing-box` **跑起来**，拦住「`check` 通过但 `run` 立刻退出」这一类问题。
//!
//! `generated_config_check.rs` 只跑 `check`。1.14 有些错误偏偏只在 `run` 时才炸，
//! 例如 DNS 服务器 `detour` 指向一个空的 direct 出站：
//!
//! ```text
//! FATAL start service: start dns-transport: start dns/udp[dns-local-1]:
//!       detour to an empty direct outbound makes no sense
//! ```
//!
//! 这条错误让真机上的连接全挂了，而 `check` 依然返回 0。所以这里对三种分流模式
//! 各起一次进程：存活 1.5 秒算通过，提前退出就把 `stderr` 和配置一起打出来。
//!
//! 规则集引用按 `generated_config_check.rs` 的做法抹掉（`.srs` 有没有装是另一类问题，
//! 不影响 DNS/出站这些启动路径）。没有二进制时整组跳过，手动跑：
//!
//! ```sh
//! VEYL_SING_BOX=/path/to/sing-box cargo test --test runtime_startup_check
//! ```

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use veyl_lib::config::{
    build_routed_multi, BuildInput, ConnectMode, NodeDescriptor, ProtocolConfig,
};
use veyl_lib::rules::plan::{self, RouteInput, RoutePlan};
use veyl_lib::rules::{Category, InstalledRules, ManifestItem, ManifestSource, RulesManifest};

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

fn missing_binary(test: &str) {
    if std::env::var("VEYL_REQUIRE_SING_BOX").as_deref() == Ok("1") {
        panic!("{test}：VEYL_REQUIRE_SING_BOX=1 但找不到 sing-box");
    }
    eprintln!("没有 sing-box 二进制，跳过 {test}（设 VEYL_SING_BOX 指向它）");
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

fn installed_rules() -> InstalledRules {
    let items = [
        ("geosite-cn", "geosite", "geosite/cn.srs"),
        ("geoip-cn", "geoip", "geoip/cn.srs"),
        ("geosite-openai", "geosite", "geosite/openai.srs"),
        ("geoip-jp", "geoip", "geoip/jp.srs"),
    ]
    .into_iter()
    .map(|(id, kind, file)| ManifestItem {
        id: id.into(),
        kind: kind.into(),
        file: file.into(),
        sha256: "test".into(),
        bytes: 0,
    })
    .collect();

    InstalledRules {
        root: PathBuf::from("/rules/2026-11-04.1"),
        manifest: RulesManifest {
            schema: 1,
            version: "2026-11-04.1".into(),
            source: ManifestSource {
                geosite_tag: None,
                geoip_tag: None,
                geosite_commit_date: None,
                geoip_commit_date: None,
                fetched_at: None,
            },
            items,
        },
        categories: vec![Category {
            id: "openai".into(),
            name_zh: "ChatGPT".into(),
            name_en: "OpenAI".into(),
            description: "test".into(),
            item_count: 0,
            rule_sets: vec!["geosite-openai".into()],
            dns_classifiable: true,
        }],
    }
}

/// 真实生成器输出，只抹掉规则集引用（`.srs` 不存在会让 router 初始化失败）。
fn real_plan(mode: &str, region: &str, targets: &[&str]) -> RoutePlan {
    let rules = installed_rules();
    let targets = targets.iter().map(|id| id.to_string()).collect::<Vec<_>>();
    let mut plan = plan::build(&RouteInput {
        mode,
        region: Some(region),
        targets: &targets,
        rules: &rules,
    })
    .unwrap_or_else(|error| panic!("plan 生成失败（{mode}/{region}）：{error}"));

    plan.rule_sets.clear();
    plan.referenced.clear();
    plan.route_rules.retain(|rule| rule.get("rule_set").is_none());
    if let Some(rules) = plan.dns.get_mut("rules").and_then(|value| value.as_array_mut()) {
        rules.retain(|rule| rule.get("rule_set").is_none());
    }
    plan
}

fn config_for(mode: &str, targets: &[&str]) -> Value {
    let plan = real_plan(mode, "cn", targets);
    // 同时持有两个监听句柄再取端口，避免两次 ephemeral 分配撞到同一个。
    let mixed = std::net::TcpListener::bind("127.0.0.1:0").expect("找空闲端口");
    let clash = std::net::TcpListener::bind("127.0.0.1:0").expect("找空闲端口");
    let mixed_port = mixed.local_addr().expect("读端口").port();
    let clash_port = clash.local_addr().expect("读端口").port();
    drop(mixed);
    drop(clash);
    let input = BuildInput::new(node(), mixed_port, clash_port, "secret".into())
        .with_connect_mode(ConnectMode::SystemProxy);
    build_routed_multi(&input, &[node()], "jp-01", &plan)
        .unwrap_or_else(|error| panic!("{mode} 生成配置失败：{error}"))
}

/// 起进程、看它能不能活过 `alive`。提前退出就是失败。
fn assert_starts(binary: &Path, name: &str, config: &Value, alive: Duration) {
    let dir = std::env::temp_dir().join(format!("veyl-run-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("建临时目录");
    let path = dir.join("config.json");
    let pretty = serde_json::to_string_pretty(config).unwrap();
    std::fs::write(&path, &pretty).expect("写配置");

    let mut child = Command::new(binary)
        .arg("run")
        .arg("-c")
        .arg(&path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("启动 sing-box run");

    let deadline = Instant::now() + alive;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().expect("等待子进程") {
            let output = child.wait_with_output().expect("读取输出");
            let stderr = String::from_utf8_lossy(&output.stderr);
            let _ = std::fs::remove_dir_all(&dir);
            panic!(
                "{name} 的配置 {status} 就退出了（check 可能是过的）：\n{stderr}\n\n配置：\n{pretty}"
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn system_proxy_configs_actually_start() {
    let Some(binary) = sing_box() else {
        missing_binary("system_proxy_configs_actually_start");
        return;
    };

    for (name, mode, targets) in [
        ("direct", "direct", Vec::new()),
        ("proxy-all", "proxy_all", Vec::new()),
        ("proxy-selected", "proxy_selected", vec!["openai"]),
    ] {
        let config = config_for(mode, &targets);
        assert_starts(&binary, name, &config, Duration::from_millis(1500));
    }
}

/// 本地 DNS 不能再指向空的 direct 出站：1.14 的 `run` 会 FATAL，`check` 查不出来。
#[test]
fn local_dns_servers_do_not_detour_to_the_direct_outbound() {
    for (mode, targets) in [
        ("direct", Vec::new()),
        ("proxy_all", Vec::new()),
        ("proxy_selected", vec!["openai"]),
    ] {
        let config = config_for(mode, &targets);
        let servers = config["dns"]["servers"]
            .as_array()
            .unwrap_or_else(|| panic!("{mode} 没有 dns.servers"));
        for server in servers {
            let tag = server["tag"].as_str().unwrap_or("");
            if !tag.starts_with("dns-local") {
                continue;
            }
            assert!(
                server.get("detour").is_none(),
                "{mode} 的本地 DNS {tag} 带了 detour：1.14 会 FATAL（配置：{}）",
                serde_json::to_string(server).unwrap()
            );
        }
    }
}
