//! 运行时二进制的平台完整性校验。
//!
//! **macOS 用代码签名，不用编译期哈希。** 打包时签名会改写 Mach-O 的字节，
//! 构建期算出的 sha256 只对签名前的文件成立；拿它判定安装包里的副本必然失败，
//! 而失败又去联网下载是最差的组合。签名才是「这是我们发布的代码」的真正凭据，
//! 而且与打包顺序无关。
//!
//! 要求与 helper 执行前的那一道完全一致（`veyl-helper/macos.rs`
//! `staged_runtime_signature_valid`）：
//!
//! ```text
//! anchor apple generic and identifier "sing-box" and certificate leaf[subject.OU] = "<TEAM_ID>"
//! ```
//!
//! - `anchor apple generic`：排除 ad-hoc 与自签名；
//! - `identifier "sing-box"`：同一个 Team 签的其它二进制（例如主程序）不算；
//! - 叶子证书 OU = 我们的 Team ID：排除别的开发者签的同名程序。
//!
//! Windows 尚未接入 Authenticode，沿用构建期哈希（`VEYL_RUNTIME_SHA256`）；
//! 已安装的版本则与安装记录里的 sha256 比对。两者都不放宽成「无校验」。

use std::path::Path;

/// 运行时必须以裸 Mach-O 的文件名作为签名 identifier。
///
/// 改名、或给 `codesign` 传 `--identifier`，都会让这里的校验和 helper 一侧
/// 同时失配，所以只在一处定义。
pub const RUNTIME_IDENTIFIER: &str = "sing-box";

/// App 侧对运行时的签名要求。与 helper 共用同一份字符串来源。
#[cfg(target_os = "macos")]
pub fn runtime_requirement() -> String {
    format!(
        "anchor apple generic and identifier \"{RUNTIME_IDENTIFIER}\" and certificate leaf[subject.OU] = \"{}\"",
        crate::tun::protocol::TEAM_ID
    )
}

/// 随包运行时（打包时由 sign-macos.sh 签过）的校验。
pub fn verify_bundled_runtime(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::static_requirement_check(path, false, &runtime_requirement(), 1)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let expected = env!("VEYL_RUNTIME_SHA256");
        if expected.is_empty() {
            return Err("这份构建没有随包运行时哈希".into());
        }
        let actual = crate::runtime::fsutil::sha256_file(path)
            .map_err(|error| format!("读取运行时失败：{error}"))?;
        if actual.eq_ignore_ascii_case(expected) {
            Ok(())
        } else {
            Err(format!("运行时哈希不符（期望 {expected}，实际 {actual}）"))
        }
    }
}

/// 已安装到用户目录的运行时：签名（macOS）或安装记录里的完整哈希（其它平台）。
pub fn verify_installed_runtime(path: &Path, recorded_sha256: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = recorded_sha256;
        macos::static_requirement_check(path, false, &runtime_requirement(), 1)
    }
    #[cfg(not(target_os = "macos"))]
    {
        if !crate::tun::trust::is_full_sha256(recorded_sha256) {
            return Err("安装记录里没有完整哈希，无法确认运行时".into());
        }
        let actual = crate::runtime::fsutil::sha256_file(path)
            .map_err(|error| format!("读取运行时失败：{error}"))?;
        if actual.eq_ignore_ascii_case(recorded_sha256) {
            Ok(())
        } else {
            Err(format!("运行时哈希与安装记录不符（记录 {recorded_sha256}，实际 {actual}）"))
        }
    }
}

/// 从更新源下载并解压出来的运行时：必须在发布前由我们重签，否则拒绝。
///
/// 不能拿构建期哈希比对——新版本本来就是别的字节。macOS 用同一条签名要求；
/// 其它平台尚无 Authenticode 校验，明确拒绝而不是放行。
pub fn verify_downloaded_runtime(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::static_requirement_check(path, false, &runtime_requirement(), 1)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("当前平台尚未接入更新包签名校验，已停止升级".into())
    }
}

/// 给用户看的一句话，说明为什么拒绝。
pub fn rejection_hint() -> &'static str {
    "安装包里的运行库不可用，请重新安装 Veyl；也可以在「高级设置 → 运行库」里手动升级。"
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_void, CString};
    use std::path::Path;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(
            allocator: *const c_void,
            buffer: *const u8,
            buf_len: isize,
            is_directory: bool,
        ) -> *const c_void;
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFRelease(value: *const c_void);
    }

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecStaticCodeCreateWithPath(
            path: *const c_void,
            flags: u32,
            code: *mut *const c_void,
        ) -> i32;
        fn SecStaticCodeCheckValidity(
            code: *const c_void,
            flags: u32,
            requirement: *const c_void,
        ) -> i32;
        fn SecRequirementCreateWithString(
            text: *const c_void,
            flags: u32,
            requirement: *mut *const c_void,
        ) -> i32;
    }

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    /// 对 `path`（bundle 或裸可执行文件）做静态签名校验。
    ///
    /// `flags = 1` 是 `kSecCSCheckAllArchitectures`：universal 二进制的每一片
    /// 都必须由我们签过，只验当前架构会漏掉另一半。
    pub(super) fn static_requirement_check(
        path: &Path,
        is_directory: bool,
        requirement: &str,
        flags: u32,
    ) -> Result<(), String> {
        let path = path.to_string_lossy().to_string();
        // SAFETY: Create 出来的 CF 对象都在本函数内释放；requirement 字符串在
        // 构造出 SecRequirement 之后即可释放。
        unsafe {
            let url = CFURLCreateFromFileSystemRepresentation(
                std::ptr::null(),
                path.as_ptr(),
                path.len() as isize,
                is_directory,
            );
            if url.is_null() {
                return Err("无法构造文件 URL".into());
            }

            let mut code: *const c_void = std::ptr::null();
            let status = SecStaticCodeCreateWithPath(url, 0, &mut code);
            CFRelease(url);
            if status != 0 || code.is_null() {
                return Err(format!("读不到代码签名（OSStatus {status}）"));
            }

            let text = match CString::new(requirement) {
                Ok(text) => text,
                Err(_) => {
                    CFRelease(code);
                    return Err("requirement 含空字节".into());
                }
            };
            let requirement_text = CFStringCreateWithCString(
                std::ptr::null(),
                text.as_ptr(),
                K_CF_STRING_ENCODING_UTF8,
            );
            if requirement_text.is_null() {
                CFRelease(code);
                return Err("无法构造签名要求".into());
            }
            let mut parsed: *const c_void = std::ptr::null();
            let status = SecRequirementCreateWithString(requirement_text, 0, &mut parsed);
            CFRelease(requirement_text);
            if status != 0 || parsed.is_null() {
                CFRelease(code);
                return Err(format!("签名要求字符串无效（OSStatus {status}）"));
            }

            let valid = SecStaticCodeCheckValidity(code, flags, parsed);
            CFRelease(parsed);
            CFRelease(code);
            if valid == 0 {
                Ok(())
            } else {
                Err(format!("签名不满足我们的要求（OSStatus {valid}）"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn the_requirement_pins_identifier_and_team() {
        let requirement = runtime_requirement();
        assert!(requirement.contains("anchor apple generic"), "{requirement}");
        assert!(requirement.contains("identifier \"sing-box\""), "{requirement}");
        assert!(
            requirement.contains(&format!(
                "subject.OU] = \"{}\"",
                crate::tun::protocol::TEAM_ID
            )),
            "{requirement}"
        );
    }

    /// 没签名的二进制必须被拒——这条不依赖证书。
    #[cfg(target_os = "macos")]
    #[test]
    fn an_unsigned_binary_is_rejected() {
        let dir = std::env::temp_dir().join(format!("veyl-sig-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let binary = dir.join("sing-box");
        std::fs::copy("/bin/echo", &binary).unwrap();
        let _ = std::process::Command::new("codesign")
            .args(["--remove-signature"])
            .arg(&binary)
            .status();

        let error = verify_bundled_runtime(&binary).unwrap_err();
        assert!(!error.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
