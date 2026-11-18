//! 可选的端到端集成测试：用真实 `sing-box` 跑一次
//! 「SOCKS5 UDP ASSOCIATE → shadowsocks 出站 → UDP echo」。
//!
//! 三条背景（改这个文件前先读）：
//!
//! 1. 这是「Proxy 模式的 UDP 在 sing-box 1.14.4 上**本来就通**」的唯一证据。
//!    `udp: true` 这个字段在该版本的 mixed / socks 入站上**不存在**——加上会让
//!    `check` 直接 `FATAL decode config: json: unknown field "udp"`，
//!    所以不要再试图「打开」它，这里测的是入站的默认行为。
//! 2. 用例需要本地起一个 shadowsocks 服务端、一个 UDP echo 和目标客户端，
//!    依赖本机 UDP 回环与随包 sing-box 二进制；**CI 不跑**（标了 `#[ignore]`）。
//! 3. 只覆盖**显式 SOCKS5 UDP ASSOCIATE**。浏览器在系统代理配置下不发
//!    SOCKS5 UDP，QUIC/HTTP3 仍被禁用、不走这里；Cloudflare 反机器人页面
//!    在 Proxy 模式仍过不了，需要 TUN。
//!
//! 触发方式（`#[ignore]` 保证默认 `cargo test` 不执行）：
//!
//! ```sh
//! VEYL_SING_BOX=$PWD/src-tauri/resources/runtime/sing-box \
//!   cargo test --test udp_forward_check -- --ignored --nocapture
//! ```
//!
//! 没设 `VEYL_SING_BOX` 时用例直接返回（不算失败）。

use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::json;

use veyl_lib::config::{build, BuildInput, NodeDescriptor, ProtocolConfig};

/// 只认显式的 `VEYL_SING_BOX`：不在 PATH 里猜，也不在没有变量时失败。
fn sing_box() -> Option<PathBuf> {
    let path = std::env::var("VEYL_SING_BOX").ok().map(PathBuf::from)?;
    path.is_file().then_some(path)
}

fn free_udp_port() -> u16 {
    let socket = UdpSocket::bind("127.0.0.1:0").expect("找空闲 UDP 端口");
    socket.local_addr().expect("读端口").port()
}

fn free_tcp_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("找空闲 TCP 端口");
    listener.local_addr().expect("读端口").port()
}

fn echo_target() -> u16 {
    let socket = UdpSocket::bind("127.0.0.1:0").expect("绑定 UDP echo");
    let port = socket.local_addr().expect("读端口").port();
    std::thread::spawn(move || {
        let mut buf = [0u8; 2048];
        // 只回这几包；用例失败时线程靠超时退出，不永久挂着。
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("设置超时");
        while let Ok((n, from)) = socket.recv_from(&mut buf) {
            let _ = socket.send_to(&buf[..n], from);
        }
    });
    port
}

fn spawn(binary: &Path, dir: &Path, name: &str, config: &serde_json::Value) -> Child {
    let path = dir.join(format!("{name}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(config).expect("序列化配置"))
        .expect("写配置");
    Command::new(binary)
        .arg("run")
        .arg("-c")
        .arg(&path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|error| panic!("启动 {name} 失败：{error}"))
}

fn wait_tcp(port: u16, child: &mut Child, what: &str) {
    let target = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(status) = child.try_wait().expect("等待子进程") {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            panic!("{what} 启动即退出（{status}）：\n{stderr}");
        }
        if TcpStream::connect_timeout(&target, Duration::from_millis(200)).is_ok() {
            return;
        }
        assert!(Instant::now() < deadline, "{what} 的端口 {port} 8 秒内没起来");
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 手动完成 SOCKS5 握手 + UDP ASSOCIATE，返回受控 TCP 连接与 relay 地址。
fn socks5_udp_associate(proxy_port: u16) -> (TcpStream, SocketAddr) {
    let mut tcp = TcpStream::connect(("127.0.0.1", proxy_port)).expect("连 mixed 入站");
    tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    tcp.write_all(&[0x05, 0x01, 0x00]).expect("发问候");
    let mut greeting = [0u8; 2];
    tcp.read_exact(&mut greeting).expect("读问候回复");
    assert_eq!(greeting, [0x05, 0x00], "SOCKS5 无认证握手失败");

    // UDP ASSOCIATE：DST.ADDR/DST.PORT 全 0，由服务端分配 relay。
    tcp.write_all(&[0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .expect("发 UDP ASSOCIATE");
    let mut head = [0u8; 4];
    tcp.read_exact(&mut head).expect("读 ASSOCIATE 回复头");
    assert_eq!(head[0], 0x05, "SOCKS 版本不对");
    assert_eq!(
        head[1], 0x00,
        "UDP ASSOCIATE 被拒绝（reply={}）：mixed 入站可能没开 UDP",
        head[1]
    );
    let addr = match head[3] {
        0x01 => {
            let mut raw = [0u8; 6];
            tcp.read_exact(&mut raw).expect("读 IPv4 relay");
            let ip = std::net::Ipv4Addr::new(raw[0], raw[1], raw[2], raw[3]);
            SocketAddr::from((ip, u16::from_be_bytes([raw[4], raw[5]])))
        }
        0x04 => {
            let mut raw = [0u8; 18];
            tcp.read_exact(&mut raw).expect("读 IPv6 relay");
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&raw[..16]);
            SocketAddr::new(
                IpAddr::from(octets),
                u16::from_be_bytes([raw[16], raw[17]]),
            )
        }
        other => panic!("UDP ASSOCIATE 返回了不支持的 ATYP {other}"),
    };
    (tcp, addr)
}

/// 把 `payload` 用 SOCKS5 UDP 头包好发到 relay，返回解头后的回包。
fn udp_roundtrip(relay: SocketAddr, target: SocketAddr, payload: &[u8]) -> Vec<u8> {
    let socket = UdpSocket::bind("127.0.0.1:0").expect("绑定本地 UDP");
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("设置超时");
    let mut packet = vec![0x00, 0x00, 0x00]; // RSV + FRAG
    match target.ip() {
        IpAddr::V4(ip) => {
            packet.push(0x01);
            packet.extend_from_slice(&ip.octets());
        }
        IpAddr::V6(_) => panic!("这个用例只用 IPv4 目标"),
    }
    packet.extend_from_slice(&target.port().to_be_bytes());
    packet.extend_from_slice(payload);
    socket.send_to(&packet, relay).expect("发 UDP 包");

    let mut buf = [0u8; 2048];
    let (n, _) = socket
        .recv_from(&mut buf)
        .expect("UDP ASSOCIATE 没有回包（UDP 可能没被转发）");
    let payload_start = match buf[3] {
        0x01 => 4 + 4 + 2,
        0x04 => 4 + 16 + 2,
        0x03 => 4 + 1 + buf[4] as usize + 2,
        other => panic!("回包 ATYP 不支持：{other}"),
    };
    buf[payload_start..n].to_vec()
}

#[test]
#[ignore = "可选集成测试：需要 VEYL_SING_BOX 指向随包 sing-box，CI 不跑"]
fn mixed_inbound_forwards_udp_through_shadowsocks() {
    let Some(binary) = sing_box() else {
        eprintln!(
            "没有 VEYL_SING_BOX（指向 sing-box 二进制），跳过 \
             mixed_inbound_forwards_udp_through_shadowsocks"
        );
        return;
    };

    let dir = std::env::temp_dir().join(format!("veyl-udp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("建临时目录");

    let echo_port = echo_target();
    let ss_port = free_udp_port();
    let server_config = json!({
        "log": { "level": "warn" },
        "inbounds": [{
            "type": "shadowsocks",
            "tag": "ss-in",
            "listen": "127.0.0.1",
            "listen_port": ss_port,
            "method": "aes-256-gcm",
            "password": "p@ss",
        }],
        "outbounds": [{ "type": "direct" }],
    });
    let mut server = spawn(&binary, &dir, "server", &server_config);
    wait_tcp(ss_port, &mut server, "shadowsocks 服务端");

    let mixed_port = free_tcp_port();
    let clash_port = free_tcp_port();
    let node = NodeDescriptor {
        id: "local-01".into(),
        name: "本地回环".into(),
        server: "127.0.0.1".into(),
        server_port: ss_port,
        protocol: ProtocolConfig::Shadowsocks {
            password: "p@ss".into(),
            method: "aes-256-gcm".into(),
        },
    };
    let client_config =
        build(&BuildInput::new(node, mixed_port, clash_port, "secret".into())).expect("生成配置");
    let mut client = spawn(&binary, &dir, "client", &client_config);
    wait_tcp(mixed_port, &mut client, "代理客户端");

    let (_control, relay) = socks5_udp_associate(mixed_port);
    let relay = if relay.ip().is_unspecified() {
        SocketAddr::from(([127, 0, 0, 1], relay.port()))
    } else {
        relay
    };
    let echoed = udp_roundtrip(
        relay,
        SocketAddr::from(([127, 0, 0, 1], echo_port)),
        b"veyl-udp",
    );
    assert_eq!(echoed, b"veyl-udp", "经 shadowsocks 转发回来的内容不一致");

    let _ = client.kill();
    let _ = client.wait();
    let _ = server.kill();
    let _ = server.wait();
    let _ = std::fs::remove_dir_all(&dir);
}
