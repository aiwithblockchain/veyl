//! Windows 特权通道：命名管道 + 客户端进程校验。
//!
//! 主程序（普通用户）与服务（LocalSystem）共用这里的线协议与路径规则；
//! 服务端入口在 `src/bin/veyl-service/`。
//!
//! 与 macOS 的 XPC 通道没有任何可复用代码，但四条原则相同：
//! 请求里没有路径、配置走 allowlist、先验对端再读消息、失败关闭。

use std::path::{Path, PathBuf};

pub mod acl;
pub mod ipc;
pub mod log;
pub mod peer;
pub mod pipe;
pub mod process;
pub mod runtime;
pub mod scm;

// `cidr.rs` 不在这里声明：主程序（`tun/mod.rs`）与服务二进制都直接
// `#[path]` 引用它，在这里再声明一次会让主程序把同一份源码编两遍。

/// 管道名与服务名。管道名沿用文档里的 `veyl-helper`，避免客户端两套名字。
pub const PIPE_NAME: &str = r"\\.\pipe\veyl-helper";
pub const SERVICE_NAME: &str = "VeylService";
// 只给安装脚本用的显示名，Rust 侧不引用。
#[allow(dead_code)]
pub const SERVICE_DISPLAY_NAME: &str = "Veyl Privileged Service";
pub const INSTALL_DIR_NAME: &str = "Veyl";

/// 拉起子进程时不创建控制台窗口（服务运行在 session 0，没人能看见它）。
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `ProgramFiles` 在服务进程里来自系统环境，不是用户可写的。
pub fn program_files_dir() -> PathBuf {
    std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
}

/// 服务只从这里读二进制、运行时、规则。
pub fn install_dir() -> PathBuf {
    program_files_dir().join(INSTALL_DIR_NAME)
}

/// 服务只往这里写状态、配置、日志。
pub fn program_data_dir() -> PathBuf {
    std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join(INSTALL_DIR_NAME)
}

pub fn logs_dir() -> PathBuf {
    program_data_dir().join("logs")
}

/// `image` 是否在 `root` 目录之下（Windows 路径大小写不敏感）。
///
/// 两边都尽量 canonicalize，防止 `..` 或 junction 把路径指到别处；
/// 目录还不存在时退回词法比较，调用方必须把 root 建出来（安装器负责）。
pub fn path_within(root: &Path, image: &Path) -> bool {
    let root = normalize(root);
    let image = normalize(image);
    image == root || image.starts_with(&format!("{root}\\"))
}

/// 两个路径是否指向同一个文件。用于「这个 pid 还是不是我们起的那个」的核对。
pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    normalize(left) == normalize(right)
}

fn normalize(path: &Path) -> String {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let raw = canonical
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();
    let raw = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    // 路径可能还不存在，canonicalize 不做词法消解；这里自己消掉 `.` 与 `..`。
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("\\")
}

pub(crate) fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

pub(crate) fn from_wide(buffer: &[u16]) -> String {
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..length])
}

pub(crate) fn last_error() -> u32 {
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_inside_the_install_dir_passes() {
        let root = Path::new(r"C:\Program Files\Veyl");
        assert!(path_within(
            root,
            Path::new(r"C:\Program Files\Veyl\veyl.exe")
        ));
        assert!(path_within(
            root,
            Path::new(r"c:\program files\veyl\sub\veyl.exe")
        ));
        assert!(!path_within(
            root,
            Path::new(r"C:\Program Files\VeylOther\veyl.exe")
        ));
        assert!(!path_within(
            root,
            Path::new(r"C:\Program Files\Veyl\..\evil\veyl.exe")
        ));
    }
}
