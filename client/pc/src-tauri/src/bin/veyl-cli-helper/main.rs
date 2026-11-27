//! veyl-cli 的特权 helper 入口。
//!
//! 实现在共享 crate `veyl_tun::helper`；这里只装本 APP 的身份再转交。
//! 其它平台编译成空壳，理由与主客户端一致：[[bin]] 声明是跨平台的。

#[cfg(target_os = "macos")]
#[path = "../../platform.rs"]
#[allow(dead_code)] // 只有网段常量被身份用到，其余属于 App 侧。
mod platform;

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
        eprintln!("veyl-cli-helper: 这个平台还不支持 TUN 接管");
        std::process::exit(2);
    }
}
