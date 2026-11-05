//! Service Control Manager 查询。
//!
//! 两个调用方，两种用途：
//! - 客户端（`pipe::verify_server`、`backend::availability`）只读状态与 pid；
//! - 主程序据此判断 `HelperStatus`，`ensure_available` 不做任何安装动作。
//!
//! 这里只查询，不创建、不启动、不删除服务。服务的安装归 W5 的提权安装器
//! （`docs/windows-tun.md` §3.2）：应用以普通用户运行，静默安装服务既做不到，
//! 也不该做。

use std::path::PathBuf;

use windows_sys::Win32::System::Services::{
    CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceConfigW, QueryServiceStatusEx,
    QUERY_SERVICE_CONFIGW, SC_HANDLE, SC_MANAGER_CONNECT, SC_STATUS_PROCESS_INFO,
    SERVICE_QUERY_CONFIG, SERVICE_QUERY_STATUS, SERVICE_STATUS_PROCESS,
};

use super::{last_error, wide};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServiceQuery {
    pub state: u32,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScmError {
    /// SCM 打不开或服务不存在：对使用者来说就是「没装」。
    NotFound(String),
    /// 服务在，但状态查询失败（权限、临时故障）。
    Query(u32),
}

impl std::fmt::Display for ScmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScmError::NotFound(detail) => write!(f, "{detail}"),
            ScmError::Query(code) => write!(f, "查询服务状态失败（Win32 {code}）"),
        }
    }
}

pub fn query(name: &str) -> Result<ServiceQuery, ScmError> {
    let scm = open_scm()?;
    let service = open_service(scm.0, name, SERVICE_QUERY_STATUS)
        .map_err(|code| ScmError::NotFound(format!("服务 {name} 未安装（Win32 {code}）")))?;
    let _service = ScHandle(service);

    let mut status: SERVICE_STATUS_PROCESS = unsafe { std::mem::zeroed() };
    let mut needed = 0u32;
    let ok = unsafe {
        QueryServiceStatusEx(
            service,
            SC_STATUS_PROCESS_INFO,
            &mut status as *mut SERVICE_STATUS_PROCESS as *mut u8,
            std::mem::size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(ScmError::Query(last_error()));
    }
    Ok(ServiceQuery {
        state: status.dwCurrentState,
        pid: status.dwProcessId,
    })
}

/// 服务的 `ImagePath`。读不到时返回 None——调用方把它当成「查不出」，
/// 不要因为权限不足就把一个正常的服务判成缺失。
pub fn binary_path(name: &str) -> Option<PathBuf> {
    let scm = open_scm().ok()?;
    let service = open_service(scm.0, name, SERVICE_QUERY_CONFIG).ok()?;
    let _service = ScHandle(service);

    let mut size = 0u32;
    unsafe { QueryServiceConfigW(service, std::ptr::null_mut(), 0, &mut size) };
    if size == 0 {
        return None;
    }
    let words = (size as usize).div_ceil(std::mem::size_of::<usize>());
    let mut buffer = vec![0usize; words];
    let ok = unsafe {
        QueryServiceConfigW(
            service,
            buffer.as_mut_ptr() as *mut QUERY_SERVICE_CONFIGW,
            size,
            &mut size,
        )
    };
    if ok == 0 {
        return None;
    }
    // SAFETY: 上面按系统给的 size 分配并对齐，QueryServiceConfigW 填的就是这个结构。
    let config = unsafe { &*(buffer.as_ptr() as *const QUERY_SERVICE_CONFIGW) };
    if config.lpBinaryPathName.is_null() {
        return None;
    }
    let mut length = 0usize;
    while unsafe { *config.lpBinaryPathName.add(length) } != 0 {
        length += 1;
        if length > 32 * 1024 {
            break;
        }
    }
    let raw =
        super::from_wide(unsafe { std::slice::from_raw_parts(config.lpBinaryPathName, length) });
    // ImagePath 可能带着引号与参数：`"C:\Program Files\Veyl\veyl-service.exe" --service`
    Some(PathBuf::from(unquoted_path(&raw)))
}

/// 从 `ImagePath` 里取出可执行文件路径（去掉引号与参数）。
fn unquoted_path(value: &str) -> String {
    let trimmed = value.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        return rest.split('"').next().unwrap_or(rest).to_string();
    }
    // 没有引号时，第一个空格之前是路径；带空格又没加引号的 ImagePath 本身就不合法。
    trimmed
        .split_whitespace()
        .next()
        .unwrap_or(trimmed)
        .to_string()
}

fn open_scm() -> Result<ScHandle, ScmError> {
    let handle = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) };
    if handle.is_null() {
        return Err(ScmError::NotFound(format!(
            "打开服务控制管理器失败（Win32 {}）",
            last_error()
        )));
    }
    Ok(ScHandle(handle))
}

fn open_service(scm: SC_HANDLE, name: &str, access: u32) -> Result<SC_HANDLE, u32> {
    let name = wide(name);
    let handle = unsafe { OpenServiceW(scm, name.as_ptr(), access) };
    if handle.is_null() {
        Err(last_error())
    } else {
        Ok(handle)
    }
}

struct ScHandle(SC_HANDLE);

impl Drop for ScHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseServiceHandle(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unquoted_image_path_keeps_only_the_executable() {
        assert_eq!(
            unquoted_path(r"C:\Program Files\Veyl\veyl-service.exe"),
            r"C:\Program Files\Veyl\veyl-service.exe"
        );
        assert_eq!(
            unquoted_path(r"C:\veyl\veyl-service.exe --service"),
            r"C:\veyl\veyl-service.exe"
        );
    }

    #[test]
    fn a_quoted_image_path_drops_the_arguments() {
        assert_eq!(
            unquoted_path(r#""C:\Program Files\Veyl\veyl-service.exe" --service"#),
            r"C:\Program Files\Veyl\veyl-service.exe"
        );
        assert_eq!(
            unquoted_path(r#"  "C:\Program Files\Veyl\veyl-service.exe"  "#),
            r"C:\Program Files\Veyl\veyl-service.exe"
        );
    }
}
