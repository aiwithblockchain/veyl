//! Persistent self-signed CA + leaf, generated with `rcgen` (no external
//! `openssl` binary). Files are reused across restarts; fingerprints are the
//! trust anchors the control plane hands to desktop clients.

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, SanType,
};
use rustls::pki_types::{
    CertificateDer, PrivateKeyDer, PrivatePkcs1KeyDer, PrivatePkcs8KeyDer, PrivateSec1KeyDer,
};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct CertPaths {
    pub ca_cert: PathBuf,
    pub ca_key: PathBuf,
    pub leaf_cert: PathBuf,
    pub leaf_key: PathBuf,
}

fn paths(dir: &Path) -> CertPaths {
    CertPaths {
        ca_cert: dir.join("ca-cert.pem"),
        ca_key: dir.join("ca-key.pem"),
        leaf_cert: dir.join("leaf-cert.pem"),
        leaf_key: dir.join("leaf-key.pem"),
    }
}

fn write_secret(path: &Path, contents: &str) -> Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("create {}", path.display()))?;
    file.write_all(contents.as_bytes())
        .with_context(|| format!("write {}", path.display()))?;
    // Tighten a pre-existing file that was created with looser permissions.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("chmod 600 {}", path.display()))?;
    }
    Ok(())
}

fn leaf_sans_path(dir: &Path) -> PathBuf {
    dir.join("leaf-sans.json")
}

/// SANs every leaf carries, plus the node's public host(s). The desktop
/// connects with `https://<public-ip>:port`, so the IP must be in the SAN or
/// webpki rejects the name even when the CA is trusted.
fn canonical_hosts(extra: &[String]) -> Vec<String> {
    let mut hosts = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    for host in extra {
        let host = host.trim();
        if !host.is_empty() {
            hosts.push(host.to_string());
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    hosts.retain(|h| seen.insert(h.clone()));
    hosts
}

/// Reuse the CA and leaf if both exist and parse; generate whichever half is
/// missing. Never overwrites an existing CA (that would silently invalidate
/// every client's pin). When the configured host list changes, only the leaf is
/// re-signed — the CA (and therefore the CA trust anchor) stays the same.
pub fn ensure_certs(dir: &Path) -> Result<CertPaths> {
    ensure_certs_with_hosts(dir, &[])
}

pub fn ensure_certs_with_hosts(dir: &Path, extra_hosts: &[String]) -> Result<CertPaths> {
    std::fs::create_dir_all(dir)?;
    let p = paths(dir);

    let issuer = match (p.ca_cert.exists(), p.ca_key.exists()) {
        (true, true) => {
            let ca_pem = std::fs::read_to_string(&p.ca_cert)
                .with_context(|| format!("read {}", p.ca_cert.display()))?;
            let key_pem = std::fs::read_to_string(&p.ca_key)
                .with_context(|| format!("read {}", p.ca_key.display()))?;
            let key_pair = KeyPair::from_pem(&key_pem).context("parse CA private key")?;
            Issuer::from_ca_cert_pem(&ca_pem, key_pair).context("parse CA certificate")?
        }
        (false, false) => {
            let (cert, issuer) = generate_ca()?;
            write_secret(&p.ca_cert, &cert.pem())?;
            write_secret(&p.ca_key, &issuer.key().serialize_pem())?;
            issuer
        }
        _ => bail!(
            "incomplete CA in {}: ca-cert.pem and ca-key.pem must both exist",
            dir.display()
        ),
    };

    let hosts = canonical_hosts(extra_hosts);
    let marker = leaf_sans_path(dir);
    let current_hosts: Option<Vec<String>> = std::fs::read_to_string(&marker)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let leaf_usable = p.leaf_cert.exists() && p.leaf_key.exists() && current_hosts.as_ref() == Some(&hosts);

    if !leaf_usable {
        let (cert, key) = generate_leaf(&issuer, &hosts)?;
        write_secret(&p.leaf_cert, &cert.pem())?;
        write_secret(&p.leaf_key, &key.serialize_pem())?;
        std::fs::write(&marker, serde_json::to_vec_pretty(&hosts)?)
            .with_context(|| format!("write {}", marker.display()))?;
    }

    Ok(p)
}

fn generate_ca() -> Result<(rcgen::Certificate, Issuer<'static, KeyPair>)> {
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    params.distinguished_name.push(DnType::CommonName, "Veyl Node Agent CA");
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let key = KeyPair::generate()?;
    let cert = params.self_signed(&key)?;
    Ok((cert, Issuer::new(params, key)))
}

fn generate_leaf(
    issuer: &Issuer<'static, KeyPair>,
    hosts: &[String],
) -> Result<(rcgen::Certificate, KeyPair)> {
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    params.distinguished_name.push(DnType::CommonName, "veyl-node-agent");
    for host in hosts {
        match host.parse::<IpAddr>() {
            Ok(ip) => params.subject_alt_names.push(SanType::IpAddress(ip)),
            Err(_) => params
                .subject_alt_names
                .push(SanType::DnsName(host.as_str().try_into()?)),
        }
    }
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.use_authority_key_identifier_extension = true;
    let key = KeyPair::generate()?;
    let cert = params.signed_by(&key, issuer)?;
    Ok((cert, key))
}

/// Generate a brand-new CA + leaf in `dir`, replacing anything there. Used by
/// `gen-certs` and tests; `ensure_certs` is what production calls.
pub fn generate(dir: &Path) -> Result<CertPaths> {
    generate_with_hosts(dir, &[])
}

pub fn generate_with_hosts(dir: &Path, extra_hosts: &[String]) -> Result<CertPaths> {
    std::fs::create_dir_all(dir)?;
    let p = paths(dir);
    for path in [&p.ca_cert, &p.ca_key, &p.leaf_cert, &p.leaf_key, &leaf_sans_path(dir)] {
        let _ = std::fs::remove_file(path);
    }
    let hosts = canonical_hosts(extra_hosts);
    let (ca_cert, issuer) = generate_ca()?;
    write_secret(&p.ca_cert, &ca_cert.pem())?;
    write_secret(&p.ca_key, &issuer.key().serialize_pem())?;
    let (leaf_cert, leaf_key) = generate_leaf(&issuer, &hosts)?;
    write_secret(&p.leaf_cert, &leaf_cert.pem())?;
    write_secret(&p.leaf_key, &leaf_key.serialize_pem())?;
    std::fs::write(leaf_sans_path(dir), serde_json::to_vec_pretty(&hosts)?)?;
    Ok(p)
}

fn pem_blocks(text: &str, label: &str) -> Result<Vec<Vec<u8>>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(&begin) {
        let after = &rest[i + begin.len()..];
        let Some(j) = after.find(&end) else { break };
        let b64: String = after[..j].chars().filter(|c| !c.is_whitespace()).collect();
        out.push(
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .context("decode PEM base64")?,
        );
        rest = &after[j + end.len()..];
    }
    Ok(out)
}

pub fn load_certs(path: &Path) -> Result<Vec<CertificateDer<'static>>> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let blocks = pem_blocks(&text, "CERTIFICATE")?;
    if blocks.is_empty() {
        bail!("no CERTIFICATE block in {}", path.display());
    }
    Ok(blocks.into_iter().map(CertificateDer::from).collect())
}

pub fn load_key(path: &Path) -> Result<PrivateKeyDer<'static>> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    for (label, wrap) in [
        ("PRIVATE KEY", true), // PKCS#8, what rcgen writes
        ("RSA PRIVATE KEY", false),
        ("EC PRIVATE KEY", false),
    ] {
        if let Some(der) = pem_blocks(&text, label)?.into_iter().next() {
            return if wrap {
                Ok(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(der)))
            } else if label == "RSA PRIVATE KEY" {
                Ok(PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(der)))
            } else {
                Ok(PrivateKeyDer::Sec1(PrivateSec1KeyDer::from(der)))
            };
        }
    }
    bail!("no private key in {}", path.display())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(Sha256::digest(bytes).as_slice())
}

fn first_cert_fingerprint(path: &Path) -> Result<String> {
    let der = load_certs(path)?
        .into_iter()
        .next()
        .with_context(|| format!("no certificate in {}", path.display()))?;
    Ok(sha256_hex(der.as_ref()))
}

pub fn leaf_fingerprint(path: &Path) -> Result<String> {
    first_cert_fingerprint(path)
}

/// SANs from the last leaf, minus the always-present local ones. Used when the
/// public IP cannot be detected at startup: re-signing without it would break
/// every desktop connection.
pub fn previous_extra_hosts(dir: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(leaf_sans_path(dir)).ok()?;
    let hosts: Vec<String> = serde_json::from_str(&text).ok()?;
    Some(
        hosts
            .into_iter()
            .filter(|h| h != "localhost" && h != "127.0.0.1")
            .collect(),
    )
}

pub fn ca_fingerprint(path: &Path) -> Result<String> {
    first_cert_fingerprint(path)
}

pub fn parse_fingerprint(s: &str) -> Result<[u8; 32]> {
    let clean: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if clean.len() != 64 {
        bail!(
            "fingerprint must be 64 hex chars (32 bytes), got {}",
            clean.len()
        );
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "veyl-agent-cert-{name}-{}-{}",
            std::process::id(),
            auth_nonce()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn auth_nonce() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos() as u64
    }

    #[test]
    fn generates_and_reuses_the_same_ca_and_leaf() {
        let dir = tmpdir("reuse");
        let first = ensure_certs(&dir).unwrap();
        let ca1 = ca_fingerprint(&first.ca_cert).unwrap();
        let leaf1 = leaf_fingerprint(&first.leaf_cert).unwrap();

        let second = ensure_certs(&dir).unwrap();
        assert_eq!(ca1, ca_fingerprint(&second.ca_cert).unwrap());
        assert_eq!(leaf1, leaf_fingerprint(&second.leaf_cert).unwrap());

        // rustls can load both halves from disk.
        assert_eq!(load_certs(&second.leaf_cert).unwrap().len(), 1);
        load_key(&second.leaf_key).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn regenerates_only_a_missing_leaf() {
        let dir = tmpdir("leaf-only");
        let first = ensure_certs(&dir).unwrap();
        let ca1 = ca_fingerprint(&first.ca_cert).unwrap();
        let leaf1 = leaf_fingerprint(&first.leaf_cert).unwrap();
        std::fs::remove_file(&first.leaf_cert).unwrap();
        std::fs::remove_file(&first.leaf_key).unwrap();

        let second = ensure_certs(&dir).unwrap();
        assert_eq!(ca1, ca_fingerprint(&second.ca_cert).unwrap());
        assert_ne!(leaf1, leaf_fingerprint(&second.leaf_cert).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn host_changes_resign_the_leaf_but_keep_the_ca() {
        let dir = tmpdir("hosts");
        let first = ensure_certs(&dir).unwrap();
        let ca1 = ca_fingerprint(&first.ca_cert).unwrap();
        let leaf1 = leaf_fingerprint(&first.leaf_cert).unwrap();

        let with_ip = ensure_certs_with_hosts(&dir, &["203.0.113.7".to_string()]).unwrap();
        let leaf2 = leaf_fingerprint(&with_ip.leaf_cert).unwrap();
        assert_eq!(ca1, ca_fingerprint(&with_ip.ca_cert).unwrap());
        assert_ne!(leaf1, leaf2);
        assert_eq!(
            previous_extra_hosts(&dir),
            Some(vec!["203.0.113.7".to_string()])
        );

        let again = ensure_certs_with_hosts(&dir, &["203.0.113.7".to_string()]).unwrap();
        assert_eq!(leaf2, leaf_fingerprint(&again.leaf_cert).unwrap());

        let back = ensure_certs(&dir).unwrap();
        assert_eq!(ca1, ca_fingerprint(&back.ca_cert).unwrap());
        assert_ne!(leaf2, leaf_fingerprint(&back.leaf_cert).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }
}
