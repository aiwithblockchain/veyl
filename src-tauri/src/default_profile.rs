//! 默认配置包：拉取、校验、加密缓存、tun→mixed 适配与回退。
//!
//! 包体（含共享凭据）只加密存放在 `secrets.enc`；数据库只保存元数据。
//! 渲染出的 sing-box 配置仍走 `config::install_profile`（0600，断开即删）。

use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::store::{self, default_profile as meta, Store};

pub const DEFAULT_PROFILE_URL: &str = "https://meshnetprotocol.github.io/bootstrap.json";
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_BYTES: usize = 2 * 1024 * 1024;

/// 调试可用环境变量覆盖；正常构建只认固定地址。
pub fn source_url() -> String {
    std::env::var("VEYL_DEFAULT_PROFILE_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_PROFILE_URL.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedPackage {
    pub provider_id: String,
    pub name: Option<String>,
    /// 发布方的版本标签，只作展示。
    pub package_hash: String,
    /// 原始响应字节的 sha256。身份判据的一部分。
    pub content_sha256: String,
    pub source_updated_at: Option<String>,
    pub outbound_tags: Vec<String>,
    pub node_count: i64,
    /// 规范化后的整包 JSON，用于加密存储。
    pub package_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshOutcome {
    Updated {
        version: String,
        node_count: i64,
        new_version_available: bool,
    },
    Unchanged,
}

#[derive(Debug, Clone)]
pub struct Status {
    pub package_id: String,
    pub name: Option<String>,
    pub version: String,
    pub applied_at: String,
    pub new_version_available: bool,
    pub node_count: i64,
}

fn secret_key(provider_id: &str, content_sha256: &str) -> String {
    format!("pkg:{provider_id}:{content_sha256}")
}

/// 004 之前写入的包体存在 `pkg:<provider_id>`；读取时兼容。
fn legacy_secret_key(provider_id: &str) -> String {
    format!("pkg:{provider_id}")
}

/// 只读状态，不联网。
pub fn status(store: &Store) -> Option<Status> {
    let conn = store.conn();
    let row = meta::load(&conn).ok().flatten()?;
    Some(Status {
        package_id: row.provider_id.clone(),
        name: row.name.clone(),
        version: row.version_label(),
        applied_at: store::iso_from_ms(row.applied_at),
        new_version_available: row.new_version_available,
        node_count: row.node_count,
    })
}

/// 读取当前包体（已解密）。
pub fn load_package(store: &Store) -> Option<(meta::DefaultProfileRow, Value)> {
    let row = {
        let conn = store.conn();
        meta::load(&conn).ok().flatten()?
    };
    let body = read_package_body(&row.provider_id, &row.content_sha256)?;
    let value: Value = serde_json::from_str(&body).ok()?;
    Some((row, value))
}

fn read_package_body(provider_id: &str, content_sha256: &str) -> Option<String> {
    if !content_sha256.is_empty() {
        if let Ok(Some(body)) = crate::secrets::get_secret(&secret_key(provider_id, content_sha256)) {
            return Some(body);
        }
    }
    crate::secrets::get_secret(&legacy_secret_key(provider_id))
        .ok()
        .flatten()
}

/// 拉取并应用新包。`running` 为真时只标记「有新版本」，不碰在线连接。
pub async fn refresh(store: &Store, running: bool) -> Result<RefreshOutcome, String> {
    let url = source_url();
    let bytes = fetch(&url).await?;
    let package = validate(&bytes, &url)?;
    let now = store::now_ms();

    let current = {
        let conn = store.conn();
        meta::load(&conn).map_err(|error| error.to_string())?
    };

    if let Some(current) = current.as_ref() {
        // 身份判据是 (provider_id, content_sha256)；004 之前的行没有内容哈希，强制重算。
        if current.provider_id == package.provider_id
            && !current.content_sha256.is_empty()
            && current.content_sha256 == package.content_sha256
        {
            let mut row = current.clone();
            row.checked_at = now;
            let conn = store.conn();
            meta::save(&conn, &row).map_err(|error| error.to_string())?;
            return Ok(RefreshOutcome::Unchanged);
        }
    }

    // 旧包体仍留在它自己的 (provider, content) 键上，回退时直接读。
    let previous = current.as_ref().map(|current| meta::PreviousProfile {
        provider_id: current.provider_id.clone(),
        name: current.name.clone(),
        package_hash: current.package_hash.clone(),
        content_sha256: current.content_sha256.clone(),
        source_updated_at: current.source_updated_at.clone(),
        outbound_tags: current.outbound_tags.clone(),
        node_count: current.node_count,
        applied_at: current.applied_at,
    });

    crate::secrets::set_secret(
        &secret_key(&package.provider_id, &package.content_sha256),
        &package.package_json,
    )
    .map_err(|error| format!("保存默认配置包失败：{error}"))?;

    let row = meta::DefaultProfileRow {
        provider_id: package.provider_id.clone(),
        name: package.name.clone(),
        package_hash: package.package_hash.clone(),
        content_sha256: package.content_sha256.clone(),
        source_updated_at: package.source_updated_at.clone(),
        outbound_tags: package.outbound_tags.clone(),
        node_count: package.node_count,
        applied_at: now,
        checked_at: now,
        // 在线时新版本只在下次连接生效，入口显示「有新版本」。
        new_version_available: running,
        previous,
    };
    {
        let conn = store.conn();
        meta::save(&conn, &row).map_err(|error| error.to_string())?;
    }

    crate::agent::app_handle::emit(
        "default-profile-updated",
        json!({
            "contract_version": "1.1.0",
            "package_id": row.provider_id,
            "version": row.version_label(),
            "applied_at": store::iso_from_ms(row.applied_at),
            "new_version_available": row.new_version_available,
            "emitted_at": chrono::Utc::now()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }),
    );

    Ok(RefreshOutcome::Updated {
        version: row.version_label(),
        node_count: row.node_count,
        new_version_available: running,
    })
}

/// 回退到上一版。成功返回 true。
pub fn rollback(store: &Store) -> bool {
    let conn = store.conn();
    let Some(row) = meta::load(&conn).ok().flatten() else {
        return false;
    };
    let Some(previous) = row.previous.clone() else {
        return false;
    };
    // 上一版包体就在它自己的 (provider, content) 键上。
    if read_package_body(&previous.provider_id, &previous.content_sha256).is_none() {
        return false;
    }

    let restored = meta::DefaultProfileRow {
        provider_id: previous.provider_id,
        name: previous.name,
        package_hash: previous.package_hash,
        content_sha256: previous.content_sha256,
        source_updated_at: previous.source_updated_at,
        outbound_tags: previous.outbound_tags,
        node_count: previous.node_count,
        applied_at: previous.applied_at,
        checked_at: row.checked_at,
        new_version_available: false,
        previous: None,
    };
    meta::save(&conn, &restored).is_ok()
}

/// 连接成功后清掉「有新版本」标记。
pub fn mark_applied(store: &Store) {
    let conn = store.conn();
    if let Ok(Some(mut row)) = meta::load(&conn) {
        if row.new_version_available {
            row.new_version_available = false;
            let _ = meta::save(&conn, &row);
        }
    }
}

/// 上次成功检查/拉取的时间（毫秒）。节流与 stale 判断都用它。
pub fn last_checked_ms(store: &Store) -> Option<i64> {
    let conn = store.conn();
    meta::load(&conn).ok().flatten().map(|row| row.checked_at)
}

/// AI 工具 `DefaultProfileStatus` 的形状（比 UI 命令多 fetched_at / stale / offline_capable）。
pub fn tool_status(store: &Store) -> Value {
    let conn = store.conn();
    let Some(row) = meta::load(&conn).ok().flatten() else {
        return json!({
            "package_id": null,
            "version": null,
            "applied_at": null,
            "fetched_at": null,
            "node_count": 0,
            "stale": true,
            "offline_capable": false,
        });
    };

    let now = store::now_ms();
    let stale = now.saturating_sub(row.checked_at) > REFRESH_INTERVAL.as_millis() as i64;
    let offline_capable = read_package_body(&row.provider_id, &row.content_sha256).is_some();
    let package_id = row
        .provider_id
        .rsplit('-')
        .next()
        .unwrap_or(row.provider_id.as_str())
        .to_string();

    json!({
        "package_id": package_id,
        "version": row.version_label(),
        "applied_at": store::iso_from_ms(row.applied_at),
        "fetched_at": store::iso_from_ms(row.checked_at),
        "node_count": row.node_count,
        "stale": stale,
        "offline_capable": offline_capable,
    })
}

async fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("默认配置地址无效：{error}"))?;
    let overridden = std::env::var("VEYL_DEFAULT_PROFILE_URL").is_ok();
    let local = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"));
    if parsed.scheme() != "https" && !(overridden && local) {
        return Err("默认配置只允许 HTTPS".into());
    }

    let host = parsed.host_str().unwrap_or_default().to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 3 {
                return attempt.stop();
            }
            if attempt.url().host_str() != Some(host.as_str()) {
                return attempt.stop();
            }
            attempt.follow()
        }))
        .build()
        .map_err(|error| format!("创建下载客户端失败：{error}"))?;

    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|error| format!("拉取默认配置失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("默认配置返回 HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取默认配置失败：{error}"))?;
    if bytes.len() > MAX_BYTES {
        return Err("默认配置超过 2 MB".into());
    }
    Ok(bytes.to_vec())
}

/// 结构校验 + 提取元数据。错误信息不含包内容（可能含凭据）。
pub fn validate(bytes: &[u8], _url: &str) -> Result<ValidatedPackage, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("默认配置不是合法 JSON：{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "默认配置必须是 JSON 对象".to_string())?;

    if let Some(status) = object.get("status").and_then(Value::as_str) {
        if status != "active" {
            return Err(format!("默认配置状态不是 active：{status}"));
        }
    }

    let provider_id = object
        .get("provider_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "默认配置缺少 provider_id".to_string())?
        .to_string();

    let config = object
        .get("config")
        .and_then(Value::as_object)
        .ok_or_else(|| "默认配置缺少 config 对象".to_string())?;
    let outbounds = config
        .get("outbounds")
        .and_then(Value::as_array)
        .filter(|outbounds| !outbounds.is_empty())
        .ok_or_else(|| "默认配置的 config.outbounds 为空".to_string())?;

    let mut outbound_tags = Vec::new();
    let mut node_count = 0i64;
    for outbound in outbounds {
        let Some(tag) = outbound.get("tag").and_then(Value::as_str) else {
            continue;
        };
        outbound_tags.push(tag.to_string());
        let kind = outbound.get("type").and_then(Value::as_str).unwrap_or_default();
        if !matches!(kind, "selector" | "urltest" | "direct" | "block" | "dns") {
            node_count += 1;
        }
    }
    if node_count == 0 {
        return Err("默认配置没有可用出站".into());
    }

    let package_hash = object
        .get("package_hash")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_default();

    // 身份用原始响应字节的 sha256，不反序列化再序列化——键顺序变化不能算新版本。
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let content_sha256 = hex::encode(hasher.finalize());

    Ok(ValidatedPackage {
        provider_id,
        name: object
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        package_hash,
        content_sha256,
        source_updated_at: object
            .get("source_updated_at")
            .and_then(Value::as_str)
            .map(str::to_string),
        outbound_tags,
        node_count,
        package_json: value.to_string(),
    })
}

const SUPPORTED_OUTBOUNDS: &[&str] = &[
    "shadowsocks",
    "vless",
    "vmess",
    "trojan",
    "hysteria",
    "hysteria2",
    "tuic",
    "wireguard",
    "socks",
    "http",
    "direct",
    "block",
    "dns",
    "selector",
    "urltest",
];

/// tun→mixed 适配：丢 `inbounds`，注入 mixed + Clash API，保留其余结构。
/// `node_tag` 有值时把 selector/urltest 的 `default` 指向它。
pub fn adapt(
    package: &Value,
    mixed_port: u16,
    clash_port: u16,
    clash_secret: &str,
    node_tag: Option<&str>,
) -> Result<Value, String> {
    let config = package
        .get("config")
        .and_then(Value::as_object)
        .ok_or_else(|| "默认配置缺少 config 对象".to_string())?;

    let outbounds = config
        .get("outbounds")
        .and_then(Value::as_array)
        .ok_or_else(|| "默认配置缺少 outbounds".to_string())?
        .clone();

    let mut kept = Vec::new();
    let mut tags = Vec::new();
    let mut node_tags = Vec::new();
    for outbound in outbounds {
        let kind = outbound.get("type").and_then(Value::as_str).unwrap_or_default();
        if !SUPPORTED_OUTBOUNDS.contains(&kind) {
            log::warn!("默认配置里跳过不支持的出站类型：{kind}");
            continue;
        }
        if let Some(tag) = outbound.get("tag").and_then(Value::as_str) {
            tags.push(tag.to_string());
            if !matches!(kind, "selector" | "urltest" | "direct" | "block" | "dns") {
                node_tags.push(tag.to_string());
            }
        }
        kept.push(outbound);
    }
    if node_tags.is_empty() {
        return Err("默认配置没有可用节点".into());
    }

    let chosen = node_tag
        .filter(|tag| node_tags.iter().any(|candidate| candidate == tag))
        .map(str::to_string)
        .unwrap_or_else(|| node_tags[0].clone());

    let mut kept: Vec<Value> = kept
        .into_iter()
        .map(|mut outbound| {
            let kind = outbound.get("type").and_then(Value::as_str).unwrap_or_default();
            if matches!(kind, "selector" | "urltest") {
                let current = outbound.get("default").and_then(Value::as_str);
                let missing = current
                    .map(|default| !tags.iter().any(|tag| tag == default))
                    .unwrap_or(true);
                if missing || node_tag.is_some() {
                    outbound["default"] = Value::String(chosen.clone());
                }
            }
            outbound
        })
        .collect();

    // 用户指定了节点时，让所有 selector/urltest 都跟随（只有一层嵌套，够用）。
    if node_tag.is_some() {
        for outbound in kept.iter_mut() {
            let kind = outbound.get("type").and_then(Value::as_str).unwrap_or_default();
            if matches!(kind, "selector" | "urltest") {
                outbound["default"] = Value::String(chosen.clone());
            }
        }
    }

    let mut result = serde_json::Map::new();
    for (key, value) in config {
        if key == "inbounds" || key == "experimental" {
            continue;
        }
        result.insert(key.clone(), value.clone());
    }
    result.insert(
        "inbounds".into(),
        json!([{
            "type": "mixed",
            "tag": "mixed-in",
            "listen": "127.0.0.1",
            "listen_port": mixed_port,
        }]),
    );
    result.insert(
        "experimental".into(),
        json!({
            "clash_api": {
                "external_controller": format!("127.0.0.1:{clash_port}"),
                "secret": clash_secret,
            },
            "cache_file": { "enabled": false },
        }),
    );
    result.insert("outbounds".into(), Value::Array(kept));

    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PACKAGE: &str = r#"{
        "name": "种子V21",
        "provider_id": "seed-v21",
        "status": "active",
        "package_hash": "abcdef1234567890",
        "source_updated_at": "2026-11-01T02:03:04Z",
        "config": {
            "log": { "level": "info" },
            "dns": { "servers": [] },
            "inbounds": [{ "type": "tun", "tag": "tun-in" }],
            "outbounds": [
                { "type": "shadowsocks", "tag": "us-1", "server": "203.0.113.10", "server_port": 8388, "method": "aes-256-gcm", "password": "pw" },
                { "type": "shadowsocks", "tag": "us-2", "server": "203.0.113.11", "server_port": 8388, "method": "aes-256-gcm", "password": "pw" },
                { "type": "selector", "tag": "proxy", "outbounds": ["us-1", "us-2"], "default": "us-1" },
                { "type": "direct", "tag": "direct" }
            ],
            "route": { "rules": [{ "outbound": "proxy" }] }
        }
    }"#;

    fn package() -> ValidatedPackage {
        validate(PACKAGE.as_bytes(), "https://example.invalid").unwrap()
    }

    #[test]
    fn validates_and_extracts_metadata() {
        let package = package();
        assert_eq!(package.provider_id, "seed-v21");
        assert_eq!(package.node_count, 2);
        assert_eq!(package.outbound_tags.len(), 4);
        assert_eq!(package.package_hash, "abcdef1234567890");
    }

    #[test]
    fn rejects_inactive_or_broken_packages() {
        let inactive = PACKAGE.replace("\"active\"", "\"draft\"");
        assert!(validate(inactive.as_bytes(), "https://x").is_err());
        assert!(validate(b"{}", "https://x").is_err());
        assert!(validate(b"not json", "https://x").is_err());
    }

    #[test]
    fn adapts_tun_to_mixed_and_keeps_route() {
        let value: Value = serde_json::from_str(PACKAGE).unwrap();
        let adapted = adapt(&value, 12345, 23456, "secret", None).unwrap();

        assert!(adapted.get("route").is_some());
        assert!(adapted.get("dns").is_some());
        let inbounds = adapted["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 1);
        assert_eq!(inbounds[0]["type"], "mixed");
        assert_eq!(inbounds[0]["listen_port"], 12345);
        assert_eq!(
            adapted["experimental"]["clash_api"]["external_controller"],
            "127.0.0.1:23456"
        );
        assert_eq!(adapted["outbounds"][2]["default"], "us-1");
    }

    #[test]
    fn selecting_a_node_updates_selector_default() {
        let value: Value = serde_json::from_str(PACKAGE).unwrap();
        let adapted = adapt(&value, 1, 2, "s", Some("us-2")).unwrap();
        let selector = adapted["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|outbound| outbound["type"] == "selector")
            .unwrap();
        assert_eq!(selector["default"], "us-2");
    }

    #[test]
    fn unsupported_outbounds_are_skipped() {
        let raw = PACKAGE.replace(
            "{ \"type\": \"direct\", \"tag\": \"direct\" }",
            "{ \"type\": \"mystery\", \"tag\": \"odd\" }, { \"type\": \"direct\", \"tag\": \"direct\" }",
        );
        let value: Value = serde_json::from_str(&raw).unwrap();
        let adapted = adapt(&value, 1, 2, "s", None).unwrap();
        let has_odd = adapted["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|outbound| outbound["tag"] == "odd");
        assert!(!has_odd);
    }
}
