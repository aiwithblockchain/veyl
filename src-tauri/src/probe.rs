//! 节点可达性探测：ICMP（系统 ping）与控制端口 TCP。
//!
//! 供节点诊断面板第一步使用（`docs/design/node-diagnosis-flow.md` §4）：
//! 一次调用同时返回两项结果，界面只读结果、不做判定。
//!
//! - ICMP 用系统 `ping` 可执行文件，不开原始套接字（签名后的正式包拿不到 root）。
//! - 输入先按 IP 字面量解析，解析失败直接拒绝；不把任意字符串拼进命令行，也不经过 shell。
//! - 每项各自有界，外层再有 10 秒硬超时，任何情况都不会把命令挂死。

use std::io::Read;
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::process::{Command, ExitStatus, Stdio};
use std::str::FromStr;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

const ICMP_COUNT: u32 = 3;
#[cfg(any(target_os = "macos", windows))]
const PING_WAIT_MS: &str = "2000";
const TCP_TIMEOUT: Duration = Duration::from_secs(5);
/// 系统 ping 自身的上限：3 次、每次最多等 2 秒，再留一点进程启动余量。
const PING_BUDGET: Duration = Duration::from_secs(8);
/// 整条命令的硬上限。
const PROBE_BUDGET: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize)]
pub struct NodeReachabilityReport {
    pub icmp: IcmpReachability,
    pub tcp: TcpReachability,
}

#[derive(Debug, Serialize)]
pub struct IcmpReachability {
    /// 退出码为 0 就算通；rtt 解析失败不影响这个判断。
    pub ok: bool,
    pub rtt_ms: Option<u32>,
    /// 丢包百分比，0.0–100.0。退出码 0 但解析不出回复行时为 0.0（无法测量，不臆造丢包）。
    pub loss: f32,
    /// 探测**没跑起来**的原因：`spawn_failed` / `timeout` / `io_error`。
    /// 正常执行完（无论退出码 0 还是非 0）为 `None`，此时 `ok` 才是对机器的判定。
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TcpReachability {
    pub ok: bool,
    pub ms: Option<u32>,
    /// 稳定短码：`timeout` / `refused` / `unreachable`。
    pub error: Option<String>,
}

#[tauri::command]
pub async fn node_probe_reachability(
    server_ip: String,
    control_port: u16,
) -> Result<NodeReachabilityReport, Value> {
    let ip = validate_ip(&server_ip).map_err(|reason| command_error("INVALID_ARGUMENT", reason))?;
    if control_port == 0 {
        return Err(command_error("INVALID_ARGUMENT", "invalid_port"));
    }

    let icmp = tokio::task::spawn_blocking(move || probe_icmp(ip));
    let tcp = tokio::task::spawn_blocking(move || probe_tcp(ip, control_port));

    match tokio::time::timeout(PROBE_BUDGET, async { (icmp.await, tcp.await) }).await {
        Ok((Ok(icmp), Ok(tcp))) => {
            // 每次诊断一条：只记结论与耗时，不记地址与端口。
            log::info!(
                "[node_probe_reachability] icmp ok={} rtt={:?} loss={} error={:?} tcp ok={} ms={:?} error={:?}",
                icmp.ok,
                icmp.rtt_ms,
                icmp.loss,
                icmp.error,
                tcp.ok,
                tcp.ms,
                tcp.error
            );
            Ok(NodeReachabilityReport { icmp, tcp })
        }
        Ok((icmp, tcp)) => {
            // 只可能是探测线程 panic；不把 panic 文本送给界面。
            if let Err(error) = icmp {
                log::warn!("[node_probe_reachability] ICMP 探测线程失败：{error}");
            }
            if let Err(error) = tcp {
                log::warn!("[node_probe_reachability] TCP 探测线程失败：{error}");
            }
            Err(command_error("INTERNAL", "internal"))
        }
        Err(_) => Err(command_error("TIMEOUT", "timeout")),
    }
}

fn command_error(code: &str, reason: &str) -> Value {
    log::warn!("[node_probe_reachability] {code} / {reason}");
    json!({
        "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
        "code": code,
        "message": "",
        "retryable": false,
        "details": { "reason": reason },
        "request_id": "",
    })
}

fn validate_ip(raw: &str) -> Result<IpAddr, &'static str> {
    IpAddr::from_str(raw).map_err(|_| "invalid_ip")
}

fn probe_icmp(ip: IpAddr) -> IcmpReachability {
    icmp_from_result(run_ping(ip))
}

/// 把 ping 的执行结果变成报告。未执行与「执行了但没回包」必须分开：
/// 前者 `error` 有值，后者 `error = None`、由退出码决定 `ok`。
fn icmp_from_result(result: Result<(ExitStatus, String), &'static str>) -> IcmpReachability {
    match result {
        Ok((status, output)) => icmp_from_output(status.success(), &output),
        Err(reason) => {
            log::warn!("[node_probe_reachability] ICMP 未执行：{reason}");
            IcmpReachability {
                ok: false,
                rtt_ms: None,
                loss: 100.0,
                error: Some(reason.to_string()),
            }
        }
    }
}

/// 把 ping 的退出码与输出变成报告。抽成纯函数便于用固定样例做单测。
fn icmp_from_output(exit_ok: bool, output: &str) -> IcmpReachability {
    let samples = parse_rtt_samples(output);
    let replies = count_replies(output);

    let rtt_ms = if samples.is_empty() {
        None
    } else {
        let average = samples.iter().sum::<f64>() / samples.len() as f64;
        Some(average.round().clamp(0.0, u32::MAX as f64) as u32)
    };

    let loss = if !exit_ok {
        100.0
    } else if replies == 0 {
        0.0
    } else {
        let missing = ICMP_COUNT.saturating_sub(replies);
        (missing as f32 / ICMP_COUNT as f32) * 100.0
    };

    IcmpReachability {
        ok: exit_ok,
        rtt_ms,
        loss,
        error: None,
    }
}

fn run_ping(ip: IpAddr) -> Result<(ExitStatus, String), &'static str> {
    let mut command = Command::new(ping_program(ip));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：正式包里不弹控制台窗口。
        command.creation_flags(0x0800_0000);
    }
    command.args(ping_args(ip)).stdin(Stdio::null());
    run_limited(command, PING_BUDGET)
}

fn ping_program(ip: IpAddr) -> &'static str {
    #[cfg(target_os = "macos")]
    {
        if ip.is_ipv6() {
            "/sbin/ping6"
        } else {
            "/sbin/ping"
        }
    }
    #[cfg(windows)]
    {
        let _ = ip;
        "ping.exe"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = ip;
        "ping"
    }
}

fn ping_args(ip: IpAddr) -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let mut args = vec!["-c".to_string(), ICMP_COUNT.to_string()];
        // ping6 的 -W 是 ICMPv6 Node Information 查询开关，不是等待时间；
        // IPv6 只靠 run_limited 的整体预算兜底。
        if !ip.is_ipv6() {
            args.extend(["-W".to_string(), PING_WAIT_MS.to_string()]);
        }
        args.push(ip.to_string());
        args
    }
    #[cfg(windows)]
    {
        let mut args = Vec::new();
        if ip.is_ipv6() {
            args.push("-6".to_string());
        }
        args.extend([
            "-n".to_string(),
            ICMP_COUNT.to_string(),
            "-w".to_string(),
            PING_WAIT_MS.to_string(),
            ip.to_string(),
        ]);
        args
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut args = Vec::new();
        if ip.is_ipv6() {
            args.push("-6".to_string());
        }
        // Linux 的 -W 单位是秒，不是毫秒。
        args.extend([
            "-c".to_string(),
            ICMP_COUNT.to_string(),
            "-W".to_string(),
            "2".to_string(),
            ip.to_string(),
        ]);
        args
    }
}

/// 等进程结束，超过 `limit` 就杀掉；不会无限期阻塞。
/// 失败原因按稳定短码返回：`spawn_failed` / `timeout` / `io_error`。
fn run_limited(
    mut command: Command,
    limit: Duration,
) -> Result<(ExitStatus, String), &'static str> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = command.spawn().map_err(|_| "spawn_failed")?;
    let mut stdout = child.stdout.take();
    let started = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut bytes = Vec::new();
                if let Some(mut pipe) = stdout.take() {
                    let _ = pipe.read_to_end(&mut bytes);
                }
                return Ok((status, String::from_utf8_lossy(&bytes).into_owned()));
            }
            Ok(None) if started.elapsed() >= limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timeout");
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("io_error");
            }
        }
    }
}

/// 只统计带 `ttl` 的回复行。各平台 ping 的回复行都有这个 ASCII 标记，
/// 不受 Windows 控制台代码页影响。
fn count_replies(output: &str) -> u32 {
    output
        .lines()
        .filter(|line| line.to_ascii_lowercase().contains("ttl"))
        .count() as u32
}

fn parse_rtt_samples(output: &str) -> Vec<f64> {
    output
        .lines()
        .filter(|line| line.to_ascii_lowercase().contains("ttl"))
        .filter_map(parse_rtt_ms)
        .collect()
}

/// 解析回复行里的 `time=12.3 ms` / `时间=12ms` / `time<1ms`。
///
/// 不依赖标签文本（Windows 中文控制台是 GBK，UTF-8 解码后标签会变成乱码），
/// 只认 `ms` 前紧邻的数字。
fn parse_rtt_ms(line: &str) -> Option<f64> {
    let lower = line.to_ascii_lowercase();
    let at = lower.find("ms")?;
    let head = lower[..at].trim_end();
    let start = head
        .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|index| index + 1)
        .unwrap_or(0);
    let value = head.get(start..)?.parse::<f64>().ok()?;
    value.is_finite().then_some(value)
}

fn probe_tcp(ip: IpAddr, port: u16) -> TcpReachability {
    let started = Instant::now();
    match TcpStream::connect_timeout(&SocketAddr::new(ip, port), TCP_TIMEOUT) {
        Ok(stream) => {
            drop(stream);
            TcpReachability {
                ok: true,
                ms: Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32),
                error: None,
            }
        }
        Err(error) => TcpReachability {
            ok: false,
            ms: None,
            error: Some(tcp_error_code(&error).to_string()),
        },
    }
}

fn tcp_error_code(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::TimedOut => "timeout",
        std::io::ErrorKind::ConnectionRefused => "refused",
        _ => "unreachable",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ipv4_and_ipv6_literals() {
        assert!(validate_ip("203.0.113.7").is_ok());
        assert!(validate_ip("2001:db8::1").is_ok());
    }

    #[test]
    fn rejects_non_literals() {
        for raw in [
            "",
            "localhost",
            "example.com",
            "203.0.113.7; rm -rf /",
            "1.2.3",
        ] {
            assert!(validate_ip(raw).is_err(), "应拒绝：{raw}");
        }
    }

    #[tokio::test]
    async fn command_rejects_non_ip_input_with_stable_code() {
        let error = node_probe_reachability("localhost".to_string(), 32100)
            .await
            .unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT");
        assert_eq!(error["details"]["reason"], "invalid_ip");
        assert_eq!(error["message"], "");
    }

    #[tokio::test]
    async fn command_rejects_zero_port() {
        let error = node_probe_reachability("203.0.113.7".to_string(), 0)
            .await
            .unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT");
        assert_eq!(error["details"]["reason"], "invalid_port");
    }

    #[test]
    fn ping_args_pass_ip_as_single_argument() {
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        let args = ping_args(ip);
        assert_eq!(args.last().unwrap(), "203.0.113.7");
        assert_eq!(args.iter().filter(|arg| *arg == "203.0.113.7").count(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_ping6_does_not_reuse_ipv4_wait_flag() {
        let args = ping_args("2001:db8::1".parse().unwrap());
        assert!(
            !args.iter().any(|arg| arg == "-W"),
            "ping6 的 -W 不是等待时间"
        );
        assert_eq!(args.last().unwrap(), "2001:db8::1");
    }

    #[test]
    fn parses_macos_ping_output() {
        let output = "\
PING 127.0.0.1 (127.0.0.1): 56 data bytes
64 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.053 ms
64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.049 ms
64 bytes from 127.0.0.1: icmp_seq=2 ttl=64 time=0.050 ms

--- 127.0.0.1 ping statistics ---
3 packets transmitted, 3 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 0.049/0.051/0.053/0.002 ms
";
        let samples = parse_rtt_samples(output);
        assert_eq!(samples.len(), 3);
        assert_eq!(count_replies(output), 3);

        let report = icmp_from_output(true, output);
        assert!(report.ok);
        assert_eq!(report.rtt_ms, Some(0));
        assert_eq!(report.loss, 0.0);
        assert_eq!(report.error, None);
    }

    #[test]
    fn parses_windows_ping_output() {
        let output = "\
正在 Ping 203.0.113.7 具有 32 字节的数据:
来自 203.0.113.7 的回复: 字节=32 时间=12ms TTL=54
来自 203.0.113.7 的回复: 字节=32 时间<1ms TTL=54
请求超时。

203.0.113.7 的 Ping 统计信息:
    数据包: 已发送 = 3，已接收 = 2，丢失 = 1 (33% 丢失)
";
        let samples = parse_rtt_samples(output);
        assert_eq!(samples, vec![12.0, 1.0]);
        assert_eq!(count_replies(output), 2);

        let report = icmp_from_output(true, output);
        assert!(report.ok, "退出码为 0 就算通，解析失败不影响判定");
        assert_eq!(report.rtt_ms, Some(7));
        assert!((report.loss - 33.333_336).abs() < 0.01);
        assert_eq!(report.error, None);
    }

    #[test]
    fn parse_failure_does_not_flip_ok() {
        let report = icmp_from_output(true, "PING 203.0.113.7: 32 data bytes\n");
        assert!(report.ok);
        assert_eq!(report.rtt_ms, None);
        assert_eq!(report.loss, 0.0);
        assert_eq!(report.error, None);
    }

    #[test]
    fn icmp_not_run_reports_reason_instead_of_unreachable() {
        let report = icmp_from_result(Err("spawn_failed"));
        assert!(!report.ok);
        assert_eq!(report.rtt_ms, None);
        assert_eq!(report.loss, 100.0);
        assert_eq!(report.error.as_deref(), Some("spawn_failed"));

        let report = icmp_from_result(Err("timeout"));
        assert_eq!(report.error.as_deref(), Some("timeout"));

        let report = icmp_from_result(Err("io_error"));
        assert_eq!(report.error.as_deref(), Some("io_error"));
    }

    #[test]
    fn nonzero_exit_is_unreachable() {
        let output = "\
PING 203.0.113.7 (203.0.113.7): 56 data bytes
Request timeout for icmp_seq 0
Request timeout for icmp_seq 1
Request timeout for icmp_seq 2

--- 203.0.113.7 ping statistics ---
3 packets transmitted, 0 packets received, 100.0% packet loss
";
        let report = icmp_from_output(false, output);
        assert!(!report.ok);
        assert_eq!(report.rtt_ms, None);
        assert_eq!(report.loss, 100.0);
        assert_eq!(report.error, None, "执行完的失败不是未执行");
    }

    #[cfg(unix)]
    #[test]
    fn run_limited_kills_overdue_process() {
        let mut command = Command::new("/bin/sleep");
        command.arg("5");
        let started = Instant::now();
        assert!(matches!(
            run_limited(command, Duration::from_millis(100)),
            Err("timeout")
        ));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "超时分支必须在预算内返回"
        );
    }

    #[test]
    fn run_limited_reports_spawn_failure() {
        let command = Command::new("/nonexistent/veyl-probe-test");
        assert!(matches!(
            run_limited(command, Duration::from_millis(100)),
            Err("spawn_failed")
        ));
    }

    #[test]
    #[ignore = "使用本机回环，可跳过"]
    fn tcp_reaches_local_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let report = probe_tcp("127.0.0.1".parse().unwrap(), port);
        assert!(report.ok);
        assert!(report.ms.is_some());
        assert_eq!(report.error, None);
    }

    #[test]
    #[ignore = "需要系统 ping 可用，可跳过"]
    fn icmp_reaches_loopback() {
        let report = probe_icmp("127.0.0.1".parse().unwrap());
        assert!(report.ok);
        assert!(report.rtt_ms.is_some());
        assert_eq!(report.error, None);
    }
}
