//! Logging setup and secret redaction.
//!
//! Rule: passwords and tokens never reach logs or error strings. Everything
//! that may embed a control-plane response body goes through `redact_sensitive`
//! first.

use tracing_subscriber::EnvFilter;

pub fn init(level: &str) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new(format!(
            "veyl_agent={level},rmcp=warn,reqwest=warn,hyper=warn,hyper_util=warn"
        ))
    });
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

/// Replace JSON string values for password/token fields and any `agt_…` /
/// `enr_…` token runs with `***`.
pub fn redact_sensitive(input: &str) -> String {
    let mut out = input.to_string();
    for field in ["password", "server_token", "enrollment_token", "token"] {
        out = redact_json_field(&out, field);
    }
    redact_prefixed_tokens(&out, &["agt_", "enr_"])
}

fn redact_json_field(input: &str, field: &str) -> String {
    let needle = format!("\"{field}\"");
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(i) = rest.find(&needle) {
        out.push_str(&rest[..i + needle.len()]);
        let after = &rest[i + needle.len()..];
        let Some(colon) = after.find(':') else {
            out.push_str(after);
            return out;
        };
        out.push_str(&after[..=colon]);
        let after_colon = &after[colon + 1..];
        let trimmed = after_colon.trim_start();
        out.push_str(&after_colon[..after_colon.len() - trimmed.len()]);
        if !trimmed.starts_with('"') {
            out.push_str(trimmed);
            return out;
        }
        let bytes = trimmed.as_bytes();
        let mut j = 1;
        let mut end = None;
        while j < bytes.len() {
            match bytes[j] {
                b'\\' => j += 2,
                b'"' => {
                    end = Some(j);
                    break;
                }
                _ => j += 1,
            }
        }
        match end {
            Some(j) => {
                out.push_str("\"***\"");
                rest = &trimmed[j + 1..];
            }
            None => {
                out.push_str(trimmed);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

fn is_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn redact_prefixed_tokens(input: &str, prefixes: &[&str]) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let boundary = i == 0 || !is_token_char(bytes[i - 1]);
        let prefix = boundary
            .then(|| prefixes.iter().find(|p| input[i..].starts_with(**p)))
            .flatten()
            .copied();
        if let Some(prefix) = prefix {
            let mut j = i + prefix.len();
            while j < input.len() && is_token_char(bytes[j]) {
                j += 1;
            }
            out.push_str(prefix);
            out.push_str("***");
            i = j;
        } else {
            let ch = input[i..].chars().next().expect("valid char boundary");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Char-safe truncation for error bodies.
pub fn truncate(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        input.to_string()
    } else {
        format!("{}…", input.chars().take(max_chars).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_password_and_token_fields() {
        let input = r#"{"password":"a1b2c3","server_token":"secret","port":30412}"#;
        let out = redact_sensitive(input);
        assert!(out.contains(r#""password":"***""#));
        assert!(out.contains(r#""server_token":"***""#));
        assert!(out.contains("30412"));
        assert!(!out.contains("a1b2c3"));
        assert!(!out.contains("secret"));
    }

    #[test]
    fn redacts_token_runs_even_when_key_is_unknown() {
        let out = redact_sensitive("auth failed for agt_ABC123-def and enr_xyz");
        assert_eq!(out, "auth failed for agt_*** and enr_***");
    }

    #[test]
    fn redaction_survives_nested_and_escaped_values() {
        let input = r#"{"error":"bad","desired":{"password":"p\"w","port":1}}"#;
        let out = redact_sensitive(input);
        assert!(out.contains(r#""password":"***""#));
        assert!(!out.contains("p\\\"w"));
    }

    #[test]
    fn truncate_is_char_safe() {
        assert_eq!(truncate("密码错误", 2), "密码…");
    }
}
