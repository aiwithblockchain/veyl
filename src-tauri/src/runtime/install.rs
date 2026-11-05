use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
#[cfg(feature = "runtime-selftest")]
use std::sync::Arc;
#[cfg(feature = "runtime-selftest")]
use std::time::Duration;

#[cfg(feature = "runtime-selftest")]
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
#[cfg(feature = "runtime-selftest")]
use sha2::{Digest, Sha256};
#[cfg(feature = "runtime-selftest")]
use tokio::io::AsyncWriteExt;

#[cfg(feature = "runtime-selftest")]
use super::archive;
use super::error::{IoContext, RuntimeError, RuntimeResult};
use super::fsutil;
#[cfg(feature = "runtime-selftest")]
use super::manifest::Release;
use super::signature;

pub const STATE_FILE: &str = "runtime-state.json";
pub const BINARY_NAME: &str = if cfg!(windows) {
    "sing-box.exe"
} else {
    "sing-box"
};

/// 安装记录的来源：随包资源装进来的，还是显式升级下载的。
pub const SOURCE_BUNDLED: &str = "bundled";
pub const SOURCE_INSTALLED: &str = "installed";

fn default_source() -> String {
    SOURCE_INSTALLED.to_string()
}

#[cfg(feature = "runtime-selftest")]
#[derive(Debug, Clone, Copy)]
pub enum InstallProgress {
    Downloading { downloaded: u64, total: u64 },
    Verifying,
    Extracting,
    Activating,
}

#[cfg(feature = "runtime-selftest")]
pub type ProgressFn = Arc<dyn Fn(InstallProgress) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledRuntime {
    pub version: String,
    pub dir: PathBuf,
    pub binary: PathBuf,
    #[serde(default)]
    pub license: Option<PathBuf>,
    pub sha256: String,
    pub installed_at: i64,
    /// `bundled` 或 `installed`。旧状态文件没有这个字段，按「已安装」处理。
    #[serde(default = "default_source")]
    pub source: String,
}

impl InstalledRuntime {
    /// 启动日志与 `core_info.active_source` 用的人类可读标签。
    pub fn source_label(&self) -> &'static str {
        if self.source == SOURCE_BUNDLED {
            "随包"
        } else {
            "已安装"
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStateFile {
    #[serde(default = "default_schema")]
    pub schema: u32,
    #[serde(default)]
    pub active_version: Option<String>,
    #[serde(default)]
    pub installs: BTreeMap<String, InstalledRuntime>,
}

fn default_schema() -> u32 {
    1
}

impl Default for RuntimeStateFile {
    fn default() -> Self {
        Self {
            schema: 1,
            active_version: None,
            installs: BTreeMap::new(),
        }
    }
}

impl RuntimeStateFile {
    pub fn active(&self) -> Option<&InstalledRuntime> {
        self.active_version
            .as_ref()
            .and_then(|v| self.installs.get(v))
    }
}

pub struct Installer {
    root: PathBuf,
    /// 旧下载安装路径的 HTTP 客户端。只给 `veyl-runtime-selftest` 编译进来，
    /// 它已经不在发布路径上（升级走 `runtime::updates`）。
    #[cfg(feature = "runtime-selftest")]
    http: reqwest::Client,
    #[cfg(feature = "runtime-selftest")]
    progress: Option<ProgressFn>,
    /// 仅测试用：测试夹具是 shell 脚本，不可能带上我们的代码签名。
    /// 生产构建里这个字段不存在。
    #[cfg(test)]
    skip_signature_check: bool,
}

impl Installer {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        #[cfg(feature = "runtime-selftest")]
        let http = reqwest::Client::builder()
            .user_agent(concat!("veyl/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .build()
            .unwrap_or_default();
        Self {
            root: root.into(),
            #[cfg(feature = "runtime-selftest")]
            http,
            #[cfg(feature = "runtime-selftest")]
            progress: None,
            #[cfg(test)]
            skip_signature_check: false,
        }
    }

    /// 测试夹具专用：允许未签名的假运行时通过校验。
    #[cfg(test)]
    pub(crate) fn allow_unsigned_runtime(&mut self) {
        self.skip_signature_check = true;
    }

    fn verify_runtime_bytes(&self, path: &Path, recorded_sha256: &str) -> Result<(), String> {
        #[cfg(test)]
        if self.skip_signature_check {
            return Ok(());
        }
        signature::verify_installed_runtime(path, recorded_sha256)
    }

    fn verify_bundled_bytes(&self, path: &Path) -> Result<(), String> {
        #[cfg(test)]
        if self.skip_signature_check {
            return Ok(());
        }
        signature::verify_bundled_runtime(path)
    }

    #[cfg(feature = "runtime-selftest")]
    pub fn with_progress(mut self, progress: ProgressFn) -> Self {
        self.progress = Some(progress);
        self
    }

    #[cfg(feature = "runtime-selftest")]
    fn notify(&self, event: InstallProgress) {
        if let Some(cb) = &self.progress {
            cb(event);
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn version_dir(&self, version: &str) -> PathBuf {
        self.root.join("runtime").join(version)
    }

    pub fn binary_path(&self, version: &str) -> PathBuf {
        self.version_dir(version).join(BINARY_NAME)
    }

    pub fn state_path(&self) -> PathBuf {
        self.root.join(STATE_FILE)
    }

    pub fn read_state(&self) -> RuntimeResult<RuntimeStateFile> {
        let mut state: RuntimeStateFile = fsutil::read_json(&self.state_path())?.unwrap_or_default();
        // D-06 尾巴：旧版本的 runtime-state.json 里 installed_at 是秒，读的时候归一成毫秒。
        for install in state.installs.values_mut() {
            install.installed_at = normalize_to_ms(install.installed_at);
        }
        Ok(state)
    }

    pub fn active(&self) -> RuntimeResult<Option<InstalledRuntime>> {
        let state = self.read_state()?;
        Ok(state.active().filter(|rt| rt.binary.is_file()).cloned())
    }

    /// 旧的「联网下载 → 安装」路径。**只存在于自测二进制**（`runtime-selftest`
    /// feature），发布构建里没有这个方法——升级只能走 `runtime::updates`，
    /// 它带清单验签与平台签名校验。
    #[cfg(feature = "runtime-selftest")]
    pub async fn install(&self, release: &Release) -> RuntimeResult<InstalledRuntime> {
        fsutil::ensure_dir(&self.root)?;

        if let Some(existing) = self.read_state()?.installs.get(&release.upstream_version) {
            if existing.binary.is_file() {
                return Ok(existing.clone());
            }
        }

        let tmp_root = self.root.join("tmp");
        fsutil::ensure_dir(&tmp_root)?;
        let nonce = format!("{:016x}", rand::random::<u64>());
        let archive_path = tmp_root.join(format!(
            "download-{nonce}.{}",
            release.artifact.format.extension()
        ));

        let digest = self
            .download_and_verify(release, &archive_path)
            .await
            .inspect_err(|_| {
                let _ = std::fs::remove_file(&archive_path);
            })?;

        self.notify(InstallProgress::Extracting);
        let staging = self
            .root
            .join("runtime")
            .join(format!(".staging-{nonce}"));
        fsutil::remove_dir_if_exists(&staging)?;

        let extract_result = archive::extract(&archive_path, &staging, release.artifact.format)
            .and_then(|_| locate_binary(&staging).ok_or_else(|| {
                RuntimeError::Archive(format!(
                    "{} does not contain {BINARY_NAME}",
                    release.upstream_asset
                ))
            }));
        let extracted_binary = match extract_result {
            Ok(path) => path,
            Err(e) => {
                fsutil::remove_dir_if_exists(&staging)?;
                let _ = std::fs::remove_file(&archive_path);
                return Err(e);
            }
        };
        let _ = std::fs::remove_file(&archive_path);

        fsutil::set_executable(&extracted_binary)?;
        if let Err(e) = verify_binary_version(&extracted_binary, &release.upstream_version).await {
            fsutil::remove_dir_if_exists(&staging)?;
            return Err(e);
        }

        self.notify(InstallProgress::Activating);
        self.activate(
            &staging,
            &extracted_binary,
            &release.upstream_version,
            digest,
            SOURCE_INSTALLED,
        )
    }

    /// 当前可用的运行时：**已安装且校验通过 > 随包**。
    ///
    /// 不再有「校验失败就去网上下载」这一步。随包那份不可用时明确报错——
    /// 用户在首次启动时最可能没有网，静默下载只会把可诊断的问题拖成超时。
    ///
    /// 校验是**平台签名**（macOS），不是编译期哈希：打包签名会改写 Mach-O，
    /// 哈希只对签名前的文件成立。
    pub async fn select_runtime(&self) -> RuntimeResult<InstalledRuntime> {
        if let Some(active) = self.active()? {
            match self.verify_runtime_bytes(&active.binary, &active.sha256) {
                Ok(()) => return Ok(active),
                Err(detail) => log::warn!(
                    "已安装的运行时 {} 未通过校验（{detail}），改用随包运行时",
                    active.version
                ),
            }
        }
        self.install_bundled().await
    }

    /// 随包的运行时：打包后在 `Contents/Resources/runtime/`，
    /// 开发时在源码树的 `resources/runtime/`。
    ///
    /// 同一条路径 TUN 的 helper 也在用（`tun/privilege` 那边），
    /// 只是它从自己所在的 bundle 推，这里从主程序推。
    pub fn bundled_runtime_path() -> Option<PathBuf> {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let candidate = dir.join("../Resources/runtime").join(BINARY_NAME);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        // 开发时：CARGO_MANIFEST_DIR 在编译期确定，装到用户机器上时这个路径不存在，
        // 自然落到上面的分支。
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/runtime")
            .join(BINARY_NAME);
        dev.is_file().then_some(dev)
    }

    /// 随包那份运行时的版本号；没有或不可调用时返回 `None`。
    pub async fn bundled_version(&self) -> Option<String> {
        let source = Self::bundled_runtime_path()?;
        if signature::verify_bundled_runtime(&source).is_err() {
            return None;
        }
        read_binary_version(&source).await.ok().filter(|v| !v.is_empty())
    }

    /// 用随包资源安装（本地拷贝，不联网）。
    ///
    /// 签名通过后把**实际字节的哈希**记进安装记录；之后复用这份记录比对，
    /// 而不是拿编译期常量去要求一个签名后必然不同的文件。
    pub async fn install_bundled(&self) -> RuntimeResult<InstalledRuntime> {
        self.install_bundled_as(SOURCE_BUNDLED).await
    }

    async fn install_bundled_as(&self, source_kind: &str) -> RuntimeResult<InstalledRuntime> {
        let source = Self::bundled_runtime_path().ok_or_else(|| {
            RuntimeError::BundledUnavailable(format!(
                "安装包里没有运行时（{}）",
                BINARY_NAME
            ))
        })?;

        self.verify_bundled_bytes(&source).map_err(|detail| {
            log::warn!("随包运行时验签失败：{detail}");
            RuntimeError::BundledUnavailable(format!("随包运行时验签未通过：{detail}"))
        })?;

        // 版本号从二进制自己问，不信文件名。
        let version = read_binary_version(&source).await?;
        if version.is_empty() {
            return Err(RuntimeError::BundledUnavailable(
                "随包运行时没有报告版本号".into(),
            ));
        }

        let state = self.read_state()?;
        if let Some(existing) = state.installs.get(&version) {
            // 已安装的同版本也要复核：状态文件说装过，不代表文件没被换过。
            // **还必须是当前激活版本**：否则「装了 A、升级到 B、再回滚到 A」会
            // 在这里早退而不改 active 指针，命令看似成功、实际仍用 B。
            let is_active = state.active_version.as_deref() == Some(version.as_str());
            if is_active
                && existing.source == source_kind
                && existing.binary.is_file()
                && self
                    .verify_runtime_bytes(&existing.binary, &existing.sha256)
                    .is_ok()
            {
                return Ok(existing.clone());
            }
        }

        fsutil::ensure_dir(&self.root)?;
        let nonce = format!("{:016x}", rand::random::<u64>());
        let staging = self.root.join("runtime").join(format!(".bundled-{nonce}"));
        fsutil::remove_dir_if_exists(&staging)?;
        fsutil::ensure_dir(&staging)?;

        let staged = staging.join(BINARY_NAME);
        if let Err(error) = std::fs::copy(&source, &staged) {
            fsutil::remove_dir_if_exists(&staging)?;
            return Err(RuntimeError::State(format!(
                "写入随包运行时失败 {}：{error}",
                staged.display()
            )));
        }
        fsutil::set_executable(&staged)?;
        let digest = fsutil::sha256_file(&staged).map_err(|e| {
            let _ = fsutil::remove_dir_if_exists(&staging);
            RuntimeError::State(format!("计算随包运行时哈希失败 {}：{e}", staged.display()))
        })?;
        if let Err(e) = verify_binary_version(&staged, &version).await {
            fsutil::remove_dir_if_exists(&staging)?;
            return Err(e);
        }

        log::info!("已从随包资源安装运行时 {}（签名校验通过，未联网）", version);
        self.activate(&staging, &staged, &version, digest, source_kind)
    }

    /// 升级流程用：staging 已在 `runtime/.staging/<version>`，二进制在其内部。
    ///
    /// `activate` 会把它 rename 成 `runtime/<version>/` 并置为 active；
    /// 签名与版本校验已在调用方完成。
    pub(crate) fn activate_staged(
        &self,
        staging: &Path,
        binary_in_staging: &Path,
        version: &str,
        sha256: String,
    ) -> RuntimeResult<InstalledRuntime> {
        self.activate(staging, binary_in_staging, version, sha256, SOURCE_INSTALLED)
    }

    /// 回到随包运行时：验签通过后把它置为 active。
    ///
    /// 不提供历史版本选择（产品决定）；这是升级失败或用户后悔时的唯一退路。
    /// 状态只由 `activate` 写一次，避免与并发的安装互相覆盖。
    pub async fn rollback_to_bundled(&self) -> RuntimeResult<InstalledRuntime> {
        let runtime = self.install_bundled_as(SOURCE_BUNDLED).await?;
        log::info!("已回滚到随包运行时 {}", runtime.version);
        Ok(runtime)
    }

    /// 把 staging 里的可执行文件落成正式安装。
    ///
    /// **下载与随包两条路共用这一段**：写状态文件、建版本目录、激活，
    /// 只有「二进制从哪来」不同。
    fn activate(
        &self,
        staging: &Path,
        binary_in_staging: &Path,
        version: &str,
        sha256: String,
        source: &str,
    ) -> RuntimeResult<InstalledRuntime> {
        let relative = binary_in_staging
            .strip_prefix(staging)
            .unwrap_or_else(|_| Path::new(BINARY_NAME))
            .to_path_buf();

        let final_dir = self.version_dir(version);
        fsutil::ensure_dir(final_dir.parent().unwrap_or(&self.root))?;

        // 同版本重装不能先把旧目录删掉：中途失败会让一个原本能用的版本消失。
        // 旧目录先挪到临时名，新目录就位后再删；任何一步失败都把旧的挪回来。
        let backup = self
            .root
            .join("runtime")
            .join(format!(".previous-{version}-{:016x}", rand::random::<u64>()));
        let had_previous = final_dir.exists();
        if had_previous {
            std::fs::rename(&final_dir, &backup).io_ctx(&final_dir)?;
        }
        if let Err(error) = std::fs::rename(staging, &final_dir) {
            if had_previous {
                let _ = std::fs::rename(&backup, &final_dir);
            }
            return Err(RuntimeError::Io {
                path: final_dir,
                source: error,
            });
        }

        let binary = final_dir.join(&relative);
        if !binary.is_file() {
            // 新目录不完整：回滚到旧版本，别留下半装状态。
            let _ = fsutil::remove_dir_if_exists(&final_dir);
            if had_previous {
                let _ = std::fs::rename(&backup, &final_dir);
            }
            return Err(RuntimeError::State(format!(
                "installed binary is missing at {}",
                binary.display()
            )));
        }

        let installed = InstalledRuntime {
            version: version.to_string(),
            binary,
            license: ["LICENSE", "LICENSE.txt", "LICENSE.md"]
                .iter()
                .map(|n| final_dir.join(n))
                .find(|p| p.is_file()),
            dir: final_dir.clone(),
            sha256,
            installed_at: crate::store::db::now_ms(),
            source: source.to_string(),
        };

        let mut state = self.read_state()?;
        state.schema = 1;
        state
            .installs
            .insert(installed.version.clone(), installed.clone());
        state.active_version = Some(installed.version.clone());
        if let Err(error) = fsutil::write_atomic_json(&self.state_path(), &state) {
            let _ = fsutil::remove_dir_if_exists(&final_dir);
            if had_previous {
                let _ = std::fs::rename(&backup, &final_dir);
            }
            return Err(error);
        }
        if had_previous {
            let _ = fsutil::remove_dir_if_exists(&backup);
        }

        Ok(installed)
    }

    #[cfg(feature = "runtime-selftest")]
    async fn download_and_verify(&self, release: &Release, dest: &Path) -> RuntimeResult<String> {
        let expected_size = release.artifact.size;
        let response = self
            .http
            .get(&release.artifact.url)
            .send()
            .await
            .map_err(|e| RuntimeError::Http(format!("{}: {e}", release.artifact.url)))?;

        if !response.status().is_success() {
            return Err(RuntimeError::Download(format!(
                "{} returned HTTP {}",
                release.artifact.url,
                response.status()
            )));
        }

        let mut file = tokio::fs::File::create(dest).await.io_ctx(dest)?;
        let mut hasher = Sha256::new();
        let mut downloaded: u64 = 0;
        let mut stream = response.bytes_stream();

        let download_result: RuntimeResult<()> = async {
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| RuntimeError::Download(e.to_string()))?;
                downloaded = downloaded.saturating_add(chunk.len() as u64);
                if downloaded > expected_size {
                    return Err(RuntimeError::SizeMismatch {
                        expected: expected_size,
                        actual: downloaded,
                    });
                }
                hasher.update(&chunk);
                file.write_all(&chunk).await.io_ctx(dest)?;
                self.notify(InstallProgress::Downloading {
                    downloaded,
                    total: expected_size,
                });
            }
            file.flush().await.io_ctx(dest)?;
            file.sync_all().await.io_ctx(dest)?;
            Ok(())
        }
        .await;

        drop(file);

        if let Err(e) = download_result {
            let _ = std::fs::remove_file(dest);
            return Err(e);
        }

        if downloaded != expected_size {
            let _ = std::fs::remove_file(dest);
            return Err(RuntimeError::SizeMismatch {
                expected: expected_size,
                actual: downloaded,
            });
        }

        self.notify(InstallProgress::Verifying);
        let actual = hex::encode(hasher.finalize());
        if !actual.eq_ignore_ascii_case(&release.artifact.sha256) {
            let _ = std::fs::remove_file(dest);
            return Err(RuntimeError::Sha256Mismatch {
                expected: release.artifact.sha256.clone(),
                actual,
            });
        }

        Ok(actual)
    }

    pub fn uninstall(&self, version: &str) -> RuntimeResult<()> {
        fsutil::remove_dir_if_exists(&self.version_dir(version))?;
        let mut state = self.read_state()?;
        state.installs.remove(version);
        if state.active_version.as_deref() == Some(version) {
            state.active_version = state.installs.keys().next_back().cloned();
        }
        fsutil::write_atomic_json(&self.state_path(), &state)
    }

    /// 启动时清理升级/换装留下的临时目录。
    ///
    /// - `.staging`：升级没做完的下载与解包，直接删；
    /// - `.previous-<version>-<nonce>`：`activate` 在两次 rename 之间崩溃会留下
    ///   一份完整运行时。若正式目录缺失，就把它改名回去（完成那次换装）；
    ///   正式目录已在，它就是多余的旧副本，删掉。
    pub fn cleanup_staging(&self) {
        let runtime = self.root.join("runtime");
        let _ = fsutil::remove_dir_if_exists(&runtime.join(".staging"));

        let Ok(entries) = std::fs::read_dir(&runtime) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(rest) = name.strip_prefix(".previous-") else {
                continue;
            };
            let Some((version, _)) = rest.rsplit_once('-') else {
                continue;
            };
            let final_dir = runtime.join(version);
            if !final_dir.exists() && std::fs::rename(entry.path(), &final_dir).is_ok() {
                log::warn!("恢复了中断换装前的运行时 {version}");
                continue;
            }
            let _ = fsutil::remove_dir_if_exists(&entry.path());
        }
    }
}

/// 秒级时间戳（< 1e11）换算成毫秒；已经是毫秒的原样返回。
fn normalize_to_ms(value: i64) -> i64 {
    if value > 0 && value < 100_000_000_000 {
        value * 1000
    } else {
        value
    }
}

#[cfg(feature = "runtime-selftest")]
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

pub async fn read_binary_version(binary: &Path) -> RuntimeResult<String> {
    let output = tokio::process::Command::new(binary)
        .arg("version")
        .output()
        .await
        .map_err(|e| {
            RuntimeError::Process(format!("failed to run {} version: {e}", binary.display()))
        })?;

    if !output.status.success() {
        return Err(RuntimeError::Process(format!(
            "{} version exited with {}",
            binary.display(),
            output.status
        )));
    }

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(text
        .lines()
        .find_map(|line| line.trim().strip_prefix("sing-box version "))
        .unwrap_or_default()
        .trim()
        .to_string())
}

pub async fn verify_binary_version(binary: &Path, expected: &str) -> RuntimeResult<String> {
    let reported = read_binary_version(binary).await?;
    if !reported.is_empty() && reported != expected {
        return Err(RuntimeError::Process(format!(
            "installed binary reports {reported}, expected {expected}"
        )));
    }
    Ok(reported)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::manifest::{ArchiveFormat, Release};

    fn release(sha: &str, size: u64) -> Release {
        Release {
            upstream_version: "9.9.9".into(),
            platform: "test".into(),
            arch: "test".into(),
            artifact: super::super::manifest::Artifact {
                url: "https://example.invalid/x.tar.gz".into(),
                sha256: sha.into(),
                size,
                format: ArchiveFormat::TarGz,
            },
            upstream_asset: "x.tar.gz".into(),
            source_url: "https://example.invalid/src".into(),
            license: "GPL-3.0-or-later".into(),
            config_schema: None,
            breaking: false,
            yanked: false,
            published_at: None,
        }
    }

    #[test]
    fn state_round_trips_atomically() {
        let dir = std::env::temp_dir().join(format!("aivpn-state-{:016x}", rand::random::<u64>()));
        fsutil::ensure_dir(&dir).unwrap();
        let installer = Installer::new(&dir);

        let mut state = RuntimeStateFile::default();
        state.schema = 1;
        state.active_version = Some("1.14.4".into());
        fsutil::write_atomic_json(&installer.state_path(), &state).unwrap();

        let loaded = installer.read_state().unwrap();
        assert_eq!(loaded.active_version.as_deref(), Some("1.14.4"));
        assert!(installer.active().unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_binary_is_reported_as_not_installed() {
        let dir = std::env::temp_dir().join(format!("aivpn-state-{:016x}", rand::random::<u64>()));
        fsutil::ensure_dir(&dir).unwrap();
        let installer = Installer::new(&dir);
        assert!(installer.active().unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalizes_legacy_second_timestamps() {
        let dir = std::env::temp_dir().join(format!("veyl-state-{:016x}", rand::random::<u64>()));
        fsutil::ensure_dir(&dir).unwrap();
        let installer = Installer::new(&dir);

        let legacy = serde_json::json!({
            "schema": 1,
            "active_version": "1.14.4",
            "installs": {
                "1.14.4": {
                    "version": "1.14.4",
                    "dir": "/tmp/a",
                    "binary": "/tmp/a/sing-box",
                    "sha256": "x",
                    "installed_at": 1_700_000_000i64
                }
            }
        });
        std::fs::write(installer.state_path(), legacy.to_string()).unwrap();

        let state = installer.read_state().unwrap();
        assert_eq!(
            state.installs["1.14.4"].installed_at,
            1_700_000_000_000,
            "旧文件里的秒级时间戳读取时应归一成毫秒"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_helper_is_consistent() {
        let r = release("00", 1);
        assert_eq!(r.artifact.format.extension(), "tar.gz");
    }

    /// 随包运行时的判定口径是**平台签名**，不是构建期哈希。
    ///
    /// 打包签名会改写 Mach-O，构建期哈希只对签名前的文件成立；这里钉住两种
    /// 结果都不能被静默当成可用：签名符合我们的要求时通过，否则必须拒绝。
    #[cfg(target_os = "macos")]
    #[test]
    fn the_bundled_runtime_is_judged_by_its_signature() {
        let Some(path) = Installer::bundled_runtime_path() else {
            return; // 没有随包资源就跳过（clean checkout 上常见）
        };

        let detail = std::process::Command::new("codesign")
            .args(["-d", "--verbose=4"])
            .arg(&path)
            .output()
            .ok()
            .map(|output| {
                let mut text = String::from_utf8_lossy(&output.stderr).to_string();
                text.push_str(&String::from_utf8_lossy(&output.stdout));
                text
            })
            .unwrap_or_default();
        let ours = detail.contains("Identifier=sing-box")
            && detail.contains(&format!("TeamIdentifier={}", crate::tun::protocol::TEAM_ID));

        let result = signature::verify_bundled_runtime(&path);
        if ours {
            result.expect("我们自己签的运行时必须通过验签");
        } else {
            assert!(
                result.is_err(),
                "不是我们签的运行时必须被拒绝：{}",
                path.display()
            );
        }
    }

    /// 全新数据目录：直接从随包那份装好，来源记为 `bundled`，第二次不再复制。
    /// 只有本机的随包运行时确实由我们签名时才跑（打包产物/开发包）。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_clean_data_dir_installs_the_signed_bundled_runtime() {
        let Some(path) = Installer::bundled_runtime_path() else {
            return;
        };
        if signature::verify_bundled_runtime(&path).is_err() {
            return; // 源码树里的未签名副本：由打包脚本负责签，这里不判失败
        }

        let dir = std::env::temp_dir().join(format!("veyl-bundled-{:016x}", rand::random::<u64>()));
        fsutil::ensure_dir(&dir).unwrap();
        let installer = Installer::new(&dir);

        let runtime = installer.select_runtime().await.unwrap();
        assert_eq!(runtime.source, SOURCE_BUNDLED);
        assert!(runtime.binary.is_file());
        assert_eq!(runtime.source_label(), "随包");
        assert!(signature::verify_installed_runtime(&runtime.binary, &runtime.sha256).is_ok());

        // 第二次走已安装且校验通过的那份，不再复制。
        let again = installer.select_runtime().await.unwrap();
        assert_eq!(again.version, runtime.version);
        assert_eq!(again.dir, runtime.dir);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回滚必须把 active 指针改回随包版本——即使随包版本早已安装、只是没在生效。
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn rollback_restores_the_bundled_version_even_when_it_is_already_installed() {
        let Some(path) = Installer::bundled_runtime_path() else {
            return;
        };
        if signature::verify_bundled_runtime(&path).is_err() {
            return;
        }

        let dir = std::env::temp_dir().join(format!("veyl-rollback-{:016x}", rand::random::<u64>()));
        fsutil::ensure_dir(&dir).unwrap();
        let installer = Installer::new(&dir);
        let bundled = installer.install_bundled().await.unwrap();
        assert_eq!(
            installer.active().unwrap().unwrap().version,
            bundled.version
        );

        // 模拟升级到 1.15.0（activate 不校验内容，测试里用假二进制即可）。
        let staging = dir.join("runtime").join(".staging").join("1.15.0");
        fsutil::ensure_dir(&staging).unwrap();
        let fake = staging.join(BINARY_NAME);
        std::fs::write(&fake, b"fake").unwrap();
        installer
            .activate_staged(&staging, &fake, "1.15.0", "x".into())
            .unwrap();
        assert_eq!(installer.active().unwrap().unwrap().version, "1.15.0");

        let rolled = installer.rollback_to_bundled().await.unwrap();
        assert_eq!(rolled.version, bundled.version);
        let state = installer.read_state().unwrap();
        assert_eq!(
            state.active_version.as_deref(),
            Some(bundled.version.as_str()),
            "回滚必须改 active 指针，不能只返回 ok"
        );
        assert_eq!(state.installs[&bundled.version].source, SOURCE_BUNDLED);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 两次 rename 之间崩溃留下的 `.previous-*`：正式目录缺失就恢复，存在就删。
    #[test]
    fn an_interrupted_swap_is_recovered_or_cleaned() {
        let dir = std::env::temp_dir().join(format!("veyl-swap-{:016x}", rand::random::<u64>()));
        let runtime = dir.join("runtime");
        fsutil::ensure_dir(&runtime).unwrap();

        let leftover = runtime.join(".previous-1.14.4-abcdef");
        fsutil::ensure_dir(&leftover).unwrap();
        std::fs::write(leftover.join(BINARY_NAME), b"x").unwrap();
        Installer::new(&dir).cleanup_staging();
        assert!(runtime.join("1.14.4").join(BINARY_NAME).is_file(), "缺失的正式目录要恢复");
        assert!(!leftover.exists());

        let orphan = runtime.join(".previous-1.14.4-123456");
        fsutil::ensure_dir(&orphan).unwrap();
        std::fs::write(orphan.join(BINARY_NAME), b"x").unwrap();
        Installer::new(&dir).cleanup_staging();
        assert!(!orphan.exists(), "正式目录已在时应删除旧副本");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_state_files_default_to_the_installed_source() {        let state: RuntimeStateFile = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "active_version": "1.14.4",
            "installs": {
                "1.14.4": {
                    "version": "1.14.4",
                    "dir": "/tmp/a",
                    "binary": "/tmp/a/sing-box",
                    "sha256": "x",
                    "installed_at": 1
                }
            }
        }))
        .unwrap();
        assert_eq!(state.installs["1.14.4"].source, SOURCE_INSTALLED);
    }
}
