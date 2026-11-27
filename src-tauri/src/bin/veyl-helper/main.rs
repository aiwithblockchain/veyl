//! 特权 helper 的入口。
//!
//! 实现在共享 crate `veyl_tun::helper`，与 veyl-cli 共用同一份源码；这里只负责
//! 装好主客户端的身份再转交。其它平台**编译成空壳**而不是删掉这个 bin：
//! TUN 在那边本来就返回「不支持」，但打包脚本与 `[[bin]]` 声明是跨平台的。

#[cfg(target_os = "macos")]
#[path = "../../tun_identity.rs"]
mod tun_identity;

fn main() {
    #[cfg(target_os = "macos")]
    {
        tun_identity::install();
        veyl_tun::helper::macos::run();
    }

    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("veyl-helper: 这个平台还不支持 TUN 接管");
        std::process::exit(2);
    }
}
