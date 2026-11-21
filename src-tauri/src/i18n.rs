//! 界面与 AI 会话的语言解析。
//!
//! **系统语言只在 Rust 这一处读**：前端拿 `app_language_get` 的 `resolved`，
//! 不自己读 OS locale。归一规则与提示词侧一致：`zh*` → `zh`，其它一律 `en`。

use std::sync::OnceLock;

/// 语言档位里「跟随系统」的存库值。
pub const SELECTED_SYSTEM: &str = "system";

/// 支持的两档语言。
pub const LANGUAGES: [&str; 2] = ["zh", "en"];

/// 档位归一：只认 `system` / `zh` / `en`，缺失或非法一律按 `system`。
pub fn normalize_selected(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("zh") => "zh",
        Some("en") => "en",
        _ => SELECTED_SYSTEM,
    }
}

/// 语言标签归一：`zh-Hans-CN`、`zh_CN.UTF-8` 都是 `zh`；其余（含空串）都是 `en`。
pub fn resolve_tag(tag: &str) -> &'static str {
    let primary = tag
        .trim()
        .split(|c: char| c == '-' || c == '_' || c == '.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if primary == "zh" {
        "zh"
    } else {
        "en"
    }
}

/// 存库档位 → 实际语言。`system` 读系统首选语言。
pub fn resolve(selected: &str) -> &'static str {
    resolve_with_tag(selected, system_language_tag())
}

/// 同 `resolve`，但系统标签由调用方注入——测试不必依赖运行环境的语言。
pub fn resolve_with_tag(selected: &str, system_tag: &str) -> &'static str {
    match normalize_selected(Some(selected)) {
        "zh" => "zh",
        "en" => "en",
        _ => resolve_tag(system_tag),
    }
}

/// 系统首选语言标签。进程内只读一次。
pub fn system_language_tag() -> &'static str {
    static TAG: OnceLock<String> = OnceLock::new();
    TAG.get_or_init(read_system_language_tag)
}

#[cfg(target_os = "macos")]
fn read_system_language_tag() -> String {
    // `defaults read -g AppleLanguages` 输出一个有序列表，第一项是首选语言：
    // (
    //     "zh-Hans-CN",
    //     "en-US"
    // )
    if let Ok(output) = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleLanguages"])
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(tag) = first_quoted(&text) {
                return tag;
            }
        }
    }
    env_language_tag()
}

#[cfg(windows)]
fn read_system_language_tag() -> String {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let preferred = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Control Panel\Desktop", KEY_READ)
        .and_then(|key| key.get_value::<Vec<String>, _>("PreferredUILanguages"))
        .ok();
    let locale = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Control Panel\International", KEY_READ)
        .and_then(|key| key.get_value::<String, _>("LocaleName"))
        .ok();
    windows_ui_language(preferred.as_deref(), locale.as_deref())
}

/// Windows 首选**显示**语言。
///
/// `Control Panel\International\LocaleName` 是区域格式（en-US + 中文界面是合法组合），
/// 不能代表界面语言；先读 `Control Panel\Desktop\PreferredUILanguages`（多字符串，
/// 第一项是首选），读不到再回落 `LocaleName`。都没有就返回空串，由 `resolve_tag`
/// 归成 `en`。
#[cfg(any(windows, test))]
fn windows_ui_language(preferred: Option<&[String]>, locale: Option<&str>) -> String {
    preferred
        .and_then(|tags| {
            tags.iter()
                .find(|tag| !tag.trim().is_empty())
                .map(|tag| tag.trim().to_string())
        })
        .or_else(|| {
            locale
                .map(str::trim)
                .filter(|tag| !tag.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn read_system_language_tag() -> String {
    env_language_tag()
}

#[cfg(not(any(unix, windows)))]
fn read_system_language_tag() -> String {
    String::new()
}

#[cfg(unix)]
fn env_language_tag() -> String {
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    String::new()
}

/// 取第一对引号里的内容：`("zh-Hans-CN", "en-US")` → `zh-Hans-CN`。
fn first_quoted(text: &str) -> Option<String> {
    let start = text.find('"')? + 1;
    let rest = &text[start..];
    let end = rest.find('"')?;
    let tag = rest[..end].trim();
    (!tag.is_empty()).then(|| tag.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 归一规则与 OS 无关：标签字符串进，`zh` / `en` 出。
    #[test]
    fn zh_tags_resolve_to_zh_and_everything_else_to_en() {
        for tag in ["zh", "zh-CN", "zh-Hans-CN", "zh_TW.UTF-8", "ZH"] {
            assert_eq!(resolve_tag(tag), "zh", "{tag}");
        }
        for tag in ["en", "en-US", "en_GB.UTF-8", "fr-FR", "ja", "", "  ", "C"] {
            assert_eq!(resolve_tag(tag), "en", "{tag}");
        }
    }

    #[test]
    fn selected_value_only_accepts_the_three_documented_values() {
        assert_eq!(normalize_selected(Some("system")), "system");
        assert_eq!(normalize_selected(Some(" zh ")), "zh");
        assert_eq!(normalize_selected(Some("en")), "en");
        assert_eq!(normalize_selected(Some("fr")), "system");
        assert_eq!(normalize_selected(Some("")), "system");
        assert_eq!(normalize_selected(None), "system");
    }

    #[test]
    fn apple_languages_output_yields_the_first_tag() {
        let output = "(\n    \"zh-Hans-CN\",\n    \"en-US\"\n)";
        assert_eq!(first_quoted(output).as_deref(), Some("zh-Hans-CN"));

        let single = "(\n    \"en-GB\"\n)";
        assert_eq!(first_quoted(single).as_deref(), Some("en-GB"));

        assert_eq!(first_quoted(""), None);
        assert_eq!(first_quoted("(\n)"), None);
    }

    /// 显式选了 zh / en 时不再碰系统语言。
    #[test]
    fn explicit_choices_are_used_as_is() {
        assert_eq!(resolve("zh"), "zh");
        assert_eq!(resolve("en"), "en");
        assert_eq!(resolve_with_tag("zh", "en-US"), "zh");
        assert_eq!(resolve_with_tag("en", "zh-CN"), "en");
    }

    /// `system` 档位按注入的系统标签解析，不依赖跑测试的机器。
    #[test]
    fn system_follows_the_injected_tag() {
        assert_eq!(resolve_with_tag("system", "zh-CN"), "zh");
        assert_eq!(resolve_with_tag("system", "ja-JP"), "en");
        assert_eq!(resolve_with_tag("", "zh-Hans"), "zh", "空档位等同 system");
    }

    /// Windows 读的是首选**显示**语言，不是区域格式。
    #[test]
    fn windows_prefers_ui_language_over_locale() {
        // 首选显示英文：即使区域是 zh-CN 也判 en。
        assert_eq!(
            windows_ui_language(Some(&["en-US".into()]), Some("zh-CN")),
            "en-US"
        );
        // 首选显示中文。
        assert_eq!(
            windows_ui_language(Some(&["zh-CN".into()]), Some("en-US")),
            "zh-CN"
        );
        // 多值取第一项。
        assert_eq!(
            windows_ui_language(
                Some(&["zh-Hans-CN".into(), "en-US".into()]),
                Some("en-US")
            ),
            "zh-Hans-CN"
        );
        // 键不存在 / 空串：回落 LocaleName，再没有就是空串（→ en）。
        assert_eq!(windows_ui_language(None, Some("zh-TW")), "zh-TW");
        assert_eq!(windows_ui_language(Some(&[]), Some("zh-TW")), "zh-TW");
        assert_eq!(windows_ui_language(None, None), "");
        assert_eq!(resolve_tag(&windows_ui_language(None, None)), "en");
    }
}
