//! In-memory error table for `get_status` (see `agent/docs/agent-health.md`).
//!
//! One fixed set of keys, one entry per key, process-local and never persisted.
//! The key is an enum on purpose: it is the only thing that keeps the table
//! bounded, since no caller can invent a new key at runtime.
//!
//! The table is cleared by a restart, which is why `get_status` also reports
//! `uptime_secs` — an empty table means "nothing since this process started",
//! not "always healthy".

use std::collections::HashMap;
use std::sync::Mutex;

use crate::logging::{redact_sensitive, truncate};

/// Cap for a stored error line; the ops platform only needs the reason, not a
/// history. Same 300-char limit the control plane applies to `last_error`.
const MAX_ERROR_CHARS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HealthKey {
    /// A window where the nft counter could not be read.
    NftRead,
    /// A traffic report the control plane rejected or never received.
    Report,
    /// Declared, not wired yet: applying the desired state (rotation.rs).
    SingboxApply,
    /// Declared, not wired yet: log rotation failures (logging.rs).
    Logging,
}

impl HealthKey {
    /// Every key this table can hold, wired or not. Kept as the checklist for
    /// when a module gets connected.
    pub const ALL: [HealthKey; 4] = [
        Self::NftRead,
        Self::Report,
        Self::SingboxApply,
        Self::Logging,
    ];

    /// Only keys that actually have a recorder. A key that is declared but not
    /// wired must be absent from the report, never a zeroed entry: "not
    /// measured" and "measured, no failures" are different answers, and a
    /// zeroed entry would draw a false green light.
    pub const WIRED: &'static [HealthKey] = &[Self::NftRead, Self::Report];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NftRead => "nft_read",
            Self::Report => "report",
            Self::SingboxApply => "singbox_apply",
            Self::Logging => "logging",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HealthEntry {
    pub count: u64,
    /// Unix seconds of the most recent failure.
    pub last_at: u64,
    pub last_error: String,
}

#[derive(Debug, Default)]
pub struct Health {
    entries: Mutex<HashMap<HealthKey, HealthEntry>>,
}

impl Health {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one failure: bump the count, keep only the latest message.
    pub fn record(&self, key: HealthKey, now: u64, error: &str) {
        let message = truncate(&redact_sensitive(error), MAX_ERROR_CHARS);
        let mut entries = self.entries.lock().unwrap();
        let entry = entries.entry(key).or_default();
        entry.count = entry.count.saturating_add(1);
        entry.last_at = now;
        entry.last_error = message;
    }

    /// Every **wired** key in a fixed order, with a zeroed entry for keys that
    /// have not failed. Unwired keys are absent on purpose: see `WIRED`.
    pub fn entries(&self) -> Vec<(HealthKey, HealthEntry)> {
        let entries = self.entries.lock().unwrap();
        HealthKey::WIRED
            .iter()
            .map(|key| (*key, entries.get(key).cloned().unwrap_or_default()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_keeps_only_its_latest_error_and_counts_every_one() {
        let health = Health::new();
        health.record(HealthKey::NftRead, 1_000, "first");
        health.record(HealthKey::NftRead, 1_030, "second");

        let entry = health
            .entries()
            .into_iter()
            .find(|(key, _)| *key == HealthKey::NftRead)
            .map(|(_, entry)| entry)
            .unwrap();
        assert_eq!(entry.count, 2, "every failure is counted");
        assert_eq!(entry.last_at, 1_030, "the table is not a history");
        assert_eq!(entry.last_error, "second");
    }

    #[test]
    fn only_wired_keys_are_reported() {
        let health = Health::new();
        let entries = health.entries();
        assert_eq!(
            entries.iter().map(|(key, _)| *key).collect::<Vec<_>>(),
            HealthKey::WIRED.to_vec(),
            "a wired key reports count 0; an unwired one must not appear at all"
        );
        assert!(entries.iter().all(|(_, entry)| entry.count == 0));
    }

    #[test]
    fn the_wired_keys_are_a_strict_subset_of_all() {
        for key in HealthKey::WIRED {
            assert!(
                HealthKey::ALL.contains(key),
                "{key:?} is wired but not declared"
            );
        }
        assert!(HealthKey::WIRED.len() < HealthKey::ALL.len());
        assert!(!HealthKey::WIRED.contains(&HealthKey::SingboxApply));
        assert!(!HealthKey::WIRED.contains(&HealthKey::Logging));
    }

    #[test]
    fn a_long_error_is_truncated_and_redacted() {
        let health = Health::new();
        let secret = format!("password=hunter2 {}", "x".repeat(2_000));
        health.record(HealthKey::Report, 5, &secret);

        let entry = health
            .entries()
            .into_iter()
            .find(|(key, _)| *key == HealthKey::Report)
            .map(|(_, entry)| entry)
            .unwrap();
        assert!(!entry.last_error.contains("hunter2"));
        assert!(entry.last_error.chars().count() <= MAX_ERROR_CHARS + 1);
    }
}
