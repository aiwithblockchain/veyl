use std::net::TcpListener;

use base64::Engine;
use rand::Rng;

use crate::runtime::{RuntimeError, RuntimeResult};

/// 用户设置里本地代理端口的默认值（`docs/design/port-stability.md` §2）。
pub const DEFAULT_PROXY_PORT: u16 = 7890;
/// 用户设置的端口被占用时，依次顺延的相邻端口。
pub const FALLBACK_PROXY_PORTS: std::ops::RangeInclusive<u16> = 7890..=7899;

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

/// 与 sing-box（Go）的绑定条件对齐：Unix 上带 `SO_REUSEADDR`。
///
/// 刚断开立刻重连时端口还在 TIME_WAIT；不带 REUSEADDR 会把它误判成
/// 「被别的程序占用」，白降一次级。Windows 的 `SO_REUSEADDR` 允许抢占，
/// 语义不同（Go 在 Windows 上也不依赖它），所以只在 Unix 上设。
#[cfg(unix)]
fn probe_bind(port: u16) -> std::io::Result<TcpListener> {
    use std::os::fd::FromRawFd;

    unsafe {
        let fd = libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0);
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let one: libc::c_int = 1;
        if libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_REUSEADDR,
            &one as *const libc::c_int as *const libc::c_void,
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        ) != 0
        {
            let error = std::io::Error::last_os_error();
            libc::close(fd);
            return Err(error);
        }
        let mut addr: libc::sockaddr_in = std::mem::zeroed();
        addr.sin_family = libc::AF_INET as libc::sa_family_t;
        addr.sin_port = port.to_be();
        addr.sin_addr.s_addr = u32::from_ne_bytes([127, 0, 0, 1]);
        if libc::bind(
            fd,
            &addr as *const libc::sockaddr_in as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
        ) != 0
        {
            let error = std::io::Error::last_os_error();
            libc::close(fd);
            return Err(error);
        }
        if libc::listen(fd, 1) != 0 {
            let error = std::io::Error::last_os_error();
            libc::close(fd);
            return Err(error);
        }
        Ok(TcpListener::from_raw_fd(fd))
    }
}

#[cfg(not(unix))]
fn probe_bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", port))
}

pub fn is_port_free(port: u16) -> bool {
    probe_bind(port).is_ok()
}

/// 端口不可用的原因：被别的程序占着，还是本进程没权限/绑不上。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortAvailability {
    Free,
    Occupied,
    Unavailable,
}

pub fn port_availability(port: u16) -> PortAvailability {
    match probe_bind(port) {
        Ok(_) => PortAvailability::Free,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            PortAvailability::Occupied
        }
        Err(_) => PortAvailability::Unavailable,
    }
}

pub fn any_free_port() -> RuntimeResult<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| RuntimeError::Config(format!("no free local port: {e}")))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| RuntimeError::Config(format!("no free local port: {e}")))
}

/// 连接时的候选链：用户设置 → 7890–7899 依次 → 系统分配（由调用方兜底）。
///
/// 去重并保持顺序：用户把端口设成 7895 时，7895 只出现一次。
pub fn proxy_port_candidates(configured: u16) -> Vec<u16> {
    let mut candidates = Vec::with_capacity(12);
    for port in std::iter::once(configured).chain(FALLBACK_PROXY_PORTS) {
        if !candidates.contains(&port) {
            candidates.push(port);
        }
    }
    candidates
}

/// 随机取一个不在 `excluded` 里的高位端口。测速运行时用，避开用户设置的端口。
pub fn pick_free_port_excluding(excluded: &[u16]) -> RuntimeResult<u16> {
    let mut rng = rand::thread_rng();
    for _ in 0..32 {
        let candidate: u16 = rng.gen_range(49152u16..=65535u16);
        if !excluded.contains(&candidate) && is_port_free(candidate) {
            return Ok(candidate);
        }
    }
    for _ in 0..8 {
        let candidate = any_free_port()?;
        if !excluded.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(RuntimeError::Config("no free local port".into()))
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

    #[test]
    fn candidates_put_the_configured_port_first_and_dedupe() {
        assert_eq!(
            proxy_port_candidates(7895)[..3],
            [7895, 7890, 7891],
            "设置值排第一，降级从 7890 开始且不重复"
        );
        let default = proxy_port_candidates(DEFAULT_PROXY_PORT);
        assert_eq!(default[0], 7890);
        assert_eq!(default.len(), 10, "7890–7899，不重复");

        let outside = proxy_port_candidates(8080);
        assert_eq!(outside[0], 8080);
        assert_eq!(outside.len(), 11);
        assert_eq!(outside[1], 7890);
    }

    #[test]
    fn availability_distinguishes_occupied_from_free() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = listener.local_addr().unwrap().port();
        assert_eq!(
            port_availability(taken),
            PortAvailability::Occupied,
            "端口 {taken} 正被本测试监听，应判为 Occupied"
        );
        drop(listener);

        // `any_free_port()` 返回前已经释放监听，别的进程可能在这两步之间抢走它。
        // 不断言单次结果，最多重试 3 次：每次都重新取一个端口再判。
        let mut last = None;
        for _ in 0..3 {
            let free = any_free_port().unwrap();
            let availability = port_availability(free);
            if availability == PortAvailability::Free {
                return;
            }
            last = Some((free, availability));
        }
        let (port, availability) = last.expect("至少试过一次");
        panic!("端口 {port} 取到后立即被判为 {availability:?}，连续 3 次都不是 Free");
    }

    #[test]
    fn excluding_picks_a_different_port() {
        let excluded = 49152;
        let port = pick_free_port_excluding(&[excluded]).unwrap();
        assert_ne!(port, excluded);
        assert!(is_port_free(port));
    }
}
