//! 控制面环境判定：dev / prod 两个 Worker，解析顺序固定且不依赖网络。
//!
//! 优先级：URL 覆盖 > 环境覆盖 > 编译期 debug 标志。
//! **release 构建只认 Prod**：环境变量不能把它骗到测试端点。

pub const DEV_URL: &str = "https://veyl-control-plane-dev.ribencong.workers.dev";
pub const PROD_URL: &str = "https://veyl-control-plane.ribencong.workers.dev";

pub const ENV_VAR: &str = "VEYL_CONTROL_PLANE_ENV";
pub const URL_VAR: &str = "VEYL_CONTROL_PLANE_URL";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlPlaneEnv {
    Dev,
    Prod,
}

/// 这次解析实际用了哪一层。只用于日志，便于排查「连到了哪个环境」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sources {
    Default,
    EnvOverride,
    UrlOverride,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub env: ControlPlaneEnv,
    pub base_url: String,
    pub source: Sources,
}

impl Resolved {
    fn new(env: ControlPlaneEnv, base_url: impl Into<String>, source: Sources) -> Self {
        Self {
            env,
            base_url: base_url.into(),
            source,
        }
    }
}

fn parse_env(value: &str) -> Option<ControlPlaneEnv> {
    match value.trim().to_ascii_lowercase().as_str() {
        "dev" => Some(ControlPlaneEnv::Dev),
        "production" => Some(ControlPlaneEnv::Prod),
        _ => None,
    }
}

/// 只接受非空的 `https://` URL；空白字符一律拒绝（防止把 `https://a b` 传给 HTTP 层）。
fn valid_https(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    let rest = trimmed.strip_prefix("https://")?;
    if rest.is_empty() || rest.chars().any(char::is_whitespace) {
        return None;
    }
    Some(trimmed)
}

/// 纯函数：输入编译期标志与两个覆盖值，返回最终环境。
///
/// - `debug == false` 时，`env_override = "dev"` 被忽略；
/// - `url_override` 只在 debug 构建生效；
/// - URL 必须是 `https://` 开头且非空，否则忽略。
pub fn resolve(
    debug: bool,
    env_override: Option<&str>,
    url_override: Option<&str>,
) -> Resolved {
    let default_env = if debug {
        ControlPlaneEnv::Dev
    } else {
        ControlPlaneEnv::Prod
    };

    let mut env_source = Sources::Default;
    let mut env = default_env;
    if let Some(parsed) = env_override.and_then(parse_env) {
        // release 不能被环境变量骗到测试端点；production 与默认一致，照常记录来源。
        if debug || parsed != ControlPlaneEnv::Dev {
            env = parsed;
            env_source = Sources::EnvOverride;
        }
    }

    if debug {
        if let Some(url) = url_override.and_then(valid_https) {
            return Resolved::new(env, url, Sources::UrlOverride);
        }
    }

    let base_url = match env {
        ControlPlaneEnv::Dev => DEV_URL,
        ControlPlaneEnv::Prod => PROD_URL,
    };
    Resolved::new(env, base_url, env_source)
}

/// 读编译期标志与 `VEYL_CONTROL_PLANE_ENV` / `VEYL_CONTROL_PLANE_URL`。
pub fn current() -> Resolved {
    let env = std::env::var(ENV_VAR).ok();
    let url = std::env::var(URL_VAR).ok();
    resolve(cfg!(debug_assertions), env.as_deref(), url.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_defaults_to_dev() {
        let resolved = resolve(true, None, None);
        assert_eq!(resolved.env, ControlPlaneEnv::Dev);
        assert_eq!(resolved.base_url, DEV_URL);
        assert_eq!(resolved.source, Sources::Default);
    }

    #[test]
    fn release_defaults_to_prod() {
        let resolved = resolve(false, None, None);
        assert_eq!(resolved.env, ControlPlaneEnv::Prod);
        assert_eq!(resolved.base_url, PROD_URL);
        assert_eq!(resolved.source, Sources::Default);
    }

    #[test]
    fn debug_can_switch_to_production() {
        let resolved = resolve(true, Some("production"), None);
        assert_eq!(resolved.env, ControlPlaneEnv::Prod);
        assert_eq!(resolved.base_url, PROD_URL);
        assert_eq!(resolved.source, Sources::EnvOverride);
    }

    #[test]
    fn release_ignores_a_dev_override() {
        let resolved = resolve(false, Some("dev"), None);
        assert_eq!(resolved.env, ControlPlaneEnv::Prod, "release 不能被骗到测试端点");
        assert_eq!(resolved.base_url, PROD_URL);
        assert_eq!(resolved.source, Sources::Default);
    }

    #[test]
    fn release_accepts_a_redundant_production_override() {
        let resolved = resolve(false, Some("PRODUCTION"), None);
        assert_eq!(resolved.env, ControlPlaneEnv::Prod);
        assert_eq!(resolved.source, Sources::EnvOverride);
    }

    #[test]
    fn env_values_are_case_insensitive_and_trimmed() {
        assert_eq!(
            resolve(true, Some("  DeV  "), None).env,
            ControlPlaneEnv::Dev
        );
        assert_eq!(
            resolve(true, Some("Production\n"), None).env,
            ControlPlaneEnv::Prod
        );
        assert_eq!(
            resolve(true, Some("PRODUCTION"), None).env,
            ControlPlaneEnv::Prod
        );
    }

    #[test]
    fn invalid_env_values_are_ignored() {
        for value in ["", "staging", "devops", "1", "prod", "production-ish"] {
            let resolved = resolve(true, Some(value), None);
            assert_eq!(resolved.env, ControlPlaneEnv::Dev, "{value:?}");
            assert_eq!(resolved.source, Sources::Default, "{value:?}");
        }
    }

    #[test]
    fn a_debug_url_override_wins_over_everything() {
        let resolved = resolve(true, Some("production"), Some("https://example.test/api"));
        assert_eq!(resolved.env, ControlPlaneEnv::Prod, "env 覆盖仍然生效");
        assert_eq!(resolved.base_url, "https://example.test/api");
        assert_eq!(resolved.source, Sources::UrlOverride);

        // 没有 env 覆盖时，env 保持 debug 默认的 Dev。
        let resolved = resolve(true, None, Some("https://example.test"));
        assert_eq!(resolved.env, ControlPlaneEnv::Dev);
        assert_eq!(resolved.base_url, "https://example.test");
        assert_eq!(resolved.source, Sources::UrlOverride);
    }

    #[test]
    fn a_release_url_override_is_ignored() {
        let resolved = resolve(false, None, Some("https://example.test"));
        assert_eq!(resolved.env, ControlPlaneEnv::Prod);
        assert_eq!(resolved.base_url, PROD_URL);
        assert_eq!(resolved.source, Sources::Default);
    }

    #[test]
    fn a_non_https_or_empty_url_is_ignored() {
        for value in [
            "",
            "   ",
            "http://example.test",
            "https://",
            "https://exa mple.test",
            "example.test",
        ] {
            let resolved = resolve(true, None, Some(value));
            assert_eq!(resolved.base_url, DEV_URL, "{value:?}");
            assert_eq!(resolved.source, Sources::Default, "{value:?}");
        }
    }
}
