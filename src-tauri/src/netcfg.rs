//! 系统网络状态查询。实现已移入 `crates/veyl-tun`。
//!
//! 主客户端保留这个模块名，是为了让 `crate::netcfg::…` 的既有引用一行不改：
//! 它反向依赖 `tun::cidr` 与 TUN 网段，本来就属于隧道层。

pub use veyl_tun::netcfg::*;
