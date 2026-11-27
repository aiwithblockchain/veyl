//! 各 APP 自己的身份参数。
//!
//! 这些值以前是写死的常量，也是主客户端 `build.rs` 用 `cargo:rustc-env` 注入的
//! 编译期值。crate 被多个 APP 依赖后 `env!` 读不到依赖方 build script 的输出，
//! 所以改成运行期注入：每个二进制在**第一次触碰 TUN/身份之前**调用一次
//! [`install`]。
//!
//! 不提供"没注入就用主客户端默认值"的回退：那会让漏调 `install` 的 APP 静默用上
//! 主客户端的 Windows 服务名，两个 APP 会认为服务已安装并连到错误的二进制——
//! 这是安全边界问题，必须失败关闭。

use std::fmt;
use std::sync::OnceLock;

/// 一个 APP 的全部身份参数。字段值在进程生命周期内不变，所以用 `&'static str`。
#[derive(Debug, Clone, Copy)]
pub struct Identity {
    /// 代码签名与 designated requirement 用的 bundle identifier。
    pub bundle_identifier: &'static str,
    /// Apple Developer Team ID（证书 `leaf[subject.OU]`）。
    pub team_id: &'static str,
    /// helper 可执行文件名（`veyl-helper` / `veyl-cli-helper`）。
    pub helper_binary_name: &'static str,
    /// helper 上报的版本号，取各 APP 自己的 `CARGO_PKG_VERSION`。
    pub helper_version: &'static str,
    /// 产品显示名，用于 helper 的用户可见文案。
    pub app_display_name: &'static str,
    /// 家目录下的数据目录名（`.veyl` / `.veyl-cli`），helper 日志写在这里。
    pub data_dir_name: &'static str,
    /// DNS 转发器绑定的回环地址。两套 APP 同时接管时不能都占 53 端口。
    pub dns_forwarder_ip: &'static str,
    /// Windows 命名管道名，含 `\\.\pipe\` 前缀。
    pub pipe_name: &'static str,
    /// Windows 服务名（SCM 里的键）。
    pub service_name: &'static str,
    /// Windows 服务显示名，只有安装器读。
    pub service_display_name: &'static str,
    /// Windows 安装目录名（`C:\Program Files\<name>` 与 `%ProgramData%\<name>`）。
    pub install_dir_name: &'static str,
    /// macOS XPC Mach service 标签，同时是 launchd 的 `Label`。
    pub mach_service: &'static str,
    /// launchd plist 文件名。
    pub daemon_plist: &'static str,
    /// macOS 信任根目录（helper 以 root 读写的固定位置）。
    pub trust_root: &'static str,
    /// macOS TUN 网段。
    pub tun_address_macos: &'static str,
    /// Windows 用 fakeip 段，与 macOS 的网段不能互换。
    pub tun_address_windows: &'static str,
    /// 随包 `sing-box` 的 sha256，空串表示这次构建没带运行时。
    pub runtime_sha256: &'static str,
    /// 规则归档的 sha256，空串表示这次构建没带归档。
    pub rules_archive_sha256: &'static str,
    /// 随包 `wintun.dll` 的 sha256，空串表示没有。
    pub wintun_sha256: &'static str,
    /// Windows 对端证书指纹固定值（可选）。
    pub win_cert_thumbprints: Option<&'static str>,
    /// Windows 对端证书发布者（可选）。
    pub win_publisher: Option<&'static str>,
    /// Windows 开发期允许未签名对端（可选，仅 debug）。
    pub win_allow_unsigned_dev: Option<&'static str>,
}

static INSTALLED: OnceLock<Identity> = OnceLock::new();

/// 重复注入。正常不会发生，出现了说明有第二个入口点在抢着装身份。
#[derive(Debug)]
pub struct AlreadyInstalled;

impl fmt::Display for AlreadyInstalled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("veyl-tun: Identity 已经被注入过")
    }
}

impl std::error::Error for AlreadyInstalled {}

/// 注入身份。每个二进制在启动时调一次。
pub fn install(identity: Identity) -> Result<(), AlreadyInstalled> {
    INSTALLED.set(identity).map_err(|_| AlreadyInstalled)
}

pub fn try_identity() -> Option<&'static Identity> {
    INSTALLED.get()
}

/// 取身份。没注入时 panic——这是启动路径上的编程错误，不是运行期可恢复状态。
pub fn identity() -> &'static Identity {
    // 只有本 crate 自己的单元测试会自动装一份夹具；依赖方（主客户端、veyl-cli）
    // 编译本 crate 时 `cfg(test)` 不成立，仍然必须显式注入。
    #[cfg(test)]
    test_fixture::install();
    INSTALLED.get().unwrap_or_else(|| {
        panic!(
            "veyl-tun: Identity 尚未注入。每个二进制都必须在任何 TUN/身份访问之前调用 \
             veyl_tun::install(...)（主客户端：veyl_lib::run()；helper：run() 首句；\
             service：main() 首句）。"
        )
    })
}

#[cfg(test)]
mod test_fixture {
    use super::*;
    use std::sync::OnceLock;

    /// crate 内测试用的身份。值取主客户端的 defaults，只为让纯计算与协议测试
    /// 能跑；断言某个具体标识的用例要用 `*_for(...)` 形式的纯函数。
    pub fn install() {
        static ONCE: OnceLock<()> = OnceLock::new();
        ONCE.get_or_init(|| {
            let _ = super::install(Identity {
                bundle_identifier: "com.example.veyl-tun-test",
                team_id: "TESTTEAM12",
                helper_binary_name: crate::defaults::HELPER_BINARY_NAME,
                helper_version: "0.0.0-test",
                app_display_name: "Veyl",
                data_dir_name: crate::defaults::DATA_DIR_NAME,
                dns_forwarder_ip: "127.0.0.1",
                pipe_name: crate::defaults::PIPE_NAME,
                service_name: crate::defaults::SERVICE_NAME,
                service_display_name: crate::defaults::SERVICE_DISPLAY_NAME,
                install_dir_name: crate::defaults::INSTALL_DIR_NAME,
                mach_service: crate::defaults::MACH_SERVICE,
                daemon_plist: crate::defaults::DAEMON_PLIST,
                trust_root: crate::defaults::TRUST_ROOT,
                tun_address_macos: crate::defaults::TUN_ADDRESS_MACOS,
                tun_address_windows: crate::defaults::TUN_ADDRESS_WINDOWS,
                runtime_sha256: "",
                rules_archive_sha256: "",
                wintun_sha256: "",
                win_cert_thumbprints: None,
                win_publisher: None,
                win_allow_unsigned_dev: None,
            });
        });
    }
}

pub fn bundle_identifier() -> &'static str {
    identity().bundle_identifier
}

pub fn team_id() -> &'static str {
    identity().team_id
}

pub fn helper_binary_name() -> &'static str {
    identity().helper_binary_name
}

pub fn helper_version() -> &'static str {
    identity().helper_version
}

pub fn app_display_name() -> &'static str {
    identity().app_display_name
}

pub fn data_dir_name() -> &'static str {
    identity().data_dir_name
}

pub fn dns_forwarder_ip() -> &'static str {
    identity().dns_forwarder_ip
}

pub fn pipe_name() -> &'static str {
    identity().pipe_name
}

pub fn service_name() -> &'static str {
    identity().service_name
}

pub fn service_display_name() -> &'static str {
    identity().service_display_name
}

pub fn install_dir_name() -> &'static str {
    identity().install_dir_name
}

pub fn mach_service() -> &'static str {
    identity().mach_service
}

pub fn daemon_plist() -> &'static str {
    identity().daemon_plist
}

pub fn trust_root() -> &'static str {
    identity().trust_root
}

pub fn tun_address_macos() -> &'static str {
    identity().tun_address_macos
}

pub fn tun_address_windows() -> &'static str {
    identity().tun_address_windows
}

/// 本平台实际使用的 TUN 网段。
pub fn tun_address() -> &'static str {
    if cfg!(windows) {
        tun_address_windows()
    } else {
        tun_address_macos()
    }
}

pub fn runtime_sha256() -> &'static str {
    identity().runtime_sha256
}

pub fn rules_archive_sha256() -> &'static str {
    identity().rules_archive_sha256
}

pub fn wintun_sha256() -> &'static str {
    identity().wintun_sha256
}

pub fn win_cert_thumbprints() -> Option<&'static str> {
    identity().win_cert_thumbprints
}

pub fn win_publisher() -> Option<&'static str> {
    identity().win_publisher
}

pub fn win_allow_unsigned_dev() -> Option<&'static str> {
    identity().win_allow_unsigned_dev
}
