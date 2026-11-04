//! 信任根的校验：**每次使用前**逐级看，而不是建的时候看一眼。
//!
//! 主程序与 helper 共用这一份（helper 用 `#[path]` 引入）。
//!
//! 规则只有三条，但对每一级都必须成立：
//! 1. 是真实目录，不是软链接；
//! 2. 属主是我们预期的 uid（生产环境是 0）；
//! 3. 没有 group / other 写位。
//!
//! 为什么不用 `.is_dir()`：它会跟随软链接。为什么要看每一级而不是只看根：
//! 中间任何一级被换掉，下面的路径就都指向别处了。

use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// helper 的状态根。系统级、属主 root、用户建不了东西在里面。
pub const TRUST_ROOT: &str = "/Library/Application Support/Veyl";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustError {
    Missing(PathBuf),
    NotADirectory(PathBuf),
    Symlink(PathBuf),
    WrongOwner { path: PathBuf, uid: u32, expected: u32 },
    WritableByGroupOrOther(PathBuf),
    NotARegularFile(PathBuf),
    WrongMode { path: PathBuf, mode: u32, expected: u32 },
    HashMismatch(PathBuf),
    Io(String),
}

impl std::fmt::Display for TrustError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrustError::Missing(path) => write!(f, "路径不存在：{}", path.display()),
            TrustError::NotADirectory(path) => write!(f, "不是目录：{}", path.display()),
            TrustError::Symlink(path) => write!(f, "是软链接，拒绝使用：{}", path.display()),
            TrustError::WrongOwner { path, uid, expected } => write!(
                f,
                "属主不对（uid {uid}，应为 {expected}）：{}",
                path.display()
            ),
            TrustError::WritableByGroupOrOther(path) => {
                write!(f, "group/other 有写权限：{}", path.display())
            }
            TrustError::NotARegularFile(path) => write!(f, "不是普通文件：{}", path.display()),
            TrustError::WrongMode { path, mode, expected } => write!(
                f,
                "权限位不对（{mode:o}，应为 {expected:o}）：{}",
                path.display()
            ),
            TrustError::HashMismatch(path) => write!(f, "内容哈希不匹配：{}", path.display()),
            TrustError::Io(message) => write!(f, "{message}"),
        }
    }
}

fn lstat(path: &Path) -> Result<std::fs::Metadata, TrustError> {
    std::fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            TrustError::Missing(path.to_path_buf())
        } else {
            TrustError::Io(format!("{}: {error}", path.display()))
        }
    })
}

fn is_link(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

/// 从 `stop_at` 逐级校验到 `path`（含两端）。
///
/// 生产环境用 `stop_at = /Library`：再往上的 `/`、`/System` 不是我们的管辖范围，
/// 也不该由这里判断。测试里传临时目录，才能在没有 root 的情况下验证规则本身。
pub fn verify_chain_from(
    stop_at: &Path,
    path: &Path,
    expect_uid: u32,
) -> Result<(), TrustError> {
    if !path.is_absolute() || !stop_at.is_absolute() {
        return Err(TrustError::Io(format!(
            "必须是绝对路径：{} / {}",
            stop_at.display(),
            path.display()
        )));
    }
    if !path.starts_with(stop_at) {
        return Err(TrustError::Io(format!(
            "{} 不在 {} 之下",
            path.display(),
            stop_at.display()
        )));
    }

    let mut chain = Vec::new();
    let mut current = Some(path);
    while let Some(item) = current {
        chain.push(item.to_path_buf());
        if item == stop_at {
            break;
        }
        current = item.parent();
    }
    if chain.last().map(PathBuf::as_path) != Some(stop_at) {
        return Err(TrustError::Io(format!(
            "{} 不在 {} 之下",
            path.display(),
            stop_at.display()
        )));
    }
    chain.reverse();

    for item in &chain {
        let metadata = lstat(item)?;
        if is_link(&metadata) {
            return Err(TrustError::Symlink(item.clone()));
        }
        if !metadata.is_dir() {
            return Err(TrustError::NotADirectory(item.clone()));
        }
        if metadata.uid() != expect_uid {
            return Err(TrustError::WrongOwner {
                path: item.clone(),
                uid: metadata.uid(),
                expected: expect_uid,
            });
        }
        if metadata.permissions().mode() & 0o022 != 0 {
            return Err(TrustError::WritableByGroupOrOther(item.clone()));
        }
    }
    Ok(())
}

/// 校验 App bundle 本身。
///
/// **不看属主**：用户把 App 拖进「应用程序」文件夹，属主就是他本人，
/// 本机 38 个 App 里有 15 个不是 root。真正决定可信的是**代码签名**，
/// 那一步在 helper 里用 `SecStaticCodeCheckValidity` 做（`trust_bundle`）。
///
/// 这里只做与签名互补、且与属主无关的检查：
/// 必须在安装根之下、**不是软链**、是目录、没有 group/other 写位。
///
/// 软链判断必须在 `canonicalize` **之前**做——先规范化再判断的话，
/// 拿到的是目标元数据，这段检查永远不会命中。
pub fn verify_bundle(bundle: &Path, install_root: &Path) -> Result<(), TrustError> {
    // 顶层与内容目录都要查：运行时和规则都从 `Contents/Resources` 来，
    // 只查 `.app` 这一层等于让资源目录绕开了校验。
    verify_plain_dir(bundle)?;
    verify_plain_dir(&bundle.join("Contents"))?;
    verify_plain_dir(&bundle.join("Contents").join("Resources"))?;

    // 安装根也要按真实路径比：macOS 上 /var 是 /private/var 的软链。
    let real = bundle.canonicalize().map_err(|error| {
        TrustError::Io(format!("{}: {error}", bundle.display()))
    })?;
    let install_real = install_root
        .canonicalize()
        .unwrap_or_else(|_| install_root.to_path_buf());
    if !real.starts_with(&install_real) {
        return Err(TrustError::Io(format!(
            "App 不在 {} 下：{}",
            install_root.display(),
            real.display()
        )));
    }
    Ok(())
}

/// 普通目录：非软链、是目录、没有 group/other 写位。属主不作判据（见上）。
fn verify_plain_dir(path: &Path) -> Result<(), TrustError> {
    let metadata = lstat(path)?;
    if is_link(&metadata) {
        return Err(TrustError::Symlink(path.to_path_buf()));
    }
    if !metadata.is_dir() {
        return Err(TrustError::NotADirectory(path.to_path_buf()));
    }
    if metadata.permissions().mode() & 0o022 != 0 {
        return Err(TrustError::WritableByGroupOrOther(path.to_path_buf()));
    }
    Ok(())
}

/// 校验一个我们要执行或读取的文件。
///
/// `expect_sha256` 给 `Some` 时做**完整**比对——前缀匹配等于把安全边际交给运气。
pub fn verify_file(
    path: &Path,
    expect_uid: u32,
    expect_mode: u32,
    expect_sha256: Option<&str>,
) -> Result<(), TrustError> {
    let metadata = lstat(path)?;
    if is_link(&metadata) {
        return Err(TrustError::Symlink(path.to_path_buf()));
    }
    if !metadata.is_file() {
        return Err(TrustError::NotARegularFile(path.to_path_buf()));
    }
    if metadata.uid() != expect_uid {
        return Err(TrustError::WrongOwner {
            path: path.to_path_buf(),
            uid: metadata.uid(),
            expected: expect_uid,
        });
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode != expect_mode {
        return Err(TrustError::WrongMode {
            path: path.to_path_buf(),
            mode,
            expected: expect_mode,
        });
    }
    if let Some(expected) = expect_sha256 {
        let bytes = std::fs::read(path)
            .map_err(|error| TrustError::Io(format!("{}: {error}", path.display())))?;
        if !hash_matches(&bytes, expected) {
            return Err(TrustError::HashMismatch(path.to_path_buf()));
        }
    }
    Ok(())
}

/// 全量比较，不接受前缀。
pub fn hash_matches(bytes: &[u8], expected_hex: &str) -> bool {
    use sha2::{Digest, Sha256};
    let actual = Sha256::digest(bytes);
    let actual: String = actual.iter().map(|byte| format!("{byte:02x}")).collect();
    // 长度也必须一致：`starts_with` 会让 16 位的前缀混过去。
    actual.len() == expected_hex.len() && actual == expected_hex.to_ascii_lowercase()
}

/// 64 位十六进制才是完整 sha256。
pub fn is_full_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn euid() -> u32 {
        // SAFETY: geteuid 无副作用。
        unsafe { libc::geteuid() }
    }

    /// 一个结构完整、权限合规的 .app。
    fn make_bundle(bundle: &std::path::Path) {
        fs::create_dir_all(bundle.join("Contents").join("Resources")).unwrap();
        for dir in [
            bundle.to_path_buf(),
            bundle.join("Contents"),
            bundle.join("Contents").join("Resources"),
        ] {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("veyl-trust-{tag}-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_a_plain_chain_owned_by_the_expected_uid() {
        let dir = temp("ok");
        let nested = dir.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        verify_chain_from(&dir, &nested, euid()).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_symlinked_component() {
        // 只看最后一段会被绕过：软链在中间任何一级都危险。
        let root = temp("link");
        let real = root.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = root.join("linked");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let nested = link.join("sub");
        fs::create_dir_all(&nested).unwrap();

        let error = verify_chain_from(&root, &nested, euid()).unwrap_err();
        assert!(
            matches!(error, TrustError::Symlink(_)),
            "中间一级是软链必须拒绝，实际：{error}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_group_or_other_writable_directories() {
        let dir = temp("perm");
        let open = dir.join("open");
        fs::create_dir_all(&open).unwrap();
        fs::set_permissions(&open, fs::Permissions::from_mode(0o777)).unwrap();

        let error = verify_chain_from(&dir, &open, euid()).unwrap_err();
        assert!(matches!(error, TrustError::WritableByGroupOrOther(_)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_wrong_owner() {
        let dir = temp("owner");
        let error = verify_chain_from(&dir, &dir, euid() + 1).unwrap_err();
        assert!(matches!(error, TrustError::WrongOwner { .. }));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_hash_check_requires_the_full_digest() {
        let bytes = b"hello";
        let full = {
            use sha2::{Digest, Sha256};
            Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect::<String>()
        };
        assert!(hash_matches(bytes, &full));
        assert!(
            !hash_matches(bytes, &full[..16]),
            "16 位前缀不能算通过"
        );
        assert!(!hash_matches(bytes, "deadbeef"));
    }

    #[test]
    fn a_file_must_be_regular_owned_and_correctly_sized() {
        let dir = temp("file");
        let file = dir.join("bin");
        fs::write(&file, b"x").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();

        verify_file(&file, euid(), 0o755, None).unwrap();

        // 权限位不对
        fs::set_permissions(&file, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(matches!(
            verify_file(&file, euid(), 0o755, None).unwrap_err(),
            TrustError::WrongMode { .. }
        ));

        // 软链
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(matches!(
            verify_file(&link, euid(), 0o755, None).unwrap_err(),
            TrustError::Symlink(_)
        ));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_sha256_detection() {
        assert!(is_full_sha256(&"a".repeat(64)));
        assert!(!is_full_sha256(&"a".repeat(16)));
        assert!(!is_full_sha256("not-hex"));
    }

    #[test]
    fn a_writable_parent_directory_does_not_condemn_the_bundle() {
        // 真机情况：/Applications 是 root:admin 0775。父目录可写，
        // 但 .app 本身是 0755 —— 必须通过，否则 TUN 第一次用就起不来。
        let root = temp("approot");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o775)).unwrap();
        let bundle = root.join("Veyl.app");
        make_bundle(&bundle);

        verify_bundle(&bundle, &root).expect("父目录可写不应该影响判断");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_group_writable_bundle_is_rejected() {
        let root = temp("appbad");
        let bundle = root.join("Veyl.app");
        make_bundle(&bundle);
        fs::set_permissions(&bundle, fs::Permissions::from_mode(0o775)).unwrap();

        let error = verify_bundle(&bundle, &root).unwrap_err();
        assert!(matches!(error, TrustError::WritableByGroupOrOther(_)));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_user_owned_bundle_is_fine_because_ownership_is_not_the_gate() {
        // 拖拽安装的 App 属主是用户本人。这条必须通过——否则最正常的安装方式会被拒。
        let root = temp("userowned");
        let bundle = root.join("Veyl.app");
        make_bundle(&bundle);
        verify_bundle(&bundle, &root).expect("属主不该影响判断");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_symlinked_bundle_is_rejected() {
        // 这条以前是死代码：先 canonicalize 再判断，拿到的是目标元数据。
        let root = temp("symbundle");
        let real_bundle = root.join("Real.app");
        make_bundle(&real_bundle);
        let link = root.join("Veyl.app");
        std::os::unix::fs::symlink(&real_bundle, &link).unwrap();

        let error = verify_bundle(&link, &root).unwrap_err();
        assert!(matches!(error, TrustError::Symlink(_)), "实际：{error}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bundle_under_a_symlinked_root_still_resolves() {
        // macOS 上 /var → /private/var。安装根与包路径两边都必须规范化。
        let real = temp("vartarget");
        let bundle = real.join("Veyl.app");
        make_bundle(&bundle);
        let link = real.parent().unwrap().join(format!("link-{:x}", rand::random::<u64>()));
        std::os::unix::fs::symlink(&real, &link).unwrap();

        verify_bundle(&link.join("Veyl.app"), &real).expect("安装根是软链路径也要能过");

        let _ = fs::remove_file(&link);
        let _ = fs::remove_dir_all(&real);
    }

    #[test]
    fn a_symlinked_resources_directory_is_rejected() {
        // 运行时和规则都从 Contents/Resources 来，只查 .app 这一层挡不住它。
        let root = temp("reslink");
        let bundle = root.join("Veyl.app");
        make_bundle(&bundle);
        let resources = bundle.join("Contents").join("Resources");
        fs::remove_dir_all(&resources).unwrap();
        let outside = temp("reslink-target");
        std::os::unix::fs::symlink(&outside, &resources).unwrap();

        let error = verify_bundle(&bundle, &root).unwrap_err();
        assert!(matches!(error, TrustError::Symlink(_)), "实际：{error}");

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn a_bundle_without_resources_is_rejected() {
        let root = temp("nores");
        let bundle = root.join("Empty.app");
        fs::create_dir_all(bundle.join("Contents")).unwrap();

        let error = verify_bundle(&bundle, &root).unwrap_err();
        assert!(matches!(error, TrustError::Missing(_)), "实际：{error}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bundle_outside_the_install_root_is_rejected() {
        let outside = temp("outside");
        let install = temp("installdir");
        let bundle = outside.join("Veyl.app");
        make_bundle(&bundle);

        let error = verify_bundle(&bundle, &install).unwrap_err();
        assert!(matches!(error, TrustError::Io(_)));

        let _ = fs::remove_dir_all(&outside);
        let _ = fs::remove_dir_all(&install);
    }
}
