//! 特权 helper 的实现。两个 APP 的 bin 各自注入 `Identity` 后调用 [`macos::run`]。
//!
//! 这里只做与平台相关的事情；身份（服务名、信任根、数据目录、转发器地址）
//! 全部从 [`crate::identity`] 取，不写死任何一个 APP 的名字。

pub mod paths;

#[cfg(target_os = "macos")]
pub mod macos;
