//! 规则数据：随包归档、运行时解压、版本状态与分类目录。
//!
//! 归档由 `scripts/rules/fetch-rules.mjs` 生成，放到 `src-tauri/resources/rules/`，
//! Tauri 打包时随安装包；首次启动解压到 `app_data/rules/<version>/`。
//! 规则文件不进数据库，`rules_state` 只记元数据。

pub mod plan;

use std::fs::File;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::store::{self, rules_state::RulesState, Store};

pub const RULES_DIR_NAME: &str = "rules";

/// 地区判定（H1 系统区域）。当前先读环境变量，缺失时回落到 `cn`；
/// UI 接上系统区域后改为传入。
pub fn detected_region() -> Option<String> {
    if let Ok(region) = std::env::var("VEYL_REGION") {
        let region = region.trim().to_ascii_lowercase();
        if !region.is_empty() {
            return Some(region);
        }
    }
    let locale = std::env::var("LANG").ok()?;
    let locale = locale.split(['.', '@']).next().unwrap_or(&locale);
    let region = locale.split(['_', '-']).nth(1)?;
    if region.len() >= 2 {
        Some(region[..2].to_ascii_lowercase())
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestSource {
    #[serde(default)]
    pub geosite_tag: Option<String>,
    #[serde(default)]
    pub geoip_tag: Option<String>,
    #[serde(default)]
    pub geosite_commit_date: Option<String>,
    #[serde(default)]
    pub geoip_commit_date: Option<String>,
    #[serde(default)]
    pub fetched_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestItem {
    pub id: String,
    pub kind: String,
    pub file: String,
    pub sha256: String,
    pub bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RulesManifest {
    pub schema: i64,
    pub version: String,
    pub source: ManifestSource,
    pub items: Vec<ManifestItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name_zh: String,
    pub name_en: String,
    pub description: String,
    /// 底层域名条数。`.srs` 是二进制，推导不出来；0 表示「未知」，不是「空分类」。
    #[serde(default)]
    pub item_count: i64,
    pub rule_sets: Vec<String>,
    #[serde(default)]
    pub dns_classifiable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoriesFile {
    pub schema: i64,
    pub version: String,
    pub categories: Vec<Category>,
}

#[derive(Debug, Clone)]
pub struct InstalledRules {
    pub root: PathBuf,
    pub manifest: RulesManifest,
    pub categories: Vec<Category>,
}

impl InstalledRules {
    pub fn rule_set(&self, id: &str) -> Option<&ManifestItem> {
        self.manifest.items.iter().find(|item| item.id == id)
    }

    pub fn rule_set_path(&self, id: &str) -> Option<PathBuf> {
        self.rule_set(id).map(|item| self.root.join(&item.file))
    }

    pub fn category(&self, id: &str) -> Option<&Category> {
        self.categories.iter().find(|category| category.id == id)
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn archive_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("veyl-rules-") && name.ends_with(".tar.zst"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}

/// 找一个随包归档。优先环境变量（调试/测试），再找 Tauri 资源目录与开发目录。
pub fn bundled_archive(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("VEYL_RULES_ARCHIVE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    let mut dirs = Vec::new();
    if let Some(resource_dir) = resource_dir {
        dirs.push(resource_dir.join("resources").join(RULES_DIR_NAME));
        dirs.push(resource_dir.join(RULES_DIR_NAME));
    }
    dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(RULES_DIR_NAME));

    for dir in dirs {
        if let Some(archive) = archive_files(&dir).pop() {
            return Some(archive);
        }
    }
    None
}

pub fn bundled_version(archive: &Path) -> Option<String> {
    let name = archive.file_name()?.to_str()?;
    name.strip_prefix("veyl-rules-")?
        .strip_suffix(".tar.zst")
        .map(str::to_string)
}

/// 校验归档整包 sha256（SOURCE.txt 记录），防止归档被替换。
fn verify_archive_hash(archive: &Path) -> Result<(), String> {
    let bytes = std::fs::read(archive).map_err(|error| format!("读取规则归档失败：{error}"))?;
    let actual = sha256_hex(&bytes);
    let source_path = archive
        .parent()
        .map(|parent| parent.join("SOURCE.txt"))
        .ok_or_else(|| "规则归档没有父目录".to_string())?;
    let source =
        std::fs::read_to_string(&source_path).map_err(|error| format!("读取 SOURCE.txt 失败：{error}"))?;
    let recorded = source
        .lines()
        .find_map(|line| line.strip_prefix("archive_sha256:"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "SOURCE.txt 缺少 archive_sha256".to_string())?;
    if recorded != actual {
        return Err(format!(
            "规则归档 sha256 不匹配：SOURCE.txt {recorded}，实际 {actual}"
        ));
    }
    Ok(())
}

fn verify_installed(root: &Path, manifest: &RulesManifest) -> Result<(), String> {
    for item in &manifest.items {
        let path = root.join(&item.file);
        let bytes = std::fs::read(&path).map_err(|error| format!("读取 {} 失败：{error}", item.id))?;
        if bytes.len() as i64 != item.bytes {
            return Err(format!(
                "{} 大小不匹配：manifest {}，实际 {}",
                item.id,
                item.bytes,
                bytes.len()
            ));
        }
        if sha256_hex(&bytes) != item.sha256 {
            return Err(format!("{} sha256 不匹配", item.id));
        }
    }
    Ok(())
}

fn read_installed(root: &Path) -> Result<InstalledRules, String> {
    let manifest: RulesManifest = serde_json::from_slice(
        &std::fs::read(root.join("manifest.json"))
            .map_err(|error| format!("读取 manifest.json 失败：{error}"))?,
    )
    .map_err(|error| format!("解析 manifest.json 失败：{error}"))?;
    let categories: CategoriesFile = serde_json::from_slice(
        &std::fs::read(root.join("categories.json"))
            .map_err(|error| format!("读取 categories.json 失败：{error}"))?,
    )
    .map_err(|error| format!("解析 categories.json 失败：{error}"))?;
    Ok(InstalledRules {
        root: root.to_path_buf(),
        manifest,
        categories: categories.categories,
    })
}

/// 解压随包归档到 `data_dir/rules/<version>/`，并写入 `rules_state`。
///
/// 已经解压且校验通过时直接复用；APP 升级时新基线版本会覆盖旧基线。
pub fn install_bundled(
    store: &Store,
    data_dir: &Path,
    resource_dir: Option<&Path>,
) -> Result<InstalledRules, String> {
    let archive = bundled_archive(resource_dir)
        .ok_or_else(|| "找不到随包规则数据（veyl-rules-*.tar.zst）".to_string())?;
    let version = bundled_version(&archive).ok_or_else(|| "规则归档文件名不合法".to_string())?;
    verify_archive_hash(&archive)?;

    let rules_root = data_dir.join(RULES_DIR_NAME);
    std::fs::create_dir_all(&rules_root).map_err(|error| format!("创建规则目录失败：{error}"))?;

    // 用户已经在线更新到更新的版本：保留用户的，不把随包旧基线切回来。
    let current = {
        let conn = store.conn();
        crate::store::rules_state::load(&conn).ok().flatten()
    };
    if let Some(current) = &current {
        if current.active_version.as_str() > version.as_str() {
            if let Ok(installed) = read_installed(&rules_root.join(&current.active_version)) {
                return Ok(installed);
            }
        }
    }

    let target = rules_root.join(&version);

    if target.join("manifest.json").is_file() {
        let installed = read_installed(&target)?;
        if verify_installed(&target, &installed.manifest).is_ok() {
            let already_active = {
                let conn = store.conn();
                crate::store::rules_state::load(&conn)
                    .ok()
                    .flatten()
                    .map(|state| state.active_version == version)
                    .unwrap_or(false)
            };
            if !already_active {
                save_state(store, &installed, &version, &version)?;
            }
            return Ok(installed);
        }
        std::fs::remove_dir_all(&target).map_err(|error| format!("清理损坏规则目录失败：{error}"))?;
    }

    let tmp = rules_root.join(format!("{version}.tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|error| format!("创建临时规则目录失败：{error}"))?;

    let extract = (|| -> Result<(), String> {
        let file = File::open(&archive).map_err(|error| format!("打开规则归档失败：{error}"))?;
        let decoder = zstd::stream::read::Decoder::new(file)
            .map_err(|error| format!("解压规则归档失败：{error}"))?;
        let mut tar = tar::Archive::new(decoder);
        tar.unpack(&tmp)
            .map_err(|error| format!("展开规则归档失败：{error}"))?;
        let installed = read_installed(&tmp)?;
        verify_installed(&tmp, &installed.manifest)?;
        Ok(())
    })();

    if let Err(error) = extract {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(error);
    }

    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&tmp, &target).map_err(|error| format!("切换规则目录失败：{error}"))?;
    let installed = read_installed(&target)?;
    save_state(store, &installed, &version, &version)?;
    prune_old_dirs(&rules_root, &version);
    Ok(installed)
}

fn save_state(
    store: &Store,
    installed: &InstalledRules,
    active_version: &str,
    bundled_version: &str,
) -> Result<(), String> {
    let manifest_bytes = std::fs::read(installed.root.join("manifest.json"))
        .map_err(|error| format!("读取 manifest.json 失败：{error}"))?;
    let total_bytes = installed.manifest.items.iter().map(|item| item.bytes).sum();
    let state = RulesState {
        active_version: active_version.to_string(),
        manifest_sha256: sha256_hex(&manifest_bytes),
        bundled_version: bundled_version.to_string(),
        geosite_tag: installed.manifest.source.geosite_tag.clone(),
        geoip_tag: installed.manifest.source.geoip_tag.clone(),
        item_count: installed.manifest.items.len() as i64,
        total_bytes,
        applied_at: store::now_ms(),
        checked_at: Some(store::now_ms()),
    };
    let conn = store.conn();
    crate::store::rules_state::save(&conn, &state).map_err(|error| error.to_string())
}

/// 只保留当前与上一版目录。
fn prune_old_dirs(rules_root: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(rules_root) else {
        return;
    };
    let mut versions = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| !name.contains(".tmp-"))
        .collect::<Vec<_>>();
    versions.sort();
    if let Some(position) = versions.iter().position(|version| version == keep) {
        let last = versions.len() - 1;
        versions.swap(position, last);
    }
    for version in versions.iter().take(versions.len().saturating_sub(2)) {
        let _ = std::fs::remove_dir_all(rules_root.join(version));
    }
}

pub fn load_active(store: &Store, data_dir: &Path) -> Option<InstalledRules> {
    let state = {
        let conn = store.conn();
        crate::store::rules_state::load(&conn).ok().flatten()?
    };
    read_installed(&data_dir.join(RULES_DIR_NAME).join(state.active_version)).ok()
}

fn age_days(value: Option<&str>) -> Option<i64> {
    let value = value?;
    let parsed = chrono::DateTime::parse_from_rfc3339(value).ok()?;
    Some((chrono::Utc::now() - parsed.with_timezone(&chrono::Utc)).num_days().max(0))
}

/// `RulesStatus`（`commands.md` §10.8）。
pub fn status(store: &Store, data_dir: &Path) -> Value {
    let state = {
        let conn = store.conn();
        crate::store::rules_state::load(&conn).ok().flatten()
    };
    let Some(state) = state else {
        return json!({
            "active_version": "",
            "manifest_sha256": "",
            "geosite_tag": null,
            "geoip_tag": null,
            "geosite_age_days": null,
            "geoip_age_days": null,
            "stale": true,
            "item_count": 0,
            "total_bytes": 0,
            "checked_at": null,
            "bundled_version": "",
            "pending_update": false,
        });
    };

    let installed = read_installed(&data_dir.join(RULES_DIR_NAME).join(&state.active_version)).ok();
    let geosite_age = installed
        .as_ref()
        .and_then(|rules| age_days(rules.manifest.source.geosite_commit_date.as_deref()));
    let geoip_age = installed
        .as_ref()
        .and_then(|rules| age_days(rules.manifest.source.geoip_commit_date.as_deref()));
    let stale = geosite_age.map(|days| days > 3).unwrap_or(true)
        || geoip_age.map(|days| days > 35).unwrap_or(true);

    json!({
        "active_version": state.active_version,
        "manifest_sha256": state.manifest_sha256,
        "geosite_tag": state.geosite_tag,
        "geoip_tag": state.geoip_tag,
        "geosite_age_days": geosite_age,
        "geoip_age_days": geoip_age,
        "stale": stale,
        "item_count": state.item_count,
        "total_bytes": state.total_bytes,
        "checked_at": state.checked_at,
        "bundled_version": state.bundled_version,
        "pending_update": false,
    })
}

/// `category_list` 的数据源。`item_count = 0` 表示上游 `.srs` 不提供条数。
pub fn categories(store: &Store, data_dir: &Path) -> Vec<Category> {
    load_active(store, data_dir)
        .map(|rules| rules.categories)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn write_fake_archive(dir: &Path, version: &str) -> PathBuf {
        let staging = dir.join("staging");
        std::fs::create_dir_all(staging.join("geosite")).unwrap();
        std::fs::create_dir_all(staging.join("geoip")).unwrap();
        std::fs::write(staging.join("geosite/cn.srs"), b"geosite-cn").unwrap();
        std::fs::write(staging.join("geoip/cn.srs"), b"geoip-cn").unwrap();
        let manifest = json!({
            "schema": 1,
            "version": version,
            "source": {
                "geosite_tag": "rule-set@aaaa",
                "geoip_tag": "rule-set@bbbb",
                "geosite_commit_date": "2026-11-03T00:00:00Z",
                "geoip_commit_date": "2026-10-01T00:00:00Z"
            },
            "items": [
                {"id":"geosite-cn","kind":"geosite","file":"geosite/cn.srs","sha256":sha256_hex(b"geosite-cn"),"bytes":10},
                {"id":"geoip-cn","kind":"geoip","file":"geoip/cn.srs","sha256":sha256_hex(b"geoip-cn"),"bytes":8}
            ]
        });
        std::fs::write(staging.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        let categories = json!({
            "schema": 1,
            "version": version,
            "categories": [{
                "id":"openai","name_zh":"ChatGPT","name_en":"OpenAI","description":"x",
                "item_count":0,"rule_sets":["geosite-cn"],"dns_classifiable":true
            }]
        });
        std::fs::write(staging.join("categories.json"), serde_json::to_vec(&categories).unwrap()).unwrap();

        let archive = dir.join(format!("veyl-rules-{version}.tar.zst"));
        let file = File::create(&archive).unwrap();
        let encoder = zstd::Encoder::new(file, 3).unwrap();
        let mut builder = tar::Builder::new(encoder);
        for (path, name) in [
            (staging.join("manifest.json"), "manifest.json"),
            (staging.join("categories.json"), "categories.json"),
            (staging.join("geosite/cn.srs"), "geosite/cn.srs"),
            (staging.join("geoip/cn.srs"), "geoip/cn.srs"),
        ] {
            builder.append_path_with_name(&path, name).unwrap();
        }
        let encoder = builder.into_inner().unwrap();
        encoder.finish().unwrap();
        let hash = sha256_hex(&std::fs::read(&archive).unwrap());
        std::fs::write(
            dir.join("SOURCE.txt"),
            format!("archive_sha256: {hash}\n"),
        )
        .unwrap();
        archive
    }

    #[test]
    fn installs_verifies_and_records_state() {
        let dir = std::env::temp_dir().join(format!("veyl-rules-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let archive = write_fake_archive(&dir, "2026-11-04.1");
        std::env::set_var("VEYL_RULES_ARCHIVE", &archive);

        let store = Store::open_in_memory().unwrap();
        let data_dir = dir.join("data");
        let installed = install_bundled(&store, &data_dir, None).unwrap();
        assert_eq!(installed.manifest.items.len(), 2);
        assert!(data_dir.join("rules/2026-11-04.1/geosite/cn.srs").is_file());

        let state = {
            let conn = store.conn();
            crate::store::rules_state::load(&conn).unwrap().unwrap()
        };
        assert_eq!(state.active_version, "2026-11-04.1");
        assert_eq!(state.item_count, 2);
        assert_eq!(state.total_bytes, 18);
        assert_eq!(state.geosite_tag.as_deref(), Some("rule-set@aaaa"));

        let status = status(&store, &data_dir);
        assert_eq!(status["active_version"], "2026-11-04.1");
        assert_eq!(status["item_count"], 2);
        assert!(status["geosite_age_days"].as_i64().unwrap() >= 0);

        let categories = categories(&store, &data_dir);
        assert_eq!(categories.len(), 1);

        std::env::remove_var("VEYL_RULES_ARCHIVE");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
