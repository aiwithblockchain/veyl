//! 系统代理的恢复判定。
//!
//! 看门狗（`bin/veyl-proxy-guard`）与启动恢复（`ProxyController::recover_on_startup`）
//! 必须用**同一份**判定，否则「崩溃后 2 秒」和「下次启动」会对同一份数据给出
//! 不同结论。这里只做纯判定：读当前值、比对、给结论，不碰 `networksetup`。

/// 对一份备份（租约或 `proxy_backup` 表）当前该怎么处理。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// 当前代理仍是我们写进去的端点：还原备份。
    Restored,
    /// 当前值已经是备份里的原始值：之前还原过，或压根没写成功。
    AlreadyRestored,
    /// 用户自己改过代理：绝不动，只报告。
    LeftAlone { current: Option<String> },
}

/// `current` 是现在读到的系统代理（`None` = 没有任何启用的代理），
/// `original` 是备份里记录的原始状态在同一口径下的读数，
/// `endpoint` 是我们写进去的端点（`server:port`）。
///
/// 比较只做精确相等，不做前缀/端口模糊匹配：`current` 与 `original`
/// 都由同一套「服务顺序 + HTTP → HTTPS → SOCKS」规则得出（见 `macos_wire`）。
pub fn decide(current: Option<&str>, original: Option<&str>, endpoint: &str) -> Decision {
    if current == Some(endpoint) {
        return Decision::Restored;
    }
    if current == original {
        return Decision::AlreadyRestored;
    }
    Decision::LeftAlone {
        current: current.map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_own_leftover_is_restored() {
        assert_eq!(
            decide(Some("127.0.0.1:2080"), Some("corp-proxy:8080"), "127.0.0.1:2080"),
            Decision::Restored
        );
    }

    #[test]
    fn the_original_value_means_already_restored() {
        assert_eq!(
            decide(Some("corp-proxy:8080"), Some("corp-proxy:8080"), "127.0.0.1:2080"),
            Decision::AlreadyRestored
        );
        // 原本就没有代理，现在也没有：同样已经恢复。
        assert_eq!(
            decide(None, None, "127.0.0.1:2080"),
            Decision::AlreadyRestored
        );
    }

    #[test]
    fn something_else_is_left_alone() {
        assert_eq!(
            decide(Some("user-proxy:3128"), Some("corp-proxy:8080"), "127.0.0.1:2080"),
            Decision::LeftAlone {
                current: Some("user-proxy:3128".into())
            }
        );
        // 用户把代理整个关掉了：也不能替他改回去。
        assert_eq!(
            decide(None, Some("corp-proxy:8080"), "127.0.0.1:2080"),
            Decision::LeftAlone { current: None }
        );
    }

    #[test]
    fn an_endpoint_that_is_not_ours_is_not_restored() {
        // 别人的 127.0.0.1:2080 也算「用户自己设的」，只有精确命中才动。
        assert_eq!(
            decide(Some("127.0.0.1:2080"), None, "127.0.0.1:2081"),
            Decision::LeftAlone {
                current: Some("127.0.0.1:2080".into())
            }
        );
    }
}
