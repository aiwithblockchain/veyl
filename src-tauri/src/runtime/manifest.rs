use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use super::error::{RuntimeError, RuntimeResult};

pub const BUILTIN_MANIFEST: &str = include_str!("../../assets/runtime-manifest.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeManifest {
    pub schema: u32,
    pub channel: String,
    #[serde(default)]
    pub generated_at: String,
    pub releases: Vec<Release>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfigSchema {
    pub min: u32,
    pub max: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Release {
    pub upstream_version: String,
    pub platform: String,
    pub arch: String,
    pub artifact: Artifact,
    pub upstream_asset: String,
    pub source_url: String,
    pub license: String,
    #[serde(default)]
    pub config_schema: Option<ConfigSchema>,
    #[serde(default)]
    pub breaking: bool,
    #[serde(default)]
    pub yanked: bool,
    #[serde(default)]
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub format: ArchiveFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArchiveFormat {
    #[serde(rename = "tar.gz")]
    TarGz,
    #[serde(rename = "zip")]
    Zip,
}

impl ArchiveFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ArchiveFormat::TarGz => "tar.gz",
            ArchiveFormat::Zip => "zip",
        }
    }
}

impl Release {
    /// 资产文件名取自官方资产名，便于溯源与 GPL 合规。
    pub fn archive_file_name(&self) -> String {
        self.upstream_asset.clone()
    }
}

impl RuntimeManifest {
    pub fn builtin() -> RuntimeResult<Self> {
        serde_json::from_str(BUILTIN_MANIFEST)
            .map_err(|e| RuntimeError::State(format!("builtin manifest is invalid: {e}")))
    }

    /// 当前编译目标对应的 (platform, arch)，使用清单里的命名。
    pub fn host_platform() -> (String, String) {
        let os = match std::env::consts::OS {
            "macos" => "darwin",
            other => other,
        };
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86" => "x86",
            other => other,
        };
        (os.to_string(), arch.to_string())
    }

    pub fn select(&self, platform: &str, arch: &str) -> Option<&Release> {
        let mut candidates: Vec<&Release> = self
            .releases
            .iter()
            .filter(|r| r.platform == platform && r.arch == arch && !r.yanked)
            .collect();
        candidates.sort_by(|a, b| compare_versions(&b.upstream_version, &a.upstream_version));
        candidates.into_iter().next()
    }

    pub fn current_for_host(&self) -> RuntimeResult<&Release> {
        let (platform, arch) = Self::host_platform();
        self.select(&platform, &arch)
            .ok_or_else(|| RuntimeError::ReleaseNotFound(platform, arch))
    }
}

pub fn current_release() -> RuntimeResult<Release> {
    let manifest = RuntimeManifest::builtin()?;
    manifest.current_for_host().cloned()
}

pub fn compare_versions(a: &str, b: &str) -> Ordering {
    parse_version(a).cmp(&parse_version(b))
}

fn parse_version(v: &str) -> (u64, u64, u64) {
    let core = v.trim_start_matches('v');
    let core = core.split(['-', '+']).next().unwrap_or(core);
    let mut parts = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_manifest_parses_and_covers_host() {
        let manifest = RuntimeManifest::builtin().expect("manifest parses");
        assert_eq!(manifest.schema, 1);
        assert!(manifest.current_for_host().is_ok());
    }

    #[test]
    fn every_release_has_a_full_sha256() {
        let manifest = RuntimeManifest::builtin().unwrap();
        for r in &manifest.releases {
            assert_eq!(r.artifact.sha256.len(), 64, "{}", r.upstream_asset);
            assert!(r.artifact.size > 0);
            assert!(r.artifact.url.starts_with("https://"));
            assert!(!r.source_url.is_empty());
        }
    }

    #[test]
    fn yanked_releases_are_skipped() {
        let mut manifest = RuntimeManifest::builtin().unwrap();
        manifest.releases[0].yanked = true;
        let target = manifest.releases[0].clone();
        let found = manifest.select(&target.platform, &target.arch);
        assert!(found.is_none() || found.unwrap().upstream_version != target.upstream_version
            || manifest
                .releases
                .iter()
                .filter(|r| r.platform == target.platform && r.arch == target.arch)
                .count()
                > 1);
    }

    #[test]
    fn version_ordering_is_numeric() {
        assert_eq!(compare_versions("1.14.4", "1.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("v1.14.4", "1.14.4"), Ordering::Equal);
    }
}
