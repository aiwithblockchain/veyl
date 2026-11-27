//! 子进程身份与孤儿回收。
//!
//! Windows 拿不到别的进程的命令行，所以「这个 pid 是不是我们起的 sing-box」
//! 只能靠三样一起核对：**pid 活着 + 进程启动时间对得上 + 镜像路径对得上**。
//! 只按 pid 杀会在 pid 复用时误杀别人的进程。
//!
//! 核对与终止都在**同一个进程句柄**上完成：如果先按 pid 核对、再按 pid 打开
//! 一次去杀，两次打开之间 pid 可能被复用。`terminate_if_ours` 把核对和
//! `TerminateProcess` 放在同一个句柄上，消除这个窗口。
//!
//! 记录写在 `%ProgramData%\Veyl\tun\sing-box.pid`，服务崩溃重启后读它。

use std::path::Path;
use std::time::Duration;

use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, STILL_ACTIVE};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
    WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessRecord {
    pub pid: u32,
    /// 进程创建时间（FILETIME，100ns 自 1601）。pid 被复用时它一定不同。
    pub creation: u64,
    pub image: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminateOutcome {
    /// 进程已经不在。
    Gone,
    /// pid 还在，但启动时间或镜像对不上——不是我们起的，**不要杀**。
    NotOurs,
    Killed,
    /// 打开了、确认是我们起的，但终止失败（Win32 错误码）。
    Failed(u32),
}

/// 记录格式就是三行文本：pid / 创建时间 / 镜像路径。
pub fn format_record(record: &ProcessRecord) -> String {
    format!("{}\n{}\n{}\n", record.pid, record.creation, record.image)
}

/// 解析失败（截断、非数字）时返回 None——调用方应当什么都不杀。
pub fn parse_record(text: &str) -> Option<ProcessRecord> {
    let mut lines = text.lines();
    let pid = lines.next()?.trim().parse::<u32>().ok()?;
    let creation = lines.next()?.trim().parse::<u64>().ok()?;
    let image = lines.next()?.trim().to_string();
    if pid == 0 || image.is_empty() {
        return None;
    }
    Some(ProcessRecord {
        pid,
        creation,
        image,
    })
}

pub fn creation_time(pid: u32) -> Option<u64> {
    let process = ProcessHandle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    Some(inspect(process.0)?.0)
}

pub fn image_path(pid: u32) -> Option<String> {
    let process = ProcessHandle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    Some(inspect(process.0)?.1)
}

/// 进程是否还在跑。打不开进程句柄按「不在」处理：SYSTEM 都打不开的 pid，
/// 我们既杀不掉也不该认领。
pub fn is_alive(pid: u32) -> bool {
    let Some(process) = ProcessHandle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION) else {
        return false;
    };
    let mut code = 0u32;
    if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
        return false;
    }
    code == STILL_ACTIVE as u32
}

/// 三重核对：还活着、启动时间一致、镜像路径一致。只读，不杀。
pub fn matches(record: &ProcessRecord) -> bool {
    let Some(process) = ProcessHandle::open(record.pid, PROCESS_QUERY_LIMITED_INFORMATION) else {
        return false;
    };
    matches_handle(process.0, record)
}

/// 核对与终止都发生在同一个句柄上。
pub fn terminate_if_ours(record: &ProcessRecord, timeout: Duration) -> TerminateOutcome {
    // WaitForSingleObject 需要 SYNCHRONIZE；只给 PROCESS_TERMINATE 会在等待处失败。
    let Some(process) = ProcessHandle::open(
        record.pid,
        PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
    ) else {
        // 打不开通常意味着已经退出；再确认一次。
        return if is_alive(record.pid) {
            TerminateOutcome::Failed(super::last_error())
        } else {
            TerminateOutcome::Gone
        };
    };

    if !matches_handle(process.0, record) {
        // 句柄已经拿到，随后就在这个句柄上核对——pid 复用不会让我们杀错。
        return TerminateOutcome::NotOurs;
    }

    if unsafe { TerminateProcess(process.0, 1) } == 0 {
        return TerminateOutcome::Failed(super::last_error());
    }
    let _ =
        unsafe { WaitForSingleObject(process.0, timeout.as_millis().min(u32::MAX as u128) as u32) };
    TerminateOutcome::Killed
}

fn matches_handle(process: HANDLE, record: &ProcessRecord) -> bool {
    let Some((creation, image)) = inspect(process) else {
        return false;
    };
    creation == record.creation && super::same_path(Path::new(&record.image), Path::new(&image))
}

/// 从同一个句柄读出创建时间与镜像路径。
fn inspect(process: HANDLE) -> Option<(u64, String)> {
    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return None;
    }

    let mut buffer = vec![0u16; 32 * 1024];
    let mut length = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return None;
    }
    Some((
        filetime(creation),
        super::from_wide(&buffer[..length as usize]),
    ))
}

fn filetime(value: FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

struct ProcessHandle(HANDLE);

impl ProcessHandle {
    fn open(pid: u32, access: u32) -> Option<Self> {
        let handle = unsafe { OpenProcess(access, 0, pid) };
        if handle.is_null() {
            None
        } else {
            Some(Self(handle))
        }
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_round_trips() {
        let record = ProcessRecord {
            pid: 4321,
            creation: 133_000_000_000_000_000,
            image: r"C:\ProgramData\Veyl\runtime\ab\sing-box.exe".into(),
        };
        let text = format_record(&record);
        assert_eq!(parse_record(&text), Some(record));
    }

    #[test]
    fn a_truncated_or_garbage_record_is_rejected() {
        assert_eq!(parse_record(""), None);
        assert_eq!(parse_record("4321\n"), None);
        assert_eq!(
            parse_record("4321\nnot-a-number\nC:\\x\\sing-box.exe\n"),
            None
        );
        assert_eq!(parse_record("0\n133\nC:\\x\n"), None);
        assert_eq!(parse_record("4321\n133\n\n"), None);
        // 老版本或手写文件多出来的行不影响解析。
        assert_eq!(
            parse_record("4321\n133\nC:\\x\\sing-box.exe\nextra\n").map(|record| record.pid),
            Some(4321)
        );
    }

    fn own_record() -> ProcessRecord {
        let pid = std::process::id();
        ProcessRecord {
            pid,
            creation: creation_time(pid).expect("当前进程一定拿得到创建时间"),
            image: image_path(pid).expect("当前进程一定拿得到镜像路径"),
        }
    }

    #[test]
    fn the_current_process_matches_its_own_identity() {
        let record = own_record();
        assert!(is_alive(record.pid));
        assert!(matches(&record), "自己核对自己必须通过");
    }

    #[test]
    fn a_wrong_creation_time_is_not_our_process() {
        let mut record = own_record();
        record.creation = record.creation.wrapping_add(1);
        assert!(!matches(&record), "启动时间不同就是另一个进程");
        assert_eq!(
            terminate_if_ours(&record, Duration::from_millis(10)),
            TerminateOutcome::NotOurs,
            "对不上就绝不能杀"
        );
    }

    #[test]
    fn a_wrong_image_path_is_not_our_process() {
        let mut record = own_record();
        record.image = r"C:\nowhere\sing-box.exe".into();
        assert!(!matches(&record));
        assert_eq!(
            terminate_if_ours(&record, Duration::from_millis(10)),
            TerminateOutcome::NotOurs
        );
    }

    #[test]
    fn a_dead_pid_is_never_claimed() {
        // pid 0 一定打不开。
        assert!(!is_alive(0));
        let record = ProcessRecord {
            pid: 0,
            creation: 1,
            image: r"C:\nowhere\sing-box.exe".into(),
        };
        assert!(!matches(&record));
        assert_eq!(
            terminate_if_ours(&record, Duration::from_millis(10)),
            TerminateOutcome::Gone
        );
    }
}
