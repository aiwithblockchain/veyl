//! 主客户端 `veyl` 的身份参数。
//!
//! `crates/veyl-tun` 里的代码以前用 `env!` / `option_env!` 直接读 `build.rs`
//! 注入的值。crate 被多个 APP 共用后 `cargo:rustc-env` 只作用于产出它的那个
//! package，依赖 crate 读不到，所以改成运行期注入。这里是把原值组装起来的地方，
//! **取值与抽取前逐字相同**——改名会被下方的黄金测试挡住。

use veyl_tun::defaults;
use veyl_tun::identity::Identity;

pub fn build() -> Identity {
    Identity {
        bundle_identifier: env!("VEYL_BUNDLE_IDENTIFIER"),
        team_id: env!("VEYL_TEAM_ID"),
        helper_binary_name: defaults::HELPER_BINARY_NAME,
        helper_version: env!("CARGO_PKG_VERSION"),
        app_display_name: "Veyl",
        data_dir_name: defaults::DATA_DIR_NAME,
        dns_forwarder_ip: "127.0.0.1",
        pipe_name: defaults::PIPE_NAME,
        service_name: defaults::SERVICE_NAME,
        service_display_name: defaults::SERVICE_DISPLAY_NAME,
        install_dir_name: defaults::INSTALL_DIR_NAME,
        mach_service: defaults::MACH_SERVICE,
        daemon_plist: defaults::DAEMON_PLIST,
        trust_root: defaults::TRUST_ROOT,
        tun_address_macos: defaults::TUN_ADDRESS_MACOS,
        tun_address_windows: defaults::TUN_ADDRESS_WINDOWS,
        runtime_sha256: env!("VEYL_RUNTIME_SHA256"),
        rules_archive_sha256: env!("VEYL_RULES_ARCHIVE_SHA256"),
        wintun_sha256: match option_env!("VEYL_WINTUN_SHA256") {
            Some(value) => value,
            None => "",
        },
        win_cert_thumbprints: option_env!("VEYL_WIN_CERT_THUMBPRINTS"),
        win_publisher: option_env!("VEYL_WIN_PUBLISHER"),
        win_allow_unsigned_dev: option_env!("VEYL_WIN_ALLOW_UNSIGNED_DEV"),
    }
}

/// 注入本进程的身份。多个入口点各自调用，重复调用无害。
pub fn install() {
    static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        veyl_tun::identity::install(build())
            .expect("veyl-tun: 身份只能注入一次，重复注入说明有第二个入口点在装它");
    });
}

/// 测试进程不经过 `run()`，没有入口点能调 `install()`；这里补上。
/// 主客户端 lib 与两个 bin 的测试共享这一份，漏注入会以 panic 暴露而非静默回退。
#[cfg(test)]
#[ctor::ctor]
fn install_for_tests() {
    install();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 抽取前后逐字相同。这些值一旦漂移，两个 APP 会共用同一个管道/服务名或
    /// 信任根，Windows 上是硬失败、macOS 上是验签失败。
    #[test]
    fn identity_keeps_the_extracted_literals() {
        let id = build();
        assert_eq!(id.pipe_name, r"\\.\pipe\veyl-helper");
        assert_eq!(id.service_name, "VeylService");
        assert_eq!(id.service_display_name, "Veyl Privileged Service");
        assert_eq!(id.install_dir_name, "Veyl");
        assert_eq!(id.mach_service, "com.veyl.helper");
        assert_eq!(id.daemon_plist, "com.veyl.helper.plist");
        assert_eq!(id.trust_root, "/Library/Application Support/Veyl");
        assert_eq!(id.tun_address_macos, "172.19.0.1/30");
        assert_eq!(id.tun_address_windows, "198.18.0.1/15");
        assert_eq!(id.helper_binary_name, "veyl-helper");
        assert_eq!(id.bundle_identifier, "io.github.aiwithblockchain.veyl");
    }

    /// requirement 字符串写错一次就是所有连接被拒，而且编译期、单测都不会发现。
    /// 所以不靠人眼：直接从 tauri.conf.json 读出来比对。
    #[test]
    fn the_requirement_uses_the_real_bundle_identifier() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let text = std::fs::read_to_string(&path).expect("读取 tauri.conf.json");
        let key = "\"identifier\"";
        let after = &text[text.find(key).expect("配置里没有 identifier") + key.len()..];
        let after = &after[after.find(':').expect("格式不对") + 1..];
        let start = after.find('"').expect("格式不对") + 1;
        let identifier = &after[start..start + after[start..].find('"').unwrap()];

        let id = build();
        assert_eq!(
            id.bundle_identifier, identifier,
            "build.rs 注入的 identifier 与 tauri.conf.json 不一致"
        );

        let requirement =
            veyl_tun::protocol::app_requirement_for(id.bundle_identifier, id.team_id);
        assert!(requirement.contains("anchor apple generic"));
        assert!(!requirement.contains("com.veyl.app"), "这是之前写错的那个值");
        assert!(requirement.contains(&format!("subject.OU] = \"{}\"", id.team_id)));
    }
}
