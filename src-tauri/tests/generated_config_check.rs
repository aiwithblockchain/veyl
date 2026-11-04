//! 用**真实的** `sing-box` 二进制校验我们生成的配置。
//!
//! 关键：路由与 DNS 必须走**真实的** `rules::plan::build`，不能手写 `RoutePlan`。
//! 手写的话测的是「builder 能把手写的东西拼成合法配置」，而不是
//! 「我们的生成器产出的东西合法」——上一轮两个 P0 就是因为没人真跑 `check`。
//!
//! 唯一被抹掉的是规则集引用：`.srs` 文件属于规则数据有没有装，是另一类问题，
//! 不该挡住这部分回归。DNS 服务器、`final`、`strategy` 全部是生成器的真实输出。
//!
//! 没有二进制时整组跳过（`CI` 策略见 `ci_mode()`）。手动跑：
//!
//! ```sh
//! VEYL_SING_BOX=/path/to/sing-box cargo test --test generated_config_check
//! ```

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

use veyl_lib::config::{
    build_routed_multi, BuildInput, ConnectMode, NodeDescriptor, ProtocolConfig,
};
use veyl_lib::rules::plan::{self, RouteInput, RoutePlan};
use veyl_lib::rules::{
    Category, InstalledRules, ManifestItem, ManifestSource, RulesManifest,
};

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

/// `VEYL_REQUIRE_SING_BOX=1` 时，找不到二进制算失败而不是跳过。
/// CI 用这个开关把「跳过」变成「红」，本地默认保持安静。
fn missing_binary(test: &str) {
    if std::env::var("VEYL_REQUIRE_SING_BOX").as_deref() == Ok("1") {
        panic!(
            "{test}：VEYL_REQUIRE_SING_BOX=1 但找不到 sing-box。\
             用 VEYL_SING_BOX 指定路径，或把它放进 PATH。"
        );
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

/// 结构完整、但不存在的规则目录：让生成器能算出引用，文件本身不参与测试。
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
        bytes: 1,
    })
    .collect();

    InstalledRules {
        root: PathBuf::from("/nonexistent/veyl-rules"),
        manifest: RulesManifest {
            schema: 1,
            version: "test".into(),
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

/// 真实生成器的输出，只抹掉规则集引用。
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

    // `.srs` 不存在，引用它的规则会让 check 在 router 初始化阶段 FATAL。
    plan.rule_sets.clear();
    plan.referenced.clear();
    plan.route_rules.retain(|rule| rule.get("rule_set").is_none());
    if let Some(rules) = plan.dns.get_mut("rules").and_then(|value| value.as_array_mut()) {
        rules.retain(|rule| rule.get("rule_set").is_none());
    }
    plan
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
        missing_binary("system_proxy_config_passes_sing_box_check");
        return;
    };

    for (name, mode, region, targets, final_out, local) in [
        ("proxy-cn-direct", "direct", "cn", vec![], "proxy", Some("direct")),
        ("proxy-cn-all", "proxy_all", "cn", vec![], "proxy", Some("proxy")),
        ("proxy-cn-selected", "proxy_selected", "cn", vec!["openai"], "direct", None),
        ("proxy-jp-direct", "direct", "jp", vec![], "proxy", Some("direct")),
    ] {
        let plan = real_plan(mode, region, &targets);
        assert_eq!(plan.route_final, final_out, "{name} 的 final 变了");
        assert_eq!(plan.outbound_local, local, "{name} 的 route-local 变了");

        let config = build_routed_multi(&input(ConnectMode::SystemProxy), &[node()], "jp-01", &plan)
            .unwrap_or_else(|error| panic!("{name} 生成配置失败：{error}"));
        assert_passes(&binary, name, &config);
    }
}

#[test]
fn tun_config_passes_sing_box_check() {
    let Some(binary) = sing_box() else {
        missing_binary("tun_config_passes_sing_box_check");
        return;
    };

    let tun = BuildInput::new(node(), 2080, 19090, "secret".into())
        .with_tun_excludes(veyl_lib::tun::excludes(&[], &[]));

    for (name, mode, region, targets) in [
        ("tun-cn-direct", "direct", "cn", vec![]),
        ("tun-cn-all", "proxy_all", "cn", vec![]),
        ("tun-cn-selected", "proxy_selected", "cn", vec!["openai"]),
        ("tun-jp-direct", "direct", "jp", vec![]),
    ] {
        let plan = real_plan(mode, region, &targets);
        let config = build_routed_multi(&tun, &[node()], "jp-01", &plan)
            .unwrap_or_else(|error| panic!("{name} 生成配置失败：{error}"));
        assert_passes(&binary, name, &config);
    }
}

/// 真实 DNS 生成器的关键形状：`dns.google` 这类**域名**形式的 DoH 服务器
/// 在 1.14 里只靠 `route.default_domain_resolver` 就够，不需要逐条
/// `domain_resolver`。这条断言是留给后来人的证据——不是我们没想过。
#[test]
fn domain_shaped_doh_server_passes_with_only_the_global_resolver() {
    let Some(binary) = sing_box() else {
        missing_binary("domain_shaped_doh_server_passes_with_only_the_global_resolver");
        return;
    };

    let plan = real_plan("direct", "cn", &[]);
    let remote = plan.dns["servers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|server| server["server"] == "dns.google")
        .expect("cn direct 的远程 DNS 里应该有域名形式的 DoH 服务器");

    assert_eq!(remote["type"], "https");
    assert!(
        remote.get("domain_resolver").is_none(),
        "生成器不写逐条 domain_resolver，靠 route 层的全局默认"
    );

    let config = build_routed_multi(
        &input(ConnectMode::SystemProxy),
        &[node()],
        "jp-01",
        &plan,
    )
    .expect("生成配置");
    assert_eq!(config["route"]["default_domain_resolver"], "dns-local-1");
    assert_passes(&binary, "proxy-cn-direct-doh", &config);
}
