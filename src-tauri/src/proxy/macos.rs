use std::process::Command;

use serde::{Deserialize, Serialize};

use super::PlatformProxy;
use crate::runtime::{RuntimeError, RuntimeResult};

pub struct MacProxy;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Setting {
    pub enabled: bool,
    pub server: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceState {
    pub service: String,
    pub http: Setting,
    pub https: Setting,
    pub socks: Setting,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MacPayload {
    pub services: Vec<ServiceState>,
}

#[derive(Clone, Copy)]
enum Kind {
    Http,
    Https,
    Socks,
}

impl Kind {
    fn get_arg(self) -> &'static str {
        match self {
            Kind::Http => "-getwebproxy",
            Kind::Https => "-getsecurewebproxy",
            Kind::Socks => "-getsocksfirewallproxy",
        }
    }

    fn set_arg(self) -> &'static str {
        match self {
            Kind::Http => "-setwebproxy",
            Kind::Https => "-setsecurewebproxy",
            Kind::Socks => "-setsocksfirewallproxy",
        }
    }

    fn state_arg(self) -> &'static str {
        match self {
            Kind::Http => "-setwebproxystate",
            Kind::Https => "-setsecurewebproxystate",
            Kind::Socks => "-setsocksfirewallproxystate",
        }
    }
}

impl PlatformProxy for MacProxy {
    fn platform(&self) -> &'static str {
        "macos"
    }

    fn capture(&self) -> RuntimeResult<serde_json::Value> {
        let mut services = Vec::new();
        for service in list_services()? {
            services.push(ServiceState {
                http: read(&service, Kind::Http)?,
                https: read(&service, Kind::Https)?,
                socks: read(&service, Kind::Socks)?,
                service,
            });
        }
        serde_json::to_value(MacPayload { services })
            .map_err(|e| RuntimeError::Proxy(format!("serialize macOS proxy backup: {e}")))
    }

    fn apply(&self, port: u16) -> RuntimeResult<()> {
        for service in list_services()? {
            for kind in [Kind::Http, Kind::Https, Kind::Socks] {
                write(&service, kind, "127.0.0.1", port)?;
            }
        }
        Ok(())
    }

    fn restore(&self, payload: &serde_json::Value) -> RuntimeResult<()> {
        let payload: MacPayload = serde_json::from_value(payload.clone())
            .map_err(|e| RuntimeError::Proxy(format!("parse macOS proxy backup: {e}")))?;
        for state in payload.services {
            restore_one(&state.service, Kind::Http, &state.http)?;
            restore_one(&state.service, Kind::Https, &state.https)?;
            restore_one(&state.service, Kind::Socks, &state.socks)?;
        }
        Ok(())
    }

    fn current(&self) -> RuntimeResult<Option<String>> {
        for service in list_services()? {
            for kind in [Kind::Http, Kind::Https, Kind::Socks] {
                let setting = read(&service, kind)?;
                if setting.enabled && setting.port != 0 {
                    return Ok(Some(format!("{}:{}", setting.server, setting.port)));
                }
            }
        }
        Ok(None)
    }
}

fn list_services() -> RuntimeResult<Vec<String>> {
    let output = run(&["-listallnetworkservices"])?;
    let services: Vec<String> = output
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.contains("denotes that a network service is disabled")
                && !line.starts_with('*')
        })
        .map(str::to_string)
        .collect();

    if services.is_empty() {
        return Err(RuntimeError::Proxy(
            "networksetup reported no enabled network services".into(),
        ));
    }
    Ok(services)
}

fn read(service: &str, kind: Kind) -> RuntimeResult<Setting> {
    let output = run(&[kind.get_arg(), service])?;
    let mut setting = Setting {
        enabled: false,
        server: String::new(),
        port: 0,
    };
    for line in output.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("Enabled:") {
            setting.enabled = value.trim().eq_ignore_ascii_case("yes");
        } else if let Some(value) = line.strip_prefix("Server:") {
            setting.server = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("Port:") {
            setting.port = value.trim().parse().unwrap_or(0);
        }
    }
    Ok(setting)
}

fn write(service: &str, kind: Kind, server: &str, port: u16) -> RuntimeResult<()> {
    run(&[kind.set_arg(), service, server, &port.to_string()])?;
    run(&[kind.state_arg(), service, "on"])?;
    Ok(())
}

fn restore_one(service: &str, kind: Kind, setting: &Setting) -> RuntimeResult<()> {
    if setting.enabled && !setting.server.is_empty() && setting.port != 0 {
        write(service, kind, &setting.server, setting.port)
    } else {
        run(&[kind.state_arg(), service, "off"])?;
        Ok(())
    }
}

fn run(args: &[&str]) -> RuntimeResult<String> {
    let output = Command::new("/usr/sbin/networksetup")
        .args(args)
        .output()
        .or_else(|_| Command::new("networksetup").args(args).output())
        .map_err(|e| RuntimeError::Proxy(format!("failed to run networksetup: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if stderr.is_empty() { &stdout } else { &stderr };

    if !output.status.success() || stdout.starts_with("** Error") {
        return Err(explain(args.first().copied().unwrap_or("networksetup"), detail));
    }
    Ok(stdout)
}

fn explain(command: &str, detail: &str) -> RuntimeError {
    let lowered = detail.to_ascii_lowercase();
    if lowered.contains("not authorized")
        || lowered.contains("must be root")
        || lowered.contains("operation not permitted")
    {
        return RuntimeError::Proxy(format!(
            "networksetup {command} needs administrator rights: {detail}"
        ));
    }
    RuntimeError::Proxy(format!("networksetup {command} failed: {detail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_proxy_block() {
        let text = "Enabled: Yes\nServer: 127.0.0.1\nPort: 2080\nAuthenticated Proxy Enabled: 0";
        let mut setting = Setting {
            enabled: false,
            server: String::new(),
            port: 0,
        };
        for line in text.lines() {
            if let Some(value) = line.strip_prefix("Enabled:") {
                setting.enabled = value.trim().eq_ignore_ascii_case("yes");
            } else if let Some(value) = line.strip_prefix("Server:") {
                setting.server = value.trim().into();
            } else if let Some(value) = line.strip_prefix("Port:") {
                setting.port = value.trim().parse().unwrap_or(0);
            }
        }
        assert_eq!(
            setting,
            Setting {
                enabled: true,
                server: "127.0.0.1".into(),
                port: 2080
            }
        );
    }
}
