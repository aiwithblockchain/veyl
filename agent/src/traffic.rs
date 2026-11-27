//! Outbound traffic metering: an nft chain that counts bytes on the default
//! route's interface, a persisted accumulator, and event-triggered reports to
//! `POST /v1/agent/traffic`.
//!
//! Contract: `docs/design/traffic-billing.md` §6.2–§6.6 and §7.2. Three rules
//! shape this file:
//! - the agent never sends a billing cycle; the control plane derives it from
//!   its own clock when the report arrives;
//! - every error is logged and swallowed: sing-box, credentials and the MCP
//!   endpoint must keep working when metering does not;
//! - when the persisted state is gone, the current counter becomes the new
//!   baseline. Some traffic is then under-counted; nothing is counted twice.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::now_unix;
use crate::config::TrafficConfig;
use crate::control::ControlApi;
use crate::host::Host;

/// Dedicated table: the host's own firewall is never touched, and `nft` only
/// ever lists this one.
pub const TABLE: &str = "veyl_meter";
pub const CHAIN: &str = "out";
/// Report at least this often even on an idle machine. Only the byte threshold
/// is configurable; this is the design doc's fixed window.
pub const REPORT_IDLE_SECS: u64 = 30 * 60;

/// One report that has been handed to the network but not acknowledged. It is
/// persisted before the request goes out: if the response is lost, the retry
/// must carry the exact same `(seq, bytes)` or the control plane cannot dedupe
/// it, and bytes that arrived in the meantime would be dropped forever.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingAttempt {
    pub seq: u64,
    pub bytes: u64,
}

/// Persisted accumulator. `seq` is per server, monotonic and never reset.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrafficState {
    #[serde(default)]
    pub counter_last: u64,
    #[serde(default)]
    pub pending_bytes: u64,
    #[serde(default)]
    pub last_saved_at: u64,
    #[serde(default)]
    pub last_ok_at: u64,
    #[serde(default)]
    pub seq: u64,
    /// In-flight report; `pending_bytes` may grow past it while it is sent.
    #[serde(default)]
    pub pending_attempt: Option<PendingAttempt>,
}

/// Atomic state file (temp file + rename, 0600).
#[derive(Debug, Clone)]
pub struct TrafficStore {
    path: PathBuf,
}

impl TrafficStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `None` means "never written"; a corrupt file is an error. Both take the
    /// conservative branch in [`TrafficMeter`].
    pub fn load(&self) -> Result<Option<TrafficState>> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text)
                .map(Some)
                .with_context(|| format!("parse {}", self.path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("read {}", self.path.display())),
        }
    }

    pub fn save(&self, state: &TrafficState) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create traffic state dir {}", parent.display()))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(state)?;
        {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&tmp)
                .with_context(|| format!("create {}", tmp.display()))?;
            file.write_all(text.as_bytes())
                .with_context(|| format!("write {}", tmp.display()))?;
        }
        std::fs::rename(&tmp, &self.path)
            .with_context(|| format!("rename {} -> {}", tmp.display(), self.path.display()))?;
        Ok(())
    }
}

pub struct TrafficMeter {
    host: Arc<dyn Host>,
    control: Arc<dyn ControlApi>,
    store: TrafficStore,
    params: TrafficConfig,
    state: Mutex<Option<TrafficState>>,
    /// Consecutive failed reports, reset by the next 2xx. Drives a single info
    /// line when reporting recovers; without it the log simply goes quiet and
    /// a healed outage looks the same as a wedged one.
    report_failures: AtomicU32,
}

impl TrafficMeter {
    pub fn new(
        host: Arc<dyn Host>,
        control: Arc<dyn ControlApi>,
        state_path: impl Into<PathBuf>,
        params: TrafficConfig,
    ) -> Self {
        Self {
            host,
            control,
            store: TrafficStore::new(state_path),
            params,
            state: Mutex::new(None),
            report_failures: AtomicU32::new(0),
        }
    }

    pub async fn tick_now(&self) {
        self.tick(now_unix()).await;
    }

    /// One 30-second window: read the counter, accumulate, then save and/or
    /// report if due. Never returns an error; every failure is a log line.
    pub async fn tick(&self, now: u64) {
        let counter = match self.read_counter().await {
            Ok(counter) => counter,
            Err(e) => {
                tracing::warn!(error = %e, "traffic: counter read failed; skipping this window");
                return;
            }
        };

        let (save_due, new_attempt, report) = {
            let mut guard = self.state.lock().unwrap();
            if guard.is_none() {
                *guard = Some(self.seed(now, counter));
            }
            let state = guard.as_mut().expect("seeded above");
            // A smaller reading means the table was recreated: everything the
            // new counter holds is new traffic. This branch is the *only* thing
            // that absorbs a rebuild — `read_counter` reports the window it
            // rebuilds in as a failure, so nothing else carries those bytes.
            // Removing or "simplifying" it double-counts or drops a rebuild.
            let delta = if counter < state.counter_last {
                counter
            } else {
                counter - state.counter_last
            };
            state.counter_last = counter;
            state.pending_bytes = state.pending_bytes.saturating_add(delta);

            let save_due = now.saturating_sub(state.last_saved_at) >= self.params.save_secs;
            let idle_due = now.saturating_sub(state.last_ok_at) >= REPORT_IDLE_SECS;
            // A zero-byte report is deliberate: the control plane pools the
            // allowance of machines that have a report in the cycle, so an idle
            // node must still say "nothing new" every 30 minutes.
            let due = state.pending_bytes >= self.params.report_bytes || idle_due;
            let mut new_attempt = false;
            if due && state.pending_attempt.is_none() {
                // Freeze the batch *before* the request leaves.
                state.pending_attempt = Some(PendingAttempt {
                    seq: state.seq,
                    bytes: state.pending_bytes,
                });
                new_attempt = true;
            }
            let report = state
                .pending_attempt
                .as_ref()
                .map(|attempt| (attempt.seq, attempt.bytes));
            (save_due, new_attempt, report)
        };

        // The attempt is on disk before the network can see it; a retry after a
        // crash resends the same batch instead of a larger, unacknowledged one.
        if save_due || new_attempt {
            self.save(now);
        }
        let Some((seq, delta_bytes)) = report else {
            return;
        };

        match self.control.traffic(seq, delta_bytes).await {
            Ok(()) => {
                let failures = self.report_failures.swap(0, Ordering::Relaxed);
                {
                    let mut guard = self.state.lock().unwrap();
                    if let Some(state) = guard.as_mut() {
                        let acknowledged = state.pending_attempt.take();
                        let bytes = acknowledged.map(|a| a.bytes).unwrap_or(delta_bytes);
                        state.pending_bytes = state.pending_bytes.saturating_sub(bytes);
                        state.seq = state.seq.saturating_add(1);
                        state.last_ok_at = now;
                    }
                }
                self.save(now);
                if failures > 0 {
                    tracing::info!(
                        failures,
                        seq,
                        "traffic: reporting recovered; the earlier failures are cleared"
                    );
                }
                tracing::debug!(seq, delta_bytes, "traffic: reported");
            }
            Err(e) => {
                let failures = self.report_failures.fetch_add(1, Ordering::Relaxed) + 1;
                // 409 `server_destroyed` is deliberately not special-cased. The
                // control plane only sets `destroyed_at` after the droplet is
                // gone, so a live agent should never see it; when it does, our
                // records are wrong while the machine still serves traffic. A
                // one-way "stop reporting" latch would hide that leak for good,
                // so the next window simply tries again.
                // Keep the attempt and the seq untouched: the next window
                // resends exactly this batch, so a report the control plane did
                // record (but whose response was lost) is deduped instead of
                // blocking the bytes that arrived after it.
                tracing::warn!(
                    seq,
                    delta_bytes,
                    failures,
                    error = %e,
                    "traffic: report failed; retrying the same batch next window"
                );
            }
        }
    }

    /// Load the persisted state, or establish a fresh baseline from the current
    /// counter. Only the missing/unreadable branch knows that the current
    /// reading must *not* be treated as delta (that would bill traffic twice).
    fn seed(&self, now: u64, counter: u64) -> TrafficState {
        match self.store.load() {
            Ok(Some(state)) => state,
            Ok(None) => {
                tracing::warn!(
                    event = "metering_state_lost",
                    counter,
                    "traffic: no state file; using the current counter as the new baseline"
                );
                self.new_baseline(now, counter)
            }
            Err(e) => {
                tracing::error!(
                    event = "metering_state_lost",
                    counter,
                    error = %e,
                    "traffic: state file is unreadable; using the current counter as the new baseline"
                );
                self.new_baseline(now, counter)
            }
        }
    }

    fn new_baseline(&self, now: u64, counter: u64) -> TrafficState {
        // `seq` starts from the clock instead of 0: the control plane discards
        // `seq <= last_seq`, so a reset to 0 after a lost state file would look
        // like a duplicate and silently drop every report until the counter
        // caught up with the old sequence.
        let state = TrafficState {
            counter_last: counter,
            pending_bytes: 0,
            last_saved_at: now,
            last_ok_at: now,
            seq: now.max(1),
            pending_attempt: None,
        };
        if let Err(e) = self.store.save(&state) {
            tracing::warn!(error = %e, "traffic: could not write the initial state");
        }
        state
    }

    fn save(&self, now: u64) {
        let mut guard = self.state.lock().unwrap();
        let Some(state) = guard.as_mut() else {
            return;
        };
        state.last_saved_at = now;
        if let Err(e) = self.store.save(state) {
            tracing::warn!(error = %e, "traffic: state save failed");
        }
    }

    #[cfg(test)]
    fn snapshot(&self) -> Option<TrafficState> {
        self.state.lock().unwrap().clone()
    }

    #[cfg(test)]
    fn report_failures(&self) -> u32 {
        self.report_failures.load(Ordering::Relaxed)
    }

    /// Resolve the interface on every read: a default-route change would
    /// otherwise freeze the counter without any error.
    ///
    /// Exactly two outcomes: `Ok(bytes)` is a real reading of the counter, and
    /// `Err` means this window has no reading at all. A rebuild is a repair,
    /// not a reading — the window it happens in is reported as a failure and
    /// the next window picks the new counter up through the negative-delta
    /// branch in `tick`.
    async fn read_counter(&self) -> Result<u64> {
        let iface = self.default_iface().await?;
        match self.read_table().await? {
            TableRead::Counter {
                iface: rule_iface,
                bytes,
            } if rule_iface == iface => Ok(bytes),
            TableRead::Counter {
                iface: rule_iface, ..
            } => {
                tracing::info!(
                    rule_iface,
                    iface = %iface,
                    "traffic: counter follows a stale interface; rebuilding"
                );
                self.rebuild(&iface)
                    .await
                    .with_context(|| "recreating the counter after a stale interface")?;
                bail!("counter followed a stale interface; recreated, skipping this window")
            }
            TableRead::Missing => {
                self.rebuild(&iface)
                    .await
                    .with_context(|| "creating the counter table")?;
                bail!("counter table was missing; recreated, skipping this window")
            }
            TableRead::Broken(reason) => bail!("counter table unreadable: {reason}"),
        }
    }

    async fn default_iface(&self) -> Result<String> {
        let out = self
            .host
            .run(
                "ip",
                &["route".into(), "show".into(), "default".into()],
            )
            .await?;
        if !out.success() {
            bail!(
                "ip route show default exited with {}: {}",
                out.status.unwrap_or(-1),
                out.summary()
            );
        }
        parse_default_iface(&out.stdout)
            .with_context(|| format!("no usable `dev` in: {}", out.stdout.trim()))
    }

    /// One read of the counter table, classified so that only a genuinely
    /// absent table is rebuilt. A failed or unparsable read must never be
    /// folded into `Missing`: rebuilding resets the counter, so doing it on
    /// every window would report zero bytes forever, with no error at all.
    async fn read_table(&self) -> Result<TableRead> {
        let out = self
            .host
            .run(
                "nft",
                &[
                    "-j".into(),
                    "list".into(),
                    "table".into(),
                    "inet".into(),
                    TABLE.into(),
                ],
            )
            .await?;
        if out.success() {
            return Ok(match parse_counter(&out.stdout) {
                Some((iface, bytes)) => TableRead::Counter { iface, bytes },
                None => TableRead::Broken(format!(
                    "unparsable counter output: {}",
                    snippet(&out.stdout)
                )),
            });
        }
        // The command failed. Ask whether the table exists at all: a kernel
        // without nftables, or a permission problem, must not be mistaken for
        // "this node has never been set up". (A missing binary never reaches
        // here: `Host::run` returns Err and `?` short-circuits.)
        //
        // The JSON listing is the primary signal: the text one has no
        // machine-readable contract, and a false negative there rebuilds the
        // table every window, resetting the counter while only logging info.
        let json_listing = self
            .host
            .run("nft", &["-j".into(), "list".into(), "tables".into()])
            .await?;
        let json_verdict = if json_listing.success() {
            json_lists_table(&json_listing.stdout)
        } else {
            None
        };
        if json_verdict == Some(true) {
            return Ok(TableRead::Broken(format!(
                "`nft list table` failed while the table exists: {}",
                snippet(&out.summary())
            )));
        }

        // Text listing: the fallback when the JSON command fails or its output
        // is not the shape we expect. It is also consulted when the JSON parsed
        // but did not list the table — either signal saying "present" is enough
        // to keep us from rebuilding over a table that is really there.
        let listing = self
            .host
            .run("nft", &["list".into(), "tables".into()])
            .await?;
        if listing.success() {
            if lists_table(&listing.stdout) {
                return Ok(TableRead::Broken(format!(
                    "`nft list table` failed while the table exists: {}",
                    snippet(&out.summary())
                )));
            }
            tracing::info!(
                json_listing = %snippet(&json_listing.stdout),
                listing = %snippet(&listing.stdout),
                "traffic: no counter table; creating it"
            );
            return Ok(TableRead::Missing);
        }
        // No usable text listing. A JSON that parsed and explicitly did not
        // list the table is still an answer; only two unusable listings are
        // reason to leave the counter alone. This is the one Missing path that
        // rebuilds on a single signal, so it is a warn: someone should see that
        // the text listing was unavailable when the counter was recreated.
        if json_verdict == Some(false) {
            tracing::warn!(
                json_listing = %snippet(&json_listing.stdout),
                "traffic: no counter table; creating it"
            );
            return Ok(TableRead::Missing);
        }
        Ok(TableRead::Broken(format!(
            "`nft list table` failed ({}); `nft list tables` failed too ({})",
            snippet(&out.summary()),
            snippet(&listing.summary())
        )))
    }

    async fn rebuild(&self, iface: &str) -> Result<()> {
        // Deleting a missing table fails; that is the expected first-run path.
        let _ = self
            .host
            .run(
                "nft",
                &["delete".into(), "table".into(), "inet".into(), TABLE.into()],
            )
            .await;
        let steps: [&[&str]; 3] = [
            &["add", "table", "inet", TABLE],
            &[
                "add", "chain", "inet", TABLE, CHAIN, "{", "type", "filter", "hook", "output",
                "priority", "0", ";", "policy", "accept", ";", "}",
            ],
            &["add", "rule", "inet", TABLE, CHAIN, "oifname", iface, "counter"],
        ];
        for step in steps {
            let args: Vec<String> = step.iter().map(|s| s.to_string()).collect();
            let out = self.host.run("nft", &args).await?;
            if !out.success() {
                bail!("nft {} failed: {}", args.join(" "), out.summary());
            }
        }
        tracing::info!(iface, "traffic: created the outbound counter table");
        Ok(())
    }
}

/// What one counter read told us. Only `Missing` may rebuild the table.
enum TableRead {
    /// The table is not there — a first run, or someone deleted it.
    Missing,
    Counter { iface: String, bytes: u64 },
    /// `nft` ran but its output cannot be used, or it failed while the table
    /// exists. Rebuilding here would zero the counter every window.
    Broken(String),
}

/// Enough of a command's stdout for a log line, without dumping a whole table.
fn snippet(stdout: &str) -> String {
    const MAX: usize = 120;
    let trimmed = stdout.trim();
    let mut out: String = trimmed.chars().take(MAX).collect();
    if trimmed.chars().count() > MAX {
        out.push('…');
    }
    out
}

/// `nft -j list tables` → whether our table is listed.
///
/// `None` means the output is not the JSON shape we expect, so the caller must
/// fall back to [`lists_table`]. Only `Some(false)` is an explicit "not there".
fn json_lists_table(json: &str) -> Option<bool> {
    let value: Value = serde_json::from_str(json).ok()?;
    let entries = value.get("nftables")?.as_array()?;
    Some(entries.iter().any(|entry| {
        entry.get("table").is_some_and(|table| {
            table.get("family").and_then(Value::as_str) == Some("inet")
                && table.get("name").and_then(Value::as_str) == Some(TABLE)
        })
    }))
}

/// `nft list tables` prints one `table <family> <name>` line per table. Used
/// only when the JSON listing is unavailable; its format has no contract.
fn lists_table(stdout: &str) -> bool {
    let want = format!("table inet {TABLE}");
    stdout.lines().any(|line| line.trim() == want)
}

/// `ip route show default` → the `dev` of the first default route. Names like
/// `eth0@if3` (veth peers) are cut at the `@`.
pub fn parse_default_iface(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.first() != Some(&"default") {
            continue;
        }
        let Some(pos) = tokens.iter().position(|t| *t == "dev") else {
            continue;
        };
        let raw = tokens.get(pos + 1)?;
        let name = raw.split('@').next().unwrap_or(raw);
        if valid_iface(name) {
            return Some(name.to_string());
        }
    }
    None
}

fn valid_iface(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 15
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b':'))
}

/// `nft -j list table inet veyl_meter` → the interface our rule matches and
/// its byte counter.
pub fn parse_counter(json: &str) -> Option<(String, u64)> {
    let value: Value = serde_json::from_str(json).ok()?;
    for entry in value.get("nftables")?.as_array()? {
        let Some(rule) = entry.get("rule") else {
            continue;
        };
        let Some(expr) = rule.get("expr").and_then(Value::as_array) else {
            continue;
        };
        let mut iface = None;
        let mut bytes = None;
        for item in expr {
            if let Some(counter) = item.get("counter") {
                bytes = counter.get("bytes").and_then(Value::as_u64);
            }
            if let Some(m) = item.get("match") {
                if m.pointer("/left/meta/key").and_then(Value::as_str) == Some("oifname") {
                    iface = m.get("right").and_then(Value::as_str).map(str::to_string);
                }
            }
        }
        if let (Some(iface), Some(bytes)) = (iface, bytes) {
            return Some((iface, bytes));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{ControlError, DesiredState, ReportRequest};
    use crate::test_support::FakeHost;
    use async_trait::async_trait;

    #[derive(Default)]
    struct RecordingControl {
        reports: Mutex<Vec<(u64, u64)>>,
        fail: Mutex<bool>,
        /// Record the report, then fail the request: the control plane counted
        /// it but the agent never sees the 2xx.
        lose_response: Mutex<bool>,
        /// The control plane says the server row is destroyed (409).
        destroyed: Mutex<bool>,
    }

    #[async_trait]
    impl ControlApi for RecordingControl {
        async fn report(&self, _body: &ReportRequest) -> Result<(), ControlError> {
            Ok(())
        }

        async fn desired_state(&self) -> Result<DesiredState, ControlError> {
            Err(ControlError::Transport("not used in this test".into()))
        }

        async fn traffic(&self, seq: u64, delta_bytes: u64) -> Result<(), ControlError> {
            if *self.destroyed.lock().unwrap() {
                return Err(ControlError::Status {
                    status: 409,
                    body: r#"{"ok":false,"reason":"server_destroyed"}"#.into(),
                });
            }
            if *self.lose_response.lock().unwrap() {
                self.reports.lock().unwrap().push((seq, delta_bytes));
                return Err(ControlError::Transport("response lost".into()));
            }
            if *self.fail.lock().unwrap() {
                return Err(ControlError::Transport("offline".into()));
            }
            self.reports.lock().unwrap().push((seq, delta_bytes));
            Ok(())
        }
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "veyl-agent-traffic-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn params(report_bytes: u64) -> TrafficConfig {
        TrafficConfig {
            read_secs: 30,
            save_secs: 300,
            report_bytes,
        }
    }

    fn nft_json(iface: &str, bytes: u64) -> String {
        format!(
            r#"{{"nftables":[{{"metainfo":{{"version":"1.0.9","release_name":"x"}}}},{{"table":{{"family":"inet","name":"veyl_meter"}}}},{{"chain":{{"family":"inet","table":"veyl_meter","name":"out","type":"filter","hook":"output","prio":0,"policy":"accept"}}}},{{"rule":{{"family":"inet","table":"veyl_meter","chain":"out","expr":[{{"match":{{"op":"==","left":{{"meta":{{"key":"oifname"}}}},"right":"{iface}"}}}},{{"counter":{{"packets":7,"bytes":{bytes}}}}}]}}}}]}}"#
        )
    }

    /// What `nft -j list tables` is assumed to print for a node that has our
    /// table. This shape is unverified on a real Linux host.
    fn nft_tables_json() -> String {
        r#"{"nftables":[{"metainfo":{"version":"1.0.9","release_name":"x"}},{"table":{"family":"inet","name":"veyl_meter"}}]}"#.to_string()
    }

    fn nft_calls(host: &FakeHost) -> Vec<Vec<String>> {
        host.commands()
            .into_iter()
            .filter(|(program, _)| program == "nft")
            .map(|(_, args)| args)
            .collect()
    }

    fn setup(name: &str) -> (PathBuf, Arc<FakeHost>, Arc<RecordingControl>) {
        let dir = tmpdir(name);
        let host = Arc::new(FakeHost::new());
        host.set_command_output(
            "ip",
            0,
            "default via 10.0.0.1 dev ens3 proto dhcp src 10.0.0.5 metric 100\n",
            "",
        );
        let control = Arc::new(RecordingControl::default());
        (dir, host, control)
    }

    /// How many times the counter table was (re)created. One rebuild issues
    /// three `nft add` calls (table, chain, rule); only the table one counts.
    fn rebuilds(host: &FakeHost) -> usize {
        host.commands()
            .into_iter()
            .filter(|(program, args)| {
                program == "nft"
                    && args.first().map(String::as_str) == Some("add")
                    && args.get(1).map(String::as_str) == Some("table")
            })
            .count()
    }

    #[tokio::test]
    async fn accumulates_deltas_and_reports_at_the_threshold() {
        let (dir, host, control) = setup("accumulate");
        host.queue_command_outputs(
            "nft",
            &[
                (0, &nft_json("ens3", 1_000), ""),
                (0, &nft_json("ens3", 1_060), ""),
                (0, &nft_json("ens3", 1_160), ""),
            ],
        );
        let store = TrafficStore::new(dir.join("traffic.json"));
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            store.path().to_path_buf(),
            params(100),
        );

        // First tick seeds the baseline: the counter is not a delta.
        meter.tick(1_000).await;
        assert!(control.reports.lock().unwrap().is_empty());
        assert_eq!(meter.snapshot().unwrap().pending_bytes, 0);

        meter.tick(1_030).await;
        assert_eq!(meter.snapshot().unwrap().pending_bytes, 60);
        assert!(control.reports.lock().unwrap().is_empty());

        meter.tick(1_060).await;
        assert_eq!(
            *control.reports.lock().unwrap(),
            vec![(1_000, 160)],
            "one report with the whole pending batch"
        );
        let state = store.load().unwrap().unwrap();
        assert_eq!(state.pending_bytes, 0);
        assert_eq!(state.seq, 1_001);
        assert_eq!(state.last_ok_at, 1_060);
        assert_eq!(state.counter_last, 1_160);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_counter_that_went_backwards_counts_the_new_value() {
        let (dir, host, control) = setup("reset");
        host.queue_command_outputs(
            "nft",
            &[
                (0, &nft_json("ens3", 5_000), ""),
                (0, &nft_json("ens3", 6_000), ""),
                // Table was recreated: the counter starts over.
                (0, &nft_json("ens3", 200), ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        meter.tick(1_000).await; // baseline 5000
        meter.tick(1_030).await; // +1000
        assert_eq!(meter.snapshot().unwrap().pending_bytes, 1_000);
        meter.tick(1_060).await; // reset to 200 → +200
        let state = meter.snapshot().unwrap();
        assert_eq!(state.pending_bytes, 1_200);
        assert_eq!(state.counter_last, 200);
        assert!(control.reports.lock().unwrap().is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_missing_state_file_uses_the_counter_as_the_new_baseline() {
        let (dir, host, control) = setup("missing");
        host.queue_command_outputs(
            "nft",
            &[
                (0, &nft_json("ens3", 5_000), ""),
                // Idle for longer than the report window: a zero-byte report
                // still goes out (the control plane pools allowances per row).
                (0, &nft_json("ens3", 5_000), ""),
                (0, &nft_json("ens3", 5_300), ""),
            ],
        );
        let store = TrafficStore::new(dir.join("traffic.json"));
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            store.path().to_path_buf(),
            params(1_000_000),
        );

        meter.tick(1_000).await;
        let seeded = store.load().unwrap().unwrap();
        assert_eq!(
            seeded.counter_last, 5_000,
            "the current counter is the baseline, not a delta"
        );
        assert_eq!(seeded.pending_bytes, 0);
        assert_eq!(seeded.seq, 1_000, "seq is seeded from the clock");

        meter.tick(1_000 + REPORT_IDLE_SECS).await;
        // The doc's algorithm reports on the idle window even with nothing
        // pending: the control plane needs the row, not the bytes.
        assert_eq!(*control.reports.lock().unwrap(), vec![(1_000, 0)]);
        assert_eq!(meter.snapshot().unwrap().pending_bytes, 0);
        assert_eq!(meter.snapshot().unwrap().seq, 1_001);
        assert_eq!(meter.snapshot().unwrap().last_ok_at, 1_000 + REPORT_IDLE_SECS);

        meter.tick(1_000 + REPORT_IDLE_SECS + 30).await;
        // Below the byte threshold and inside a fresh idle window: wait.
        assert_eq!(meter.snapshot().unwrap().pending_bytes, 300);
        assert_eq!(*control.reports.lock().unwrap(), vec![(1_000, 0)]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_failed_report_resends_the_frozen_batch() {
        let (dir, host, control) = setup("retry");
        host.queue_command_outputs(
            "nft",
            &[
                (0, &nft_json("ens3", 1_000), ""),
                (0, &nft_json("ens3", 1_200), ""),
                (0, &nft_json("ens3", 1_250), ""),
            ],
        );
        let store = TrafficStore::new(dir.join("traffic.json"));
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            store.path().to_path_buf(),
            params(100),
        );
        *control.fail.lock().unwrap() = true;

        meter.tick(1_000).await; // baseline
        meter.tick(1_030).await; // +200 → the batch is frozen, the request fails
        let state = meter.snapshot().unwrap();
        assert_eq!(state.pending_bytes, 200, "nothing is lost on failure");
        assert_eq!(state.seq, 1_000, "seq is only advanced by a 2xx");
        assert_eq!(state.last_ok_at, 1_000);
        assert_eq!(
            state.pending_attempt,
            Some(PendingAttempt {
                seq: 1_000,
                bytes: 200
            }),
            "the attempted batch is written before the request goes out"
        );
        assert_eq!(
            store.load().unwrap().unwrap().pending_attempt,
            state.pending_attempt,
            "the attempt survives a crash mid-send"
        );
        assert!(control.reports.lock().unwrap().is_empty());

        *control.fail.lock().unwrap() = false;
        meter.tick(1_060).await; // +50 → resend the frozen 200, not 250
        assert_eq!(*control.reports.lock().unwrap(), vec![(1_000, 200)]);
        let state = meter.snapshot().unwrap();
        assert_eq!(state.pending_bytes, 50, "the new 50 bytes are kept");
        assert_eq!(state.seq, 1_001);
        assert_eq!(state.pending_attempt, None);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_lost_response_does_not_block_the_bytes_that_follow_it() {
        let (dir, host, control) = setup("lost-response");
        host.queue_command_outputs(
            "nft",
            &[
                (0, &nft_json("ens3", 1_000), ""),
                (0, &nft_json("ens3", 1_100), ""),
                (0, &nft_json("ens3", 1_150), ""),
                (0, &nft_json("ens3", 1_250), ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            dir.join("traffic.json"),
            params(100),
        );

        meter.tick(1_000).await; // baseline
        *control.lose_response.lock().unwrap() = true;
        meter.tick(1_030).await; // +100 → counted by the control plane, 2xx lost
        assert_eq!(*control.reports.lock().unwrap(), vec![(1_000, 100)]);
        assert_eq!(meter.snapshot().unwrap().pending_bytes, 100);

        *control.lose_response.lock().unwrap() = false;
        meter.tick(1_060).await; // +50 → same seq, same 100 bytes
        assert_eq!(
            *control.reports.lock().unwrap(),
            vec![(1_000, 100), (1_000, 100)],
            "the retry is the duplicate the control plane dedupes"
        );
        let state = meter.snapshot().unwrap();
        assert_eq!(state.pending_bytes, 50, "the 50 new bytes are not lost");
        assert_eq!(state.seq, 1_001);

        meter.tick(1_090).await; // +100 → only the bytes after the ack
        assert_eq!(
            *control.reports.lock().unwrap(),
            vec![(1_000, 100), (1_000, 100), (1_001, 150)]
        );
        assert_eq!(meter.snapshot().unwrap().pending_bytes, 0);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn seq_increases_by_one_per_accepted_report() {
        let (dir, host, control) = setup("seq");
        host.queue_command_outputs(
            "nft",
            &[
                (0, &nft_json("ens3", 0), ""),
                (0, &nft_json("ens3", 500), ""),
                (0, &nft_json("ens3", 1_000), ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            dir.join("traffic.json"),
            params(100),
        );

        meter.tick(1_000).await;
        meter.tick(1_030).await;
        meter.tick(1_060).await;
        assert_eq!(
            *control.reports.lock().unwrap(),
            vec![(1_000, 500), (1_001, 500)]
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_failed_nft_read_is_not_mistaken_for_a_missing_table() {
        let (dir, host, control) = setup("broken-nft");
        host.queue_command_outputs(
            "nft",
            &[
                (0, &nft_json("ens3", 1_000), ""),
                // The read fails, but the JSON listing shows the table is there.
                (1, "", "Operation not permitted"),
                (0, &nft_tables_json(), ""),
                (1, "", "Operation not permitted"),
                (0, &nft_tables_json(), ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        meter.tick(1_000).await; // baseline 1_000
        meter.tick(1_030).await; // unreadable → this window is skipped
        meter.tick(1_060).await; // still unreadable

        let state = meter.snapshot().unwrap();
        assert_eq!(state.counter_last, 1_000, "the counter is left alone");
        assert_eq!(state.pending_bytes, 0);
        assert_eq!(
            rebuilds(&host),
            0,
            "a broken read must never recreate the table"
        );
        assert!(control.reports.lock().unwrap().is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_unparsable_counter_is_an_error_not_a_reset() {
        let (dir, host, control) = setup("unparsable");
        host.queue_command_outputs(
            "nft",
            &[
                (0, &nft_json("ens3", 5_000), ""),
                // Exit 0 but no rule we can read: a parser that broke, not a
                // node that has never been set up.
                (0, r#"{"nftables":[]}"#, ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        meter.tick(1_000).await;
        meter.tick(1_030).await;

        let state = meter.snapshot().unwrap();
        assert_eq!(
            state.counter_last, 5_000,
            "an unreadable counter is not a zero counter"
        );
        assert_eq!(state.pending_bytes, 0);
        assert_eq!(rebuilds(&host), 0);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_missing_table_is_rebuilt_once() {
        let (dir, host, control) = setup("missing-table");
        host.queue_command_outputs(
            "nft",
            &[
                // First window: the table is not there.
                (1, "", "No such file or directory"),
                // `nft -j list tables` agrees: only metainfo.
                (0, r#"{"nftables":[{"metainfo":{"version":"1.0.9"}}]}"#, ""),
                (0, "table inet filter\n", ""),
                // The rebuild issues four calls of its own: delete, add table,
                // add chain, add rule.
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
                // After the rebuild the counter starts from zero and then grows.
                (0, &nft_json("ens3", 500), ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        // The window that creates the table is a failed read, not a zero one.
        meter.tick(1_000).await;
        assert!(meter.snapshot().is_none(), "a rebuild is not a reading");
        assert_eq!(rebuilds(&host), 1);

        // The next window reads the fresh counter and adopts it as the
        // baseline: whatever flowed before this point is not counted. That loss
        // is bounded by one window and only happens on the first install.
        // The reading is deliberately non-zero so this cannot pass by accident
        // when the baseline would have been zero anyway.
        meter.tick(1_030).await;
        assert_eq!(rebuilds(&host), 1, "the next window must not rebuild again");
        let state = meter.snapshot().unwrap();
        assert_eq!(state.counter_last, 500);
        assert_eq!(
            state.pending_bytes, 0,
            "the first window after the rebuild is adopted as the baseline"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_json_listing_that_names_the_table_is_not_missing() {
        let (dir, host, _control) = setup("json-present");
        host.queue_command_outputs(
            "nft",
            &[
                (1, "", "Operation not permitted"),
                (0, &nft_tables_json(), ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            Arc::new(RecordingControl::default()),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        meter.tick(1_000).await;

        assert!(meter.snapshot().is_none(), "a broken read is not a reading");
        assert_eq!(rebuilds(&host), 0, "a listed table is never recreated");
        let calls = nft_calls(&host);
        assert_eq!(calls.len(), 2, "the text listing is not consulted");
        assert_eq!(calls[1], vec!["-j", "list", "tables"]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_json_listing_without_the_table_falls_back_to_text_and_rebuilds() {
        let (dir, host, _control) = setup("json-absent");
        host.queue_command_outputs(
            "nft",
            &[
                (1, "", "Operation not permitted"),
                (0, r#"{"nftables":[{"metainfo":{"version":"1.0.9"}}]}"#, ""),
                (0, "table inet filter\n", ""),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            Arc::new(RecordingControl::default()),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        meter.tick(1_000).await;

        assert!(meter.snapshot().is_none(), "a rebuild is not a reading");
        assert_eq!(rebuilds(&host), 1, "both listings agree the table is gone");
        let calls = nft_calls(&host);
        assert_eq!(
            calls.len(),
            7,
            "read + JSON listing + text listing + 4 rebuilds"
        );
        assert_eq!(calls[1], vec!["-j", "list", "tables"]);
        assert_eq!(calls[2], vec!["list", "tables"]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_failed_json_listing_with_no_text_table_is_missing() {
        let (dir, host, _control) = setup("json-list-failed");
        host.queue_command_outputs(
            "nft",
            &[
                (1, "", "Operation not permitted"),
                (1, "", "unknown option -- -j"),
                (0, "table inet filter\n", ""),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            Arc::new(RecordingControl::default()),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        meter.tick(1_000).await;

        assert!(meter.snapshot().is_none());
        assert_eq!(rebuilds(&host), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_failed_json_listing_with_a_text_table_is_broken() {
        let (dir, host, _control) = setup("text-present");
        host.queue_command_outputs(
            "nft",
            &[
                (1, "", "Operation not permitted"),
                (1, "", "unknown option -- -j"),
                (0, "table inet filter\ntable inet veyl_meter\n", ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            Arc::new(RecordingControl::default()),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        meter.tick(1_000).await;

        assert!(meter.snapshot().is_none());
        assert_eq!(rebuilds(&host), 0, "the text fallback saw the table");
        assert_eq!(nft_calls(&host).len(), 3);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_explicit_json_absence_with_an_unusable_text_listing_is_missing() {
        let (dir, host, _control) = setup("json-absent-text-failed");
        host.queue_command_outputs(
            "nft",
            &[
                (1, "", "Operation not permitted"),
                // The JSON listing parsed and explicitly has no table for us.
                (0, r#"{"nftables":[{"metainfo":{"version":"1.0.9"}}]}"#, ""),
                // The text listing cannot be used at all. JSON is the only
                // signal left, and it said "not there".
                (1, "", "Operation not permitted"),
                // The rebuild issues four calls of its own: delete, add table,
                // add chain, add rule.
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            Arc::new(RecordingControl::default()),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        meter.tick(1_000).await;

        assert!(meter.snapshot().is_none(), "a rebuild is not a reading");
        assert_eq!(
            rebuilds(&host),
            1,
            "an explicit JSON absence is enough to rebuild even when the text listing fails"
        );
        assert_eq!(nft_calls(&host).len(), 7);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_table_in_another_family_is_not_ours() {
        let (dir, host, _control) = setup("wrong-family");
        host.queue_command_outputs(
            "nft",
            &[
                (1, "", "Operation not permitted"),
                (
                    0,
                    r#"{"nftables":[{"metainfo":{"version":"1.0.9"}},{"table":{"family":"ip","name":"veyl_meter"}}]}"#,
                    "",
                ),
                (0, "table inet filter\n", ""),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            Arc::new(RecordingControl::default()),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        meter.tick(1_000).await;

        assert!(meter.snapshot().is_none());
        assert_eq!(rebuilds(&host), 1, "`table ip` is a different table");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_non_json_listing_falls_back_to_the_text_check() {
        let (dir, host, _control) = setup("not-json");
        host.queue_command_outputs(
            "nft",
            &[
                (1, "", "Operation not permitted"),
                // Exit 0 but not JSON: the fallback has to answer.
                (0, "table inet veyl_meter\n", ""),
                (0, "table inet veyl_meter\n", ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            Arc::new(RecordingControl::default()),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        meter.tick(1_000).await;

        assert!(meter.snapshot().is_none());
        assert_eq!(rebuilds(&host), 0);
        assert_eq!(nft_calls(&host).len(), 3);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_stale_interface_is_a_failed_window_not_a_zero_reading() {
        let (dir, host, control) = setup("stale-iface");
        host.queue_command_outputs(
            "ip",
            &[
                (
                    0,
                    "default via 10.0.0.1 dev ens3 proto dhcp src 10.0.0.5 metric 100\n",
                    "",
                ),
                (
                    0,
                    "default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.6 metric 100\n",
                    "",
                ),
                (
                    0,
                    "default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.6 metric 100\n",
                    "",
                ),
            ],
        );
        host.queue_command_outputs(
            "nft",
            &[
                (0, &nft_json("ens3", 1_000), ""),
                // The default route moved, but the rule still counts ens3.
                (0, &nft_json("ens3", 1_000), ""),
                // The rebuild issues four calls of its own: delete, add table,
                // add chain, add rule.
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
                (0, "", ""),
                // The rebuilt table counts the new interface from zero.
                (0, &nft_json("eth0", 700), ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        meter.tick(1_000).await; // baseline 1_000 on ens3
        meter.tick(1_030).await; // stale interface → rebuild → failed window

        assert_eq!(rebuilds(&host), 1);
        let state = meter.snapshot().unwrap();
        assert_eq!(state.pending_bytes, 0);
        assert_eq!(
            state.counter_last, 1_000,
            "a rebuild is not a reading, so the baseline is untouched"
        );

        meter.tick(1_060).await;
        assert_eq!(
            meter.snapshot().unwrap().pending_bytes,
            700,
            "700 < 1_000, so the negative-delta branch carries the whole new counter"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn failed_reports_are_counted_and_cleared_by_the_next_success() {
        let (dir, host, control) = setup("recovery");
        host.queue_command_outputs(
            "nft",
            &[
                (0, &nft_json("ens3", 1_000), ""),
                (0, &nft_json("ens3", 1_200), ""),
                (0, &nft_json("ens3", 1_250), ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            dir.join("traffic.json"),
            params(100),
        );

        *control.fail.lock().unwrap() = true;
        meter.tick(1_000).await; // baseline
        meter.tick(1_030).await; // +200 → the report fails
        assert_eq!(meter.report_failures(), 1);

        *control.fail.lock().unwrap() = false;
        meter.tick(1_060).await; // the frozen batch goes through
        assert_eq!(
            meter.report_failures(),
            0,
            "a 2xx clears the counter that drives the recovery log line"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_skipped_window_is_recovered_by_the_next_successful_read() {
        let (dir, host, control) = setup("skip-recovers");
        host.queue_command_outputs(
            "nft",
            &[
                (0, &nft_json("ens3", 1_000), ""),
                (1, "", "Operation not permitted"),
                (0, &nft_tables_json(), ""),
                (0, &nft_json("ens3", 1_600), ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            dir.join("traffic.json"),
            params(1_000_000),
        );

        meter.tick(1_000).await; // baseline 1_000
        meter.tick(1_030).await; // unreadable: the window is skipped
        assert_eq!(meter.snapshot().unwrap().pending_bytes, 0);

        meter.tick(1_060).await; // 1_600 → the whole segment lands in one delta
        assert_eq!(
            meter.snapshot().unwrap().pending_bytes,
            600,
            "the counter is cumulative, so the skipped window is not lost"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_destroyed_row_does_not_stop_reporting() {
        let (dir, host, control) = setup("destroyed");
        host.queue_command_outputs(
            "nft",
            &[
                (0, &nft_json("ens3", 1_000), ""),
                (0, &nft_json("ens3", 1_200), ""),
                (0, &nft_json("ens3", 1_350), ""),
            ],
        );
        let meter = TrafficMeter::new(
            host.clone(),
            control.clone(),
            dir.join("traffic.json"),
            params(100),
        );

        *control.destroyed.lock().unwrap() = true;
        meter.tick(1_000).await; // baseline
        meter.tick(1_030).await; // +200 → 409

        let state = meter.snapshot().unwrap();
        assert_eq!(state.pending_bytes, 200, "the batch is kept");
        assert_eq!(state.seq, 1_000, "a 409 does not advance the sequence");
        assert_eq!(meter.report_failures(), 1);
        assert!(control.reports.lock().unwrap().is_empty());

        // The control plane's records disagree with reality and the machine is
        // still serving, so the next window must try again instead of going
        // quiet forever.
        *control.destroyed.lock().unwrap() = false;
        meter.tick(1_060).await;

        assert_eq!(*control.reports.lock().unwrap(), vec![(1_000, 200)]);
        assert_eq!(meter.report_failures(), 0);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_table_listing_is_recognised() {
        assert!(lists_table("table inet filter\ntable inet veyl_meter\n"));
        assert!(!lists_table("table inet filter\n"));
        assert!(!lists_table(""));
        assert!(!lists_table("table ip veyl_meter\n"));
    }

    #[test]
    fn the_json_table_listing_is_recognised() {
        assert_eq!(json_lists_table(&nft_tables_json()), Some(true));
        assert_eq!(
            json_lists_table(r#"{"nftables":[{"metainfo":{"version":"1.0.9"}}]}"#),
            Some(false)
        );
        assert_eq!(
            json_lists_table(r#"{"nftables":[{"table":{"family":"ip","name":"veyl_meter"}}]}"#),
            Some(false)
        );
        assert_eq!(
            json_lists_table(r#"{"nftables":[{"table":{"family":"inet","name":"other"}}]}"#),
            Some(false)
        );
        // Anything that is not the shape we expect must let the caller fall
        // back to the text listing rather than claim the table is absent.
        assert_eq!(json_lists_table("table inet veyl_meter\n"), None);
        assert_eq!(json_lists_table(""), None);
        assert_eq!(json_lists_table("{}"), None);
        assert_eq!(json_lists_table(r#"{"nftables":"nope"}"#), None);
    }

    #[test]
    fn log_snippets_are_bounded() {
        assert_eq!(snippet("  \n"), "");
        assert_eq!(snippet("abc"), "abc");
        let long = "x".repeat(500);
        let out = snippet(&long);
        assert_eq!(out.chars().count(), 121, "120 chars plus the ellipsis");
        assert!(out.ends_with('…'));
    }

    #[test]
    fn default_route_interface_is_parsed_not_assumed() {
        assert_eq!(
            parse_default_iface("default via 10.0.0.1 dev ens3 proto dhcp src 10.0.0.5\n")
                .as_deref(),
            Some("ens3")
        );
        assert_eq!(
            parse_default_iface(
                "10.0.0.0/24 dev ens3 proto kernel scope link src 10.0.0.5\ndefault via 10.0.0.1 dev eth0 metric 100\n"
            )
            .as_deref(),
            Some("eth0")
        );
        assert_eq!(
            parse_default_iface("default via 10.0.0.1 dev veth1a@if2 proto dhcp\n").as_deref(),
            Some("veth1a")
        );
        assert_eq!(parse_default_iface(""), None);
        assert_eq!(parse_default_iface("default via 10.0.0.1 proto dhcp\n"), None);
    }

    #[test]
    fn counter_is_read_from_the_json_rule() {
        assert_eq!(
            parse_counter(&nft_json("ens3", 4_294_967_296)),
            Some(("ens3".to_string(), 4_294_967_296))
        );
        assert_eq!(parse_counter("not json"), None);
        assert_eq!(parse_counter(r#"{"nftables":[]}"#), None);
    }
}
