//! 种子包导入。
//!
//! 输入是一份**完整的 sing-box 配置包**，但我们只取 `outbounds[]` 里 shadowsocks 节点的
//! 「是什么」（server / port / method / password）。`log` / `dns` / `inbounds` / `route`
//! 一律忽略——配置由 `config::builder` 重新生成，否则测的就是别人的配置。
//!
//! 密码只进 `secrets.enc` 的 `node:<profile_id>`，不进 SQLite、不进日志；
//! 摘要里给的是 `sha256(password)` 前 8 位，用来证明「没有泄漏」。

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::catalog::SUPPORTED_METHODS;
use crate::store::{NewProfile, Store};

#[derive(Debug, Deserialize)]
pub struct SeedPackage {
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub package_hash: String,
    pub config: SeedConfig,
}

#[derive(Debug, Deserialize)]
pub struct SeedConfig {
    #[serde(default)]
    pub outbounds: Vec<SeedOutbound>,
}

#[derive(Debug, Deserialize)]
pub struct SeedOutbound {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub server: String,
    #[serde(default)]
    pub server_port: u16,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ImportedNode {
    pub id: String,
    pub name: String,
    pub server: String,
    pub server_port: u16,
    pub method: String,
    pub tag: String,
    /// 只在导入时用，永不打印。
    pub password: String,
    /// `sha256(password)` 前 8 位，用于证明密码没进日志。
    pub password_fingerprint: String,
}

impl std::fmt::Debug for ImportedNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportedNode")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("server", &self.server)
            .field("server_port", &self.server_port)
            .field("method", &self.method)
            .field("tag", &self.tag)
            .field("password", &"<redacted>")
            .field("password_fingerprint", &self.password_fingerprint)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedNode {
    pub tag: String,
    pub reason: String,
}

#[derive(Debug, Default)]
pub struct ImportPlan {
    pub imported: Vec<ImportedNode>,
    pub skipped: Vec<SkippedNode>,
}

pub fn parse(contents: &str) -> Result<SeedPackage, String> {
    serde_json::from_str(contents).map_err(|e| format!("种子文件不是合法的 JSON：{e}"))
}

/// 纯函数：决定哪些 outbound 能导入、哪些跳过。不碰磁盘、不碰凭据。
pub fn plan(package: &SeedPackage) -> ImportPlan {
    let mut result = ImportPlan::default();

    for outbound in &package.config.outbounds {
        if outbound.kind != "shadowsocks" {
            result.skipped.push(SkippedNode {
                tag: outbound.tag.clone(),
                reason: format!("不是 shadowsocks（{}）", outbound.kind),
            });
            continue;
        }

        let method = outbound.method.as_deref().unwrap_or("").trim();
        if !SUPPORTED_METHODS.contains(&method) {
            result.skipped.push(SkippedNode {
                tag: outbound.tag.clone(),
                reason: format!("unsupported method: {method}"),
            });
            continue;
        }

        let password = outbound.password.as_deref().unwrap_or("").trim();
        if password.is_empty() {
            result.skipped.push(SkippedNode {
                tag: outbound.tag.clone(),
                reason: "missing password".to_string(),
            });
            continue;
        }

        let name = profile_name(package, outbound);
        let id = seed_id(
            &package.provider_id,
            &name,
            &outbound.server,
            outbound.server_port,
            &outbound.tag,
        );

        let password_fingerprint = fingerprint(&id, password);
        result.imported.push(ImportedNode {
            id,
            name,
            server: outbound.server.clone(),
            server_port: outbound.server_port,
            method: method.to_string(),
            tag: outbound.tag.clone(),
            password: password.to_string(),
            password_fingerprint,
        });
    }

    result
}

/// `<包名> · <outbound tag>`；缺字段时退化为 `<server>:<port>`。
fn profile_name(package: &SeedPackage, outbound: &SeedOutbound) -> String {
    let package_name = package.name.trim();
    let tag = outbound.tag.trim();
    if !package_name.is_empty() && !tag.is_empty() {
        return format!("{package_name} · {tag}");
    }
    if !tag.is_empty() {
        return tag.to_string();
    }
    format!("{}:{}", outbound.server, outbound.server_port)
}

/// 同一个包导入两次必须得到同一个 id（重跑是更新，不是复制）。
pub fn seed_id(provider_id: &str, name: &str, server: &str, port: u16, tag: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(
        format!("{provider_id}|{name}|{server}|{port}|{tag}").as_bytes(),
    );
    let hex = hex::encode(hasher.finalize());
    format!("seed-{}", &hex[..16])
}

/// `hex(sha256("<profile_id>:<password>"))[..8]`。
///
/// 按节点加盐：同一密码在不同节点得到不同指纹，不能跨节点比对，
/// 也让 32 bit 的短指纹不再暴露「弱密码字典」的可枚举性。
pub fn fingerprint(profile_id: &str, password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{profile_id}:{password}").as_bytes());
    hex::encode(hasher.finalize())[..8].to_string()
}

/// 落库：profile 走 SQLite（不含凭据），密码走 `secrets.enc` 的 `node:<id>`。
/// 幂等：同 id 覆盖。
pub fn apply(store: &Store, plan: &ImportPlan) -> Result<usize, String> {
    let mut written = 0;

    for node in &plan.imported {
        let config: Value = json!({
            "server": node.server,
            "server_port": node.server_port,
            "tls": Value::Null,
            "flow": Value::Null,
            "mux": Value::Null,
        });

        {
            let conn = store.conn();
            crate::store::profiles::upsert(
                &conn,
                &NewProfile {
                    id: &node.id,
                    node_id: None,
                    name: &node.name,
                    protocol: Some("shadowsocks"),
                    region: None,
                    config: &config,
                },
            )
            .map_err(|e| format!("写入 profile 失败：{e}"))?;
        }

        let secret: Value = json!({
            "server": node.server,
            "server_port": node.server_port,
            "protocol": "shadowsocks",
            "method": node.method,
            "password": node.password,
            "name": node.name,
        });
        crate::secrets::set_secret(&format!("node:{}", node.id), &secret.to_string())
            .map_err(|e| format!("写入凭据失败：{e}"))?;

        written += 1;
    }

    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    const PACKAGE: &str = r#"{
      "provider_id": "prov_demo",
      "name": "Demo",
      "tags": ["seed"],
      "package_hash": "abc",
      "config": {
        "log": { "level": "info" },
        "dns": {},
        "inbounds": [{ "type": "mixed", "tag": "in" }],
        "outbounds": [
          { "type": "shadowsocks", "tag": "Tokyo-01", "server": "203.0.113.5",
            "server_port": 8388, "method": "aes-256-gcm", "password": "pw-tokyo" },
          { "type": "shadowsocks", "tag": "Osaka-01", "server": "203.0.113.9",
            "server_port": 8388, "method": "aes-256-gcm", "password": "pw-osaka" },
          { "type": "direct", "tag": "direct" },
          { "type": "block", "tag": "block" },
          { "type": "shadowsocks", "tag": "hk-01", "server": "203.0.113.7",
            "server_port": 8388, "method": "chacha20-ietf-poly1305", "password": "x" },
          { "type": "shadowsocks", "tag": "no-pw", "server": "203.0.113.8",
            "server_port": 8388, "method": "aes-256-gcm" }
        ],
        "route": { "final": "Tokyo-01" }
      }
    }"#;

    fn package() -> SeedPackage {
        parse(PACKAGE).unwrap()
    }

    fn shared_secrets() {
        static ONCE: OnceLock<()> = OnceLock::new();
        ONCE.get_or_init(|| {
            let dir = std::env::temp_dir().join("veyl-seed-secrets");
            let _ = std::fs::create_dir_all(&dir);
            crate::secrets::install(&dir);
        });
    }

    #[test]
    fn only_supported_shadowsocks_outbounds_are_imported() {
        let plan = plan(&package());
        assert_eq!(plan.imported.len(), 2);
        let names: Vec<&str> = plan.imported.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"Demo · Tokyo-01"));
        assert!(names.contains(&"Demo · Osaka-01"));

        assert_eq!(plan.skipped.len(), 4);
        let reasons: Vec<&str> = plan.skipped.iter().map(|s| s.reason.as_str()).collect();
        assert!(reasons.iter().any(|r| r.contains("不是 shadowsocks")));
        assert!(reasons
            .iter()
            .any(|r| r.contains("unsupported method: chacha20-ietf-poly1305")));
        assert!(reasons.contains(&"missing password"));
    }

    #[test]
    fn ids_are_deterministic_for_the_same_package() {
        let first = plan(&package());
        let second = plan(&package());
        let ids_a: Vec<&str> = first.imported.iter().map(|n| n.id.as_str()).collect();
        let ids_b: Vec<&str> = second.imported.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids_a, ids_b);
        assert!(ids_a.iter().all(|id| id.starts_with("seed-") && id.len() == 21));
    }

    #[test]
    fn the_fingerprint_is_short_hex_and_not_the_password() {
        let node = &plan(&package()).imported[0];
        assert_eq!(node.password_fingerprint.len(), 8);
        assert!(node
            .password_fingerprint
            .chars()
            .all(|c| c.is_ascii_hexdigit()));
        assert!(!node.password_fingerprint.contains(&node.password));
        // Debug 输出不能带密码。
        assert!(!format!("{node:?}").contains("pw-"));
    }

    #[test]
    fn the_fingerprint_is_salted_by_profile_id() {
        // 同一个密码在不同节点必须得到不同指纹。
        assert_ne!(
            fingerprint("seed-aaaaaaaaaaaaaaaa", "same-password"),
            fingerprint("seed-bbbbbbbbbbbbbbbb", "same-password")
        );
        // 同一输入稳定。
        assert_eq!(
            fingerprint("seed-aaaaaaaaaaaaaaaa", "same-password"),
            fingerprint("seed-aaaaaaaaaaaaaaaa", "same-password")
        );
    }

    #[test]
    fn importing_twice_updates_instead_of_duplicating() {
        shared_secrets();
        let store = crate::store::Store::open_in_memory().unwrap();
        let plan = plan(&package());

        assert_eq!(apply(&store, &plan).unwrap(), 2);
        assert_eq!(apply(&store, &plan).unwrap(), 2);

        let conn = store.conn();
        let profiles = crate::store::profiles::list(&conn).unwrap();
        assert_eq!(profiles.len(), 2, "重跑不能复制出两套");
        assert!(profiles.iter().all(|p| p.node_id.is_none()));
        assert!(profiles.iter().all(|p| p.protocol.as_deref() == Some("shadowsocks")));

        // SQLite 里不能有密码。
        let snapshot = profiles[0].config.to_string();
        assert!(!snapshot.contains("pw-"), "{snapshot}");
        assert!(!snapshot.contains("password"), "{snapshot}");

        // 密码在 secrets 里，且能按约定的结构读回来。
        drop(conn);
        let raw = crate::secrets::get_secret(&format!("node:{}", profiles[0].id))
            .unwrap()
            .expect("凭据应已写入");
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["protocol"], "shadowsocks");
        assert_eq!(value["method"], "aes-256-gcm");
        assert!(value["password"].as_str().unwrap().starts_with("pw-"));
    }
}
