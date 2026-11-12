//! 问题报告：本地生成材料、脱敏、落盘与两个动作命令。
//!
//! 设计见 `docs/design/issue-report.md`；工具契约 `tools.md` §4.46、
//! 命令契约 `commands.md` §7.12。这里只做文件与文本，不碰网络、不改配置。

pub mod redact;

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use redact::{counts_json, redact_text, Redactor, REDACTION_MARKER};

pub const FEEDBACK_EMAIL: &str = "ribencong@gmail.com";
pub const REPORT_ROOT_NAME: &str = "Veyl 问题报告";
pub const SCHEMA_VERSION: i64 = 1;
pub const LOG_LINES_MIN: usize = 40;
pub const LOG_LINES_MAX: usize = 400;
pub const LOG_LINES_DEFAULT: usize = 200;
pub const REPORT_MARKDOWN_LIMIT: usize = 128 * 1024;
pub const REPORT_MD_FILE_LIMIT: usize = 256 * 1024;
pub const SCENE_JSON_LIMIT: usize = 64 * 1024;
pub const LOG_FILE_LIMIT: u64 = 2 * 1024 * 1024;
pub const TOTAL_LIMIT: u64 = 8 * 1024 * 1024;
/// mailto 正文的**编码后**上限：中文百分号编码会膨胀到 3 倍。
pub const MAILTO_BODY_LIMIT_BYTES: usize = 7500;
/// 正文原始字符的软上限（仅用于文档与测试参考）。
pub const MAIL_BODY_LIMIT: usize = 6000;
/// 用户在入口处是否允许完整域名。开关属于用户，模型不能放宽。
pub const INCLUDE_DOMAINS_KEY: &str = "issue_report_include_domains";

/// 已批准的唯一表述：不得改写成「材料不出本机」。
pub const LOCAL_STATEMENT: &str = "报告只保存在你的电脑上；生成时，脱敏后的日志会发给你配置的 AI 服务。要不要把它发出去，由你决定。";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueReportInput {
    pub log_lines: usize,
    /// `None` = 没表态，由用户设置决定；`Some(false)` 才是模型主动收窄。
    pub include_domains: Option<bool>,
    pub report_markdown: Option<String>,
}

/// 工具入参校验：**未知字段与越界一律拒绝**，且不产生任何文件（契约 §4.46）。
pub fn parse_input(input: &Value) -> Result<IssueReportInput, String> {
    let Some(object) = input.as_object() else {
        return Err("unknown_argument".to_string());
    };
    for key in object.keys() {
        if !matches!(key.as_str(), "log_lines" | "include_domains" | "report_markdown") {
            return Err("unknown_argument".to_string());
        }
    }
    let log_lines = match object.get("log_lines") {
        None | Some(Value::Null) => LOG_LINES_DEFAULT,
        Some(value) => {
            // 参数名是认识的，只是取值不合法：给独立 reason，调用方才能据此纠正。
            let lines = value.as_u64().ok_or_else(|| "log_lines_out_of_range".to_string())?;
            if !(LOG_LINES_MIN as u64..=LOG_LINES_MAX as u64).contains(&lines) {
                return Err("log_lines_out_of_range".to_string());
            }
            lines as usize
        }
    };
    let include_domains = match object.get("include_domains") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(value)) => Some(*value),
        Some(_) => return Err("unknown_argument".to_string()),
    };
    let report_markdown = match object.get("report_markdown") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            if text.trim().is_empty() {
                return Err("empty_report".to_string());
            }
            if text.len() > REPORT_MARKDOWN_LIMIT {
                return Err("unknown_argument".to_string());
            }
            Some(text.clone())
        }
        Some(_) => return Err("unknown_argument".to_string()),
    };
    Ok(IssueReportInput {
        log_lines,
        include_domains,
        report_markdown,
    })
}

/// 生成报告所需的现场数据（由服务层收集后传进来，测试可直接构造）。
#[derive(Debug, Clone, Default)]
pub struct ReportContext {
    pub data_dir: PathBuf,
    pub runtime: Value,
    pub checks: Value,
    pub app_version: String,
    pub platform: String,
    pub arch: String,
    pub routing_mode: Option<String>,
    pub node_count: usize,
    pub config_count: usize,
    pub node_protocols: Vec<String>,
    pub node_hosts: Vec<String>,
    pub node_names: Vec<String>,
    pub config_names: Vec<String>,
    /// 用户是否在入口打开了「包含网站域名」。
    pub user_allows_domains: bool,
}

#[derive(Debug)]
pub struct ReportError {
    pub code: &'static str,
    pub message: String,
    pub reason: Option<&'static str>,
}

impl ReportError {
    fn invalid(reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_ARGUMENT",
            message: message.into(),
            reason: Some(reason),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            code: "NOT_FOUND",
            message: message.into(),
            reason: Some("report_not_found"),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "INTERNAL",
            message: message.into(),
            reason: None,
        }
    }
}

// ---------------------------------------------------------------------------
// report_id ↔ 目录登记
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Registry {
    /// session_id → report_id：同一个会话只对应一个目录。
    sessions: HashMap<String, String>,
    /// report_id → 目录。
    dirs: HashMap<String, PathBuf>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

fn lock_registry() -> std::sync::MutexGuard<'static, Registry> {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
pub fn reset_registry_for_test() {
    *lock_registry() = Registry::default();
}

/// 报告根目录：优先桌面；取不到（被重定向、无桌面）落到数据目录下的 reports。
/// 命令侧用的根目录：没有 data_dir 上下文，按默认数据目录算。
pub fn default_report_root() -> PathBuf {
    reports_root(&crate::runtime::default_app_data_dir())
}

pub fn reports_root(data_dir: &Path) -> PathBuf {
    match desktop_dir() {
        Some(desktop) => desktop.join(REPORT_ROOT_NAME),
        None => data_dir.join("reports"),
    }
}

fn desktop_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        let desktop = Path::new(&home).join("Desktop");
        return desktop.is_dir().then_some(desktop);
    }
    #[cfg(target_os = "windows")]
    {
        let home = std::env::var("USERPROFILE").ok()?;
        let desktop = Path::new(&home).join("Desktop");
        return desktop.is_dir().then_some(desktop);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

fn new_report_id(now: chrono::DateTime<chrono::Local>) -> String {
    let suffix: u32 = rand::random::<u32>() % 0x1000000;
    format!("rpt-{}-{suffix:06x}", now.format("%Y%m%d-%H%M%S"))
}

/// 目标目录的候选名：同一分钟已存在就 `-2`…`-9`，再到 `-HHmmss`。
fn report_dir_candidates(root: &Path, now: chrono::DateTime<chrono::Local>) -> Vec<PathBuf> {
    let base = now.format("%Y-%m-%d-%H%M").to_string();
    let mut names: Vec<String> = vec![base.clone()];
    for index in 2..=9 {
        names.push(format!("{base}-{index}"));
    }
    names.push(format!("{}-{}", base, now.format("%H%M%S")));
    names.into_iter().map(|name| root.join(name)).collect()
}

/// 全部文件先写进临时目录，成功后一次性改名成正式目录。
/// 中途失败时 Drop 会把临时目录删掉，目录里没有任何 `.report-id`，`lookup` 找不到。
struct StagingGuard(PathBuf);

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

fn create_staging_dir(root: &Path) -> std::io::Result<PathBuf> {
    fs::create_dir_all(root)?;
    let path = root.join(format!(
        ".tmp-{:016x}",
        rand::random::<u64>()
    ));
    fs::create_dir(&path)?;
    restrict_dir(&path);
    Ok(path)
}

/// 把临时目录改名成正式目录；同名已存在就换下一个候选，**绝不覆盖**。
fn commit_staging(
    staging: &Path,
    root: &Path,
    now: chrono::DateTime<chrono::Local>,
) -> std::io::Result<PathBuf> {
    let mut last = None;
    for candidate in report_dir_candidates(root, now) {
        // macOS 对「非空目录」返回 ENOTEMPTY 而不是 AlreadyExists，先看存在性最稳。
        if candidate.exists() {
            continue;
        }
        match fs::rename(staging, &candidate) {
            Ok(()) => return Ok(candidate),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                last = Some(error);
                continue;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "同一分钟的报告目录已经用满",
        )
    }))
}

/// 单个文件先写临时文件再改名：崩溃时不会留下半个文件，也不会覆盖失败。
fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    let temp = dir.join(format!(".{name}.tmp-{:08x}", rand::random::<u32>()));
    let result = write_private(&temp, bytes).and_then(|()| fs::rename(&temp, dir.join(name)));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn restrict_dir(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

fn read_report_id(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join(".report-id"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn register(report_id: &str, dir: &Path, session_id: &str) {
    let mut registry = lock_registry();
    registry
        .sessions
        .insert(session_id.to_string(), report_id.to_string());
    registry.dirs.insert(report_id.to_string(), dir.to_path_buf());
}

/// 只认登记过的目录：先查内存，再扫各报告目录的 `.report-id`。**不接受路径**。
pub fn lookup(report_id: &str, root: &Path) -> Option<PathBuf> {
    if report_id.trim().is_empty() || report_id.contains('/') || report_id.contains('\\') {
        return None;
    }
    if let Some(dir) = lock_registry().dirs.get(report_id).cloned() {
        if dir.join(".report-id").is_file() || dir.is_dir() {
            return Some(dir);
        }
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        // 不跟随符号链接：报告目录只认我们自己建的实体目录。
        let Ok(meta) = fs::symlink_metadata(&dir) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        // 写入中的暂存目录已经带 `.report-id`；崩在 commit 之前不能把它当成正式报告。
        if dir
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(".tmp-"))
        {
            continue;
        }
        if read_report_id(&dir).as_deref() == Some(report_id) {
            lock_registry()
                .dirs
                .insert(report_id.to_string(), dir.clone());
            return Some(dir);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 收集与写入
// ---------------------------------------------------------------------------

struct LogSource {
    /// 写进报告里的文件名。
    name: String,
    path: PathBuf,
}

fn log_sources(data_dir: &Path) -> Vec<LogSource> {
    let log_dir = data_dir.join("logs");
    let helper_dir = crate::veyl_paths::helper_logs_dir(data_dir);
    let app = crate::logging::log_path(&log_dir);
    let mut sources = Vec::new();
    sources.push(LogSource {
        name: app
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "app.log".to_string()),
        path: app,
    });
    let runtime = newest_runtime_log(&log_dir);
    sources.push(match runtime {
        Some(path) => LogSource {
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "runtime.log".to_string()),
            path,
        },
        None => LogSource {
            name: "runtime.log".to_string(),
            path: log_dir.join("runtime.log"),
        },
    });
    #[cfg(target_os = "windows")]
    {
        sources.push(LogSource {
            name: "service.log".to_string(),
            path: PathBuf::from(r"C:\ProgramData\Veyl\logs\service.log"),
        });
    }
    #[cfg(target_os = "macos")]
    {
        sources.push(LogSource {
            name: "helper.log".to_string(),
            path: helper_dir.join("helper.log"),
        });
        sources.push(LogSource {
            name: "sing-box.log".to_string(),
            path: helper_dir.join("sing-box.log"),
        });
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = &helper_dir;
    }
    sources
}

fn newest_runtime_log(log_dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(log_dir).ok()?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().map(|name| name.to_string_lossy().to_string()) else {
            continue;
        };
        if !name.starts_with("runtime-") || !name.ends_with(".log") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map_or(true, |(at, _)| modified > *at) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, path)| path)
}

/// 读文件尾部：最多 `max_bytes`，再取最后 `max_lines` 行。返回（行，是否截断）。
fn read_tail(path: &Path, max_lines: usize, max_bytes: u64) -> Option<(Vec<String>, bool)> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    // 从中间开始读时，第一行可能是半行：丢掉。
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let mut truncated = start > 0 || length > max_bytes;
    if lines.len() > max_lines {
        truncated = true;
        lines = lines.split_off(lines.len() - max_lines);
    }
    Some((lines, truncated))
}

fn clip_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

fn template_report(ctx: &ReportContext, redactor: &mut Redactor) -> String {
    let state = ctx
        .runtime
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let mode = ctx
        .runtime
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let routing = ctx.routing_mode.as_deref().unwrap_or("unknown");
    let draft = format!(
        "# 问题报告\n\n\
> 本报告由 Veyl 与用户配置的模型生成，可能不准确。\n\
> 报告中的 `***` 表示已打码（域名子域、节点地址、公网 IP 等）。\n\
> 报告文件只保存在本机；是否发送由你决定。\n\n\
## 现象\n\
（用户未补充描述；现场材料已按当前状态生成。）\n\n\
## 环境\n\
- 应用版本：{}\n\
- 系统：{} / {}\n\
- 连接模式：{}\n\
- 当前状态：{}\n\
- 走法：{}\n\
- 节点数 / 配置数：{} / {}\n\n\
## 下一步建议\n\
1. 重新连接一次，观察是否恢复。\n\
2. 换一个节点再试。\n\
3. 把本文件夹里的 `现场.json` 与 `日志/` 一起发给支持方，或让助手继续看日志。\n",
        ctx.app_version,
        ctx.platform,
        ctx.arch,
        mode,
        state,
        routing,
        ctx.node_count,
        ctx.config_count
    );
    redact_text(redactor, &draft)
}


const GUIDE_TEXT: &str = "\
*** 表示这里被打码了（域名子域、节点地址、公网 IP 等），不是乱码。
里面有：报告.md（现象与可疑点）、现场.json（当时的状态）、日志/（日志尾部副本，行号可直接引用）。
发送邮件时请把 现场.json 与 日志/ 一起附上，只发正文会缺材料。
";

/// 把主目录前缀折叠成 `~`；找不到 home 时返回 `None`。
///
/// 报告目录在正常机器上一定位于主目录下；**折叠失败时宁可不显示路径**，
/// 也不能把 `/Users/<名字>` 交出去（`先看我.txt` 会随邮件发出去）。
pub fn fold_home(path: &str) -> Option<String> {
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())?;
    fold_home_with(path, &home)
}

pub fn fold_home_with(path: &str, home: &str) -> Option<String> {
    if home.is_empty() || path.len() < home.len() {
        return None;
    }
    // 长度前缀不能落在多字节字符中间：`split_at` 在这里会 panic。
    if !path.is_char_boundary(home.len()) {
        return None;
    }
    let (head, rest) = path.split_at(home.len());
    if !head.eq_ignore_ascii_case(home) {
        return None;
    }
    // 只认路径边界：`/Users/alice2` 不能被 `/Users/alice` 折叠。
    if !rest.is_empty() && !rest.starts_with('/') && !rest.starts_with('\\') {
        return None;
    }
    Some(format!("~{rest}"))
}

/// 给模型与界面看的目录：`~` 形式；折叠不了就只给目录名，绝不给绝对路径。
pub fn public_dir(dir: &Path) -> String {
    let full = dir.display().to_string();
    fold_home(&full).unwrap_or_else(|| {
        dir.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "报告目录".to_string())
    })
}

fn guide_text(dir: &Path) -> String {
    let mut text = format!("{LOCAL_STATEMENT}\n\n{GUIDE_TEXT}");
    if let Some(shown) = fold_home(&dir.display().to_string()) {
        text.push_str(&format!("\n实际保存位置：{shown}\n"));
    }
    text
}

fn scene_json(
    report_id: &str,
    ctx: &ReportContext,
    redactor: &mut Redactor,
    domains_included: bool,
    log_files: &[Value],
) -> Value {
    let runtime = &ctx.runtime;
    let health = runtime.get("health").cloned().unwrap_or(Value::Null);
    let last_error = runtime.get("last_error").cloned().unwrap_or(Value::Null);
    let last_error = if last_error.is_null() {
        Value::Null
    } else {
        let message = last_error
            .get("message")
            .and_then(Value::as_str)
            .map(|text| redact_text(redactor, text))
            .unwrap_or_default();
        json!({
            "code": last_error.get("code").cloned().unwrap_or(Value::Null),
            "message": message,
            "reason": last_error
                .get("details")
                .and_then(|details| details.get("reason"))
                .cloned()
                .unwrap_or(Value::Null),
        })
    };
    json!({
        "schema_version": SCHEMA_VERSION,
        "report_id": report_id,
        "generated_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "tool_version": crate::tools::envelope::CONTRACT_VERSION,
        "app_version": ctx.app_version,
        "platform": ctx.platform,
        "os_version": os_version(),
        "arch": ctx.arch,
        "locale": std::env::var("LANG").unwrap_or_else(|_| "unknown".to_string()),
        "timezone": chrono::Local::now().offset().to_string(),
        "mode": runtime.get("mode").cloned().unwrap_or(Value::Null),
        "state": runtime.get("state").cloned().unwrap_or(Value::Null),
        "routing_mode": ctx.routing_mode,
        "mixed_port": runtime.get("mixed_port").cloned().unwrap_or(Value::Null),
        "port_fallback": runtime.get("port_fallback").cloned().unwrap_or(Value::Null),
        "health": {
            "process": health.get("process").cloned().unwrap_or(Value::Null),
            "clash_api": health.get("clash_api").cloned().unwrap_or(Value::Null),
            "data_plane": health.get("data_plane").cloned().unwrap_or(Value::Null),
            "consecutive_failures": health.get("consecutive_failures").cloned().unwrap_or(Value::Null),
            "checked_at": health.get("checked_at").cloned().unwrap_or(Value::Null),
        },
        "system_dns": runtime.get("system_dns").cloned().unwrap_or(Value::Null),
        "connected_since": runtime.get("connected_since").cloned().unwrap_or(Value::Null),
        "uptime_seconds": runtime.get("uptime_seconds").cloned().unwrap_or(Value::Null),
        "node_count": ctx.node_count,
        "config_count": ctx.config_count,
        "node_protocols": ctx.node_protocols,
        "runtime_version": runtime.get("upstream_version").cloned().unwrap_or(Value::Null),
        "runtime_source": runtime.get("runtime_source").cloned().unwrap_or(Value::Null),
        "last_error": last_error,
        "log_files": log_files,
        "redaction_marker": REDACTION_MARKER,
        "redactions": counts_json(redactor.counts(), if domains_included { "detailed" } else { "minimal" }),
        "domains_included": domains_included,
    })
}

fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
        {
            if output.status.success() {
                return String::from_utf8_lossy(&output.stdout).trim().to_string();
            }
        }
    }
    std::env::var("OS").unwrap_or_else(|_| "unknown".to_string())
}

fn fit_json(mut value: Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(&value).unwrap_or_default();
    // 现场 JSON 超限时先丢检查项（列表最长的那块），仍超再退到紧凑序列化。
    while bytes.len() > SCENE_JSON_LIMIT {
        let Some(checks) = value
            .get_mut("checks")
            .and_then(Value::as_array_mut)
        else {
            break;
        };
        if checks.len() <= 10 {
            break;
        }
        checks.truncate(checks.len() / 2);
        bytes = serde_json::to_vec_pretty(&value).unwrap_or_default();
    }
    if bytes.len() > SCENE_JSON_LIMIT {
        bytes = serde_json::to_vec(&value).unwrap_or_default();
    }
    bytes
}

/// 模型产出的报告必须带固定结构与披露句；缺了由 Host 补上，不能靠模型自觉。
fn ensure_report_structure(markdown: &str) -> String {
    const TITLE: &str = "# 问题报告";
    const DISCLOSURE: &str = "> 报告文件只保存在本机；是否发送由你决定。";
    let mut text = markdown.trim().to_string();
    if !text.lines().any(|line| line.trim() == TITLE) {
        text = format!("{TITLE}\n\n{text}");
    }
    // 命中任一特征短语就视为已声明，避免模型换了说法又被补一遍。
    if !text.contains("只保存在") && !text.contains("发给你配置的 AI 服务") {
        let preamble = format!(
            "\n\n> 本报告由 Veyl 与用户配置的模型生成，可能不准确。\n> 报告中的 `***` 表示已打码（域名子域、节点地址、公网 IP 等）。\n{DISCLOSURE}"
        );
        if let Some(position) = text.find('\n') {
            text.insert_str(position, &preamble);
        } else {
            text.push_str(&preamble);
        }
    }
    // 固定六节：缺哪节插哪节，已有内容一字不动。
    const SECTIONS: &[(&str, &str)] = &[
        ("## 现象", "（本次未采集到）"),
        ("## 环境", "（本次未采集到）"),
        ("## 时间线", "（本次未采集到）"),
        ("## 可疑点", "（本次未采集到）"),
        ("## 下一步建议", "（暂无）"),
    ];
    for (heading, placeholder) in SECTIONS {
        if !text.contains(*heading) {
            text.push_str(&format!("\n\n{heading}\n{placeholder}"));
        }
    }
    text
}

/// 把 JSON 里所有字符串过同一个 Redactor：进模型的材料与落盘的现场用同一套口径。
fn redact_json(redactor: &mut Redactor, value: &mut Value) {
    match value {
        Value::String(text) => *text = redact_text(redactor, text),
        Value::Array(items) => {
            for item in items {
                redact_json(redactor, item);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                redact_json(redactor, item);
            }
        }
        _ => {}
    }
}

/// 同一会话的两次生成不能各建一个目录：锁住整个生成过程。
static GENERATE_LOCK: Mutex<()> = Mutex::new(());

fn lock_generate() -> std::sync::MutexGuard<'static, ()> {
    GENERATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 写入阶段：只重写 `报告.md`，其余文件一律不动。
fn write_ai_report(
    report_id: &str,
    dir: &Path,
    markdown: &str,
    ctx: &ReportContext,
    domains_included: bool,
) -> Result<Value, ReportError> {
    let mut redactor = Redactor::new(domains_included).with_aliases(
        ctx.node_hosts.clone(),
        ctx.node_names.clone(),
        ctx.config_names.clone(),
    );
    let text = redact_text(&mut redactor, &ensure_report_structure(markdown));
    let text = if text.len() > REPORT_MD_FILE_LIMIT {
        clip_chars(&text, REPORT_MD_FILE_LIMIT / 4)
    } else {
        text
    };
    write_atomic(dir, "报告.md", text.as_bytes()).map_err(|error| {
        ReportError::invalid("report_dir_unwritable", format!("写报告失败：{error}"))
    })?;

    let scene: Value = fs::read_to_string(dir.join("现场.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null);
    Ok(json!({
        "report_id": report_id,
        "report_dir": public_dir(dir),
        "phase": "written",
        "files": listed_files(dir),
        "redactions": merge_redactions(&scene, &redactor),
        "ai_report": true,
    }))
}

/// 列出现有目录里的文件（写入阶段不再重写它们，只报事实）。
fn listed_files(dir: &Path) -> Value {
    let mut files = Vec::new();
    let mut push = |name: String, path: &Path| {
        let Ok(meta) = fs::metadata(path) else {
            return;
        };
        let lines = fs::read_to_string(path)
            .ok()
            .map(|text| text.lines().count());
        files.push(json!({
            "name": name,
            "bytes": meta.len(),
            "lines": lines,
            "truncated": false,
            "missing": false,
        }));
    };
    if let Ok(entries) = fs::read_dir(dir.join("日志")) {
        let mut logs: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
        logs.sort();
        for path in logs {
            if let Some(name) = path.file_name() {
                push(
                    format!("日志/{}", name.to_string_lossy()),
                    &path,
                );
            }
        }
    }
    for name in ["报告.md", "现场.json", "先看我.txt"] {
        push(name.to_string(), &dir.join(name));
    }
    Value::Array(files)
}

/// 现场.json 里已经有累计计数：写入阶段在此基础上加上本次报告文本的计数。
fn merge_redactions(scene: &Value, redactor: &Redactor) -> Value {
    let counts = redactor.counts();
    let existing = scene.get("redactions");
    let extra = |key: &str, own: usize| {
        existing
            .and_then(|value| value.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize
            + own
    };
    json!({
        "domains": extra("domains", counts.domains),
        "public_ips": extra("public_ips", counts.public_ips),
        "paths": extra("paths", counts.paths),
        "urls": extra("urls", counts.urls),
        "node_refs": extra("node_refs", counts.node_refs),
        "config_refs": extra("config_refs", counts.config_refs),
        "secrets": extra("secrets", counts.secrets),
        "mode": existing
            .and_then(|value| value.get("mode"))
            .cloned()
            .unwrap_or_else(|| json!("minimal")),
    })
}

/// 生成（收集或写入）一份报告。`root` 显式传入，测试可指向临时目录。
pub fn generate(
    session_id: &str,
    input: &IssueReportInput,
    ctx: &ReportContext,
    root: &Path,
) -> Result<Value, ReportError> {
    let _generate = lock_generate();
    // 省略参数 = 遵循用户设置；显式 false 才是模型收窄。
    let domains_included = ctx.user_allows_domains && input.include_domains.unwrap_or(true);
    let phase = if input.report_markdown.is_some() {
        "written"
    } else {
        "collected"
    };
    let now = chrono::Local::now();
    let (report_id, staging, final_root) = match existing_session(session_id) {
        Some((report_id, dir)) => (report_id, dir, None),
        None => {
            let report_id = new_report_id(now);
            let staging = create_staging_dir(root).map_err(|error| {
                ReportError::invalid(
                    "report_dir_unwritable",
                    format!("没写成，检查桌面权限：{error}"),
                )
            })?;
            (report_id, staging, Some(root.to_path_buf()))
        }
    };
    // 新目录：中途失败时删掉临时目录，不留下能被 lookup 找到的半成品。
    let _staging_guard = final_root.as_ref().map(|_| StagingGuard(staging.clone()));
    let dir = staging.clone();
    // 写入阶段只覆盖 报告.md：日志与 现场.json 必须保持收集阶段的原样，
    // 否则 `日志/<文件>:<行号>` 的引用会漂移。
    if phase == "written" && final_root.is_none() && dir.join("现场.json").is_file() {
        return write_ai_report(
            &report_id,
            &dir,
            input.report_markdown.as_deref().unwrap_or_default(),
            ctx,
            domains_included,
        );
    }

    let mut redactor = Redactor::new(domains_included).with_aliases(
        ctx.node_hosts.clone(),
        ctx.node_names.clone(),
        ctx.config_names.clone(),
    );
    // 模型可见的材料与落盘的现场共用这一份脱敏结果：
    // 快照里的 config_name / node_name / last_error、diag 的出口 IP 都不能原样交出去。
    let mut materials_runtime = ctx.runtime.clone();
    redact_json(&mut redactor, &mut materials_runtime);
    let mut materials_checks = ctx.checks.clone();
    redact_json(&mut redactor, &mut materials_checks);

    let mut files = Vec::new();
    let mut logs_material = Vec::new();
    let mut log_files_json = Vec::new();
    let mut total_written: u64 = 0;
    // 报告.md / 现场.json / 先看我.txt 也要占额度，给它们留出 512 KiB。
    const NON_LOG_RESERVE: u64 = 512 * 1024;
    let log_dir = dir.join("日志");
    if let Err(error) = fs::create_dir_all(&log_dir) {
        return Err(ReportError::internal(format!("创建日志目录失败：{error}")));
    }
    restrict_dir(&log_dir);

    for source in log_sources(&ctx.data_dir) {
        let budget = LOG_FILE_LIMIT.min(
            TOTAL_LIMIT
                .saturating_sub(NON_LOG_RESERVE)
                .saturating_sub(total_written),
        );
        let tail = if source.path.is_file() && budget > 0 {
            read_tail(&source.path, input.log_lines, budget)
        } else {
            None
        };
        match tail {
            Some((lines, truncated)) => {
                let redacted: Vec<String> =
                    lines.iter().map(|line| redact_text(&mut redactor, line)).collect();
                let mut text = redacted.join("\n");
                if !text.is_empty() {
                    text.push('\n');
                }
                if text.len() as u64 > budget {
                    // 极少见：先按字节截断，再补一行说明。
                    let mut cut = budget as usize;
                    while cut > 0 && !text.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    text.truncate(cut);
                    text.push_str("（日志超过单份上限，已截断）\n");
                }
                let bytes = text.as_bytes().len() as u64;
                total_written += bytes;
                write_atomic(&log_dir, &source.name, text.as_bytes())
                    .map_err(|error| ReportError::invalid("report_dir_unwritable", format!("写日志失败：{error}")))?;
                let line_count = text.lines().count();
                files.push(json!({
                    "name": format!("日志/{}", source.name),
                    "bytes": bytes,
                    "lines": line_count,
                    "truncated": truncated,
                    "missing": false,
                }));
                log_files_json.push(json!({
                    "name": source.name,
                    "lines": line_count,
                    "truncated": truncated,
                    "missing": false,
                    "redacted": true,
                }));
                logs_material.push(json!({
                    "name": source.name,
                    "start_line": 1,
                    "lines": redacted
                        .iter()
                        .map(|line| clip_chars(line, 500))
                        .collect::<Vec<_>>(),
                    "total_lines": line_count,
                }));
            }
            None => {
                files.push(json!({
                    "name": format!("日志/{}", source.name),
                    "bytes": 0,
                    "lines": null,
                    "truncated": false,
                    "missing": true,
                }));
                log_files_json.push(json!({
                    "name": source.name,
                    "lines": 0,
                    "truncated": false,
                    "missing": true,
                    "redacted": true,
                }));
            }
        }
    }

    cap_material_lines(&mut logs_material);

    let report_text = match (&input.report_markdown, phase) {
        (Some(markdown), "written") => {
            redact_text(&mut redactor, &ensure_report_structure(markdown))
        }
        _ => template_report(ctx, &mut redactor),
    };
    let report_bytes = report_text.as_bytes();
    let (report_text, report_truncated) = if report_bytes.len() > REPORT_MD_FILE_LIMIT {
        (clip_chars(&report_text, REPORT_MD_FILE_LIMIT / 4), true)
    } else {
        (report_text, false)
    };
    write_atomic(&dir, "报告.md", report_text.as_bytes())
        .map_err(|error| ReportError::invalid("report_dir_unwritable", format!("写报告失败：{error}")))?;
    files.push(json!({
        "name": "报告.md",
        "bytes": report_text.len(),
        "lines": report_text.lines().count(),
        "truncated": report_truncated,
        "missing": false,
    }));

    let scene = scene_json(&report_id, ctx, &mut redactor, domains_included, &log_files_json);
    let scene_bytes = fit_json(scene);
    write_atomic(&dir, "现场.json", &scene_bytes)
        .map_err(|error| ReportError::invalid("report_dir_unwritable", format!("写现场失败：{error}")))?;
    files.push(json!({
        "name": "现场.json",
        "bytes": scene_bytes.len(),
        "lines": null,
        "truncated": scene_bytes.len() >= SCENE_JSON_LIMIT,
        "missing": false,
    }));

    let guide = guide_text(&dir);
    write_atomic(&dir, "先看我.txt", guide.as_bytes())
        .map_err(|error| ReportError::invalid("report_dir_unwritable", format!("写说明失败：{error}")))?;
    files.push(json!({
        "name": "先看我.txt",
        "bytes": guide.len(),
        "lines": guide.lines().count(),
        "truncated": false,
        "missing": false,
    }));

    let dir = match final_root {
        Some(root) => {
            write_atomic(&staging, ".report-id", report_id.as_bytes()).map_err(|error| {
                ReportError::invalid("report_dir_unwritable", format!("写报告编号失败：{error}"))
            })?;
            commit_staging(&staging, &root, now).map_err(|error| {
                ReportError::invalid("report_dir_unwritable", format!("保存报告目录失败：{error}"))
            })?
        }
        None => {
            write_atomic(&staging, ".report-id", report_id.as_bytes()).map_err(|error| {
                ReportError::invalid("report_dir_unwritable", format!("写报告编号失败：{error}"))
            })?;
            staging
        }
    };
    register(&report_id, &dir, session_id);

    let mut data = json!({
        "report_id": report_id,
        "report_dir": public_dir(&dir),
        "phase": phase,
        "files": files,
        "redactions": counts_json(redactor.counts(), if domains_included { "detailed" } else { "minimal" }),
        "ai_report": phase == "written",
    });
    if phase == "collected" {
        data["materials"] = json!({
            "runtime": materials_runtime,
            "checks": materials_checks,
            "logs": logs_material,
            "domains_included": domains_included,
        });
    }
    Ok(data)
}

/// 模型可见日志上限：4 份 × log_lines，合计 ≤400 行；超了优先保留 runtime 与 sing-box。
/// 截断从最早的行开始（保留最接近故障的尾部），并同步修正 `start_line`。
fn cap_material_lines(logs: &mut [Value]) {
    const TOTAL_LINES: usize = 400;
    let line_count = |entry: &Value| entry["lines"].as_array().map_or(0, Vec::len);
    let total = |logs: &[Value]| logs.iter().map(line_count).sum::<usize>();
    let priority = |entry: &Value| {
        entry["name"]
            .as_str()
            .is_some_and(|name| name.starts_with("runtime-") || name == "sing-box.log")
    };

    while total(logs) > TOTAL_LINES {
        let mut candidate: Option<usize> = None;
        let mut longest = 0usize;
        for (index, entry) in logs.iter().enumerate() {
            if priority(entry) {
                continue;
            }
            let len = line_count(entry);
            if len > longest {
                longest = len;
                candidate = Some(index);
            }
        }
        match candidate {
            Some(index) => {
                if let Some(lines) = logs[index]["lines"].as_array_mut() {
                    lines.remove(0);
                }
            }
            None => break,
        }
    }
    while total(logs) > TOTAL_LINES {
        let mut candidate: Option<usize> = None;
        let mut longest = 0usize;
        for (index, entry) in logs.iter().enumerate() {
            let len = line_count(entry);
            if len > longest {
                longest = len;
                candidate = Some(index);
            }
        }
        let Some(index) = candidate else { break };
        if let Some(lines) = logs[index]["lines"].as_array_mut() {
            lines.remove(0);
        }
    }

    for entry in logs.iter_mut() {
        let kept = line_count(entry);
        let total_lines = entry["total_lines"].as_u64().unwrap_or(kept as u64) as usize;
        let start = total_lines.saturating_sub(kept) + 1;
        entry["start_line"] = json!(start);
    }
}

/// 同一会话复用同一目录；换会话或用户删了目录才新建。
fn existing_session(session_id: &str) -> Option<(String, PathBuf)> {
    let registry = lock_registry();
    let report_id = registry.sessions.get(session_id)?;
    let dir = registry.dirs.get(report_id)?;
    dir.is_dir().then(|| (report_id.clone(), dir.clone()))
}

// ---------------------------------------------------------------------------
// 两个动作命令
// ---------------------------------------------------------------------------

pub fn reveal(report_id: &str, root: &Path) -> Result<Value, ReportError> {
    let dir = lookup(report_id, root)
        .ok_or_else(|| ReportError::not_found("找不到这份报告，请重新生成"))?;
    let opened = open_in_file_manager(&dir);
    Ok(json!({
        "opened": opened,
        "method": "reveal",
        "report_dir": public_dir(&dir),
        "body_chars": 0,
    }))
}

pub fn compose_mail(report_id: &str, root: &Path) -> Result<Value, ReportError> {
    let dir = lookup(report_id, root)
        .ok_or_else(|| ReportError::not_found("找不到这份报告，请重新生成"))?;
    let report = fs::read_to_string(dir.join("报告.md"))
        .map_err(|_| ReportError::not_found("报告文件已经不在了，请重新生成"))?;
    let scene: Value = fs::read_to_string(dir.join("现场.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let subject = mail_subject(&report, &scene);
    let body = mail_body(&report);
    // 编码后仍超限就不要交给客户端（会被截断）：直接返回 copy_only 的可复制正文。
    let opened = encoded_len(&body) <= MAILTO_BODY_LIMIT_BYTES
        && open_mail_client(&subject, &body);
    Ok(mail_action(&dir, &body, opened))
}

/// 邮件命令的返回形状。
///
/// 调不起邮件客户端时**必须把正文带回去**：UI 的兜底是「复制正文」，
/// 没有正文这个按钮就没有内容可复制。打开成功时不回传（`null`），
/// 避免把整份正文再走一遍前端。
fn mail_action(dir: &Path, body: &str, opened: bool) -> Value {
    json!({
        "opened": opened,
        "method": if opened { "mail_client" } else { "copy_only" },
        "report_dir": public_dir(&dir),
        "body_chars": body.chars().count(),
        "body": if opened { Value::Null } else { json!(body) },
    })
}

fn mail_subject(report: &str, scene: &Value) -> String {
    let when = scene
        .get("generated_at")
        .and_then(Value::as_str)
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .map(|at| at.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d %H:%M").to_string());
    let platform = scene
        .get("platform")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let code = scene
        .get("last_error")
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .or_else(|| {
            report
                .lines()
                .find_map(|line| line.trim().strip_prefix("错误码："))
        })
        .unwrap_or("问题反馈");
    let subject = format!("[Veyl 问题报告] {when} {platform} · {code}");
    subject.chars().take(80).collect()
}

/// 正文 = 报告全文 + 附件提示，按 **percent-encoding 后** 的长度限 7500 字节。
///
/// 裁剪顺序：时间线 → 下一步建议 → 可疑点证据 → 现象/环境内容。
/// **开头声明（含 `***` 图例）与附件提示永不删除**：没有图例，收件人会把
/// `***.google.com` 当成真实域名。
pub fn mail_body(report: &str) -> String {
    const HINT: &str = "\n\n附件请附上同目录的 现场.json 与 日志/。";
    const NOTE: &str = "\n\n正文已截断，完整内容见附件里的 报告.md。";

    let (preamble, mut sections) = split_sections(report);
    let assemble = |sections: &[MailSection]| {
        let mut body = preamble.clone();
        for section in sections {
            body.push_str(&format!("\n\n{}\n{}", section.heading, section.body));
        }
        body.push_str(HINT);
        body
    };

    let mut truncated = false;
    loop {
        let body = assemble(&sections);
        if encoded_len(&body) <= MAILTO_BODY_LIMIT_BYTES {
            return if truncated {
                // 在附件提示前插一句说明；提示本身不动。
                body.replace(HINT, &format!("{NOTE}{HINT}"))
            } else {
                body
            };
        }
        // 1. 时间线整节
        if let Some(index) = section_index(&sections, "## 时间线") {
            sections.remove(index);
            truncated = true;
            continue;
        }
        // 2. 下一步建议只留第 1 条
        if let Some(section) = section_mut(&mut sections, "## 下一步建议") {
            if let Some(first) = section.body.lines().find(|line| {
                let line = line.trim_start();
                line.starts_with("1") || line.starts_with("- ") || line.starts_with("* ")
            }) {
                if section.body.trim() != first.trim() {
                    section.body = first.to_string();
                    truncated = true;
                    continue;
                }
            }
        }
        // 3. 可疑点只留每条的第一行证据
        if let Some(section) = section_mut(&mut sections, "## 可疑点") {
            let mut kept = Vec::new();
            let mut seen_evidence = false;
            for line in section.body.lines() {
                if line.trim_start().starts_with("证据") {
                    if seen_evidence {
                        truncated = true;
                        continue;
                    }
                    seen_evidence = true;
                }
                kept.push(line);
            }
            let next = kept.join("\n");
            if next != section.body {
                section.body = next;
                continue;
            }
        }
        // 4. 现象 / 环境：逐次截短内容，标题保留
        if let Some(section) = section_mut(&mut sections, "## 现象") {
            if section.body.chars().count() > 40 {
                let keep = section.body.chars().count() * 3 / 4;
                section.body = section.body.chars().take(keep).collect();
                truncated = true;
                continue;
            }
        }
        if let Some(section) = section_mut(&mut sections, "## 环境") {
            if section.body.chars().count() > 40 {
                let keep = section.body.chars().count() * 3 / 4;
                section.body = section.body.chars().take(keep).collect();
                truncated = true;
                continue;
            }
        }
        // 5. 兜底：只截断正文内容，声明（图例）与附件提示原样保留。
        let tail = format!("{NOTE}{HINT}");
        let budget = MAILTO_BODY_LIMIT_BYTES.saturating_sub(encoded_len(&tail));
        let mut content = preamble.clone();
        for section in &sections {
            content.push_str(&format!("\n\n{}\n{}", section.heading, section.body));
        }
        let mut cut = content.chars().count();
        while cut > 0 && encoded_len(&content) > budget {
            cut = cut.saturating_sub(64);
            content = content.chars().take(cut).collect();
        }
        return format!("{content}{tail}");
    }
}

struct MailSection {
    heading: String,
    body: String,
}

fn section_index(sections: &[MailSection], heading: &str) -> Option<usize> {
    sections.iter().position(|section| section.heading == heading)
}

fn section_mut<'a>(sections: &'a mut [MailSection], heading: &str) -> Option<&'a mut MailSection> {
    sections.iter_mut().find(|section| section.heading == heading)
}

/// 把报告拆成「开头声明」与按顺序的 `##` 节。开头声明原样保留。
fn split_sections(report: &str) -> (String, Vec<MailSection>) {
    let mut preamble = String::new();
    let mut sections: Vec<MailSection> = Vec::new();
    for line in report.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            sections.push(MailSection {
                heading: format!("## {heading}"),
                body: String::new(),
            });
            continue;
        }
        match sections.last_mut() {
            Some(section) => {
                if !section.body.is_empty() {
                    section.body.push('\n');
                }
                section.body.push_str(line);
            }
            None => {
                if !preamble.is_empty() {
                    preamble.push('\n');
                }
                preamble.push_str(line);
            }
        }
    }
    (preamble, sections)
}

fn encoded_len(text: &str) -> usize {
    percent_encode(text).len()
}


fn open_in_file_manager(dir: &Path) -> bool {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("/usr/bin/open").arg(dir).status();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer.exe").arg(dir).status();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result: std::io::Result<std::process::ExitStatus> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "unsupported platform",
    ));
    result.map(|status| status.success()).unwrap_or(false)
}

fn open_mail_client(subject: &str, body: &str) -> bool {
    let url = format!(
        "mailto:{}?subject={}&body={}",
        FEEDBACK_EMAIL,
        percent_encode(subject),
        percent_encode(body)
    );
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("/usr/bin/open").arg(&url).status();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .status();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result: std::io::Result<std::process::ExitStatus> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "unsupported platform",
    ));
    result.map(|status| status.success()).unwrap_or(false)
}

fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests;
