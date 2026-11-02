use std::fmt;

use serde::{Deserialize, Serialize};

use crate::config::builder::{BuildInput, NodeDescriptor as ConfigNode, ProtocolConfig};
use crate::runtime::{RuntimeError, RuntimeResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeProtocol {
    #[serde(rename = "vless_reality")]
    VlessReality,
    #[serde(rename = "hysteria2")]
    Hysteria2,
}

impl NodeProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            NodeProtocol::VlessReality => "vless_reality",
            NodeProtocol::Hysteria2 => "hysteria2",
        }
    }
}

/// 列表摘要：**永远不含凭据**，可以安全进入模型上下文、日志与 UI。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeSummary {
    pub id: String,
    pub name: String,
    pub region: String,
    pub city: String,
    pub protocol: NodeProtocol,
    #[serde(default)]
    pub latency_ms: Option<u32>,
    #[serde(default)]
    pub health_score: f64,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub updated_at: String,
}

/// 详情：含凭据，**刻意不实现 `Serialize`**，只能交给 Config Builder。
#[derive(Clone, Deserialize)]
pub struct NodeDescriptor {
    #[serde(flatten)]
    pub summary: NodeSummary,
    pub server: String,
    pub server_port: u16,
    pub credentials: Credentials,
    pub tls: NodeTls,
    #[serde(default)]
    pub flow: Option<String>,
    #[serde(default)]
    pub mux: Option<Mux>,
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub enum Credentials {
    VlessReality { uuid: String },
    Hysteria2 { password: String },
}

#[derive(Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum NodeTls {
    Reality {
        server_name: String,
        utls_fingerprint: String,
        reality_public_key: String,
        #[serde(default)]
        reality_short_id: String,
    },
    Tls {
        server_name: String,
        #[serde(default)]
        utls_fingerprint: Option<String>,
    },
    Insecure {
        server_name: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct Mux {
    pub enabled: bool,
    #[serde(default)]
    pub concurrency: u32,
}

impl fmt::Debug for NodeDescriptor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NodeDescriptor")
            .field("id", &self.summary.id)
            .field("protocol", &self.summary.protocol)
            .field("server", &self.server)
            .field("server_port", &self.server_port)
            .field("credentials", &"<redacted>")
            .field("tls", &self.tls_mode())
            .finish()
    }
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Credentials::VlessReality { .. } => f.write_str("VlessReality(<redacted>)"),
            Credentials::Hysteria2 { .. } => f.write_str("Hysteria2(<redacted>)"),
        }
    }
}

impl NodeDescriptor {
    pub fn tls_mode(&self) -> &'static str {
        match self.tls {
            NodeTls::Reality { .. } => "reality",
            NodeTls::Tls { .. } => "tls",
            NodeTls::Insecure { .. } => "insecure",
        }
    }

    pub fn validate(&self) -> RuntimeResult<()> {
        let matches_protocol = matches!(
            (&self.summary.protocol, &self.credentials),
            (NodeProtocol::VlessReality, Credentials::VlessReality { .. })
                | (NodeProtocol::Hysteria2, Credentials::Hysteria2 { .. })
        );
        if !matches_protocol {
            return Err(RuntimeError::Config(
                "node protocol does not match its credentials".into(),
            ));
        }
        if let NodeTls::Reality {
            reality_public_key, ..
        } = &self.tls
        {
            if reality_public_key.trim().is_empty() {
                return Err(RuntimeError::Config(
                    "reality node is missing reality_public_key".into(),
                ));
            }
        }
        Ok(())
    }

    /// 凭据只在这里穿过边界：直接变成 Config Builder 的输入，不经过任何可序列化的中间结构。
    pub fn into_build_input(
        &self,
        mixed_port: u16,
        clash_port: u16,
        clash_secret: String,
    ) -> RuntimeResult<BuildInput> {
        self.validate()?;

        let protocol = match (&self.summary.protocol, &self.credentials, &self.tls) {
            (
                NodeProtocol::VlessReality,
                Credentials::VlessReality { uuid },
                NodeTls::Reality {
                    server_name,
                    utls_fingerprint,
                    reality_public_key,
                    reality_short_id,
                },
            ) => ProtocolConfig::VlessReality {
                uuid: uuid.clone(),
                flow: self.flow.clone(),
                server_name: server_name.clone(),
                public_key: reality_public_key.clone(),
                short_id: reality_short_id.clone(),
                fingerprint: Some(utls_fingerprint.clone()),
            },
            (NodeProtocol::VlessReality, _, _) => {
                return Err(RuntimeError::Config(
                    "P1 only supports VLESS with reality TLS".into(),
                ))
            }
            (NodeProtocol::Hysteria2, Credentials::Hysteria2 { password }, tls) => {
                let (server_name, insecure) = match tls {
                    NodeTls::Reality { server_name, .. } | NodeTls::Tls { server_name, .. } => {
                        (server_name.clone(), false)
                    }
                    NodeTls::Insecure { server_name } => (server_name.clone(), true),
                };
                ProtocolConfig::Hysteria2 {
                    password: password.clone(),
                    server_name,
                    insecure,
                }
            }
            (NodeProtocol::Hysteria2, _, _) => {
                return Err(RuntimeError::Config(
                    "hysteria2 node is missing its password".into(),
                ))
            }
        };

        Ok(BuildInput::new(
            ConfigNode {
                id: self.summary.id.clone(),
                name: self.summary.name.clone(),
                server: self.server.clone(),
                server_port: self.server_port,
                protocol,
            },
            mixed_port,
            clash_port,
            clash_secret,
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeListResponse {
    pub etag: String,
    pub nodes: Vec<NodeSummary>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub fetched_at: String,
}

/// 详情响应。刻意不实现 `Serialize`：凭据只能交给 Config Builder。
#[derive(Clone, Deserialize)]
pub struct NodeDetailResponse {
    #[serde(default)]
    pub etag: String,
    pub node: NodeDescriptor,
    #[serde(default)]
    pub fetched_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    const VLESS: &str = r#"{
        "id": "seed-jp-01", "name": "东京 01", "region": "jp", "city": "Tokyo",
        "protocol": "vless_reality", "latency_ms": 42, "health_score": 0.98,
        "tags": ["seed"], "updated_at": "2026-11-02T09:15:03Z",
        "server": "203.0.113.10", "server_port": 443,
        "credentials": { "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811" },
        "tls": { "mode": "reality", "server_name": "www.example.com",
                 "utls_fingerprint": "chrome",
                 "reality_public_key": "jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0",
                 "reality_short_id": "0123abcd" },
        "flow": "xtls-rprx-vision", "mux": null
    }"#;

    #[test]
    fn summary_ignores_credentials_the_server_might_send() {
        let summary: NodeSummary = serde_json::from_str(VLESS).unwrap();
        let text = serde_json::to_string(&summary).unwrap();
        assert!(!text.contains("uuid"));
        assert!(!text.contains("credentials"));
        assert!(!text.contains("password"));
    }

    #[test]
    fn descriptor_debug_never_prints_credentials() {
        let node: NodeDescriptor = serde_json::from_str(VLESS).unwrap();
        let text = format!("{node:?}");
        assert!(!text.contains("b831381d"));
        assert!(text.contains("<redacted>"));
    }

    #[test]
    fn vless_descriptor_becomes_a_build_input() {
        let node: NodeDescriptor = serde_json::from_str(VLESS).unwrap();
        let input = node.into_build_input(2080, 19090, "secret".into()).unwrap();
        match input.node.protocol {
            ProtocolConfig::VlessReality {
                uuid,
                server_name,
                public_key,
                short_id,
                fingerprint,
                ..
            } => {
                assert_eq!(uuid, "b831381d-6324-4d53-ad4f-8cda48b30811");
                assert_eq!(server_name, "www.example.com");
                assert!(public_key.starts_with("jNXH"));
                assert_eq!(short_id, "0123abcd");
                assert_eq!(fingerprint.as_deref(), Some("chrome"));
            }
            _ => panic!("expected a vless outbound"),
        }
    }

    #[test]
    fn hysteria2_descriptor_maps_insecure_tls() {
        let json = r#"{
            "id": "seed-sg-01", "name": "新加坡 01", "region": "sg", "city": "Singapore",
            "protocol": "hysteria2", "health_score": 1.0, "tags": [],
            "server": "198.51.100.7", "server_port": 8443,
            "credentials": { "password": "p@ss" },
            "tls": { "mode": "insecure", "server_name": "hy.example.com" }
        }"#;
        let node: NodeDescriptor = serde_json::from_str(json).unwrap();
        let input = node.into_build_input(2080, 19090, "secret".into()).unwrap();
        match input.node.protocol {
            ProtocolConfig::Hysteria2 {
                password, insecure, ..
            } => {
                assert_eq!(password, "p@ss");
                assert!(insecure);
            }
            _ => panic!("expected a hysteria2 outbound"),
        }
    }

    #[test]
    fn rejects_a_protocol_credentials_mismatch() {
        let json = r#"{
            "id": "x", "name": "x", "region": "jp", "city": "Tokyo",
            "protocol": "hysteria2", "health_score": 1.0, "tags": [],
            "server": "198.51.100.7", "server_port": 443,
            "credentials": { "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811" },
            "tls": { "mode": "tls", "server_name": "x" }
        }"#;
        let node: NodeDescriptor = serde_json::from_str(json).unwrap();
        assert!(node.validate().is_err());
    }
}
