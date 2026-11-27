//! Logging setup and secret redaction.
//!
//! Rule: passwords and tokens never reach logs or error strings. Everything
//! that may embed a control-plane response body goes through `redact_sensitive`
//! first.
//!
//! The file sink (for console troubleshooting on real nodes) is fed by the same
//! formatter as stdout, line by line, and every line is redacted again before
//! it is appended to `/var/log/veyl-agent/agent.log`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tracing_subscriber::EnvFilter;

/// Default location, size cap and backup count for the on-disk log.
#[derive(Debug, Clone)]
pub struct FileLogConfig {
    pub path: PathBuf,
    pub max_bytes: u64,
    pub keep_files: usize,
}

/// Install the tracing subscriber. `file` enables the rotating file sink; the
/// return value is the path actually opened (None when only stdout is used).
pub fn init(level: &str, file: Option<FileLogConfig>) -> Option<PathBuf> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new(format!(
            "veyl_agent={level},rmcp=warn,reqwest=warn,hyper=warn,hyper_util=warn"
        ))
    });

    let Some(cfg) = file else {
        init_stdout(filter);
        return None;
    };

    let sink = match FileSink::open(&cfg.path, cfg.max_bytes, cfg.keep_files) {
        Ok(sink) => Arc::new(Mutex::new(sink)),
        Err(e) => {
            // Never fail startup because the log file is unavailable (a dev run
            // as a normal user cannot create /var/log/veyl-agent).
            eprintln!(
                "veyl-agent: cannot open log file {}: {e}; logging to stdout only",
                cfg.path.display()
            );
            init_stdout(filter);
            return None;
        }
    };

    let make = {
        let sink = sink.clone();
        move || TeeWriter::new(Some(sink.clone()))
    };
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_ansi(false)
        .with_writer(make)
        .try_init();
    Some(cfg.path)
}

fn init_stdout(filter: EnvFilter) {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_ansi(false)
        .with_writer(|| TeeWriter::new(None))
        .try_init();
}

/// Writer that emits every completed line to stdout and, when a file sink is
/// configured, appends the same redacted line to it. Buffering per line keeps
/// JSON field redaction working even when the formatter writes in chunks.
struct TeeWriter {
    sink: Option<Arc<Mutex<FileSink>>>,
    buf: Vec<u8>,
}

impl TeeWriter {
    fn new(sink: Option<Arc<Mutex<FileSink>>>) -> Self {
        Self {
            sink,
            buf: Vec::new(),
        }
    }

    fn emit_line(&self, line: &[u8]) {
        let text = String::from_utf8_lossy(line);
        let redacted = redact_sensitive(text.trim_end_matches('\n'));
        {
            let mut stdout = io::stdout().lock();
            let _ = stdout.write_all(redacted.as_bytes());
            let _ = stdout.write_all(b"\n");
            let _ = stdout.flush();
        }
        if let Some(sink) = &self.sink {
            if let Ok(mut sink) = sink.lock() {
                if let Err(e) = sink.write_line(&redacted) {
                    eprintln!("veyl-agent: log file write failed: {e}");
                }
            }
        }
    }
}

impl Write for TeeWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            self.emit_line(&line);
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if !self.buf.is_empty() {
            let line = std::mem::take(&mut self.buf);
            self.emit_line(&line);
        }
        Ok(())
    }
}

impl Drop for TeeWriter {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

/// Append-only log file with size-based rotation (`agent.log`, `agent.log.1`,
/// …). Created 0600 in a 0700 directory; rotation renames, never copies.
struct FileSink {
    path: PathBuf,
    max_bytes: u64,
    keep_files: usize,
    file: File,
    size: u64,
}

impl FileSink {
    fn open(path: &Path, max_bytes: u64, keep_files: usize) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(path)?;
        // `mode` only applies at creation; tighten a pre-existing file too.
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        let size = file.metadata()?.len();
        Ok(Self {
            path: path.to_path_buf(),
            max_bytes,
            keep_files: keep_files.max(1),
            file,
            size,
        })
    }

    fn write_line(&mut self, line: &str) -> io::Result<()> {
        let mut bytes = line.as_bytes().to_vec();
        bytes.push(b'\n');
        if self.size > 0 && self.size + bytes.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        self.file.write_all(&bytes)?;
        self.size += bytes.len() as u64;
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        // This is the logging subsystem itself, so `tracing` would recurse back
        // into this sink. Failures go to stderr instead, and every one of them
        // is reported: a rotation that quietly stops working is a file that
        // grows until the disk is full, on a machine nobody can log into.
        let mut problems: Vec<(PathBuf, io::Error)> = Vec::new();

        let oldest = backup_path(&self.path, self.keep_files);
        if let Err(e) = fs::remove_file(&oldest) {
            if e.kind() != io::ErrorKind::NotFound {
                problems.push((oldest.clone(), e));
            }
        }
        for i in (1..self.keep_files).rev() {
            let from = backup_path(&self.path, i);
            // `Path::exists()` folds "not there" and "cannot stat" into `false`,
            // which would skip this backup level without a word.
            match fs::metadata(&from) {
                Ok(_) => {
                    if let Err(e) = fs::rename(&from, backup_path(&self.path, i + 1)) {
                        problems.push((from, e));
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => problems.push((from, e)),
            }
        }
        match fs::rename(&self.path, backup_path(&self.path, 1)) {
            Ok(()) => {}
            // The live file is gone (logrotate, or a manual `rm`): our handle
            // still points at the unlinked inode and the `open` below recreates
            // the path. That is a recovery path, not a rotation failure.
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => problems.push((self.path.clone(), e)),
        }
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&self.path)?;
        if let Err(e) = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600)) {
            problems.push((self.path.clone(), e));
        }
        for (path, e) in &problems {
            eprintln!(
                "veyl-agent: log rotation failed for {}: {e}",
                path.display()
            );
        }
        // Take the size from the file that actually exists. If the rename above
        // failed the old contents are still here; hard-setting 0 would make the
        // rotator believe it had replaced them, and the file would grow to about
        // twice `max_bytes` before another attempt.
        self.size = match self.file.metadata() {
            Ok(meta) => meta.len(),
            Err(e) => {
                eprintln!(
                    "veyl-agent: log rotation could not stat {}: {e}",
                    self.path.display()
                );
                // Retry on the next write rather than pretend the file is empty.
                self.max_bytes
            }
        };
        Ok(())
    }
}

fn backup_path(path: &Path, index: usize) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

/// Replace JSON string values for password/token fields and any `agt_…` /
/// `enr_…` token runs with `***`. `Authorization:` headers and `Bearer <token>`
/// runs are redacted too, so a stray header dump cannot leak a token.
pub fn redact_sensitive(input: &str) -> String {
    let mut out = input.to_string();
    for field in [
        "password",
        "server_token",
        "enrollment_token",
        "token",
        "authorization",
    ] {
        out = redact_json_field(&out, field);
    }
    out = redact_authorization_header(&out);
    out = redact_bearer(&out);
    out = redact_assignments(&out);
    redact_prefixed_tokens(&out, &["agt_", "enr_"])
}

/// `password=…`, `token=…`, `access_token=…` in query strings, form bodies and
/// key/value log lines (the JSON form is handled by `redact_json_field`).
fn redact_assignments(input: &str) -> String {
    const KEYS: &[&str] = &[
        "password",
        "token",
        "access_token",
        "server_token",
        "enrollment_token",
        "authorization",
    ];
    let lower = input.to_ascii_lowercase();
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;
    while cursor < input.len() {
        let hit = KEYS
            .iter()
            .filter_map(|key| {
                let rel = lower[cursor..].find(key)?;
                Some((cursor + rel, key.len()))
            })
            .min_by_key(|(start, _)| *start);
        let Some((start, key_len)) = hit else {
            out.push_str(&input[cursor..]);
            break;
        };
        let boundary = start == 0 || !is_token_char(bytes[start - 1]);
        if !boundary {
            let end = start + key_len;
            out.push_str(&input[cursor..end]);
            cursor = end;
            continue;
        }
        let key_end = start + key_len;
        let mut i = key_end;
        while i < input.len() && matches!(bytes[i], b' ' | b'\t') {
            i += 1;
        }
        let value_start = if i < input.len() && bytes[i] == b'=' {
            i += 1;
            while i < input.len() && matches!(bytes[i], b' ' | b'\t') {
                i += 1;
            }
            i
        } else {
            out.push_str(&input[cursor..key_end]);
            cursor = key_end;
            continue;
        };
        let mut value_end = value_start;
        while value_end < input.len() {
            match bytes[value_end] {
                b'&' | b' ' | b'\t' | b'\n' | b'\r' | b'"' | b'\'' | b',' | b'}' | b')' => break,
                _ => value_end += 1,
            }
        }
        out.push_str(&input[cursor..value_start]);
        out.push_str("***");
        cursor = value_end;
    }
    if cursor == 0 {
        return input.to_string();
    }
    out
}

fn redact_json_field(input: &str, field: &str) -> String {
    let needle = format!("\"{field}\"");
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(i) = rest.find(&needle) {
        out.push_str(&rest[..i + needle.len()]);
        let after = &rest[i + needle.len()..];
        let Some(colon) = after.find(':') else {
            out.push_str(after);
            return out;
        };
        out.push_str(&after[..=colon]);
        let after_colon = &after[colon + 1..];
        let trimmed = after_colon.trim_start();
        out.push_str(&after_colon[..after_colon.len() - trimmed.len()]);
        if !trimmed.starts_with('"') {
            out.push_str(trimmed);
            return out;
        }
        let bytes = trimmed.as_bytes();
        let mut j = 1;
        let mut end = None;
        while j < bytes.len() {
            match bytes[j] {
                b'\\' => j += 2,
                b'"' => {
                    end = Some(j);
                    break;
                }
                _ => j += 1,
            }
        }
        match end {
            Some(j) => {
                out.push_str("\"***\"");
                rest = &trimmed[j + 1..];
            }
            None => {
                out.push_str(trimmed);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `authorization: <anything up to the line end>` -> `authorization: ***`.
fn redact_authorization_header(input: &str) -> String {
    const NEEDLE: &str = "authorization";
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(rel) = lower[cursor..].find(NEEDLE) {
        let start = cursor + rel;
        let end = start + NEEDLE.len();
        let boundary = start == 0 || !is_token_char(input.as_bytes()[start - 1]);
        if !boundary {
            out.push_str(&input[cursor..end]);
            cursor = end;
            continue;
        }
        out.push_str(&input[cursor..end]);
        let mut i = end;
        while i < input.len() && matches!(input.as_bytes()[i], b' ' | b'\t') {
            i += 1;
        }
        if i < input.len() && input.as_bytes()[i] == b':' {
            out.push_str(&input[end..=i]);
            i += 1;
            while i < input.len() && matches!(input.as_bytes()[i], b' ' | b'\t') {
                i += 1;
            }
            let line_end = input[i..].find('\n').map(|p| i + p).unwrap_or(input.len());
            out.push_str(" ***");
            cursor = line_end;
        } else {
            cursor = end;
        }
    }
    out.push_str(&input[cursor..]);
    out
}

/// `Bearer <token>` -> `Bearer ***` (case-insensitive prefix).
fn redact_bearer(input: &str) -> String {
    const NEEDLE: &str = "bearer ";
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(rel) = lower[cursor..].find(NEEDLE) {
        let start = cursor + rel;
        // Only accept a word boundary before "bearer".
        let boundary = start == 0 || !is_token_char(input.as_bytes()[start - 1]);
        if !boundary {
            out.push_str(&input[cursor..start + NEEDLE.len()]);
            cursor = start + NEEDLE.len();
            continue;
        }
        let token_start = start + NEEDLE.len();
        let mut end = token_start;
        while end < input.len() && is_token_char(input.as_bytes()[end]) {
            end += 1;
        }
        out.push_str(&input[cursor..start]);
        out.push_str(&input[start..token_start]);
        if end > token_start {
            out.push_str("***");
        }
        cursor = end;
    }
    out.push_str(&input[cursor..]);
    out
}

fn is_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.' || b == b'~' || b == b'+'
}

fn redact_prefixed_tokens(input: &str, prefixes: &[&str]) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let boundary = i == 0 || !is_token_char(bytes[i - 1]);
        let prefix = boundary
            .then(|| prefixes.iter().find(|p| input[i..].starts_with(**p)))
            .flatten()
            .copied();
        if let Some(prefix) = prefix {
            let mut j = i + prefix.len();
            while j < input.len() && is_token_char(bytes[j]) {
                j += 1;
            }
            out.push_str(prefix);
            out.push_str("***");
            i = j;
        } else {
            let ch = input[i..].chars().next().expect("valid char boundary");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Char-safe truncation for error bodies.
pub fn truncate(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        input.to_string()
    } else {
        format!("{}…", input.chars().take(max_chars).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn redacts_password_and_token_fields() {
        let input = r#"{"password":"a1b2c3","server_token":"secret","port":30412}"#;
        let out = redact_sensitive(input);
        assert!(out.contains(r#""password":"***""#));
        assert!(out.contains(r#""server_token":"***""#));
        assert!(out.contains("30412"));
        assert!(!out.contains("a1b2c3"));
        assert!(!out.contains("secret"));
    }

    #[test]
    fn redacts_token_runs_even_when_key_is_unknown() {
        let out = redact_sensitive("auth failed for agt_ABC123-def and enr_xyz");
        assert_eq!(out, "auth failed for agt_*** and enr_***");
    }

    #[test]
    fn redaction_survives_nested_and_escaped_values() {
        let input = r#"{"error":"bad","desired":{"password":"p\"w","port":1}}"#;
        let out = redact_sensitive(input);
        assert!(out.contains(r#""password":"***""#));
        assert!(!out.contains("p\\\"w"));
    }

    #[test]
    fn redacts_authorization_headers_and_bearer_tokens() {
        let out = redact_sensitive(
            "Authorization: Bearer abc.def.ghi\nsent bearer tok123 to the node",
        );
        assert!(!out.contains("abc.def.ghi"));
        assert!(!out.contains("tok123"));
        assert!(out.contains("Authorization: ***"));
        assert!(out.to_ascii_lowercase().contains("bearer ***"));
    }

    #[test]
    fn redacts_query_and_assignment_secrets() {
        let out = redact_sensitive(
            "GET /v1/agent/enroll?password=abc123&port=1 token=tok-456 access_token=xyz",
        );
        assert!(!out.contains("abc123"));
        assert!(!out.contains("tok-456"));
        assert!(!out.contains("xyz"));
        assert!(out.contains("password=***"));
        assert!(out.contains("token=***"));
    }

    #[test]
    fn truncate_is_char_safe() {
        assert_eq!(truncate("密码错误", 2), "密码…");
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "veyl-agent-log-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read(path: &Path) -> String {
        let mut s = String::new();
        File::open(path).unwrap().read_to_string(&mut s).unwrap();
        s
    }

    #[test]
    fn file_sink_writes_redacted_lines_with_0600() {
        let dir = tmpdir("redact");
        let path = dir.join("logs/agent.log");
        let sink = FileSink::open(&path, 1024 * 1024, 3).unwrap();
        let writer = TeeWriter::new(Some(Arc::new(Mutex::new(sink))));
        let mut w = writer;
        // Split a record across writes to prove redaction is per line.
        w.write_all(b"rotate ok ").unwrap();
        w.write_all(br#"{"password":"deadbeef","server_token":"#).unwrap();
        w.write_all(b"\"secret\"}\n").unwrap();
        w.write_all(b"req header Authorization: Bearer tok-123\n")
            .unwrap();
        w.write_all(b"enrolled agt_ABCDEF\n").unwrap();
        drop(w);

        let text = read(&path);
        assert!(text.contains(r#""password":"***""#));
        assert!(!text.contains("deadbeef"));
        assert!(!text.contains("secret"));
        assert!(!text.contains("tok-123"));
        assert!(!text.contains("ABCDEF"));
        assert!(text.contains("agt_***"));

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir_mode = fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_sink_rotates_by_size_and_keeps_the_configured_count() {
        let dir = tmpdir("rotate");
        let path = dir.join("agent.log");
        let mut sink = FileSink::open(&path, 200, 2).unwrap();
        for i in 0..20 {
            sink.write_line(&format!("line {i:02} {}", "x".repeat(40)))
                .unwrap();
        }
        assert!(path.exists());
        assert!(backup_path(&path, 1).exists());
        assert!(backup_path(&path, 2).exists());
        assert!(!backup_path(&path, 3).exists(), "keep_files=2 keeps two backups");
        let current = read(&path);
        assert!(current.contains("line 19"));
        // The old backup holds older lines, not the newest one.
        let oldest = read(&backup_path(&path, 2));
        assert!(!oldest.contains("line 19"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_sink_starts_a_new_file_after_rotation() {
        let dir = tmpdir("rotate-size");
        let path = dir.join("agent.log");
        let mut sink = FileSink::open(&path, 100, 1).unwrap();
        sink.write_line(&"a".repeat(80)).unwrap();
        sink.write_line(&"b".repeat(80)).unwrap();
        assert!(read(&backup_path(&path, 1)).contains(&"a".repeat(80)));
        assert!(read(&path).contains(&"b".repeat(80)));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failed_rename_keeps_the_size_honest() {
        let dir = tmpdir("rotate-fail");
        let path = dir.join("agent.log");
        let mut sink = FileSink::open(&path, 50, 1).unwrap();
        sink.write_line(&"a".repeat(40)).unwrap();
        // Make the rotation's rename fail: `.1` is a non-empty directory.
        let blocker = backup_path(&path, 1);
        fs::create_dir_all(&blocker).unwrap();
        fs::write(blocker.join("keep"), b"x").unwrap();
        sink.write_line(&"b".repeat(40)).unwrap();
        let on_disk = fs::metadata(&path).unwrap().len();
        assert!(on_disk > 50, "old contents were not rotated away");
        assert_eq!(sink.size, on_disk, "size must follow the file that survived");
        fs::remove_dir_all(&dir).ok();
    }
}
