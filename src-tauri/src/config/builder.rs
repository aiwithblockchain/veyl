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
    Shadowsocks {
        password: String,
        method: String,
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
            ProtocolConfig::Shadowsocks { method, .. } => f
                .debug_struct("Shadowsocks")
                .field("method", method)
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
        ProtocolConfig::Shadowsocks { password, method } => {
            require(password, "password")?;
            require(method, "method")?;
            if !crate::catalog::SUPPORTED_METHODS.contains(&method.as_str()) {
                return Err(RuntimeError::Unsupported {
                    message: format!("shadowsocks method {method} is not supported"),
                    details: serde_json::json!({
                        "method": method,
                        "supported": crate::catalog::SUPPORTED_METHODS,
                    }),
                });
            }
            json!({
                "type": "shadowsocks",
                "tag": PROXY_TAG,
                "server": input.node.server,
                "server_port": input.node.server_port,
                "method": method,
                "password": password,
            })
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
    fn shadowsocks_outbound_matches_the_template() {
        let node = NodeDescriptor {
            id: "seed-hk-01".into(),
            name: "香港 01".into(),
            server: "198.51.100.9".into(),
            server_port: 8388,
            protocol: ProtocolConfig::Shadowsocks {
                password: "p@ss".into(),
                method: "aes-256-gcm".into(),
            },
        };
        let config = build(&input(node)).unwrap();
        assert_eq!(config["outbounds"][0]["type"], "shadowsocks");
        assert_eq!(config["outbounds"][0]["method"], "aes-256-gcm");
        assert_eq!(config["outbounds"][0]["server_port"], 8388);
        assert_eq!(config["outbounds"][0]["password"], "p@ss");
        // shadowsocks 没有 TLS 块。
        assert!(config["outbounds"][0].get("tls").is_none());
    }

    #[test]
    fn an_unsupported_shadowsocks_method_is_rejected() {
        let node = NodeDescriptor {
            id: "seed-hk-01".into(),
            name: "香港 01".into(),
            server: "198.51.100.9".into(),
            server_port: 8388,
            protocol: ProtocolConfig::Shadowsocks {
                password: "p@ss".into(),
                method: "rc4-md5".into(),
            },
        };
        let error = build(&input(node)).unwrap_err();
        assert_eq!(error.code(), "UNSUPPORTED");
    }

    #[test]
    fn shadowsocks_debug_output_redacts_the_password() {
        let node = NodeDescriptor {
            id: "seed-hk-01".into(),
            name: "香港 01".into(),
            server: "198.51.100.9".into(),
            server_port: 8388,
            protocol: ProtocolConfig::Shadowsocks {
                password: "p@ss".into(),
                method: "aes-256-gcm".into(),
            },
        };
        let text = format!("{:?}", input(node));
        assert!(!text.contains("p@ss"), "{text}");
        assert!(text.contains("<redacted>"), "{text}");
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

/// 补充的负向用例：已有模块覆盖了结构形状与端口冲突，
/// 这里补「关键字段缺失」和「产品标识不落配置」两类——
/// 前者是 `sing-box check` 拦不住的（它只做 schema 校验）。
#[cfg(test)]
mod negative_tests {
    use super::*;

    fn node_with(protocol: ProtocolConfig) -> NodeDescriptor {
        NodeDescriptor {
            id: "jp-01".into(),
            name: "东京 01".into(),
            server: "203.0.113.10".into(),
            server_port: 443,
            protocol,
        }
    }

    fn vless_protocol() -> ProtocolConfig {
        ProtocolConfig::VlessReality {
            uuid: "00000000-0000-0000-0000-000000000000".into(),
            flow: Some("xtls-rprx-vision".into()),
            server_name: "www.example.com".into(),
            public_key: "PUBLIC_KEY".into(),
            short_id: "ab12".into(),
            fingerprint: None,
        }
    }

    #[test]
    fn rejects_empty_uuid_before_sing_box_check() {
        // TC-CFG-003：实测 `sing-box check` 会放过缺 uuid 的 vless 出站，
        // 所以生成阶段必须自己拦住。
        let mut protocol = vless_protocol();
        if let ProtocolConfig::VlessReality { uuid, .. } = &mut protocol {
            *uuid = String::new();
        }
        let error = build(&BuildInput::new(
            node_with(protocol),
            2080,
            19090,
            "secret".into(),
        ))
        .expect_err("缺 uuid 必须在生成阶段报错");
        assert!(format!("{error}").contains("uuid"), "错误信息应指向 uuid");
    }

    #[test]
    fn rejects_blank_public_key() {
        let mut protocol = vless_protocol();
        if let ProtocolConfig::VlessReality { public_key, .. } = &mut protocol {
            *public_key = "   ".into();
        }
        assert!(build(&BuildInput::new(
            node_with(protocol),
            2080,
            19090,
            "secret".into()
        ))
        .is_err());
    }

    #[test]
    fn rejects_zero_ports_and_blank_secret() {
        assert!(build(&BuildInput::new(node_with(vless_protocol()), 0, 19090, "s".into())).is_err());
        assert!(build(&BuildInput::new(node_with(vless_protocol()), 2080, 0, "s".into())).is_err());
        assert!(
            build(&BuildInput::new(node_with(vless_protocol()), 2080, 19090, "  ".into())).is_err(),
            "空 clash secret 必须拒绝"
        );
    }

    #[test]
    fn config_contains_no_product_identity() {
        // TC-CFG-006：配置里不得出现我们的标识或遥测字段。
        let config = build(&BuildInput::new(
            node_with(vless_protocol()),
            2080,
            19090,
            "secret".into(),
        ))
        .unwrap();
        let text = serde_json::to_string(&config).unwrap();
        for needle in ["veyl", "Veyl", "aivpn", "AIVPN", "telemetry", "device_id"] {
            assert!(!text.contains(needle), "配置里不应出现 {needle}");
        }
        assert!(!text.contains("东京 01"), "节点名称不应写进配置");
    }
}
