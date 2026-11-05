//! 运行库升级：签名清单、下载、校验、安装。
//!
//! 这是**唯一**会联网获取运行时的路径，而且只能由用户在高级设置里显式发起。
//! 连接流程与 AI 工具都不再触发安装（`CoreInstall` 已从工具集删除）。
//!
//! 信任链：
//! 1. 固定 URL、HTTPS、禁止跳到其它主机、禁止 userinfo；
//! 2. 信封 `{ payload, sig, key_id }`，Ed25519 验的是 **base64 解码后的原始字节**，
//!    不做 JSON 规范化；
//! 3. schema / `generated_at`（30 天）/ `min_app_version` 任一不符即视为不可信；
//! 4. 下载后先比清单 `sha256`，再验平台签名——更新源上的产物必须是我们重签过的。
//!
//! 私钥永远不进仓库、日志或模型上下文；这里只读编译进二进制的公钥。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use super::archive;
use super::fsutil;
use super::install::{self, Installer, BINARY_NAME};
use super::manifest::ArchiveFormat;
use super::signature;

/// 清单地址固定，不接受调用方传入。
pub const MANIFEST_URL: &str = "https://updates.veyl.app/runtime/manifest-v1.json";
const MANIFEST_HOST: &str = "updates.veyl.app";
const MANIFEST_SCHEMA: u32 = 1;
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_REDIRECTS: usize = 3;
const MAX_MANIFEST_AGE_DAYS: i64 = 30;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
/// 检查 + 建任务的同步阶段上限；超时按 `NETWORK_UNREACHABLE`。
const UPGRADE_BUDGET: Duration = Duration::from_secs(12);

/// `NETWORK_UNREACHABLE / SOURCE_UNAVAILABLE / HASH_MISMATCH / DISK_FULL / BUSY / NOT_FOUND / INTERNAL`
#[derive(Debug, Clone, Serialize)]
pub struct UpdateError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl UpdateError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    fn with_details(
        code: &'static str,
        message: impl Into<String>,
        details: serde_json::Value,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            details: Some(details),
        }
    }

    fn unreachable(message: impl Into<String>) -> Self {
        Self::new("NETWORK_UNREACHABLE", message)
    }

    fn source(message: impl Into<String>) -> Self {
        Self::new("SOURCE_UNAVAILABLE", message)
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL", message)
    }

    fn busy() -> Self {
        Self::new("BUSY", "已有运行库升级在进行中")
    }

    /// 目标版本不高于当前版本：单独的结果，不静默降级。
    fn not_newer(current: &str, target: &str) -> Self {
        Self::with_details(
            "PRECONDITION_FAILED",
            format!("目标版本 {target} 不高于当前 {current}，无需升级"),
            serde_json::json!({
                "reason": "not_newer",
                "current_version": current,
                "target_version": target,
            }),
        )
    }
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ManifestEnvelope {
    pub payload: String,
    pub sig: String,
    pub key_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UpdateManifest {
    pub schema: u32,
    #[serde(default)]
    pub channel: String,
    pub generated_at: String,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default)]
    pub releases: Vec<UpdateRelease>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UpdateRelease {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub yanked: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub version: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheck {
    /// `ok` | `unreachable` | `source_error`
    pub network: &'static str,
    pub candidates: Vec<Candidate>,
    /// 结果来自本地缓存（联网检查失败）。界面不能把它当成实时结果。
    pub cached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

struct ActiveJob {
    id: String,
    cancel: Arc<AtomicBool>,
}

/// `core_upgrade` 的同步结果：调用方可以原样转述当前版本与目标版本。
#[derive(Debug, Clone, Serialize)]
pub struct StartedUpgrade {
    pub job_id: String,
    pub current_version: String,
    pub target_version: String,
}

struct PreparedUpgrade {
    release: UpdateRelease,
    current_version: String,
}

/// 可克隆：每个 `WiredServices` 持有一份，后台任务拿到自己的拷贝。
#[derive(Clone)]
pub struct UpdateManager {
    root: PathBuf,
    client: reqwest::Client,
    active: Arc<Mutex<Option<ActiveJob>>>,
    manifest_url: String,
    /// 测试用：缩短单次请求超时，避免重试测试真的等 10 秒。
    #[cfg(test)]
    request_timeout: Duration,
    /// 测试用：替换编译期公钥。
    #[cfg(test)]
    test_keys: Option<Vec<(String, [u8; 32])>>,
}

impl UpdateManager {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let client = reqwest::Client::builder()
            .user_agent(concat!("veyl/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(60))
            // 只允许同主机跳转：清单地址固定，跨主机跳转一律停。
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= MAX_REDIRECTS {
                    attempt.stop()
                } else if attempt.url().host_str() == Some(MANIFEST_HOST) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .unwrap_or_default();
        Self {
            root: root.into(),
            client,
            active: Arc::new(Mutex::new(None)),
            manifest_url: MANIFEST_URL.to_string(),
            #[cfg(test)]
            request_timeout: Duration::from_secs(5),
            #[cfg(test)]
            test_keys: None,
        }
    }

    /// 测试用：指向本地 HTTP 服务并缩短超时。
    #[cfg(test)]
    pub(crate) fn with_test_endpoint(mut self, url: String, timeout: Duration) -> Self {
        self.manifest_url = url;
        self.request_timeout = timeout;
        self
    }

    /// 测试用：用本地生成的密钥替换编译期公钥。
    #[cfg(test)]
    pub(crate) fn with_test_keys(mut self, keys: Vec<(String, [u8; 32])>) -> Self {
        self.test_keys = Some(keys);
        self
    }

    fn keys(&self) -> Vec<(String, [u8; 32])> {
        #[cfg(test)]
        if let Some(keys) = &self.test_keys {
            return keys.clone();
        }
        builtin_keys()
    }

    fn manifest_timeout(&self) -> Duration {
        #[cfg(test)]
        {
            self.request_timeout
        }
        #[cfg(not(test))]
        {
            Duration::from_secs(5)
        }
    }

    fn cache_path(&self) -> PathBuf {
        self.root.join("runtime").join("manifest-v1.json")
    }

    fn cache_sig_path(&self) -> PathBuf {
        self.root.join("runtime").join("manifest-v1.sig")
    }

    /// 检查更新。总是先联网；失败时可用缓存，但明确标记过期。
    pub async fn check(&self) -> Result<UpdateCheck, UpdateError> {
        match self.fetch_network().await {
            Ok(manifest) => {
                self.write_cache(&manifest);
                Ok(UpdateCheck {
                    network: "ok",
                    candidates: self.candidates(&manifest.manifest),
                    cached: false,
                    message: None,
                })
            }
            Err(error) => match self.read_cache() {
                Ok(manifest) => Ok(UpdateCheck {
                    network: if error.code == "NETWORK_UNREACHABLE" {
                        "unreachable"
                    } else {
                        "source_error"
                    },
                    candidates: self.candidates(&manifest),
                    cached: true,
                    message: Some(error.message),
                }),
                Err(_) => Err(error),
            },
        }
    }

    /// 启动一次升级。
    ///
    /// **不假设调用方已经检查过**：每次调用都重新拉取并验签清单、核对版本、
    /// 预检磁盘；任何一步失败都在建任务之前返回，不写临时文件、不发下载请求。
    /// 本地缓存一律不参与升级放行。
    pub async fn start(&self, version: &str) -> Result<StartedUpgrade, UpdateError> {
        if semver::Version::parse(version).is_err() {
            return Err(UpdateError::new("NOT_FOUND", "版本号格式不对"));
        }
        let job_id = format!("core-{:016x}", rand::random::<u64>());
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut active = self.active.lock().unwrap();
            if active.is_some() {
                return Err(UpdateError::busy());
            }
            *active = Some(ActiveJob {
                id: job_id.clone(),
                cancel: Arc::clone(&cancel),
            });
        }

        // 预留槽位之后再联网：并发的第二次调用会立刻得到 BUSY。
        let prepared = match self.prepare(version).await {
            Ok(prepared) => prepared,
            Err(error) => {
                self.active.lock().unwrap().take();
                return Err(error);
            }
        };

        let manager = self.clone();
        let task_job = job_id.clone();
        let task_release = prepared.release.clone();
        let task_version = prepared.release.version.clone();
        tauri::async_runtime::spawn(async move {
            let result = manager.run_job(&task_job, &task_release, &cancel).await;
            manager.finish(&result, &task_job, &task_version);
            manager.active.lock().unwrap().take();
        });

        Ok(StartedUpgrade {
            job_id,
            current_version: prepared.current_version,
            target_version: prepared.release.version,
        })
    }

    /// 是否有升级任务在进行中（`core_rollback` 用它返回 BUSY）。
    pub fn busy(&self) -> bool {
        self.active.lock().unwrap().is_some()
    }

    /// 进行中任务的 id，用于 `BUSY` 错误的 `details.job_id`。
    pub fn active_job_id(&self) -> Option<String> {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .map(|job| job.id.clone())
    }

    /// 拉取并验签**本次**清单，在全部未 yanked 的版本里找目标，再与当前版本比较。
    ///
    /// 候选展示与可升级判断是两层：展示层只列「新于本地」的版本，
    /// 这里必须能在**全部**未 yanked 版本里找到目标，才能对「相等/更低」给出
    /// 明确的 `not_newer`，而不是变成不可达分支。
    async fn prepare(&self, version: &str) -> Result<PreparedUpgrade, UpdateError> {
        let manifest = self.fetch_for_upgrade().await?.manifest;
        let release = manifest
            .releases
            .iter()
            .filter(|release| {
                release.platform == host_platform()
                    && release.arch == host_arch()
                    && !release.yanked
            })
            .find(|release| release.version == version)
            .cloned()
            .ok_or_else(|| UpdateError::new("NOT_FOUND", format!("清单里没有可用版本 {version}")))?;

        let current_version = self.current_version().await?;
        let current = semver::Version::parse(&current_version)
            .map_err(|_| UpdateError::internal("当前版本号不是 semver，无法比较"))?;
        let target = semver::Version::parse(&release.version)
            .map_err(|_| UpdateError::source("更新信息里的版本号不合法"))?;
        if target <= current {
            return Err(UpdateError::not_newer(&current_version, &release.version));
        }

        checked_url(&release.url)?;
        self.check_disk(release.size)?;
        Ok(PreparedUpgrade {
            release,
            current_version,
        })
    }

    /// 当前生效版本：已安装优先，否则随包。
    async fn current_version(&self) -> Result<String, UpdateError> {
        let installer = Installer::new(&self.root);
        if let Some(active) = installer.active().ok().flatten() {
            return Ok(active.version);
        }
        installer
            .bundled_version()
            .await
            .ok_or_else(|| UpdateError::new("NOT_FOUND", "没有可用的当前版本"))
    }

    /// 取消指定 job。只有 id 匹配且未结束时生效。
    pub fn cancel(&self, job_id: &str) -> bool {
        let active = self.active.lock().unwrap();
        match active.as_ref() {
            Some(job) if job.id == job_id => {
                job.cancel.store(true, Ordering::SeqCst);
                true
            }
            _ => false,
        }
    }

    fn finish(&self, result: &Result<(), UpdateError>, job_id: &str, version: &str) {
        let emitted_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let contract = crate::runtime::EVENT_CONTRACT_VERSION;
        let payload = match result {
            Ok(()) => serde_json::json!({
                "contract_version": contract,
                "job_id": job_id,
                "ok": true,
                "version": version,
                "emitted_at": emitted_at,
            }),
            Err(error) if error.code == "CANCELLED" => serde_json::json!({
                "contract_version": contract,
                "job_id": job_id,
                "ok": false,
                "code": "CANCELLED",
                "emitted_at": emitted_at,
            }),
            Err(error) => serde_json::json!({
                "contract_version": contract,
                "job_id": job_id,
                "ok": false,
                "code": error.code,
                "message": error.message,
                "emitted_at": emitted_at,
            }),
        };
        crate::agent::app_handle::emit(
            crate::claurst_session::events::EV_CORE_UPGRADE_FINISHED,
            payload,
        );
    }

    fn emit_progress(&self, job_id: &str, phase: &str, received: u64, total: u64) {
        crate::agent::app_handle::emit(
            crate::claurst_session::events::EV_CORE_UPGRADE_PROGRESS,
            serde_json::json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "job_id": job_id,
                "phase": phase,
                "received": received,
                "total": total,
                "emitted_at": chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            }),
        );
    }

    async fn run_job(
        &self,
        job_id: &str,
        release: &UpdateRelease,
        cancel: &AtomicBool,
    ) -> Result<(), UpdateError> {
        let url = checked_url(&release.url)?;
        self.check_disk(release.size)?;

        if cancel.load(Ordering::SeqCst) {
            return Err(UpdateError::new("CANCELLED", "已取消"));
        }

        let staging = self.root.join("runtime").join(".staging").join(&release.version);
        fsutil::remove_dir_if_exists(&staging).map_err(internal)?;
        fsutil::ensure_dir(&staging).map_err(internal)?;

        let result = self
            .download_and_install(job_id, release, &url, &staging, cancel)
            .await;

        if result.is_err() {
            let _ = fsutil::remove_dir_if_exists(&staging);
        }
        result
    }

    async fn download_and_install(
        &self,
        job_id: &str,
        release: &UpdateRelease,
        url: &reqwest::Url,
        staging: &Path,
        cancel: &AtomicBool,
    ) -> Result<(), UpdateError> {
        let format = release
            .format
            .as_deref()
            .map(archive_format)
            .unwrap_or_else(|| {
                if release.url.ends_with(".zip") {
                    ArchiveFormat::Zip
                } else {
                    ArchiveFormat::TarGz
                }
            });
        let archive_path = staging.join(format!("download.{}", format.extension()));

        let downloaded_sha = self
            .download(job_id, url, &archive_path, release.size, cancel)
            .await?;
        if !downloaded_sha.eq_ignore_ascii_case(&release.sha256) {
            return Err(UpdateError::new(
                "HASH_MISMATCH",
                format!("下载文件的 sha256 与清单不符（期望 {}，实际 {downloaded_sha}）", release.sha256),
            ));
        }

        if cancel.load(Ordering::SeqCst) {
            return Err(UpdateError::new("CANCELLED", "已取消"));
        }
        self.emit_progress(job_id, "verifying", release.size, release.size);

        self.emit_progress(job_id, "unpacking", release.size, release.size);
        archive::extract(&archive_path, staging, format).map_err(|error| {
            UpdateError::source(format!("解压更新包失败：{error}"))
        })?;
        let binary = locate_binary(staging)
            .ok_or_else(|| UpdateError::source("更新包里没有 sing-box"))?;

        // 更新源上的产物必须是我们重签过的。
        signature::verify_downloaded_runtime(&binary)
            .map_err(|detail| UpdateError::source(format!("更新包未通过签名校验：{detail}")))?;

        let reported = install::read_binary_version(&binary)
            .await
            .map_err(|error| UpdateError::source(format!("更新包无法运行：{error}")))?;
        if reported != release.version {
            return Err(UpdateError::source(format!(
                "更新包报告版本 {reported}，与清单的 {} 不一致",
                release.version
            )));
        }

        fsutil::set_executable(&binary).map_err(internal)?;
        let binary_sha = fsutil::sha256_file(&binary)
            .map_err(|error| UpdateError::internal(format!("计算运行时哈希失败：{error}")))?;
        let _ = std::fs::remove_file(&archive_path);

        if cancel.load(Ordering::SeqCst) {
            return Err(UpdateError::new("CANCELLED", "已取消"));
        }
        self.emit_progress(job_id, "installing", release.size, release.size);

        let installer = Installer::new(&self.root);
        installer
            .activate_staged(staging, &binary, &release.version, binary_sha)
            .map_err(|error| UpdateError::internal(format!("激活新版本失败：{error}")))?;
        log::info!("运行库已升级到 {}（签名校验通过）", release.version);
        Ok(())
    }

    async fn download(
        &self,
        job_id: &str,
        url: &reqwest::Url,
        dest: &Path,
        total: u64,
        cancel: &AtomicBool,
    ) -> Result<String, UpdateError> {
        let response = self
            .client
            .get(url.clone())
            .send()
            .await
            .map_err(|error| classify_request_error(&error))?;
        if !response.status().is_success() {
            return Err(UpdateError::source(format!(
                "下载地址返回 HTTP {}",
                response.status()
            )));
        }

        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|error| UpdateError::internal(format!("写入临时文件失败：{error}")))?;
        let mut hasher = sha2::Sha256::new();
        use sha2::Digest as _;
        let mut received: u64 = 0;
        let mut last_emit = Instant::now();
        let mut stream = response.bytes_stream();

        loop {
            if cancel.load(Ordering::SeqCst) {
                drop(file);
                let _ = std::fs::remove_file(dest);
                return Err(UpdateError::new("CANCELLED", "已取消"));
            }
            let Some(chunk) = stream.next().await else {
                break;
            };
            let chunk = chunk.map_err(|error| UpdateError::source(format!("下载中断：{error}")))?;
            received = received.saturating_add(chunk.len() as u64);
            if total > 0 && received > total {
                drop(file);
                let _ = std::fs::remove_file(dest);
                return Err(UpdateError::new(
                    "SOURCE_UNAVAILABLE",
                    "下载内容超过清单大小，已停止",
                ));
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|error| UpdateError::internal(format!("写入临时文件失败：{error}")))?;
            if last_emit.elapsed() >= PROGRESS_INTERVAL {
                self.emit_progress(job_id, "downloading", received, total);
                last_emit = Instant::now();
            }
        }

        file.flush()
            .await
            .map_err(|error| UpdateError::internal(format!("写入临时文件失败：{error}")))?;
        file.sync_all()
            .await
            .map_err(|error| UpdateError::internal(format!("写入临时文件失败：{error}")))?;
        drop(file);

        if total > 0 && received != total {
            let _ = std::fs::remove_file(dest);
            return Err(UpdateError::new(
                "SOURCE_UNAVAILABLE",
                format!("下载不完整（期望 {total} 字节，实际 {received}）"),
            ));
        }
        self.emit_progress(job_id, "downloading", received, total);
        Ok(hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }

    fn check_disk(&self, size: u64) -> Result<(), UpdateError> {
        let needed = size.saturating_mul(2).saturating_add(100 * 1024 * 1024);
        if let Some(free) = fsutil::free_space(&self.root) {
            if free < needed {
                return Err(UpdateError::new(
                    "DISK_FULL",
                    format!(
                        "磁盘空间不足：需要约 {} MB，可用 {} MB",
                        needed / (1024 * 1024),
                        free / (1024 * 1024)
                    ),
                ));
            }
        }
        Ok(())
    }

    /// 只返回**新于当前激活版本**的候选，按版本降序（契约 `CoreCheckUpdatesData`）。
    fn candidates(&self, manifest: &UpdateManifest) -> Vec<Candidate> {
        let active = Installer::new(&self.root)
            .active()
            .ok()
            .flatten()
            .map(|runtime| runtime.version);
        let active = active
            .as_deref()
            .and_then(|version| semver::Version::parse(version).ok());

        let mut items: Vec<(semver::Version, Candidate)> = manifest
            .releases
            .iter()
            .filter(|release| {
                release.platform == host_platform()
                    && release.arch == host_arch()
                    && !release.yanked
            })
            .filter_map(|release| {
                let version = semver::Version::parse(&release.version).ok()?;
                if active.as_ref().is_some_and(|active| version <= *active) {
                    return None;
                }
                Some((
                    version,
                    Candidate {
                        version: release.version.clone(),
                        size: release.size,
                    },
                ))
            })
            .collect();
        items.sort_by(|left, right| right.0.cmp(&left.0));
        items.into_iter().map(|(_, candidate)| candidate).collect()
    }

    async fn fetch_manifest_once(&self, no_cache: bool) -> Result<VerifiedManifest, UpdateError> {
        let url = checked_url(&self.manifest_url)?;
        let mut request = self.client.get(url).timeout(self.manifest_timeout());
        if no_cache {
            request = request.header(reqwest::header::CACHE_CONTROL, "no-cache");
        }
        let response = request
            .send()
            .await
            .map_err(|error| classify_request_error(&error))?;
        if !response.status().is_success() {
            return Err(UpdateError::source(format!(
                "更新服务返回 HTTP {}",
                response.status()
            )));
        }
        if let Some(length) = response.content_length() {
            if length as usize > MAX_MANIFEST_BYTES {
                return Err(UpdateError::source("更新信息超出大小上限"));
            }
        }

        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|error| UpdateError::source(format!("读取更新信息失败：{error}")))?;
            if body.len() + chunk.len() > MAX_MANIFEST_BYTES {
                return Err(UpdateError::source("更新信息超出大小上限"));
            }
            body.extend_from_slice(&chunk);
        }

        verify_envelope(&body, &self.keys())
    }

    /// 展示用：允许回退缓存。
    async fn fetch_network(&self) -> Result<VerifiedManifest, UpdateError> {
        self.fetch_manifest_once(false).await
    }

    /// 升级用：**禁止缓存**，只对网络不可达重试一次，整体不超过 12 秒。
    async fn fetch_for_upgrade(&self) -> Result<VerifiedManifest, UpdateError> {
        let started = Instant::now();
        let mut attempt = 0;
        loop {
            attempt += 1;
            match self.fetch_manifest_once(true).await {
                Ok(manifest) => return Ok(manifest),
                Err(error) if error.code == "NETWORK_UNREACHABLE" && attempt == 1 => {
                    if started.elapsed() >= UPGRADE_BUDGET {
                        return Err(UpdateError::unreachable("检查更新超时"));
                    }
                    // 只重试一次，且只针对网络不可达；其它错误立即返回。
                    continue;
                }
                Err(error) => {
                    if started.elapsed() > UPGRADE_BUDGET {
                        return Err(UpdateError::unreachable("检查更新超时"));
                    }
                    return Err(error);
                }
            }
        }
    }

    fn write_cache(&self, manifest: &VerifiedManifest) {
        if let Err(error) = fsutil::ensure_dir(&self.root.join("runtime")) {
            log::warn!("写更新缓存失败：{error}");
            return;
        }
        let _ = fsutil::write_atomic_private(&self.cache_path(), &manifest.raw_envelope);
        let _ = fsutil::write_atomic_private(
            &self.cache_sig_path(),
            manifest.envelope.sig.as_bytes(),
        );
    }

    fn read_cache(&self) -> Result<UpdateManifest, UpdateError> {
        let raw = std::fs::read(self.cache_path())
            .map_err(|_| UpdateError::source("本地没有可用的更新信息"))?;
        verify_envelope(&raw, &self.keys()).map(|verified| verified.manifest)
    }
}

pub(crate) struct VerifiedManifest {
    manifest: UpdateManifest,
    envelope: ManifestEnvelope,
    raw_envelope: Vec<u8>,
}

/// 固定主机的 HTTPS 地址；拒绝 userinfo 与其它 schema。
///
/// 测试构建允许 `http://127.0.0.1:<port>`（单元测试用本地服务模拟更新源）；
/// 发布构建没有这个分支。
fn checked_url(raw: &str) -> Result<reqwest::Url, UpdateError> {
    let url = reqwest::Url::parse(raw)
        .map_err(|error| UpdateError::source(format!("地址无效：{error}")))?;
    let local_test = cfg!(test) && url.host_str() == Some("127.0.0.1");
    if url.scheme() != "https" && !local_test {
        return Err(UpdateError::source("更新地址必须是 HTTPS"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(UpdateError::source("更新地址不能包含凭据"));
    }
    Ok(url)
}

fn classify_request_error(error: &reqwest::Error) -> UpdateError {
    if error.is_timeout() || error.is_connect() {
        UpdateError::unreachable(format!("无法连接更新服务：{error}"))
    } else {
        UpdateError::source(format!("请求更新服务失败：{error}"))
    }
}

fn archive_format(value: &str) -> ArchiveFormat {
    if value.eq_ignore_ascii_case("zip") {
        ArchiveFormat::Zip
    } else {
        ArchiveFormat::TarGz
    }
}

fn internal(error: super::error::RuntimeError) -> UpdateError {
    UpdateError::internal(error.to_string())
}

fn locate_binary(root: &Path) -> Option<PathBuf> {
    let direct = root.join(BINARY_NAME);
    if direct.is_file() {
        return Some(direct);
    }
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().ok()?.is_dir() {
            continue;
        }
        let candidate = entry.path().join(BINARY_NAME);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn host_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    }
}

/// 编译进二进制的公钥（`key_id=hex`，逗号分隔）。私钥永不进仓库。
pub fn builtin_keys() -> Vec<(String, [u8; 32])> {
    parse_keys(env!("VEYL_UPDATE_PUBKEYS"))
}

fn parse_keys(raw: &str) -> Vec<(String, [u8; 32])> {
    raw.split(',')
        .filter_map(|item| {
            let (id, hex_key) = item.trim().split_once('=')?;
            let bytes = hex::decode(hex_key.trim()).ok()?;
            let key: [u8; 32] = bytes.try_into().ok()?;
            Some((id.trim().to_string(), key))
        })
        .collect()
}

/// 验信封、解析 payload、检查 schema / 有效期 / 最低 App 版本。
///
/// 验的是 base64 解码后的原始字节——签名覆盖的就是这些字节，不做 JSON 规范化。
pub(crate) fn verify_envelope(
    raw: &[u8],
    keys: &[(String, [u8; 32])],
) -> Result<VerifiedManifest, UpdateError> {
    let envelope: ManifestEnvelope = serde_json::from_slice(raw)
        .map_err(|error| UpdateError::source(format!("更新信息格式不对：{error}")))?;
    let payload = base64::engine::general_purpose::STANDARD
        .decode(envelope.payload.trim())
        .map_err(|_| UpdateError::source("更新信息无法验证，已停止"))?;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(envelope.sig.trim())
        .map_err(|_| UpdateError::source("更新信息无法验证，已停止"))?;
    let Some((_, key)) = keys.iter().find(|(id, _)| id == &envelope.key_id) else {
        return Err(UpdateError::source("更新信息无法验证，已停止"));
    };
    UnparsedPublicKey::new(&ED25519, key)
        .verify(&payload, &signature)
        .map_err(|_| UpdateError::source("更新信息无法验证，已停止"))?;

    let manifest: UpdateManifest = serde_json::from_slice(&payload)
        .map_err(|error| UpdateError::source(format!("更新信息无法验证，已停止：{error}")))?;
    if manifest.schema != MANIFEST_SCHEMA {
        return Err(UpdateError::source("更新信息无法验证，已停止"));
    }

    let generated = DateTime::parse_from_rfc3339(&manifest.generated_at)
        .map_err(|_| UpdateError::source("更新信息无法验证，已停止"))?
        .with_timezone(&Utc);
    let age = Utc::now().signed_duration_since(generated);
    if age.num_days() > MAX_MANIFEST_AGE_DAYS || age.num_seconds() < -3600 {
        return Err(UpdateError::source("更新信息已过期，已停止"));
    }

    if let Some(minimum) = manifest.min_app_version.as_deref() {
        let required = semver::Version::parse(minimum)
            .map_err(|_| UpdateError::source("更新信息无法验证，已停止"))?;
        let current = semver::Version::parse(env!("CARGO_PKG_VERSION"))
            .map_err(|_| UpdateError::internal("当前版本号不是 semver"))?;
        if required > current {
            return Err(UpdateError::source(format!(
                "这份更新需要 Veyl {minimum} 或更高版本，请先升级应用"
            )));
        }
    }

    if manifest.releases.iter().any(|release| {
        reqwest::Url::parse(&release.url)
            .map(|url| url.scheme() != "https" || !url.username().is_empty())
            .unwrap_or(true)
    }) {
        return Err(UpdateError::source("更新信息里的下载地址不可信，已停止"));
    }

    Ok(VerifiedManifest {
        manifest,
        envelope,
        raw_envelope: raw.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn sign_payload(payload: &[u8]) -> (Vec<u8>, String) {
        let pair = Ed25519KeyPair::from_seed_unchecked(&[7u8; 32]).unwrap();
        let public = pair.public_key().as_ref().to_vec();
        let signature = pair.sign(payload);
        let envelope = serde_json::json!({
            "payload": base64::engine::general_purpose::STANDARD.encode(payload),
            "sig": base64::engine::general_purpose::STANDARD.encode(signature.as_ref()),
            "key_id": "test",
        });
        (serde_json::to_vec(&envelope).unwrap(), hex::encode(public))
    }

    fn manifest_json(generated_at: &str, min_app: &str, release_url: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schema": 1,
            "channel": "stable",
            "generated_at": generated_at,
            "min_app_version": min_app,
            "releases": [{
                "version": "1.15.0",
                "platform": host_platform(),
                "arch": host_arch(),
                "url": release_url,
                "sha256": "0".repeat(64),
                "size": 1024
            }]
        }))
        .unwrap()
    }

    fn keys(raw: &str) -> Vec<(String, [u8; 32])> {
        parse_keys(raw)
    }

    #[test]
    fn a_signed_manifest_is_accepted() {
        let (envelope, public) = sign_payload(&manifest_json(
            &Utc::now().to_rfc3339(),
            "0.0.0",
            "https://updates.veyl.app/x.tar.gz",
        ));
        let verified = verify_envelope(&envelope, &keys(&format!("test={public}"))).unwrap();
        assert_eq!(verified.manifest.releases[0].version, "1.15.0");
    }

    #[test]
    fn a_tampered_payload_is_rejected() {
        let (envelope, public) = sign_payload(&manifest_json(
            &Utc::now().to_rfc3339(),
            "0.0.0",
            "https://updates.veyl.app/x.tar.gz",
        ));
        // 改 payload（base64）里的一个字符，签名就对不上。
        let mut value: serde_json::Value = serde_json::from_slice(&envelope).unwrap();
        let payload = value["payload"].as_str().unwrap().to_string();
        let mut chars: Vec<char> = payload.chars().collect();
        let index = chars.len() / 2;
        chars[index] = if chars[index] == 'A' { 'B' } else { 'A' };
        value["payload"] = serde_json::Value::String(chars.into_iter().collect());
        let tampered = serde_json::to_vec(&value).unwrap();

        let error = verify_envelope(&tampered, &keys(&format!("test={public}")))
            .err()
            .expect("篡改必须被拒");
        assert_eq!(error.code, "SOURCE_UNAVAILABLE");
    }

    #[test]
    fn an_unknown_key_id_is_rejected() {
        let (envelope, public) = sign_payload(&manifest_json(
            &Utc::now().to_rfc3339(),
            "0.0.0",
            "https://updates.veyl.app/x.tar.gz",
        ));
        let error = verify_envelope(&envelope, &keys(&format!("other={public}"))).err().unwrap();
        assert_eq!(error.code, "SOURCE_UNAVAILABLE");
    }

    #[test]
    fn a_stale_manifest_is_rejected() {
        let old = (Utc::now() - chrono::Duration::days(31)).to_rfc3339();
        let (envelope, public) = sign_payload(&manifest_json(
            &old,
            "0.0.0",
            "https://updates.veyl.app/x.tar.gz",
        ));
        let error = verify_envelope(&envelope, &keys(&format!("test={public}")))
            .err()
            .unwrap();
        assert_eq!(error.code, "SOURCE_UNAVAILABLE");
    }

    #[test]
    fn a_newer_minimum_app_version_is_rejected() {
        let (envelope, public) = sign_payload(&manifest_json(
            &Utc::now().to_rfc3339(),
            "99.0.0",
            "https://updates.veyl.app/x.tar.gz",
        ));
        let error = verify_envelope(&envelope, &keys(&format!("test={public}")))
            .err()
            .unwrap();
        assert_eq!(error.code, "SOURCE_UNAVAILABLE");
    }

    #[test]
    fn a_non_https_release_url_is_rejected() {
        let (envelope, public) = sign_payload(&manifest_json(
            &Utc::now().to_rfc3339(),
            "0.0.0",
            "http://updates.veyl.app/x.tar.gz",
        ));
        assert!(verify_envelope(&envelope, &keys(&format!("test={public}"))).is_err());
    }

    #[test]
    fn urls_with_credentials_are_rejected() {
        assert!(checked_url("https://user:pass@updates.veyl.app/x").is_err());
        assert!(checked_url("http://updates.veyl.app/x").is_err());
        assert!(checked_url("https://updates.veyl.app/x").is_ok());
    }

    fn release(version: &str) -> UpdateRelease {
        UpdateRelease {
            version: version.into(),
            platform: host_platform().into(),
            arch: host_arch().into(),
            url: format!("https://updates.veyl.app/{version}.tar.gz"),
            sha256: "0".repeat(64),
            size: 1,
            format: Some("tar.gz".into()),
            yanked: false,
        }
    }

    fn manifest_with(releases: Vec<UpdateRelease>) -> UpdateManifest {
        UpdateManifest {
            schema: 1,
            channel: "stable".into(),
            generated_at: Utc::now().to_rfc3339(),
            min_app_version: None,
            releases,
        }
    }

    #[test]
    fn candidates_are_newer_than_active_and_sorted_desc() {
        let dir = std::env::temp_dir().join(format!("veyl-cand-{:016x}", rand::random::<u64>()));
        fsutil::ensure_dir(&dir).unwrap();
        let manager = UpdateManager::new(&dir);

        let mut manifest = manifest_with(vec![
            release("1.14.4"),
            release("1.15.0"),
            release("1.14.10"),
        ]);
        let versions: Vec<String> = manager
            .candidates(&manifest)
            .into_iter()
            .map(|candidate| candidate.version)
            .collect();
        assert_eq!(versions, vec!["1.15.0", "1.14.10", "1.14.4"]);

        // 激活 1.14.10 之后，只应看到更新的 1.15.0。
        let runtime_dir = dir.join("runtime").join("1.14.10");
        fsutil::ensure_dir(&runtime_dir).unwrap();
        std::fs::write(runtime_dir.join(BINARY_NAME), b"fake").unwrap();
        let state = serde_json::json!({
            "schema": 1,
            "active_version": "1.14.10",
            "installs": {
                "1.14.10": {
                    "version": "1.14.10",
                    "dir": runtime_dir,
                    "binary": runtime_dir.join(BINARY_NAME),
                    "sha256": "0".repeat(64),
                    "installed_at": 1
                }
            }
        });
        fsutil::write_atomic_json(
            &dir.join(crate::runtime::install::STATE_FILE),
            &state,
        )
        .unwrap();

        let versions: Vec<String> = manager
            .candidates(&manifest)
            .into_iter()
            .map(|candidate| candidate.version)
            .collect();
        assert_eq!(versions, vec!["1.15.0"]);

        manifest.releases.push(UpdateRelease {
            platform: "windows".into(),
            ..release("9.0.0")
        });
        let versions: Vec<String> = manager
            .candidates(&manifest)
            .into_iter()
            .map(|candidate| candidate.version)
            .collect();
        assert_eq!(versions, vec!["1.15.0"], "别的平台不能出现在候选里");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn only_one_upgrade_runs_at_a_time() {        let dir = std::env::temp_dir().join(format!("veyl-updates-{:016x}", rand::random::<u64>()));
        let manager = UpdateManager::new(&dir);
        // 不真正启动任务：只验证 active 槽位的行为。
        manager.active.lock().unwrap().replace(ActiveJob {
            id: "job-1".into(),
            cancel: Arc::new(AtomicBool::new(false)),
        });
        assert!(manager.busy());
        assert_eq!(manager.active_job_id().as_deref(), Some("job-1"));
        assert_eq!(
            manager.start("1.15.0").await.err().unwrap().code,
            "BUSY",
            "槽位被占用时不能再起第二个任务"
        );
        assert!(manager.cancel("job-1"));
        assert!(!manager.cancel("other"));
    }

    /// 断网时必须是 NETWORK_UNREACHABLE，而不是笼统的失败——UI 要靠它
    /// 在进入下载之前就提示「网络不可用」。
    #[tokio::test]
    async fn a_closed_port_is_reported_as_unreachable() {
        let client = reqwest::Client::new();
        let error = client
            .get("http://127.0.0.1:9/")
            .send()
            .await
            .expect_err("本机 9 端口不应有服务");
        assert_eq!(classify_request_error(&error).code, "NETWORK_UNREACHABLE");
    }

    // ---------- 升级前的强制检查 ----------

    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("veyl-{tag}-{:016x}", rand::random::<u64>()));
        fsutil::ensure_dir(&dir).unwrap();
        dir
    }

    fn install_active(dir: &Path, version: &str) {
        let runtime_dir = dir.join("runtime").join(version);
        fsutil::ensure_dir(&runtime_dir).unwrap();
        std::fs::write(runtime_dir.join(BINARY_NAME), b"fake").unwrap();
        let state = serde_json::json!({
            "schema": 1,
            "active_version": version,
            "installs": {
                (version): {
                    "version": version,
                    "dir": runtime_dir,
                    "binary": runtime_dir.join(BINARY_NAME),
                    "sha256": "0".repeat(64),
                    "installed_at": 1
                }
            }
        });
        fsutil::write_atomic_json(&dir.join(crate::runtime::install::STATE_FILE), &state).unwrap();
    }

    fn manifest_value(version: &str, yanked: bool) -> serde_json::Value {
        serde_json::json!({
            "schema": 1,
            "channel": "stable",
            "generated_at": Utc::now().to_rfc3339(),
            "min_app_version": "0.0.0",
            "releases": [{
                "version": version,
                "platform": host_platform(),
                "arch": host_arch(),
                "url": "https://updates.veyl.app/x.tar.gz",
                "sha256": "0".repeat(64),
                "size": 1024,
                "yanked": yanked
            }]
        })
    }

    fn signed(manifest: &serde_json::Value) -> (Vec<u8>, Vec<(String, [u8; 32])>) {
        let payload = serde_json::to_vec(manifest).unwrap();
        let (envelope, public) = sign_payload(&payload);
        (envelope, parse_keys(&format!("test={public}")))
    }

    /// 本地 HTTP 服务：最多响应 `max` 次，返回访问次数计数。
    fn serve(envelope: Vec<u8>, max: usize) -> (String, Arc<AtomicUsize>) {
        use std::io::{Read, Write};
        use std::sync::atomic::AtomicUsize;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&requests);
        std::thread::spawn(move || {
            for _ in 0..max {
                let Ok((mut socket, _)) = listener.accept() else {
                    break;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    envelope.len()
                );
                let _ = socket.write_all(head.as_bytes());
                let _ = socket.write_all(&envelope);
            }
        });
        (format!("http://127.0.0.1:{port}/manifest-v1.json"), requests)
    }

    fn closed_endpoint() -> String {
        "http://127.0.0.1:9/manifest-v1.json".to_string()
    }

    #[tokio::test]
    async fn a_network_failure_creates_no_job() {
        let dir = temp_dir("upgrade-offline");
        let manager = UpdateManager::new(&dir).with_test_endpoint(closed_endpoint(), Duration::from_millis(200));
        let error = manager.start("1.15.0").await.err().expect("断网必须失败");
        assert_eq!(error.code, "NETWORK_UNREACHABLE");
        assert!(!manager.busy(), "失败后不能留下任务槽位");
        assert!(manager.active_job_id().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_cached_manifest_never_authorizes_an_upgrade() {
        let dir = temp_dir("upgrade-cache");
        install_active(&dir, "1.14.4");
        let (envelope, keys) = signed(&manifest_value("1.15.0", false));
        // 把一份「看起来可用」的清单放进缓存。
        fsutil::ensure_dir(&dir.join("runtime")).unwrap();
        std::fs::write(dir.join("runtime/manifest-v1.json"), &envelope).unwrap();
        std::fs::write(dir.join("runtime/manifest-v1.sig"), b"cached").unwrap();

        let manager = UpdateManager::new(&dir)
            .with_test_endpoint(closed_endpoint(), Duration::from_millis(200))
            .with_test_keys(keys);
        let error = manager.start("1.15.0").await.err().expect("缓存不能放行升级");
        assert_eq!(error.code, "NETWORK_UNREACHABLE");
        assert!(!manager.busy());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_equal_or_older_version_is_not_newer() {
        let dir = temp_dir("upgrade-not-newer");
        install_active(&dir, "1.15.0");

        for target in ["1.15.0", "1.14.4"] {
            let (envelope, keys) = signed(&manifest_value(target, false));
            let (url, _) = serve(envelope, 2);
            let manager = UpdateManager::new(&dir)
                .with_test_endpoint(url, Duration::from_secs(2))
                .with_test_keys(keys);

            let error = manager.start(target).await.err().expect("不能升级到不更新的版本");
            assert_eq!(error.code, "PRECONDITION_FAILED", "{target}");
            let details = error.details.expect("要带 current_version");
            assert_eq!(details["reason"], "not_newer");
            assert_eq!(details["current_version"], "1.15.0");
            assert_eq!(details["target_version"], target);
            assert!(!manager.busy(), "拒绝时不能建任务");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_yanked_version_is_not_offered() {
        let dir = temp_dir("upgrade-yanked");
        install_active(&dir, "1.14.4");
        let (envelope, keys) = signed(&manifest_value("1.15.0", true));
        let (url, _) = serve(envelope, 2);

        let manager = UpdateManager::new(&dir)
            .with_test_endpoint(url, Duration::from_secs(2))
            .with_test_keys(keys);
        let error = manager.start("1.15.0").await.err().expect("yanked 不能升级");
        assert_eq!(error.code, "NOT_FOUND");
        assert!(!manager.busy());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_network_timeout_is_retried_exactly_once() {
        use std::io::Read;
        use std::sync::atomic::AtomicUsize;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&requests);
        std::thread::spawn(move || {
            let mut accepted = 0;
            while accepted < 2 {
                let Ok((mut socket, _)) = listener.accept() else {
                    break;
                };
                accepted += 1;
                counter.fetch_add(1, Ordering::SeqCst);
                // 每个连接都不响应，让客户端超时；连接在独立线程里保持一会儿。
                std::thread::spawn(move || {
                    let mut buf = [0u8; 1024];
                    let _ = socket.read(&mut buf);
                    std::thread::sleep(Duration::from_millis(500));
                });
            }
        });

        let dir = temp_dir("upgrade-retry");
        let manager = UpdateManager::new(&dir).with_test_endpoint(
            format!("http://127.0.0.1:{port}/manifest-v1.json"),
            Duration::from_millis(100),
        );
        let started = Instant::now();
        let error = manager.start("1.15.0").await.err().expect("两次超时都要失败");
        assert_eq!(error.code, "NETWORK_UNREACHABLE");
        // 接受连接的计数可能略晚于客户端超时，等一小会儿再断言。
        let deadline = Instant::now() + Duration::from_secs(1);
        while requests.load(Ordering::SeqCst) < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(requests.load(Ordering::SeqCst), 2, "只重试一次");
        assert!(started.elapsed() < Duration::from_secs(12), "同步阶段要在 12 秒内结束");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
