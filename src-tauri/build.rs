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

    // 3. 运行时的完整 sha256。helper/service 只认这个值，请求方说了不算。
    //    文件不存在时留空，特权侧会在启动时报 runtime_missing。
    //
    //    哈希取的是**此刻文件里的字节**，所以打包脚本必须先给运行时签名、
    //    再开始构建：签名会改写 Mach-O，签完之后就不能再碰这个文件，
    //    否则这里算出的值与包内副本对不上，安装时会静默回退到下载。
    //
    //    Windows 的运行时是 `sing-box.exe`（不是 macOS 的 `sing-box`），
    //    TUN 还多一个 `wintun.dll`。三个哈希都编进二进制，特权侧不读用户可写目录。
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let runtime_name = if target_os == "windows" {
        "sing-box.exe"
    } else {
        "sing-box"
    };
    let runtime = manifest.join("resources/runtime").join(runtime_name);
    println!("cargo:rerun-if-changed={}", runtime.display());
    let digest = match std::fs::read(&runtime) {
        Ok(bytes) => sha256_hex(&bytes),
        Err(_) => String::new(),
    };
    println!("cargo:rustc-env=VEYL_RUNTIME_SHA256={digest}");

    let wintun = manifest.join("resources/runtime/wintun.dll");
    println!("cargo:rerun-if-changed={}", wintun.display());
    let wintun_digest = match std::fs::read(&wintun) {
        Ok(bytes) => sha256_hex(&bytes),
        Err(_) => String::new(),
    };
    println!("cargo:rustc-env=VEYL_WINTUN_SHA256={wintun_digest}");

    // Windows 签名策略：发布构建通过环境变量把允许的发布者/证书指纹编进服务。
    // 未设置时服务只接受「链有效」的签名，并在开发机上允许显式开启的未签名测试文件。
    for key in [
        "VEYL_WIN_PUBLISHER",
        "VEYL_WIN_CERT_THUMBPRINTS",
        "VEYL_WIN_ALLOW_UNSIGNED_DEV",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }

    // 4. 更新清单的 Ed25519 公钥。
    //
    //    格式 `key_id=hex[,key_id=hex]`，只放**公钥**：私钥在 CI secret 里，
    //    本地开发用 scripts/dev/update-keys.sh 生成到 ~/.veyl/dev-keys/，
    //    构建时通过同名环境变量注入。未配置时升级功能不可用（而不是跳过验签）。
    println!("cargo:rerun-if-env-changed=VEYL_UPDATE_PUBKEYS");
    println!(
        "cargo:rustc-env=VEYL_UPDATE_PUBKEYS={}",
        std::env::var("VEYL_UPDATE_PUBKEYS").unwrap_or_default()
    );

    // 5. 规则归档的 sha256。
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

    // 提示词被 include_str! 编进二进制；改了它要让 cargo 重新编译。
    let prompts = manifest.join("../resources/prompts");
    println!("cargo:rerun-if-changed={}", prompts.display());

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
