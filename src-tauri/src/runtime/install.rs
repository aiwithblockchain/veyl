use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::archive;
use super::error::{IoContext, RuntimeError, RuntimeResult};
use super::fsutil;
use super::manifest::Release;

pub const STATE_FILE: &str = "runtime-state.json";
pub const BINARY_NAME: &str = if cfg!(windows) {
    "sing-box.exe"
} else {
    "sing-box"
};

#[derive(Debug, Clone, Copy)]
pub enum InstallProgress {
    Downloading { downloaded: u64, total: u64 },
    Verifying,
    Extracting,
    Activating,
}

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
    http: reqwest::Client,
    progress: Option<ProgressFn>,
}

impl Installer {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("veyl/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .build()
            .unwrap_or_default();
        Self {
            root: root.into(),
            http,
            progress: None,
        }
    }

    pub fn with_progress(mut self, progress: ProgressFn) -> Self {
        self.progress = Some(progress);
        self
    }

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
        let relative = extracted_binary
            .strip_prefix(&staging)
            .unwrap_or_else(|_| Path::new(BINARY_NAME))
            .to_path_buf();

        let final_dir = self.version_dir(&release.upstream_version);
        fsutil::remove_dir_if_exists(&final_dir)?;
        fsutil::ensure_dir(final_dir.parent().unwrap_or(&self.root))?;
        std::fs::rename(&staging, &final_dir).io_ctx(&final_dir)?;

        let binary = final_dir.join(&relative);
        if !binary.is_file() {
            return Err(RuntimeError::State(format!(
                "installed binary is missing at {}",
                binary.display()
            )));
        }

        let installed = InstalledRuntime {
            version: release.upstream_version.clone(),
            binary,
            license: ["LICENSE", "LICENSE.txt", "LICENSE.md"]
                .iter()
                .map(|n| final_dir.join(n))
                .find(|p| p.is_file()),
            dir: final_dir,
            sha256: digest,
            installed_at: crate::store::db::now_ms(),
        };

        let mut state = self.read_state()?;
        state.schema = 1;
        state
            .installs
            .insert(installed.version.clone(), installed.clone());
        state.active_version = Some(installed.version.clone());
        fsutil::write_atomic_json(&self.state_path(), &state)?;

        Ok(installed)
    }

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
}

/// 秒级时间戳（< 1e11）换算成毫秒；已经是毫秒的原样返回。
fn normalize_to_ms(value: i64) -> i64 {
    if value > 0 && value < 100_000_000_000 {
        value * 1000
    } else {
        value
    }
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

pub async fn verify_binary_version(binary: &Path, expected: &str) -> RuntimeResult<String> {
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
    let reported = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("sing-box version "))
        .unwrap_or_default()
        .trim()
        .to_string();

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
    use crate::runtime::manifest::ArchiveFormat;

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
}
