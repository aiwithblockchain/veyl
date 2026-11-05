//! 对端认证（`docs/contracts/tun-backend.md` §5.4）。
//!
//! 顺序固定：`GetNamedPipeClientProcessId` → `OpenProcess` 并**持有句柄到会话结束**
//! → `QueryFullProcessImageNameW` → `WinVerifyTrust` 校验发布者 / 证书指纹。
//!
//! **客户端路径只写日志，不参与准入**。应用是 per-user 安装，路径限制会拒掉
//! 我们自己的 App；信任根是「谁签名谁可信」。路径白名单只约束服务自己
//! 执行或加载的文件（`sing-box.exe` / `wintun.dll` / 规则 / staging），见 `harden_process`。
//!
//! 任何一步失败都断开，**不读请求体**，也不回错误明细。

use std::ffi::c_void;
use std::path::Path;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows_sys::Win32::Security::Cryptography::{
    CertGetCertificateContextProperty, CertGetNameStringW, CERT_CONTEXT,
    CERT_NAME_SIMPLE_DISPLAY_TYPE, CERT_SHA1_HASH_PROP_ID,
};
use windows_sys::Win32::Security::WinTrust::{
    WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData,
    WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
    WINTRUST_FILE_INFO, WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
    WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};
use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
use windows_sys::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTSGetActiveConsoleSessionId,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// 发布构建通过环境变量把允许的证书指纹 / 发布者编进服务（`build.rs` 转发）。
const PINNED_THUMBPRINTS: Option<&str> = option_env!("VEYL_WIN_CERT_THUMBPRINTS");
const PINNED_PUBLISHER: Option<&str> = option_env!("VEYL_WIN_PUBLISHER");

/// 开发开关：允许未签名客户端连接。**编译期环境变量、默认关闭、
/// 只在 debug 构建生效**；发布构建即使设置也无效。每次放行都会写 warn 日志。
const ALLOW_UNSIGNED_DEV: Option<&str> = option_env!("VEYL_WIN_ALLOW_UNSIGNED_DEV");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignatureInfo {
    pub subject: String,
    pub thumbprint: String,
    /// 仅 debug 构建可能非空；服务日志必须 warn。发布构建恒为 None。
    pub debug_relaxation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerInfo {
    pub pid: u32,
    /// 只用于日志与诊断；不参与准入。
    pub image: String,
    pub signature: SignatureInfo,
}

/// 校验结果里持有客户端进程句柄：会话期间不能关，否则 pid 可能被复用。
pub struct PeerSession {
    pub info: PeerInfo,
    _process: ProcessHandle,
}

impl std::ops::Deref for PeerSession {
    type Target = PeerInfo;

    fn deref(&self) -> &Self::Target {
        &self.info
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerError {
    ClientPid(u32),
    Session { pid: u32, code: u32 },
    SessionMismatch { pid: u32, session: u32, active: u32 },
    OpenProcess { pid: u32, code: u32 },
    ImagePath { pid: u32, code: u32 },
    Signature { image: String, reason: String },
    Policy { image: String, reason: String },
}

impl std::fmt::Display for PeerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PeerError::ClientPid(code) => write!(f, "取客户端 pid 失败（Win32 {code}）"),
            PeerError::Session { pid, code } => {
                write!(f, "取客户端进程 {pid} 的会话 id 失败（Win32 {code}）")
            }
            PeerError::SessionMismatch {
                pid,
                session,
                active,
            } => write!(
                f,
                "客户端进程 {pid} 在会话 {session}，不是当前控制台会话 {active}"
            ),
            PeerError::OpenProcess { pid, code } => {
                write!(f, "打开客户端进程 {pid} 失败（Win32 {code}）")
            }
            PeerError::ImagePath { pid, code } => {
                write!(f, "读取客户端进程 {pid} 镜像路径失败（Win32 {code}）")
            }
            PeerError::Signature { image, reason } => {
                write!(f, "客户端签名校验失败：{image}：{reason}")
            }
            PeerError::Policy { image, reason } => {
                write!(f, "客户端签名者不被允许：{image}：{reason}")
            }
        }
    }
}

struct ProcessHandle(HANDLE);

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// 校验管道对端。失败即断开；调用方不得在失败后继续读管道。
pub fn verify(pipe: HANDLE) -> Result<PeerSession, PeerError> {
    let mut pid = 0u32;
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } == 0 {
        return Err(PeerError::ClientPid(super::last_error()));
    }

    // 与管道 ACL 的「当前控制台用户」约束一致：RDP 或其它登录会话一律拒绝。
    // 服务早于登录启动时 active 是 `u32::MAX`，此时没有任何客户端能通过。
    let active = unsafe { WTSGetActiveConsoleSessionId() };
    let mut session = 0u32;
    if unsafe { ProcessIdToSessionId(pid, &mut session) } == 0 {
        return Err(PeerError::Session {
            pid,
            code: super::last_error(),
        });
    }
    if session != active {
        return Err(PeerError::SessionMismatch {
            pid,
            session,
            active,
        });
    }

    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(PeerError::OpenProcess {
            pid,
            code: super::last_error(),
        });
    }
    let process = ProcessHandle(process);

    let image = query_image(process.0, pid)?;
    let signature = check_signature(&image, Path::new(&image))?;

    Ok(PeerSession {
        info: PeerInfo {
            pid,
            image,
            signature,
        },
        _process: process,
    })
}

fn query_image(process: HANDLE, pid: u32) -> Result<String, PeerError> {
    let mut buffer = vec![0u16; 32 * 1024];
    let mut length = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return Err(PeerError::ImagePath {
            pid,
            code: super::last_error(),
        });
    }
    Ok(super::from_wide(&buffer[..length as usize]))
}

fn check_signature(image: &str, path: &Path) -> Result<SignatureInfo, PeerError> {
    let pins = PINNED_THUMBPRINTS.unwrap_or_default();
    // 证书的 simple display name 通常只有 CN 的值（不含 "CN="），两种写法都接受。
    let publisher = PINNED_PUBLISHER
        .map(normalize_publisher)
        .filter(|value| !value.is_empty());
    let pinned = !pins.trim().is_empty() || publisher.is_some();

    let mut info = match verify_authenticode(path) {
        Ok(info) => info,
        Err(reason) => {
            // 只有 debug + 显式开关 + 完全没配置策略时才允许未签名；
            // 一旦配置了指纹或发布者，任何放宽都不成立（失败关闭）。
            if cfg!(debug_assertions) && !pinned && dev_unsigned_enabled() {
                SignatureInfo {
                    subject: "<unsigned-dev>".into(),
                    thumbprint: String::new(),
                    debug_relaxation: Some(
                        "未签名客户端按 VEYL_WIN_ALLOW_UNSIGNED_DEV 放行（仅 debug，本次请求）"
                            .into(),
                    ),
                }
            } else {
                return Err(PeerError::Signature {
                    image: image.to_string(),
                    reason,
                });
            }
        }
    };

    if !pins.trim().is_empty() {
        let allowed = pins
            .split(',')
            .map(|pin| pin.trim().replace(':', "").to_lowercase())
            .filter(|pin| !pin.is_empty())
            .any(|pin| pin == info.thumbprint);
        if !allowed {
            return Err(PeerError::Policy {
                image: image.to_string(),
                reason: format!("证书指纹不在允许列表（实际 {}）", info.thumbprint),
            });
        }
    } else if !cfg!(debug_assertions) && publisher.is_none() {
        // 发布构建至少要固定指纹或发布者；两者都没有就失败关闭。
        return Err(PeerError::Policy {
            image: image.to_string(),
            reason: "发布构建未配置 VEYL_WIN_CERT_THUMBPRINTS 或 VEYL_WIN_PUBLISHER".into(),
        });
    } else if info.debug_relaxation.is_none() && publisher.is_none() {
        // debug 构建没有固定任何策略：可以跑，但每次都要留下记录。
        info.debug_relaxation =
            Some("debug 构建未配置 VEYL_WIN_CERT_THUMBPRINTS，接受任意可信签名者".into());
    }

    if let Some(publisher) = publisher {
        if !info.subject.eq_ignore_ascii_case(publisher) {
            return Err(PeerError::Policy {
                image: image.to_string(),
                reason: format!("发布者不是 {publisher}（实际 {}）", info.subject),
            });
        }
    }

    Ok(info)
}

fn normalize_publisher(value: &str) -> &str {
    let trimmed = value.trim();
    let trimmed = trimmed.strip_prefix("CN=").unwrap_or(trimmed);
    trimmed.trim_matches('"').trim()
}

fn dev_unsigned_enabled() -> bool {
    ALLOW_UNSIGNED_DEV
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes"))
}

fn verify_authenticode(path: &Path) -> Result<SignatureInfo, String> {
    let path_wide = super::wide(&path.to_string_lossy());

    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: path_wide.as_ptr(),
        hFile: std::ptr::null_mut(),
        pgKnownSubject: std::ptr::null_mut(),
    };

    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        pPolicyCallbackData: std::ptr::null_mut(),
        pSIPClientData: std::ptr::null_mut(),
        dwUIChoice: WTD_UI_NONE,
        // 服务经常在离线环境里跑；证书链仍然要有效，吊销检查交给分发侧。
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 {
            pFile: &mut file_info,
        },
        dwStateAction: WTD_STATEACTION_VERIFY,
        hWVTStateData: std::ptr::null_mut(),
        pwszURLReference: std::ptr::null_mut(),
        dwProvFlags: 0,
        dwUIContext: 0,
        pSignatureSettings: std::ptr::null_mut(),
    };

    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let null_window: HWND = std::ptr::null_mut();
    let status = unsafe {
        WinVerifyTrust(
            null_window,
            &mut action,
            &mut data as *mut WINTRUST_DATA as *mut c_void,
        )
    };

    if status != 0 {
        close_state(null_window, &mut action, &mut data);
        return Err(format!("WinVerifyTrust 返回 0x{status:08x}"));
    }

    // SAFETY: 状态句柄由上面成功的 WinVerifyTrust 建立，下面读完就关。
    let extracted = unsafe { extract_signer(data.hWVTStateData) };
    close_state(null_window, &mut action, &mut data);
    extracted
}

fn close_state(window: HWND, action: &mut windows_sys::core::GUID, data: &mut WINTRUST_DATA) {
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(window, action, data as *mut WINTRUST_DATA as *mut c_void);
    }
}

unsafe fn extract_signer(state: HANDLE) -> Result<SignatureInfo, String> {
    if state.is_null() {
        return Err("WinVerifyTrust 没有返回状态句柄".into());
    }
    // SAFETY: 以下指针都来自 WinVerifyTrust 的状态数据，只在本函数内读取。
    let provider = unsafe { WTHelperProvDataFromStateData(state) };
    if provider.is_null() {
        return Err("取不到签名提供者数据".into());
    }
    let signer = unsafe { WTHelperGetProvSignerFromChain(provider, 0, 0, 0) };
    if signer.is_null() {
        return Err("取不到签名者".into());
    }
    let cert = unsafe { WTHelperGetProvCertFromChain(signer, 0) };
    if cert.is_null() {
        return Err("取不到签名者证书".into());
    }
    let context = unsafe { (*cert).pCert };
    if context.is_null() {
        return Err("签名者证书为空".into());
    }

    Ok(SignatureInfo {
        subject: unsafe { cert_subject(context) },
        thumbprint: unsafe { cert_thumbprint(context) },
        debug_relaxation: None,
    })
}

unsafe fn cert_subject(context: *const CERT_CONTEXT) -> String {
    let length = unsafe {
        CertGetNameStringW(
            context,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
        )
    };
    if length <= 1 {
        return String::new();
    }
    let mut buffer = vec![0u16; length as usize];
    let written = unsafe {
        CertGetNameStringW(
            context,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            std::ptr::null(),
            buffer.as_mut_ptr(),
            length,
        )
    };
    if written == 0 {
        return String::new();
    }
    super::from_wide(&buffer)
}

unsafe fn cert_thumbprint(context: *const CERT_CONTEXT) -> String {
    let mut length = 0u32;
    unsafe {
        CertGetCertificateContextProperty(
            context,
            CERT_SHA1_HASH_PROP_ID,
            std::ptr::null_mut(),
            &mut length,
        )
    };
    if length == 0 {
        return String::new();
    }
    let mut buffer = vec![0u8; length as usize];
    let ok = unsafe {
        CertGetCertificateContextProperty(
            context,
            CERT_SHA1_HASH_PROP_ID,
            buffer.as_mut_ptr() as *mut c_void,
            &mut length,
        )
    };
    if ok == 0 {
        return String::new();
    }
    buffer
        .iter()
        .take(length as usize)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
