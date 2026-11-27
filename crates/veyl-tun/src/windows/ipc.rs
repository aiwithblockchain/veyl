//! 服务与主程序之间的线协议（`docs/contracts/tun-backend.md` §1）。
//!
//! 帧格式：`u32` 小端长度 + UTF-8 JSON。信封**只允许 `method` 与 `config`**，
//! 多余键直接 `bad_request`。`config` 是配置文本（字符串），不是对象——
//! 与 macOS XPC 传的是同一段 UTF-8 字节。
//!
//! 一次连接 = 一条请求 + 一条回复 + 关闭；没有长连接、没有请求 ID。

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 开发探活用的协议版本；与 `ping` 一样只在 debug 构建存在。
#[cfg(debug_assertions)]
pub const PROTOCOL_VERSION: u32 = 1;

/// 配置文本上限是 512 KiB（`protocol::MAX_CONFIG_BYTES`），但信封是 JSON，
/// 引号/换行的转义会让帧比原文大。帧上限放到 2 MiB：超限的配置仍由
/// `prepare_config` 报 `config_too_large`，不会被帧层误报成 `bad_request`。
pub const MAX_BODY: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum Request {
    /// 开发/验证用探活，**只存在于 debug 构建**。
    /// 发布构建里 `ping` 与其它未知方法一样是 `bad_request`（契约 §1.1）。
    #[cfg(debug_assertions)]
    Ping,
    Status,
    Start {
        config: String,
    },
    Stop,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
    /// 成功时恒存在；`stop` 的 `result` 就是 `null`，不是省略键。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}

impl Response {
    pub fn ok(result: Value) -> Self {
        Self {
            ok: true,
            code: None,
            message: None,
            detail: None,
            result: Some(result),
        }
    }

    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            code: Some(code.into()),
            message: Some(message.into()),
            detail: None,
            result: None,
        }
    }
}

pub fn encode(request: &Request) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(request)
}

/// 严格按契约解析信封。错误消息直接进 `bad_request.message`。
pub fn parse_request(body: &[u8]) -> Result<Request, String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|error| format!("请求不是合法 JSON：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "请求必须是一个 JSON 对象".to_string())?;

    for key in object.keys() {
        if key != "method" && key != "config" {
            return Err(format!("信封不允许字段 {key}"));
        }
    }

    let method = object
        .get("method")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "缺少 method".to_string())?;

    let config = object.get("config");
    let config_text = || match config {
        Some(Value::String(text)) => Ok(text.clone()),
        Some(Value::Null) | None => Err("start 缺少 config 文本".to_string()),
        Some(other) => Err(format!(
            "config 必须是字符串（配置文本），收到 {}",
            type_name(other)
        )),
    };

    match method {
        "status" => {
            reject_config(method, config)?;
            Ok(Request::Status)
        }
        "stop" => {
            reject_config(method, config)?;
            Ok(Request::Stop)
        }
        #[cfg(debug_assertions)]
        "ping" => {
            reject_config(method, config)?;
            Ok(Request::Ping)
        }
        #[cfg(not(debug_assertions))]
        "ping" => Err("未知 method：ping（发布构建不提供探活方法，请用 status）".to_string()),
        "start" => Ok(Request::Start {
            config: config_text()?,
        }),
        other => Err(format!("未知 method：{other}")),
    }
}

fn reject_config(method: &str, config: Option<&Value>) -> Result<(), String> {
    if config.is_some_and(|value| !value.is_null()) {
        Err(format!("{method} 不接受 config"))
    } else {
        Ok(())
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub fn read_frame(reader: &mut impl Read) -> io::Result<Vec<u8>> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header)?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_BODY {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("帧长度 {length} 超出上限 {MAX_BODY}"),
        ));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    Ok(body)
}

pub fn write_frame(writer: &mut impl Write, body: &[u8]) -> io::Result<()> {
    if body.len() > MAX_BODY {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("帧长度 {} 超出上限 {MAX_BODY}", body.len()),
        ));
    }
    writer.write_all(&(body.len() as u32).to_le_bytes())?;
    writer.write_all(body)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_survives_a_frame_round_trip() {
        let request = Request::Start {
            config: r#"{"inbounds":[{"type":"tun"}]}"#.to_string(),
        };
        let body = encode(&request).unwrap();
        let mut frame = Vec::new();
        write_frame(&mut frame, &body).unwrap();
        let decoded = read_frame(&mut frame.as_slice()).unwrap();
        assert_eq!(parse_request(&decoded).unwrap(), request);
    }

    #[test]
    fn extra_envelope_keys_are_rejected_not_ignored() {
        assert!(parse_request(br#"{"method":"status","path":"C:\\x"}"#).is_err());
        assert!(parse_request(br#"{"method":"stop","config":null}"#).is_ok());
        assert!(parse_request(br#"{"method":"status","config":"x"}"#).is_err());
    }

    #[test]
    fn unknown_methods_and_bad_config_types_are_rejected() {
        assert!(parse_request(br#"{"method":"exec"}"#).is_err());
        assert!(parse_request(br#"{"method":"start"}"#).is_err());
        assert!(parse_request(br#"{"method":"start","config":{}}"#).is_err());
        assert!(parse_request(br#"{"method":"start","config":null}"#).is_err());
        assert!(parse_request(br##"{"method":"start","config":"{}"}"##).is_ok());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn ping_exists_only_in_debug_builds() {
        assert!(parse_request(br#"{"method":"ping"}"#).is_ok());
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn ping_is_rejected_in_release_builds() {
        assert!(parse_request(br#"{"method":"ping"}"#).is_err());
    }

    #[test]
    fn oversized_frames_are_rejected() {
        let mut frame = 0u32.to_le_bytes().to_vec();
        frame.resize(4, 0);
        assert!(read_frame(&mut frame.as_slice()).is_err());

        let mut frame = (MAX_BODY as u32 + 1).to_le_bytes().to_vec();
        frame.resize(4, 0);
        assert!(read_frame(&mut frame.as_slice()).is_err());
    }
}
