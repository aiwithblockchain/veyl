//! `%ProgramData%\Veyl` 的 DACL：服务自己建、自己校验。
//!
//! 安装脚本也会设同样的 ACL，但**不能只靠它**：目录有可能是被普通用户
//! 预先建好、ACL 宽松的，而服务会从这个目录执行 staged 的 `sing-box.exe`。
//! 所以服务在启动时（以及每次 `start` 前）都会：
//!
//! 1. 目录不存在 → 用**受保护**的 DACL 创建（不继承父目录的 ACE）；
//! 2. 目录已存在 → 枚举 DACL，任何非 SYSTEM/Administrators 的写权限都失败关闭；
//! 3. 拒绝 reparse point（junction / symlink 可以把目录指到别处）。
//!
//! `logs` 是唯一允许 Users 只读的子目录（排障要能看日志），且只给读+执行。
//! W5 的提权安装器复用同一段（`ensure_data_layout`）。

use std::ffi::c_void;
use std::path::Path;

use windows_sys::Win32::Foundation::{LocalFree, ERROR_SUCCESS, GENERIC_ALL, GENERIC_WRITE};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW,
    GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    AclSizeInformation, EqualSid, GetAce, GetAclInformation, ACCESS_ALLOWED_ACE, ACL,
    ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES,
};

use super::{last_error, wide};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;

/// 只允许 SYSTEM 与 Administrators 完全控制；`P` 表示不继承父目录的 ACE。
const PRIVATE_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

/// `logs` 额外允许 Users 只读 + 执行（0x1200a9 = FILE_GENERIC_READ |
/// FILE_GENERIC_EXECUTE）。不含任何写位。
const LOGS_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)";

// ACE 类型是 ABI 常量。windows-sys 把它们放在 `Win32_System_SystemServices`
// 特性里，这里只用到四个值，就不为一个常量多开一个特性。
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
const SYSTEM_AUDIT_ACE_TYPE: u8 = 2;
const SYSTEM_ALARM_ACE_TYPE: u8 = 3;

const SYSTEM_SID: &str = "S-1-5-18";
const ADMINISTRATORS_SID: &str = "S-1-5-32-544";

/// 任何「能让普通用户改写目录内容」的权限位。
///
/// 目录上的 `FILE_WRITE_DATA` 等于 `FILE_ADD_FILE`，`FILE_APPEND_DATA` 等于
/// `FILE_ADD_SUBDIRECTORY`；`FILE_DELETE_CHILD` 允许删掉我们放进去的 exe。
pub(crate) const WRITE_MASK: u32 = 0x0000_0002 // FILE_WRITE_DATA / FILE_ADD_FILE
    | 0x0000_0004 // FILE_APPEND_DATA / FILE_ADD_SUBDIRECTORY
    | 0x0000_0010 // FILE_WRITE_EA
    | 0x0000_0040 // FILE_DELETE_CHILD
    | 0x0000_0100 // FILE_WRITE_ATTRIBUTES
    | 0x0001_0000 // DELETE
    | 0x0004_0000 // WRITE_DAC
    | 0x0008_0000 // WRITE_OWNER
    | GENERIC_ALL
    | GENERIC_WRITE;

/// 建好（或校验好）`%ProgramData%\Veyl` 的目录形状。失败即拒绝启动。
///
/// 错误信息只用泛称（「数据目录」「运行时目录」…），不带绝对路径：
/// 契约 §1.1 要求 message 不含路径。
pub fn ensure_data_layout(root: &Path) -> Result<(), String> {
    ensure_dir(root, "数据目录", PRIVATE_SDDL)?;
    ensure_dir(&root.join("runtime"), "运行时目录", PRIVATE_SDDL)?;
    ensure_dir(&root.join("tun"), "配置目录", PRIVATE_SDDL)?;
    ensure_dir(&root.join("logs"), "日志目录", LOGS_SDDL)?;
    Ok(())
}

fn ensure_dir(path: &Path, label: &str, sddl: &str) -> Result<(), String> {
    if !path.exists() {
        create_protected(path, label, sddl)?;
    }
    // 同名文件不能顶替目录通过校验。
    if !path.is_dir() {
        return Err(format!("{label}不是目录，拒绝使用"));
    }
    verify_no_user_writes(path, label)
}

fn create_protected(path: &Path, label: &str, sddl: &str) -> Result<(), String> {
    let sddl = wide(sddl);
    let mut descriptor: *mut c_void = std::ptr::null_mut();
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || descriptor.is_null() {
        return Err(format!("构造目录安全描述符失败（Win32 {}）", last_error()));
    }
    let descriptor = LocalPtr(descriptor);

    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let path_wide = wide(&path.to_string_lossy());
    // 直接带 SD 创建：不存在「先建出来、再收紧」的窗口。
    let ok = unsafe { CreateDirectoryW(path_wide.as_ptr(), &attributes) };
    if ok != 0 {
        return Ok(());
    }
    let code = last_error();
    if code == windows_sys::Win32::Foundation::ERROR_ALREADY_EXISTS {
        return Ok(());
    }
    Err(format!("创建{label}失败（Win32 {code}）"))
}

/// 目录是否允许非管理员写入。任何一处不合规都失败关闭。
fn verify_no_user_writes(path: &Path, label: &str) -> Result<(), String> {
    let path_wide = wide(&path.to_string_lossy());
    let attributes = unsafe { GetFileAttributesW(path_wide.as_ptr()) };
    if attributes != INVALID_FILE_ATTRIBUTES && attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!("{label}是 reparse point，拒绝使用"));
    }

    let mut descriptor: *mut c_void = std::ptr::null_mut();
    let mut owner: *mut c_void = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("读取{label}的 ACL 失败（Win32 {status}）"));
    }
    let _descriptor = LocalPtr(descriptor);

    // 所有者隐含 READ_CONTROL + WRITE_DAC：即使 DACL 只有 SYSTEM/BA，
    // 普通用户只要拥有这个目录，就能给自己加写权限。所有者也必须是我们的人。
    if owner.is_null() || !is_privileged_sid(owner) {
        return Err(format!(
            "{label}的所有者不是 SYSTEM/Administrators，拒绝使用"
        ));
    }

    if dacl.is_null() {
        // NULL DACL = 所有人完全控制，这是最坏的情况，不能当成「没设 ACL」放行。
        return Err(format!("{label}没有 DACL（等同于所有人可写）"));
    }

    let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        GetAclInformation(
            dacl,
            &mut info as *mut ACL_SIZE_INFORMATION as *mut c_void,
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    };
    if ok == 0 {
        return Err(format!(
            "读取{label}的 DACL 信息失败（Win32 {}）",
            last_error()
        ));
    }

    for index in 0..info.AceCount {
        let mut ace: *mut c_void = std::ptr::null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
            continue;
        }
        // SAFETY: ACE 指针由 GetAce 给出，长度至少是 ACE_HEADER；Mask 在所有
        // 带掩码的 ACE 里都在 header 之后。
        let allowed = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
        let header = allowed.Header;
        if header.AceType == ACCESS_DENIED_ACE_TYPE
            || header.AceType == SYSTEM_AUDIT_ACE_TYPE
            || header.AceType == SYSTEM_ALARM_ACE_TYPE
        {
            continue;
        }
        if allowed.Mask & WRITE_MASK == 0 {
            continue;
        }
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
            // 对象 ACE 等不认识的类型：不猜它的 SID 布局，直接失败关闭。
            return Err(format!(
                "{label}的 DACL 含未识别的授权类型（ACE #{index}），拒绝使用"
            ));
        }
        // SAFETY: ACCESS_ALLOWED_ACE 的 SID 从 SidStart 开始。
        let sid = &allowed.SidStart as *const u32 as *const c_void;
        if !is_privileged_sid(sid) {
            return Err(format!(
                "{label}的 DACL 允许非管理员写入（ACE #{index}），拒绝使用"
            ));
        }
    }
    Ok(())
}

/// 只认 SYSTEM 与 Administrators；其余一律视为「普通用户」。
fn is_privileged_sid(sid: *const c_void) -> bool {
    for text in [SYSTEM_SID, ADMINISTRATORS_SID] {
        let text_wide = wide(text);
        let mut known: *mut c_void = std::ptr::null_mut();
        if unsafe { ConvertStringSidToSidW(text_wide.as_ptr(), &mut known) } == 0 {
            continue;
        }
        let known = LocalPtr(known);
        // EqualSid 需要可写指针，但不会修改内容。
        if unsafe { EqualSid(sid as *mut c_void, known.0) } != 0 {
            return true;
        }
    }
    false
}

struct LocalPtr(*mut c_void);

impl Drop for LocalPtr {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::fs::symlink_dir;
    use std::path::PathBuf;
    use windows_sys::Win32::Security::Authorization::SetNamedSecurityInfoW;
    use windows_sys::Win32::Security::UNPROTECTED_DACL_SECURITY_INFORMATION;

    fn temp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("veyl-acl-{tag}-{:016x}", rand::random::<u64>()))
    }

    /// 以 Administrators 为所有者创建目录。
    ///
    /// 只有「当前进程没有提权」才跳过：SDDL 拼错或实现回归必须让用例变红，
    /// 不能一律静默跳过。
    fn make(tag: &str, dacl: &str) -> Option<PathBuf> {
        if !running_elevated() {
            eprintln!("跳过 {tag}：需要管理员权限设置目录所有者与 DACL");
            return None;
        }
        let path = temp(tag);
        create_protected(&path, "测试目录", &format!("O:BAD:P{dacl}"))
            .unwrap_or_else(|error| panic!("创建测试目录失败（{tag}）：{error}"));
        Some(path)
    }

    /// 当前进程是否提权。非提权时无法把目录所有者设成 Administrators。
    fn running_elevated() -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::Security::{
            GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        struct Token(HANDLE);

        impl Drop for Token {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe { CloseHandle(self.0) };
                }
            }
        }

        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return false;
        }
        let token = Token(token);
        let mut elevation: TOKEN_ELEVATION = unsafe { std::mem::zeroed() };
        let mut size = 0u32;
        let ok = unsafe {
            GetTokenInformation(
                token.0,
                TokenElevation,
                &mut elevation as *mut TOKEN_ELEVATION as *mut c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            )
        };
        ok != 0 && elevation.TokenIsElevated != 0
    }

    fn private_dir(tag: &str) -> Option<PathBuf> {
        make(tag, "(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
    }

    #[test]
    fn a_protected_directory_passes() {
        let Some(dir) = private_dir("private") else {
            return;
        };
        verify_no_user_writes(&dir, "测试目录").expect("受保护 DACL 必须通过");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_world_writable_directory_is_refused() {
        let Some(dir) = make("world", "(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;WD)") else {
            return;
        };
        let error = verify_no_user_writes(&dir, "测试目录").unwrap_err();
        assert!(error.contains("非管理员写入"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_reparse_point_is_refused() {
        let Some(target) = private_dir("reparse-target") else {
            return;
        };
        let link = temp("reparse-link");
        if symlink_dir(&target, &link).is_err() {
            eprintln!("跳过 reparse：需要开发者模式或管理员权限");
            let _ = std::fs::remove_dir_all(&target);
            return;
        }
        let error = verify_no_user_writes(&link, "测试目录").unwrap_err();
        assert!(error.contains("reparse"), "{error}");
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&target);
    }

    #[test]
    fn a_directory_without_a_dacl_is_refused() {
        let Some(dir) = private_dir("nulldacl") else {
            return;
        };
        let path_wide = wide(&dir.to_string_lossy());
        let status = unsafe {
            SetNamedSecurityInfoW(
                path_wide.as_ptr() as *mut u16,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            eprintln!("跳过 NULL DACL：设置失败（Win32 {status}），需要管理员");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let error = verify_no_user_writes(&dir, "测试目录").unwrap_err();
        assert!(error.contains("没有 DACL"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同名文件不能顶替目录通过校验。
    #[test]
    fn a_file_with_the_directory_name_is_refused() {
        let path = temp("file");
        std::fs::write(&path, b"x").unwrap();
        let error = ensure_dir(&path, "测试目录", PRIVATE_SDDL).unwrap_err();
        assert!(error.contains("不是目录"), "{error}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn every_way_to_rewrite_the_directory_is_in_the_mask() {
        for bit in [
            0x0000_0002, // FILE_ADD_FILE
            0x0000_0004, // FILE_ADD_SUBDIRECTORY
            0x0000_0040, // FILE_DELETE_CHILD
            0x0001_0000, // DELETE
            0x0004_0000, // WRITE_DAC
            0x0008_0000, // WRITE_OWNER
            GENERIC_WRITE,
            GENERIC_ALL,
        ] {
            assert_eq!(WRITE_MASK & bit, bit, "缺少写权限位 {bit:#x}");
        }
    }

    #[test]
    fn read_and_execute_is_not_a_write() {
        // 0x1200a9 = 给 Users 的读+执行（logs 目录）。
        assert_eq!(WRITE_MASK & 0x0012_00a9, 0);
    }

    #[test]
    fn the_logs_directory_is_the_only_one_with_users_access() {
        assert!(!PRIVATE_SDDL.contains(";;;BU)"));
        assert!(LOGS_SDDL.contains(";;;BU)"));
        // 两者都必须是受保护 DACL，否则父目录的 ACE 会漏进来。
        assert!(PRIVATE_SDDL.starts_with("D:P"));
        assert!(LOGS_SDDL.starts_with("D:P"));
    }
}
