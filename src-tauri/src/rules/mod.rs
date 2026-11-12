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

/// 用户所在地区。**判定只做一次，四个入口共用同一个类型**：
/// 连接、批量测速、`route_get`、`system_region` 都读 [`effective_region`]，
/// 调用方不许再自己 `unwrap_or("cn")`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Region {
    /// 中国大陆。
    Cn,
    /// 其它国家/地区，小写 ISO 3166-1 alpha-2。
    Cc(String),
    /// 判不出来。
    Unknown,
}

impl Region {
    /// 小写国家码；未知为 `None`。
    pub fn code(&self) -> Option<&str> {
        match self {
            Region::Cn => Some("cn"),
            Region::Cc(code) => Some(code.as_str()),
            Region::Unknown => None,
        }
    }

    pub fn is_cn(&self) -> bool {
        matches!(self, Region::Cn)
    }

    /// 给提示词用的中文说法；没有中文名的国家回落到大写国家码（小写代码对模型没有意义）。
    pub fn label(&self) -> String {
        match self {
            Region::Cn => "中国大陆".to_string(),
            Region::Cc(code) => country_label(code)
                .map(str::to_string)
                .unwrap_or_else(|| code.to_uppercase()),
            Region::Unknown => "未知".to_string(),
        }
    }

    /// 允许外部（`VEYL_REGION`、时区表）给任意写法；不合法按未知处理。
    pub fn from_code(value: &str) -> Self {
        let code = value.trim().to_ascii_lowercase();
        if code == "cn" {
            return Region::Cn;
        }
        if code.len() == 2 && code.chars().all(|c| c.is_ascii_alphabetic()) {
            return Region::Cc(code);
        }
        Region::Unknown
    }
}

impl std::fmt::Display for Region {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Region::Cn => f.write_str("cn"),
            Region::Cc(code) => f.write_str(code),
            Region::Unknown => f.write_str("unknown"),
        }
    }
}

/// 只有时区表里出现的国家才给中文名；其余回落到大写国家码。
fn country_label(code: &str) -> Option<&'static str> {
    let name = match code {
        "hk" => "中国香港",
        "tw" => "中国台湾",
        "mo" => "中国澳门",
        "jp" => "日本",
        "kr" => "韩国",
        "sg" => "新加坡",
        "my" => "马来西亚",
        "th" => "泰国",
        "vn" => "越南",
        "ph" => "菲律宾",
        "id" => "印度尼西亚",
        "in" => "印度",
        "ae" => "阿联酋",
        "sa" => "沙特阿拉伯",
        "il" => "以色列",
        "tr" => "土耳其",
        "ru" => "俄罗斯",
        "ua" => "乌克兰",
        "md" => "摩尔多瓦",
        "gb" => "英国",
        "ie" => "爱尔兰",
        "pt" => "葡萄牙",
        "de" => "德国",
        "fr" => "法国",
        "nl" => "荷兰",
        "es" => "西班牙",
        "it" => "意大利",
        "ch" => "瑞士",
        "at" => "奥地利",
        "cz" => "捷克",
        "pl" => "波兰",
        "se" => "瑞典",
        "no" => "挪威",
        "dk" => "丹麦",
        "fi" => "芬兰",
        "gr" => "希腊",
        "ca" => "加拿大",
        "us" => "美国",
        "mx" => "墨西哥",
        "br" => "巴西",
        "ar" => "阿根廷",
        "cl" => "智利",
        "co" => "哥伦比亚",
        "pe" => "秘鲁",
        "ve" => "委内瑞拉",
        "au" => "澳大利亚",
        "nz" => "新西兰",
        "za" => "南非",
        "eg" => "埃及",
        _ => return None,
    };
    Some(name)
}

/// 生效地区来自哪里。`system_region` 与 `region-changed` 对外只报这两个值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegionSource {
    /// `VEYL_REGION`（测试/开发覆盖）或系统推断。
    System,
    /// 用户在对话里明示、由 `SetUserRegion` 写入 `settings.user_region`。
    Ai,
}

impl RegionSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Ai => "ai",
        }
    }
}

/// 生效地区：`VEYL_REGION` → `settings.user_region` → 系统推断 → 未知。
///
/// 建连、测速、`route_get`、`system_region` 都读这里，不再各自调 [`detect_region`]。
/// `user_region` 缺失、空串或非法（旧数据/手改库）按「没有用户值」回落，不报错。
pub fn effective_region(store: &Store) -> (Region, RegionSource) {
    let env_region = std::env::var("VEYL_REGION").ok();
    let user_region = {
        let conn = store.conn();
        crate::store::settings::get(&conn, crate::store::settings::USER_REGION_KEY)
            .ok()
            .flatten()
    };
    effective_from_sources(
        env_region.as_deref(),
        user_region.as_deref(),
        detect_region(),
    )
}

/// 进程内取生效地区与来源（提示词注入等拿不到 `Store` 的场景）。
pub fn effective_region_now() -> (Region, RegionSource) {
    match crate::store::global() {
        Some(store) => effective_region(store),
        None => (detect_region(), RegionSource::System),
    }
}

/// 纯函数：四档优先级便于单测，不读环境与数据库。
fn effective_from_sources(
    env_region: Option<&str>,
    user_region: Option<&str>,
    system: Region,
) -> (Region, RegionSource) {
    if let Some(region) = env_region.map(Region::from_code).filter(|r| r.code().is_some()) {
        return (region, RegionSource::System);
    }
    if let Some(region) = user_region.map(Region::from_code).filter(|r| r.code().is_some()) {
        return (region, RegionSource::Ai);
    }
    (system, RegionSource::System)
}

/// 系统推断：系统时区 → 系统区域 → `LANG` → 未知。
///
/// 全部离线：不测 IP、不联网。时区优先于区域设置，因为分流关心的是位置，
/// 而区域设置反映的是语言偏好（双语机器、旅行中、公司统一装机都会对不上）。
/// `VEYL_REGION` 不在这里处理，见 [`effective_region`]。
pub fn detect_region() -> Region {
    region_from_sources(
        None,
        system_timezone().as_deref(),
        system_locale().as_deref(),
        std::env::var("LANG").ok().as_deref(),
    )
}

/// 纯函数：便于测试顺序与时区表，不读环境。
fn region_from_sources(
    veyl_region: Option<&str>,
    timezone: Option<&str>,
    locale: Option<&str>,
    lang: Option<&str>,
) -> Region {
    if let Some(region) = veyl_region.map(Region::from_code) {
        if region != Region::Unknown {
            return region;
        }
    }
    if let Some(code) = timezone.and_then(region_from_timezone) {
        let region = Region::from_code(code);
        if region != Region::Unknown {
            return region;
        }
    }
    for value in [locale, lang] {
        if let Some(region) = value.and_then(region_from_locale).map(Region::from_code) {
            if region != Region::Unknown {
                return region;
            }
        }
    }
    Region::Unknown
}

/// 时区 → 国家码。表外返回 `None`，交给下一级。
///
/// 常见项一张表，不引第三方库。`America/*` 兜底算 `us`，但先把明确的国家列出来
/// （巴西/墨西哥/加拿大/阿根廷…）——把巴西用户标成「美国」比标成「未知」更误导模型。
/// Windows 显示名按「该时区的主要国家」取一个；同一条 Windows 时区覆盖多国时
/// 只能近似，这是区域设置的固有歧义。
fn region_from_timezone(timezone: &str) -> Option<&'static str> {
    let tz = timezone.trim();
    let tz = tz.rsplit("zoneinfo/").next().unwrap_or(tz);
    let code = match tz {
        "Asia/Shanghai" | "Asia/Chongqing" | "Asia/Harbin" | "Asia/Urumqi"
        | "Asia/Kashgar" | "PRC" => "cn",
        "Asia/Hong_Kong" => "hk",
        "Asia/Macau" => "mo",
        "Asia/Taipei" => "tw",
        "Asia/Tokyo" => "jp",
        "Asia/Seoul" => "kr",
        "Asia/Singapore" => "sg",
        "Asia/Kuala_Lumpur" => "my",
        "Asia/Bangkok" => "th",
        "Asia/Ho_Chi_Minh" | "Asia/Saigon" => "vn",
        "Asia/Manila" => "ph",
        "Asia/Jakarta" => "id",
        "Asia/Kolkata" | "Asia/Calcutta" => "in",
        "Asia/Dubai" => "ae",
        "Asia/Riyadh" => "sa",
        "Asia/Jerusalem" => "il",
        "Asia/Istanbul" | "Europe/Istanbul" => "tr",
        "Europe/Moscow" => "ru",
        "Europe/Kyiv" | "Europe/Kiev" => "ua",
        "Europe/Chisinau" | "Europe/Tiraspol" => "md",
        "Europe/London" => "gb",
        "Europe/Dublin" => "ie",
        "Europe/Lisbon" => "pt",
        "Europe/Berlin" => "de",
        "Europe/Vienna" => "at",
        "Europe/Prague" => "cz",
        "Europe/Warsaw" => "pl",
        "Europe/Paris" => "fr",
        "Europe/Amsterdam" => "nl",
        "Europe/Madrid" => "es",
        "Europe/Rome" => "it",
        "Europe/Stockholm" => "se",
        "Europe/Oslo" => "no",
        "Europe/Copenhagen" => "dk",
        "Europe/Helsinki" => "fi",
        "Europe/Athens" => "gr",
        "Europe/Zurich" => "ch",
        "Australia/Sydney" | "Australia/Melbourne" => "au",
        "Pacific/Auckland" => "nz",
        // 美洲先列明确国家，剩下的才兜底成 us。
        "America/Sao_Paulo" | "America/Bahia" | "America/Recife" => "br",
        "America/Mexico_City" | "America/Monterrey" | "America/Mazatlan"
        | "America/Tijuana" => "mx",
        "America/Toronto" | "America/Vancouver" | "America/Edmonton"
        | "America/Winnipeg" | "America/Regina" | "America/Halifax"
        | "America/St_Johns" => "ca",
        "America/Argentina/Buenos_Aires" | "America/Buenos_Aires" => "ar",
        "America/Santiago" => "cl",
        "America/Bogota" => "co",
        "America/Lima" => "pe",
        "America/Caracas" => "ve",
        // Windows 显示名；注册表里的 `TimeZoneKeyName` 就是这种写法。
        "China Standard Time" => "cn",
        "Hong Kong Standard Time" => "hk",
        "Taipei Standard Time" => "tw",
        "Tokyo Standard Time" => "jp",
        "Korea Standard Time" => "kr",
        "Singapore Standard Time" => "sg",
        "SE Asia Standard Time" => "th",
        "India Standard Time" => "in",
        "Arabian Standard Time" => "ae",
        "Israel Standard Time" => "il",
        "Turkey Standard Time" => "tr",
        "Russian Standard Time" => "ru",
        "FLE Standard Time" => "fi",
        "GTB Standard Time" => "gr",
        "E. Europe Standard Time" => "md",
        "GMT Standard Time" => "gb",
        "Central Europe Standard Time" => "cz",
        "Central European Standard Time" => "pl",
        "W. Europe Standard Time" => "de",
        "Romance Standard Time" => "fr",
        "AUS Eastern Standard Time" | "AUS Central Standard Time"
        | "W. Australia Standard Time" => "au",
        "New Zealand Standard Time" => "nz",
        "Atlantic Standard Time" | "Newfoundland Standard Time" => "ca",
        "E. South America Standard Time" => "br",
        "Pacific Standard Time (Mexico)" | "Central Standard Time (Mexico)"
        | "Mountain Standard Time (Mexico)" => "mx",
        "South Africa Standard Time" => "za",
        "Egypt Standard Time" => "eg",
        "Eastern Standard Time" | "Central Standard Time" | "Mountain Standard Time"
        | "Pacific Standard Time" => "us",
        _ if tz.starts_with("America/") => "us",
        _ => return None,
    };
    Some(code)
}

/// 从 `zh_CN.UTF-8` / `zh-Hans-CN` / `AppleLocale` 一类字符串里取国家码。
///
/// 按 BCP-47：**跳过第一段语言**，取之后第一个恰好两个字母的子标签
/// （`sr-Latn-RS` → `RS`；`zh-Hans-CN` → `CN`）。4 字母 script 段自然不会被选中。
fn region_from_locale(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("C") || value.eq_ignore_ascii_case("POSIX") {
        return None;
    }
    let base = value.split(['.', '@']).next().unwrap_or(value);
    base.split(['_', '-'])
        .skip(1)
        .find(|part| part.len() == 2 && part.chars().all(|c| c.is_ascii_alphabetic()))
}

#[cfg(target_os = "macos")]
fn system_timezone() -> Option<String> {
    if let Ok(tz) = std::env::var("TZ") {
        if !tz.trim().is_empty() {
            return Some(tz);
        }
    }
    let path = std::fs::read_link("/etc/localtime").ok()?;
    let path = path.to_string_lossy().to_string();
    let name = path.rsplit("zoneinfo/").next()?.to_string();
    (!name.is_empty() && !name.contains("zoneinfo")).then_some(name)
}

#[cfg(target_os = "windows")]
fn system_timezone() -> Option<String> {
    if let Ok(tz) = std::env::var("TZ") {
        if !tz.trim().is_empty() {
            return Some(tz);
        }
    }
    reg_query(
        r"HKLM\SYSTEM\CurrentControlSet\Control\TimeZoneInformation",
        "TimeZoneKeyName",
    )
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_timezone() -> Option<String> {
    if let Ok(tz) = std::env::var("TZ") {
        if !tz.trim().is_empty() {
            return Some(tz);
        }
    }
    let path = std::fs::read_link("/etc/localtime").ok()?;
    let path = path.to_string_lossy().to_string();
    let name = path.rsplit("zoneinfo/").next()?.to_string();
    (!name.is_empty() && !name.contains("zoneinfo")).then_some(name)
}

#[cfg(target_os = "macos")]
fn system_locale() -> Option<String> {
    let output = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(target_os = "windows")]
fn system_locale() -> Option<String> {
    reg_query(r"HKCU\Control Panel\International", "LocaleName")
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_locale() -> Option<String> {
    std::env::var("LC_ALL")
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// `reg query … /v <name>` 的输出里取 `REG_SZ` 后面那段。
///
/// `CREATE_NO_WINDOW`（0x08000000）不能省：Tauri 是 windows 子系统进程，
/// 不带的子进程会闪一个控制台窗口；而这条路径每轮对话与每次连接都会走。
#[cfg(target_os = "windows")]
fn reg_query(key: &str, name: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("reg")
        .args(["query", key, "/v", name])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text
        .lines()
        .find(|line| line.contains(name) && line.contains("REG_SZ"))?;
    let value = line.split("REG_SZ").nth(1)?.trim().to_string();
    (!value.is_empty()).then_some(value)
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

#[cfg(test)]
mod region_tests {
    use super::*;

    #[test]
    fn timezone_beats_locale_for_location() {
        // 双语机器 / 公司统一装机：区域设置是 en_US，但机器在东京。
        let region = region_from_sources(
            None,
            Some("Asia/Tokyo"),
            Some("en_US"),
            Some("en_US.UTF-8"),
        );
        assert_eq!(region, Region::Cc("jp".into()));
    }

    #[test]
    fn veyl_region_beats_everything() {
        assert_eq!(
            region_from_sources(Some("hk"), Some("Asia/Tokyo"), Some("en_US"), None),
            Region::Cc("hk".into())
        );
    }

    #[test]
    fn locale_is_used_when_timezone_is_unknown() {
        assert_eq!(
            region_from_sources(None, Some("Mars/Olympus"), Some("zh_CN"), None),
            Region::Cn
        );
        assert_eq!(
            region_from_sources(None, None, None, Some("zh_CN.UTF-8")),
            Region::Cn
        );
    }

    #[test]
    fn unknown_stays_unknown() {
        assert_eq!(
            region_from_sources(None, Some("Mars/Olympus"), Some("C"), Some("POSIX")),
            Region::Unknown
        );
    }

    #[test]
    fn locale_subtags_are_parsed_per_bcp47() {
        // 第二段可能是 4 字母 script，不能截成两字母当成国家。
        assert_eq!(region_from_locale("sr-Latn-RS"), Some("RS"));
        assert_eq!(region_from_locale("zh-Hans-CN"), Some("CN"));
        assert_eq!(region_from_locale("en_US"), Some("US"));
        assert_eq!(region_from_locale("en_CN"), Some("CN"));
        assert_eq!(region_from_locale("zh_CN.UTF-8"), Some("CN"));
        // 只有语言没有地区：不能凭空造一个。
        assert_eq!(region_from_locale("de"), None);
        assert_eq!(region_from_locale("C"), None);
        assert_eq!(region_from_locale("POSIX"), None);
    }

    #[test]
    fn timezone_table_covers_common_zones() {
        for (tz, code) in [
            ("Asia/Shanghai", "cn"),
            ("Asia/Hong_Kong", "hk"),
            ("Asia/Taipei", "tw"),
            ("Asia/Tokyo", "jp"),
            ("Europe/Prague", "cz"),
            ("Europe/Warsaw", "pl"),
            ("Europe/Vienna", "at"),
            ("Europe/Oslo", "no"),
            ("Europe/Copenhagen", "dk"),
            ("Europe/Helsinki", "fi"),
            ("Europe/Athens", "gr"),
            ("Europe/Istanbul", "tr"),
            ("Europe/Lisbon", "pt"),
            ("Europe/Dublin", "ie"),
            ("Europe/Kyiv", "ua"),
            ("China Standard Time", "cn"),
            ("Tokyo Standard Time", "jp"),
            ("Central Europe Standard Time", "cz"),
            ("Central European Standard Time", "pl"),
            ("FLE Standard Time", "fi"),
            ("GTB Standard Time", "gr"),
            ("Turkey Standard Time", "tr"),
            ("/var/db/timezone/zoneinfo/Asia/Tokyo", "jp"),
        ] {
            assert_eq!(region_from_timezone(tz), Some(code), "{tz}");
        }
        assert_eq!(region_from_timezone("Mars/Olympus"), None);
    }

    #[test]
    fn america_is_not_all_the_united_states() {
        for (tz, code) in [
            ("America/New_York", "us"),
            ("America/Sao_Paulo", "br"),
            ("America/Mexico_City", "mx"),
            ("America/Toronto", "ca"),
            ("America/Vancouver", "ca"),
            ("America/Argentina/Buenos_Aires", "ar"),
            ("America/Santiago", "cl"),
        ] {
            assert_eq!(region_from_timezone(tz), Some(code), "{tz}");
        }
    }

    #[test]
    fn region_codes_are_normalised_and_validated() {
        assert!(Region::from_code("CN").is_cn());
        assert_eq!(Region::from_code(" JP "), Region::Cc("jp".into()));
        assert_eq!(Region::from_code("日本"), Region::Unknown);
        assert_eq!(Region::from_code(""), Region::Unknown);
        assert_eq!(Region::Unknown.code(), None);
        assert_eq!(Region::Cn.label(), "中国大陆");
        assert_eq!(Region::Cc("jp".into()).label(), "日本");
    }

    #[test]
    fn effective_region_priority_is_env_user_system_unknown() {
        let system = Region::Cc("us".into());
        let cases = [
            (
                Some("hk"),
                Some("jp"),
                (Region::Cc("hk".into()), RegionSource::System),
            ),
            (
                None,
                Some("jp"),
                (Region::Cc("jp".into()), RegionSource::Ai),
            ),
            // 非法 VEYL_REGION 不比合法用户值优先。
            (
                Some("nope"),
                Some("JP"),
                (Region::Cc("jp".into()), RegionSource::Ai),
            ),
            (None, None, (system.clone(), RegionSource::System)),
            // 三档都没有 → 未知；建连侧按「无本地层、全代理」处理。
            (
                None,
                None,
                (Region::Unknown, RegionSource::System),
            ),
        ];
        for (env, user, expected) in cases {
            let system = if expected.0 == Region::Unknown {
                Region::Unknown
            } else {
                system.clone()
            };
            assert_eq!(
                effective_from_sources(env, user, system),
                expected,
                "env={env:?} user={user:?}"
            );
        }
    }

    #[test]
    fn missing_empty_or_invalid_user_region_falls_back_to_system() {
        let store = Store::open_in_memory().unwrap();
        for value in [None, Some(""), Some("   "), Some("usa"), Some("日本")] {
            {
                let conn = store.conn();
                match value {
                    Some(text) => {
                        crate::store::settings::set(
                            &conn,
                            crate::store::settings::USER_REGION_KEY,
                            text,
                        )
                        .unwrap();
                    }
                    None => {
                        crate::store::settings::delete(
                            &conn,
                            crate::store::settings::USER_REGION_KEY,
                        )
                        .unwrap();
                    }
                }
            }
            let system = detect_region();
            assert_eq!(
                effective_region(&store),
                (system, RegionSource::System),
                "value={value:?}"
            );
        }
    }

    #[test]
    fn valid_user_region_beats_system_inference() {
        let store = Store::open_in_memory().unwrap();
        {
            let conn = store.conn();
            crate::store::settings::set(
                &conn,
                crate::store::settings::USER_REGION_KEY,
                "JP",
            )
            .unwrap();
        }
        assert_eq!(
            effective_region(&store),
            (Region::Cc("jp".into()), RegionSource::Ai)
        );
    }
}
