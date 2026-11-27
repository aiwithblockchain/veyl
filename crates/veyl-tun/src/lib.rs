//! Veyl 的 TUN 接管与提权协议层。
//!
//! 主客户端（`veyl`）与轻量客户端（`veyl-cli`）共用这一份实现：平台特权的
//! 边界、接管协议、状态机都在这里，各 APP 只提供自己的身份参数（见
//! [`identity`]）与 UI。
//!
//! # 启动顺序
//!
//! 每个二进制必须在**第一次触碰 TUN/身份之前**调用一次 [`identity::install`]。
//! 没注入时 [`identity::identity`] 会 panic，而不是回退到某个默认身份——
//! 回退会让两个 APP 在 Windows 上抢同一个服务名。

pub mod cidr;
pub mod defaults;
pub mod gate;
pub mod identity;
pub mod netcfg;
pub mod protocol;
#[cfg(unix)]
pub mod trust;
#[cfg(target_os = "macos")]
pub mod xpc;
