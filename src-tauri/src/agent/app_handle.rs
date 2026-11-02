//! 全局 AppHandle 句柄。
//!
//! 工具事件（如 tool-call-start）是从工具实现里发出的，而工具拿不到 AppHandle，
//! 所以启动时注入一次。P1 单窗口，够用；多窗口时改成按 session 查表。

use std::sync::OnceLock;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

static HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn set(handle: AppHandle) {
    let _ = HANDLE.set(handle);
}

pub fn emit(event: &str, payload: Value) {
    match HANDLE.get() {
        Some(handle) => {
            if let Err(error) = handle.emit(event, payload) {
                log::warn!("[agent] emit {event} failed: {error}");
            }
        }
        None => log::warn!("[agent] emit {event} before AppHandle was set"),
    }
}
