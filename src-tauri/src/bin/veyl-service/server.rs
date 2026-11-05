//! 请求分发。W1 只做 ping / status / start / stop 的最小语义。
//!
//! `start` 会走**与 macOS 同一份** allowlist（`tun/protocol.rs`），
//! 然后明确返回 `runtime_missing`——本轮不拉起 sing-box，也不假装已经连上。
//! `ping` 是开发/验证用的探活，不在 `TunBackend` 契约里。

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{json, Value};

use super::protocol;
use super::win::ipc::{Request, Response};

pub fn dispatch(request: &Request) -> Response {
    match request {
        #[cfg(debug_assertions)]
        Request::Ping => Response::ok(json!({
            "pong": true,
            "protocol": super::win::ipc::PROTOCOL_VERSION,
            "service_pid": std::process::id(),
        })),
        // 运行时还没接入，状态只可能是 stopped；不伪造 running。
        // 契约 §3.2：字段恒存在，无值写 null。
        Request::Status => Response::ok(json!({
            "running": false,
            "pid": Value::Null,
            "clash_api": Value::Null,
            "since": Value::Null,
            "last_error": Value::Null,
        })),
        // 契约 §1.1：stop 的 result 是 null，不是省略键。
        Request::Stop => Response::ok(Value::Null),
        Request::Start { config } => start(config),
    }
}

fn start(config: &str) -> Response {
    let port = match ephemeral_clash_port() {
        Ok(port) => port,
        Err(message) => return Response::error("internal", message),
    };
    let rules = rule_index();
    let secret = hex::encode(rand::random::<[u8; 24]>());

    match protocol::prepare_config(config, &rules, port, &secret) {
        Ok(_) => Response::error(
            protocol::ERR_RUNTIME_MISSING,
            "运行时接入在 W3 完成；本轮只验证协议、allowlist 与对端认证",
        ),
        Err(error) => Response::error(error.code, error.message),
    }
}

/// 契约要求 Clash API 只绑回环、端口在 49152–65535。向系统要一个临时端口，
/// 再交给 `prepare_config`。这里拿到端口后会释放监听；W3 拉起 sing-box 前
/// 需要重新确认端口仍可用（或让 sing-box 自己报告实际端口）。
fn ephemeral_clash_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("分配回环端口失败：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取回环端口失败：{error}"))?
        .port();
    drop(listener);
    if !(49152..=65535).contains(&port) {
        return Err(format!("系统分配的端口 {port} 不在契约范围 49152–65535"));
    }
    Ok(port)
}

/// 规则集只认 tag，文件由服务自己从 `%ProgramData%\Veyl\rules\` 取。
fn rule_index() -> HashMap<String, PathBuf> {
    let directory = super::win::program_data_dir().join("rules");
    let mut rules = HashMap::new();
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return rules;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("srs") {
            continue;
        }
        if let Some(tag) = path.file_stem().and_then(|value| value.to_str()) {
            rules.insert(tag.to_string(), path);
        }
    }
    rules
}
