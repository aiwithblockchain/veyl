//! 特权 helper 的实现。两个 APP 的 bin 各自注入 `Identity` 后调用 [`macos::run`]。
//!
//! 这里只做与平台相关的事情；身份（服务名、信任根、数据目录、转发器地址）
//! 全部从 [`crate::identity`] 取，不写死任何一个 APP 的名字。

pub mod paths;

/// helper 的诊断输出：前缀用注入的 helper 二进制名（`veyl-helper` / `veyl-cli-helper`），
/// 不写死任何一个 APP 的名字。
#[macro_export]
macro_rules! helper_note {
    ($($arg:tt)*) => {
        eprintln!("{}: {}", $crate::identity::helper_binary_name(), format_args!($($arg)*))
    };
}

#[cfg(target_os = "macos")]
pub mod macos;
