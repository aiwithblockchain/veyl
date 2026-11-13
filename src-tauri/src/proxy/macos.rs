use super::macos_wire;
use super::PlatformProxy;
use crate::runtime::{RuntimeError, RuntimeResult};

pub struct MacProxy;

impl PlatformProxy for MacProxy {
    fn platform(&self) -> &'static str {
        "macos"
    }

    fn capture(&self) -> RuntimeResult<serde_json::Value> {
        macos_wire::capture().map_err(RuntimeError::Proxy)
    }

    fn apply(&self, port: u16) -> RuntimeResult<()> {
        macos_wire::apply(port).map_err(RuntimeError::Proxy)
    }

    fn restore(&self, payload: &serde_json::Value) -> RuntimeResult<()> {
        macos_wire::restore(payload).map_err(RuntimeError::Proxy)
    }

    fn current(&self) -> RuntimeResult<Option<String>> {
        macos_wire::current().map_err(RuntimeError::Proxy)
    }

    fn active_endpoints(&self) -> RuntimeResult<Vec<String>> {
        macos_wire::active_endpoints().map_err(RuntimeError::Proxy)
    }

    fn original_endpoint(&self, payload: &serde_json::Value) -> Option<String> {
        macos_wire::original_endpoint(payload)
    }
}
