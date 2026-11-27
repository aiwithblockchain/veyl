//! veyl-cli 的身份参数。
//!
//! 共享 crate 不认识任何具体 APP：管道名、服务名、launchd 标签、信任根、网段、
//! 随包 runtime 的哈希全部由这里注入。两个 APP 的这些值必须**互不相同**，
//! 否则在 Windows 上会抢同一个服务名、在 macOS 上会共用一个信任根。

use veyl_tun::identity::Identity;

/// 家目录下的数据目录名。
pub const DATA_DIR_NAME: &str = ".veyl-cli";

pub fn build() -> Identity {
    Identity {
        bundle_identifier: env!("VEYL_BUNDLE_IDENTIFIER"),
        team_id: env!("VEYL_TEAM_ID"),
        helper_binary_name: "veyl-cli-helper",
        helper_version: env!("CARGO_PKG_VERSION"),
        app_display_name: "veyl-cli",
        data_dir_name: DATA_DIR_NAME,
        // 与主客户端的 127.0.0.1:53 错开，两套 APP 同时接管时不抢端口。
        dns_forwarder_ip: "127.0.0.2",
        pipe_name: r"\\.\pipe\veyl-cli-helper",
        service_name: "VeylCliService",
        service_display_name: "veyl-cli Privileged Service",
        install_dir_name: "veyl-cli",
        mach_service: "com.veyl.cli.helper",
        daemon_plist: "com.veyl.cli.helper.plist",
        trust_root: "/Library/Application Support/veyl-cli",
        tun_address_macos: crate::platform::TUN_ADDRESS_MACOS,
        tun_address_windows: crate::platform::TUN_ADDRESS_WINDOWS,
        runtime_sha256: env!("VEYL_RUNTIME_SHA256"),
        rules_archive_sha256: env!("VEYL_RULES_ARCHIVE_SHA256"),
        wintun_sha256: "",
        win_cert_thumbprints: None,
        win_publisher: None,
        win_allow_unsigned_dev: None,
    }
}

/// 注入本进程的身份。重复调用无害。
pub fn install() {
    static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        veyl_tun::identity::install(build())
            .expect("veyl-tun: 身份只能注入一次");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两套 APP 的身份不能撞：撞了就是抢服务名 / 共用信任根。
    #[test]
    fn identity_is_distinct_from_the_main_client() {
        let id = build();
        assert_eq!(id.helper_binary_name, "veyl-cli-helper");
        assert_eq!(id.mach_service, "com.veyl.cli.helper");
        assert_eq!(id.daemon_plist, "com.veyl.cli.helper.plist");
        assert_eq!(id.trust_root, "/Library/Application Support/veyl-cli");
        assert_eq!(id.pipe_name, r"\\.\pipe\veyl-cli-helper");
        assert_eq!(id.service_name, "VeylCliService");
        assert_eq!(id.install_dir_name, "veyl-cli");
        assert_eq!(id.data_dir_name, ".veyl-cli");
        assert_eq!(id.dns_forwarder_ip, "127.0.0.2");
        assert_eq!(id.bundle_identifier, "io.github.aiwithblockchain.veyl.cli");
    }
}
