use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::runtime::{RuntimeError, RuntimeResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeDescriptor {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub server: String,
    pub server_port: u16,
    pub protocol: ProtocolConfig,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProtocolConfig {
    VlessReality {
        uuid: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        flow: Option<String>,
        server_name: String,
        public_key: String,
        short_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fingerprint: Option<String>,
    },
    Hysteria2 {
        password: String,
        server_name: String,
        #[serde(default)]
        insecure: bool,
    },
}

#[derive(Clone)]
pub struct BuildInput {
    pub node: NodeDescriptor,
    pub mixed_port: u16,
    pub clash_port: u16,
    pub clash_secret: String,
    pub log_level: String,
}

impl std::fmt::Debug for BuildInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BuildInput")
            .field("node", &self.node)
            .field("mixed_port", &self.mixed_port)
            .field("clash_port", &self.clash_port)
            .field("clash_secret", &"<redacted>")
            .field("log_level", &self.log_level)
            .finish()
    }
}

impl std::fmt::Debug for ProtocolConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProtocolConfig::VlessReality { server_name, .. } => f
                .debug_struct("VlessReality")
                .field("server_name", server_name)
                .field("uuid", &"<redacted>")
                .finish(),
            ProtocolConfig::Hysteria2 { server_name, .. } => f
                .debug_struct("Hysteria2")
                .field("server_name", server_name)
                .field("password", &"<redacted>")
                .finish(),
        }
    }
}

impl BuildInput {
    pub fn new(node: NodeDescriptor, mixed_port: u16, clash_port: u16, clash_secret: String) -> Self {
        Self {
            node,
            mixed_port,
            clash_port,
            clash_secret,
            log_level: "info".into(),
        }
    }
}

/// 生成客户端配置。节点字段来自目录服务，按不可信输入处理。
pub fn build(input: &BuildInput) -> RuntimeResult<Value> {
    validate_port(input.mixed_port, "mixed_port")?;
    validate_port(input.clash_port, "clash_port")?;
    if input.mixed_port == input.clash_port {
        return Err(RuntimeError::Config(
            "mixed_port and clash_port must differ".into(),
        ));
    }
    if input.clash_secret.trim().is_empty() {
        return Err(RuntimeError::Config("clash secret must not be empty".into()));
    }
    validate_server(&input.node.server)?;
    validate_port(input.node.server_port, "server_port")?;

    let outbound = match &input.node.protocol {
        ProtocolConfig::VlessReality {
            uuid,
            flow,
            server_name,
            public_key,
            short_id,
            fingerprint,
        } => {
            require(uuid, "uuid")?;
            require(server_name, "server_name")?;
            require(public_key, "public_key")?;
            let mut outbound = json!({
                "type": "vless",
                "tag": PROXY_TAG,
                "server": input.node.server,
                "server_port": input.node.server_port,
                "uuid": uuid,
                "tls": {
                    "enabled": true,
                    "server_name": server_name,
                    "utls": {
                        "enabled": true,
                        "fingerprint": fingerprint.clone().unwrap_or_else(|| "chrome".into()),
                    },
                    "reality": {
                        "enabled": true,
                        "public_key": public_key,
                        "short_id": short_id,
                    },
                },
            });
            if let Some(flow) = flow {
                if !flow.trim().is_empty() {
                    outbound["flow"] = json!(flow);
                }
            }
            outbound
        }
        ProtocolConfig::Hysteria2 {
            password,
            server_name,
            insecure,
        } => {
            require(password, "password")?;
            require(server_name, "server_name")?;
            json!({
                "type": "hysteria2",
                "tag": PROXY_TAG,
                "server": input.node.server,
                "server_port": input.node.server_port,
                "password": password,
                "tls": {
                    "enabled": true,
                    "server_name": server_name,
                    "insecure": insecure,
                },
            })
        }
    };

    Ok(json!({
        "log": {
            "level": input.log_level,
            "timestamp": true,
        },
        "inbounds": [{
            "type": "mixed",
            "tag": "mixed-in",
            "listen": "127.0.0.1",
            "listen_port": input.mixed_port,
        }],
        "outbounds": [
            outbound,
            { "type": "direct", "tag": "direct" },
        ],
        "route": { "final": PROXY_TAG },
        "experimental": {
            "clash_api": {
                "external_controller": format!("127.0.0.1:{}", input.clash_port),
                "secret": input.clash_secret,
            }
        },
    }))
}

pub const PROXY_TAG: &str = "proxy";

fn validate_port(port: u16, field: &str) -> RuntimeResult<()> {
    if port == 0 {
        return Err(RuntimeError::Config(format!("{field} must not be zero")));
    }
    Ok(())
}

fn require(value: &str, field: &str) -> RuntimeResult<()> {
    if value.trim().is_empty() {
        return Err(RuntimeError::Config(format!("{field} must not be empty")));
    }
    Ok(())
}

fn validate_server(server: &str) -> RuntimeResult<()> {
    if server.is_empty() || server.len() > 253 {
        return Err(RuntimeError::Config("server host is invalid".into()));
    }
    if server.contains("://") {
        return Err(RuntimeError::Config(
            "server must be a bare host, not a URL".into(),
        ));
    }
    if server
        .chars()
        .any(|c| c.is_whitespace() || c == '/' || c == '\\' || c.is_control())
    {
        return Err(RuntimeError::Config(
            "server host contains illegal characters".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vless_node() -> NodeDescriptor {
        NodeDescriptor {
            id: "jp-01".into(),
            name: "东京 01".into(),
            server: "203.0.113.10".into(),
            server_port: 443,
            protocol: ProtocolConfig::VlessReality {
                uuid: "00000000-0000-0000-0000-000000000000".into(),
                flow: Some("xtls-rprx-vision".into()),
                server_name: "www.example.com".into(),
                public_key: "PUBLIC_KEY".into(),
                short_id: "ab12".into(),
                fingerprint: None,
            },
        }
    }

    fn input(node: NodeDescriptor) -> BuildInput {
        BuildInput::new(node, 2080, 19090, "secret".into())
    }

    #[test]
    fn vless_reality_shape_matches_the_template() {
        let config = build(&input(vless_node())).unwrap();
        assert_eq!(config["inbounds"][0]["listen"], "127.0.0.1");
        assert_eq!(config["inbounds"][0]["listen_port"], 2080);
        assert_eq!(config["route"]["final"], "proxy");
        assert_eq!(config["outbounds"][0]["type"], "vless");
        assert_eq!(config["outbounds"][0]["tls"]["reality"]["enabled"], true);
        assert_eq!(
            config["outbounds"][0]["tls"]["utls"]["fingerprint"],
            "chrome"
        );
        assert_eq!(
            config["experimental"]["clash_api"]["external_controller"],
            "127.0.0.1:19090"
        );
        assert_eq!(config["experimental"]["clash_api"]["secret"], "secret");
    }

    #[test]
    fn hysteria2_shape_matches_the_template() {
        let node = NodeDescriptor {
            id: "sg-01".into(),
            name: String::new(),
            server: "198.51.100.7".into(),
            server_port: 8443,
            protocol: ProtocolConfig::Hysteria2 {
                password: "pass".into(),
                server_name: "hy.example.com".into(),
                insecure: false,
            },
        };
        let config = build(&input(node)).unwrap();
        assert_eq!(config["outbounds"][0]["type"], "hysteria2");
        assert_eq!(config["outbounds"][0]["tls"]["enabled"], true);
        assert_eq!(config["outbounds"][0]["tls"]["server_name"], "hy.example.com");
    }

    #[test]
    fn rejects_a_url_in_the_server_field() {
        let mut node = vless_node();
        node.server = "https://evil.example.com".into();
        assert!(build(&input(node)).is_err());
    }

    #[test]
    fn rejects_port_collision_between_inbound_and_clash() {
        let node = vless_node();
        let err = build(&BuildInput::new(node, 2080, 2080, "s".into())).unwrap_err();
        assert!(matches!(err, RuntimeError::Config(_)));
    }

    #[test]
    fn never_embeds_the_display_name() {
        let config = build(&input(vless_node())).unwrap();
        let text = serde_json::to_string(&config).unwrap();
        assert!(!text.contains("东京"));
    }

    #[test]
    fn debug_output_redacts_credentials() {
        let text = format!("{:?}", input(vless_node()));
        assert!(!text.contains("00000000-0000-0000-0000-000000000000"));
        assert!(!text.contains("\"secret\""));
        assert!(text.contains("<redacted>"));
    }
}
