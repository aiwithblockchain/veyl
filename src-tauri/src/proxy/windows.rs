use serde::{Deserialize, Serialize};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

use super::PlatformProxy;
use crate::runtime::{RuntimeError, RuntimeResult};

pub struct WindowsProxy;

const SETTINGS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WinPayload {
    pub proxy_enable: Option<u32>,
    pub proxy_server: Option<String>,
    pub proxy_override: Option<String>,
}

impl PlatformProxy for WindowsProxy {
    fn platform(&self) -> &'static str {
        "windows"
    }

    fn capture(&self) -> RuntimeResult<serde_json::Value> {
        let payload = read_payload(&open()?);
        serde_json::to_value(payload)
            .map_err(|e| RuntimeError::Proxy(format!("serialize Windows proxy backup: {e}")))
    }

    fn apply(&self, port: u16) -> RuntimeResult<()> {
        let key = open()?;
        key.set_value("ProxyEnable", &1u32)
            .map_err(|e| RuntimeError::Proxy(format!("write ProxyEnable: {e}")))?;
        key.set_value("ProxyServer", &format!("127.0.0.1:{port}"))
            .map_err(|e| RuntimeError::Proxy(format!("write ProxyServer: {e}")))?;
        notify_settings_changed();
        Ok(())
    }

    fn restore(&self, payload: &serde_json::Value) -> RuntimeResult<()> {
        let payload: WinPayload = serde_json::from_value(payload.clone())
            .map_err(|e| RuntimeError::Proxy(format!("parse Windows proxy backup: {e}")))?;
        let key = open()?;

        match payload.proxy_enable {
            Some(value) => key
                .set_value("ProxyEnable", &value)
                .map_err(|e| RuntimeError::Proxy(format!("restore ProxyEnable: {e}")))?,
            None => {
                let _ = key.delete_value("ProxyEnable");
            }
        }
        match payload.proxy_server {
            Some(value) => key
                .set_value("ProxyServer", &value)
                .map_err(|e| RuntimeError::Proxy(format!("restore ProxyServer: {e}")))?,
            None => {
                let _ = key.delete_value("ProxyServer");
            }
        }
        match payload.proxy_override {
            Some(value) => key
                .set_value("ProxyOverride", &value)
                .map_err(|e| RuntimeError::Proxy(format!("restore ProxyOverride: {e}")))?,
            None => {
                let _ = key.delete_value("ProxyOverride");
            }
        }

        notify_settings_changed();
        Ok(())
    }

    fn current(&self) -> RuntimeResult<Option<String>> {
        let key = open()?;
        let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
        if enabled == 0 {
            return Ok(None);
        }
        let server: String = key.get_value("ProxyServer").unwrap_or_default();
        if server.is_empty() {
            Ok(None)
        } else {
            Ok(Some(server))
        }
    }

    fn original_endpoint(&self, payload: &serde_json::Value) -> Option<String> {
        let payload: WinPayload = serde_json::from_value(payload.clone()).ok()?;
        if payload.proxy_enable != Some(1) {
            return None;
        }
        payload.proxy_server.filter(|server| !server.is_empty())
    }
}

fn open() -> RuntimeResult<RegKey> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(SETTINGS_KEY, KEY_READ | KEY_WRITE)
        .map_err(|e| RuntimeError::Proxy(format!("open Internet Settings: {e}")))
}

fn read_payload(key: &RegKey) -> WinPayload {
    WinPayload {
        proxy_enable: key.get_value("ProxyEnable").ok(),
        proxy_server: key.get_value("ProxyServer").ok(),
        proxy_override: key.get_value("ProxyOverride").ok(),
    }
}

fn notify_settings_changed() {
    use windows_sys::Win32::Networking::WinInet::{
        InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
    };
    // WinINet 缓存了代理配置，改注册表后必须显式通知。
    unsafe {
        InternetSetOptionW(
            std::ptr::null_mut(),
            INTERNET_OPTION_SETTINGS_CHANGED,
            std::ptr::null_mut(),
            0,
        );
        InternetSetOptionW(
            std::ptr::null_mut(),
            INTERNET_OPTION_REFRESH,
            std::ptr::null_mut(),
            0,
        );
    }
}
