//! Wintun 适配器的检测与兜底清理。
//!
//! sing-box 被 `TerminateProcess` 结束；Wintun 设备的删除是**异步**的，而且
//! 上一条连接跑得越久、流量越多（`strict_route` 的 WFP 过滤器、活跃连接），
//! 释放越慢。紧接着用同名重新创建会报
//! `create adapter: Cannot create a file when that file already exists |
//!  open existing adapter: Element not found`（2026-11-20 真机复现）。
//!
//! 所以 `start` 之前先等它消失；等不到就移除这个 PnP 设备。停掉进程后设备
//! 会变成 phantom（`CM_PROB_PHANTOM`）：不在网卡列表里，但仍占着名字，
//! 只能按 `sing-tun` 标记去 PnP 设备列表里找并移除。

use std::time::{Duration, Instant};

use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiCallClassInstaller, SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo,
    SetupDiGetClassDevsW, SetupDiGetDeviceRegistryPropertyW, SetupDiRemoveDevice,
    SetupDiSetClassInstallParamsW, DIF_REMOVE, DI_REMOVEDEVICE_GLOBAL, HDEVINFO,
    SP_DEVINFO_DATA, SP_REMOVEDEVICE_PARAMS, SPDRP_DEVICEDESC, SPDRP_FRIENDLYNAME,
    GUID_DEVCLASS_NET,
};
use windows_sys::Win32::Foundation::{GetLastError, ERROR_BUFFER_OVERFLOW, INVALID_HANDLE_VALUE};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
    GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
};
use windows_sys::Win32::Networking::WinSock::AF_UNSPEC;

/// 配置里不给 `interface_name` 时，sing-box 在 Windows 上创建的**连接名**是
/// `tun0`（2026-11-20 真机确认；对应的 PnP 设备友好名是 `sing-tun Tunnel`）。
/// `GetAdaptersAddresses` 返回的是这个连接名。
pub const ADAPTER_NAME: &str = "tun0";

/// 当前是否有同名 Wintun 适配器。读不到网卡列表时按「没有」处理：
/// 调用方还有超时兜底，不能让一次查询失败挡住连接。
pub fn adapter_present(name: &str) -> bool {
    let mut size: u32 = 16 * 1024;
    for _ in 0..4 {
        let words = (size as usize).div_ceil(8) + 8;
        let mut buffer = vec![0u64; words];
        let mut actual = (words * 8) as u32;
        let result = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER,
                std::ptr::null(),
                buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH,
                &mut actual,
            )
        };
        if result == ERROR_BUFFER_OVERFLOW {
            size = actual;
            continue;
        }
        if result != 0 {
            return false;
        }
        let mut current = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !current.is_null() {
            let friendly = unsafe { (*current).FriendlyName };
            if !friendly.is_null() && unsafe { wide_eq(friendly, name) } {
                return true;
            }
            current = unsafe { (*current).Next };
        }
        return false;
    }
    false
}

/// 等到适配器消失。返回是否在期限内消失。
pub fn wait_until_gone(name: &str, timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        if !adapter_present(name) {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// 移除 sing-box 的 Wintun PnP 设备。`Ok(true)` 表示确实移除了设备。
///
/// 真机确认（2026-11-20）：sing-box 1.14.4 的设备友好名是 `sing-tun Tunnel`，
/// 实例 ID 形如 `SWD\WINTUN\{...}`；进程被结束后它变成 **phantom 设备**
/// （`CM_PROB_PHANTOM`，不在网卡列表里），但仍然占着名字。
///
/// 所以按 `sing-tun` / `sing-box` 标记匹配，并枚举包括非 present 在内的全部
/// 网络设备；别的 Wintun 客户端（名字不含这两个标记）不受影响。
pub fn remove_adapter() -> Result<bool, String> {
    unsafe {
        // flags = 0：**连同非 present 的 phantom 设备一起枚举**。
        let set = SetupDiGetClassDevsW(
            &GUID_DEVCLASS_NET,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
        );
        if set == INVALID_HANDLE_VALUE as isize {
            return Err(format!("打开网络设备列表失败（Win32 {}）", GetLastError()));
        }

        // 先收集再移除：移除设备会让后续枚举的索引失效。
        let mut matches: Vec<SP_DEVINFO_DATA> = Vec::new();
        let mut index = 0u32;
        loop {
            let mut info: SP_DEVINFO_DATA = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
            if SetupDiEnumDeviceInfo(set, index, &mut info) == 0 {
                break;
            }
            index += 1;

            let friendly = device_property(set, &info, SPDRP_FRIENDLYNAME).unwrap_or_default();
            let description = device_property(set, &info, SPDRP_DEVICEDESC).unwrap_or_default();
            let marker = format!("{friendly} {description}").to_ascii_lowercase();
            if marker.contains("sing-tun") || marker.contains("sing-box") {
                matches.push(info);
            }
        }

        for info in &matches {
            let mut params: SP_REMOVEDEVICE_PARAMS = std::mem::zeroed();
            params.ClassInstallHeader.cbSize =
                std::mem::size_of::<SP_REMOVEDEVICE_PARAMS>() as u32;
            params.ClassInstallHeader.InstallFunction = DIF_REMOVE;
            params.Scope = DI_REMOVEDEVICE_GLOBAL;
            let set_params = SetupDiSetClassInstallParamsW(
                set,
                info,
                &params.ClassInstallHeader,
                std::mem::size_of::<SP_REMOVEDEVICE_PARAMS>() as u32,
            );
            if set_params != 0
                && SetupDiCallClassInstaller(DIF_REMOVE, set, info) != 0
            {
                continue;
            }
            // 非 present / 半删除的设备走不通类安装器，退回直接移除。
            if SetupDiRemoveDevice(set, info as *const _ as *mut _) == 0 {
                let code = GetLastError();
                SetupDiDestroyDeviceInfoList(set);
                return Err(format!("移除 Wintun 设备失败（Win32 {code}）"));
            }
        }
        SetupDiDestroyDeviceInfoList(set);
        Ok(!matches.is_empty())
    }
}

unsafe fn device_property(
    set: HDEVINFO,
    info: &SP_DEVINFO_DATA,
    property: u32,
) -> Option<String> {
    let mut buffer = [0u16; 512];
    let mut kind = 0u32;
    let mut required = 0u32;
    let ok = SetupDiGetDeviceRegistryPropertyW(
        set,
        info,
        property,
        &mut kind,
        buffer.as_mut_ptr() as *mut u8,
        (buffer.len() * 2) as u32,
        &mut required,
    );
    if ok == 0 {
        return None;
    }
    let len = buffer.iter().position(|&unit| unit == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..len]))
}

unsafe fn wide_eq(ptr: *const u16, expected: &str) -> bool {
    let mut index = 0usize;
    for unit in expected.encode_utf16() {
        if *ptr.add(index) != unit {
            return false;
        }
        index += 1;
    }
    *ptr.add(index) == 0
}
