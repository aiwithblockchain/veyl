use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));

    // 1. bundle identifier：只认**顶层**那个。之前取的是文件里第一个 `"identifier"`，
    //    一旦别处出现同名键就会取错，而取错的后果是所有 XPC 连接被拒。
    let config = manifest.join("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", config.display());
    let text = std::fs::read_to_string(&config).expect("读取 tauri.conf.json 失败");
    let identifier = top_level_identifier(&text).expect("tauri.conf.json 顶层缺少 identifier");
    println!("cargo:rustc-env=VEYL_BUNDLE_IDENTIFIER={identifier}");

    // 2. Team ID：来自签名身份，允许环境变量覆盖，但必须是合法格式。
    println!("cargo:rerun-if-env-changed=VEYL_TEAM_ID");
    let team = std::env::var("VEYL_TEAM_ID").unwrap_or_else(|_| "2XYK8RBB6M".into());
    assert!(
        is_team_id(&team),
        "VEYL_TEAM_ID 格式不对（应为 10 位大写字母数字）：{team}"
    );
    println!("cargo:rustc-env=VEYL_TEAM_ID={team}");

    // 3. 运行时的完整 sha256。helper 只认这个值，请求方说了不算。
    //    文件不存在时留空，helper 会在启动时报 runtime_missing。
    let runtime = manifest.join("resources/runtime/sing-box");
    println!("cargo:rerun-if-changed={}", runtime.display());
    let digest = match std::fs::read(&runtime) {
        Ok(bytes) => sha256_hex(&bytes),
        Err(_) => String::new(),
    };
    println!("cargo:rustc-env=VEYL_RUNTIME_SHA256={digest}");

    // 4. 规则归档的 sha256。
    //
    //    这是一个**有效的构建期绑定**：哈希编进 helper，helper 又被签名，
    //    所以构建完成之后把包里的归档换掉会被发现。
    //    但它不是「来源可信」的证明——哈希是从归档本身算的，构建期就被换掉的话验不出来。
    //    真正的信任根是签名封存 bundle + SMAppService 启动 helper 时对 helper 验签。
    let rules_dir = manifest.join("resources/rules");
    println!("cargo:rerun-if-changed={}", rules_dir.display());
    let mut rules_digest = String::new();
    if let Ok(entries) = std::fs::read_dir(&rules_dir) {
        let mut archives: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
                name.starts_with("veyl-rules-") && name.ends_with(".tar.zst")
            })
            .collect();
        archives.sort();
        if let Some(archive) = archives.pop() {
            rules_digest = std::fs::read(&archive).map(|b| sha256_hex(&b)).unwrap_or_default();
        }
    }
    println!("cargo:rustc-env=VEYL_RULES_ARCHIVE_SHA256={rules_digest}");

    tauri_build::build()
}

/// 只取顶层对象的 identifier。按大括号深度扫描，跳过字符串内容。
fn top_level_identifier(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let start = i + 1;
                let mut j = start;
                let mut escaped = false;
                while j < bytes.len() {
                    match bytes[j] {
                        _ if escaped => escaped = false,
                        b'\\' => escaped = true,
                        b'"' => break,
                        _ => {}
                    }
                    j += 1;
                }
                if depth == 1 && &text[start..j] == "identifier" {
                    let rest = &text[j + 1..];
                    let colon = rest.find(':')?;
                    let after = &rest[colon + 1..];
                    let open = after.find('"')? + 1;
                    let tail = &after[open..];
                    let end = tail.find('"')?;
                    return Some(tail[..end].to_string());
                }
                i = j + 1;
                continue;
            }
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    None
}

fn is_team_id(value: &str) -> bool {
    value.len() == 10 && value.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
