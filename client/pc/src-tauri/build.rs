//! 把构建期事实注入编译：bundle id、Team、随包 runtime 与规则归档的哈希。
//!
//! 共享 crate 读不到依赖方 build script 的 `cargo:rustc-env`，所以这些值在本包
//! 里编好，再由 `tun_identity.rs` 组装成 `veyl_tun::identity::Identity`。
//!
//! 产物缺失不阻断编译（M1-A 的界面与导入不依赖它们），但会打 `cargo:warning`，
//! 并且连接时 helper 会以 `runtime_missing` / `rule_set_missing` 明确报错。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const DEFAULT_TEAM_ID: &str = "2XYK8RBB6M";

fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=resources/runtime/sing-box");
    println!("cargo:rerun-if-changed=resources/rules");
    println!("cargo:rerun-if-env-changed=VEYL_TEAM_ID");

    let identifier = read_identifier().expect("tauri.conf.json 里必须有一个顶层 identifier");
    println!("cargo:rustc-env=VEYL_BUNDLE_IDENTIFIER={identifier}");

    let team_id = env::var("VEYL_TEAM_ID").unwrap_or_else(|_| DEFAULT_TEAM_ID.to_string());
    assert!(
        team_id.len() == 10 && team_id.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()),
        "VEYL_TEAM_ID 必须是 10 位大写字母或数字：{team_id}"
    );
    println!("cargo:rustc-env=VEYL_TEAM_ID={team_id}");

    let runtime_sha = match sha256_file(Path::new("resources/runtime/sing-box")) {
        Some(digest) => digest,
        None => {
            println!(
                "cargo:warning=resources/runtime/sing-box 不存在：这次构建没有随包运行时，TUN 连接会报 runtime_missing"
            );
            String::new()
        }
    };
    println!("cargo:rustc-env=VEYL_RUNTIME_SHA256={runtime_sha}");

    let rules_sha = match newest_rules_archive() {
        Some(path) => sha256_file(&path).unwrap_or_default(),
        None => {
            println!(
                "cargo:warning=resources/rules/ 下没有 veyl-rules-*.tar.zst：订阅里的规则集会缺失，连接会报 rule_set_missing"
            );
            String::new()
        }
    };
    println!("cargo:rustc-env=VEYL_RULES_ARCHIVE_SHA256={rules_sha}");

    tauri_build::build();
}

fn read_identifier() -> Option<String> {
    let text = fs::read_to_string("tauri.conf.json").ok()?;
    let key = "\"identifier\"";
    let after = &text[text.find(key)? + key.len()..];
    let after = &after[after.find(':')? + 1..];
    let start = after.find('"')? + 1;
    let end = start + after[start..].find('"')?;
    Some(after[start..end].to_string())
}

fn newest_rules_archive() -> Option<PathBuf> {
    let dir = Path::new("resources/rules");
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let name = path.file_name()?.to_string_lossy().into_owned();
        if !(name.starts_with("veyl-rules-") && name.ends_with(".tar.zst")) {
            continue;
        }
        let modified = entry.metadata().ok()?.modified().ok()?;
        if newest.as_ref().map(|(time, _)| modified > *time).unwrap_or(true) {
            newest = Some((modified, path));
        }
    }
    newest.map(|(_, path)| path)
}

fn sha256_file(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let digest = Sha256::digest(&bytes);
    Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}
