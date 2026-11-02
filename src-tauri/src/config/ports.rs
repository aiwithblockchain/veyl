use std::net::TcpListener;

use base64::Engine;
use rand::Rng;

use crate::runtime::{RuntimeError, RuntimeResult};

/// 随机取一个高位端口；被占用就重试，最终退化为系统分配。
pub fn pick_free_port() -> RuntimeResult<u16> {
    let mut rng = rand::thread_rng();
    for _ in 0..32 {
        let candidate: u16 = rng.gen_range(49152u16..=65535u16);
        if is_port_free(candidate) {
            return Ok(candidate);
        }
    }
    any_free_port()
}

pub fn is_port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub fn any_free_port() -> RuntimeResult<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| RuntimeError::Config(format!("no free local port: {e}")))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| RuntimeError::Config(format!("no free local port: {e}")))
}

/// 32 字节随机，Base64URL 无填充。
pub fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_is_long_and_unique() {
        let a = random_secret();
        let b = random_secret();
        assert!(a.len() >= 43);
        assert_ne!(a, b);
        assert!(!a.contains('='));
    }

    #[test]
    fn picked_port_is_bindable() {
        let port = pick_free_port().unwrap();
        assert!(port >= 1024);
        assert!(is_port_free(port));
    }
}
