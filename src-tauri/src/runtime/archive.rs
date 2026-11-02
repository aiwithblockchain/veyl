use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};

use super::error::{IoContext, RuntimeError, RuntimeResult};
use super::manifest::ArchiveFormat;

#[derive(Debug, Clone, Copy)]
pub struct ExtractLimits {
    pub max_entries: usize,
    pub max_total_bytes: u64,
    pub max_path_len: usize,
}

impl Default for ExtractLimits {
    fn default() -> Self {
        Self {
            max_entries: 4096,
            max_total_bytes: 512 * 1024 * 1024,
            max_path_len: 4096,
        }
    }
}

/// 解压到 `dest`；返回本次写出的相对路径。任何条目越界都会整体失败。
pub fn extract(archive: &Path, dest: &Path, format: ArchiveFormat) -> RuntimeResult<Vec<PathBuf>> {
    fs::create_dir_all(dest).io_ctx(dest)?;
    match format {
        ArchiveFormat::TarGz => extract_tar_gz(archive, dest, ExtractLimits::default()),
        ArchiveFormat::Zip => extract_zip(archive, dest, ExtractLimits::default()),
    }
}

fn extract_tar_gz(archive: &Path, dest: &Path, limits: ExtractLimits) -> RuntimeResult<Vec<PathBuf>> {
    let file = File::open(archive).io_ctx(archive)?;
    let decoder = flate2::read::GzDecoder::new(BufReader::new(file));
    let mut tar = tar::Archive::new(decoder);

    let mut written = Vec::new();
    let mut total: u64 = 0;
    let mut count: usize = 0;

    for entry in tar.entries().map_err(archive_err)? {
        let mut entry = entry.map_err(archive_err)?;
        count += 1;
        if count > limits.max_entries {
            return Err(unsafe_entry("<archive>", "too many entries"));
        }

        let raw = entry.path().map_err(archive_err)?.to_path_buf();
        let rel = validate_rel_path(&raw)?;
        check_path(&rel, &limits)?;
        let out = dest.join(&rel);
        let kind = entry.header().entry_type();

        match kind {
            tar::EntryType::Directory => {
                fs::create_dir_all(&out).io_ctx(&out)?;
            }
            tar::EntryType::Regular => {
                total = total.saturating_add(entry.size());
                if total > limits.max_total_bytes {
                    return Err(unsafe_entry(
                        rel.display(),
                        "archive expands past the configured size limit",
                    ));
                }
                ensure_parent(&out)?;
                let mut target = File::create(&out).io_ctx(&out)?;
                std::io::copy(&mut entry, &mut target).io_ctx(&out)?;
                set_mode(&out, entry.header().mode().unwrap_or(0o644));
                written.push(rel);
            }
            tar::EntryType::Symlink => {
                let target = entry
                    .link_name()
                    .map_err(archive_err)?
                    .ok_or_else(|| unsafe_entry(rel.display(), "symlink without a target"))?
                    .to_path_buf();
                validate_link_target(&rel, &target)?;
                ensure_parent(&out)?;
                create_symlink(&target, &out, &rel)?;
                written.push(rel);
            }
            tar::EntryType::Link => {
                let target = entry
                    .link_name()
                    .map_err(archive_err)?
                    .ok_or_else(|| unsafe_entry(rel.display(), "hard link without a target"))?
                    .to_path_buf();
                let target_rel = validate_rel_path(&target)?;
                validate_link_target(&rel, &target_rel)?;
                ensure_parent(&out)?;
                fs::hard_link(dest.join(&target_rel), &out).io_ctx(&out)?;
                written.push(rel);
            }
            _ => {}
        }
    }

    Ok(written)
}

fn extract_zip(archive: &Path, dest: &Path, limits: ExtractLimits) -> RuntimeResult<Vec<PathBuf>> {
    let file = File::open(archive).io_ctx(archive)?;
    let mut zip = zip::ZipArchive::new(file).map_err(archive_err)?;

    let mut written = Vec::new();
    let mut total: u64 = 0;

    if zip.len() > limits.max_entries {
        return Err(unsafe_entry("<archive>", "too many entries"));
    }

    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(archive_err)?;
        let name = entry.name().to_string();
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| unsafe_entry(&name, "entry escapes the archive root"))?
            .to_path_buf();
        let rel = validate_rel_path(&enclosed)?;
        check_path(&rel, &limits)?;
        let out = dest.join(&rel);

        if entry.is_dir() {
            fs::create_dir_all(&out).io_ctx(&out)?;
            continue;
        }

        let mode = entry.unix_mode().unwrap_or(0o644);
        if mode & 0o170000 == 0o120000 {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(archive_err)?;
            let target = PathBuf::from(String::from_utf8_lossy(&buf).into_owned());
            validate_link_target(&rel, &target)?;
            ensure_parent(&out)?;
            create_symlink(&target, &out, &rel)?;
            written.push(rel);
            continue;
        }

        total = total.saturating_add(entry.size());
        if total > limits.max_total_bytes {
            return Err(unsafe_entry(
                rel.display(),
                "archive expands past the configured size limit",
            ));
        }
        ensure_parent(&out)?;
        let mut target = File::create(&out).io_ctx(&out)?;
        std::io::copy(&mut entry, &mut target).io_ctx(&out)?;
        set_mode(&out, mode);
        written.push(rel);
    }

    Ok(written)
}

pub fn validate_rel_path(path: &Path) -> RuntimeResult<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => {
                if segment.is_empty() {
                    continue;
                }
                out.push(segment);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(unsafe_entry(path.display(), "path traversal is not allowed"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(unsafe_entry(path.display(), "absolute path is not allowed"));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err(unsafe_entry(path.display(), "empty path"));
    }
    Ok(out)
}

fn check_path(rel: &Path, limits: &ExtractLimits) -> RuntimeResult<()> {
    if rel.as_os_str().len() > limits.max_path_len {
        return Err(unsafe_entry(rel.display(), "path is too long"));
    }
    for component in rel.components() {
        if let Component::Normal(segment) = component {
            if segment.len() > 255 {
                return Err(unsafe_entry(rel.display(), "path component is too long"));
            }
            if cfg!(windows) && segment.to_string_lossy().contains(':') {
                return Err(unsafe_entry(
                    rel.display(),
                    "alternate data stream syntax is not allowed",
                ));
            }
        }
    }
    Ok(())
}

fn validate_link_target(entry_rel: &Path, target: &Path) -> RuntimeResult<()> {
    if target.is_absolute() || target.has_root() {
        return Err(unsafe_entry(entry_rel.display(), "link target is absolute"));
    }
    let mut depth: i64 = entry_rel
        .parent()
        .map(|p| {
            p.components()
                .filter(|c| matches!(c, Component::Normal(_)))
                .count() as i64
        })
        .unwrap_or(0);
    for component in target.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return Err(unsafe_entry(
                        entry_rel.display(),
                        "link resolves outside the extraction root",
                    ));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(unsafe_entry(entry_rel.display(), "link target is absolute"));
            }
        }
    }
    Ok(())
}

fn ensure_parent(out: &Path) -> RuntimeResult<()> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).io_ctx(parent)?;
    }
    Ok(())
}

#[cfg(unix)]
fn create_symlink(target: &Path, out: &Path, rel: &Path) -> RuntimeResult<()> {
    std::os::unix::fs::symlink(target, out).io_ctx(out).map_err(|_| {
        unsafe_entry(rel.display(), "failed to create a symlink inside the install root")
    })
}

#[cfg(not(unix))]
fn create_symlink(_target: &Path, _out: &Path, rel: &Path) -> RuntimeResult<()> {
    Err(unsafe_entry(
        rel.display(),
        "symlinks are not supported on this platform",
    ))
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let mode = mode & 0o777;
    let mode = if mode == 0 { 0o644 } else { mode };
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

fn archive_err(error: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::Archive(error.to_string())
}

fn unsafe_entry(entry: impl std::fmt::Display, reason: &str) -> RuntimeError {
    RuntimeError::UnsafeArchive {
        entry: entry.to_string(),
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use flate2::write::GzEncoder;
    use flate2::Compression;

    fn write_tar_gz(path: &Path, entries: &[(&str, &[u8])], symlinks: &[(&str, &str)]) {
        let file = File::create(path).unwrap();
        let encoder = GzEncoder::new(file, Compression::fast());
        let mut builder = tar::Builder::new(encoder);

        for (name, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            set_gnu_name(&mut header, name);
            header.set_cksum();
            builder.append(&header, &body[..]).unwrap();
        }
        for (name, target) in symlinks {
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_mode(0o777);
            header.set_entry_type(tar::EntryType::Symlink);
            set_gnu_name(&mut header, name);
            {
                let gnu = header.as_gnu_mut().unwrap();
                let bytes = target.as_bytes();
                assert!(bytes.len() < gnu.linkname.len());
                gnu.linkname[..bytes.len()].copy_from_slice(bytes);
            }
            header.set_cksum();
            builder.append(&header, &[][..]).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
    }

    /// 直接写 GNU 头，绕过 `Builder` 对路径的校验——测试要构造的就是恶意归档。
    fn set_gnu_name(header: &mut tar::Header, name: &str) {
        let gnu = header.as_gnu_mut().expect("gnu header");
        let bytes = name.as_bytes();
        assert!(bytes.len() < gnu.name.len());
        gnu.name[..bytes.len()].copy_from_slice(bytes);
    }

    #[test]
    fn accepts_a_flat_archive() {
        let dir = tempfile_dir();
        let archive = dir.join("ok.tar.gz");
        write_tar_gz(
            &archive,
            &[("pkg/sing-box", b"binary"), ("pkg/LICENSE", b"gpl")],
            &[],
        );
        let dest = dir.join("out");
        let files = extract(&archive, &dest, ArchiveFormat::TarGz).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(fs::read_to_string(dest.join("pkg/LICENSE")).unwrap(), "gpl");
    }

    #[test]
    fn rejects_parent_traversal() {
        let dir = tempfile_dir();
        let archive = dir.join("evil.tar.gz");
        write_tar_gz(&archive, &[("../escape.txt", b"x")], &[]);
        let err = extract(&archive, &dir.join("out"), ArchiveFormat::TarGz).unwrap_err();
        assert!(matches!(err, RuntimeError::UnsafeArchive { .. }), "{err}");
        assert!(!dir.join("escape.txt").exists());
    }

    #[test]
    fn rejects_absolute_entries() {
        let dir = tempfile_dir();
        let archive = dir.join("abs.tar.gz");
        write_tar_gz(&archive, &[("/tmp/aivpn-escape.txt", b"x")], &[]);
        let err = extract(&archive, &dir.join("out"), ArchiveFormat::TarGz).unwrap_err();
        assert!(matches!(err, RuntimeError::UnsafeArchive { .. }), "{err}");
    }

    #[test]
    fn rejects_symlink_escaping_the_root() {
        let dir = tempfile_dir();
        let archive = dir.join("link.tar.gz");
        write_tar_gz(&archive, &[("pkg/readme", b"x")], &[("pkg/evil", "../../etc")]);
        let err = extract(&archive, &dir.join("out"), ArchiveFormat::TarGz).unwrap_err();
        assert!(matches!(err, RuntimeError::UnsafeArchive { .. }), "{err}");
    }

    #[test]
    fn rejects_zip_traversal() {
        use zip::write::SimpleFileOptions;
        let dir = tempfile_dir();
        let archive = dir.join("evil.zip");
        {
            let file = File::create(&archive).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            writer
                .start_file("../escape.txt", SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"x").unwrap();
            writer.finish().unwrap();
        }
        let err = extract(&archive, &dir.join("out"), ArchiveFormat::Zip).unwrap_err();
        assert!(matches!(err, RuntimeError::UnsafeArchive { .. }), "{err}");
    }

    #[test]
    fn accepts_a_zip_with_nested_dir() {
        use zip::write::SimpleFileOptions;
        let dir = tempfile_dir();
        let archive = dir.join("ok.zip");
        {
            let file = File::create(&archive).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            writer
                .start_file("pkg/sing-box.exe", SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"binary").unwrap();
            writer.finish().unwrap();
        }
        let dest = dir.join("out");
        let files = extract(&archive, &dest, ArchiveFormat::Zip).unwrap();
        assert_eq!(files, vec![PathBuf::from("pkg/sing-box.exe")]);
        assert_eq!(
            fs::read_to_string(dest.join("pkg/sing-box.exe")).unwrap(),
            "binary"
        );
    }

    fn tempfile_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aivpn-archive-test-{}-{:x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
