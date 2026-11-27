//! 主客户端（veyl）的现值。
//!
//! 共享 crate 不认识任何一个具体的 APP，所以这里只放**主客户端目前写死的值**，
//! 由 `src-tauri/src/tun_identity.rs` 组装进 [`crate::identity::Identity`]。
//! veyl-cli 不读这个模块，它注入自己的名字。
//!
//! 改名会被黄金测试挡住（`src-tauri/src/tun_identity.rs` 的 tests）。

/// Windows 命名管道名。
pub const PIPE_NAME: &str = r"\\.\pipe\veyl-helper";

/// Windows 服务名（SCM 里的键）。
pub const SERVICE_NAME: &str = "VeylService";

/// Windows 服务显示名，只有安装器读。
pub const SERVICE_DISPLAY_NAME: &str = "Veyl Privileged Service";

/// Windows 安装目录名（`C:\Program Files\<name>` 与 `%ProgramData%\<name>`）。
pub const INSTALL_DIR_NAME: &str = "Veyl";

/// macOS XPC Mach service 标签，同时是 launchd 的 `Label`。
pub const MACH_SERVICE: &str = "com.veyl.helper";

/// launchd plist 文件名。
pub const DAEMON_PLIST: &str = "com.veyl.helper.plist";

/// macOS 信任根目录。
pub const TRUST_ROOT: &str = "/Library/Application Support/Veyl";

/// macOS TUN 网段。
pub const TUN_ADDRESS_MACOS: &str = "172.19.0.1/30";

/// Windows fakeip 段。与 macOS 的网段**不能互换**。
pub const TUN_ADDRESS_WINDOWS: &str = "198.18.0.1/15";

/// helper 可执行文件名。
pub const HELPER_BINARY_NAME: &str = "veyl-helper";
