//! 特权 helper 的入口。
//!
//! 真正的实现只在 macOS 上存在（见 `macos.rs`）：它依赖 libxpc、Security、
//! CoreFoundation，并且要按 SMAppService 的方式注册成 LaunchDaemon。
//!
//! 其它平台**编译成空壳**而不是直接删掉这个 bin：TUN 在那边本来就返回
//! 「不支持」，但打包脚本与 `[[bin]]` 声明是跨平台的，让它能编译过、
//! 运行时报一句明确的错，比在 Cargo.toml 里用 cfg 把整个 bin 摘掉干净。

#[cfg(target_os = "macos")]
mod macos;

fn main() {
    #[cfg(target_os = "macos")]
    {
        macos::run();
    }

    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("veyl-helper: 这个平台还不支持 TUN 接管");
        std::process::exit(2);
    }
}
