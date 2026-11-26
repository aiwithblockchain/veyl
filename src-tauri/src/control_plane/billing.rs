//! 账单流水（`GET /v1/billing/ledger`，`commands.md` §7.36，2.76.0）。
//!
//! 控制面把 `wallet_ledger` 摊平成账单页直读的形状；Host 只做形状校验，
//! 不换算金额、不排序、不重新分页、不做本地缓存。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::client::ControlPlane;
use super::error::CpError;

const MIN_WINDOW_DAYS: i64 = 1;
const MAX_WINDOW_DAYS: i64 = 30;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BillingLedger {
    pub balance_cents: i64,
    pub currency: String,
    /// 实际生效的天数：入参越界时控制面回落为 30。
    pub window_days: i64,
    /// 列表被 1000 条上限截断；`totals` 仍是全量。
    pub truncated: bool,
    pub totals: BillingLedgerTotals,
    pub entries: Vec<BillingLedgerEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BillingLedgerTotals {
    pub topup_cents: i64,
    pub charge_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BillingLedgerEntry {
    pub id: String,
    /// 五类之一；认不出的原样透出，由界面归到 `other`，Host 不丢行。
    pub kind: String,
    /// USD 分：扣费为负、入账为正。
    pub amount_cents: i64,
    /// epoch 毫秒（不是秒）。
    pub at: i64,
    /// 解析不出机器时为 None（充值、`other` 常见）。
    #[serde(default)]
    pub server: Option<BillingLedgerServer>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BillingLedgerServer {
    pub id: String,
    pub name: String,
    pub plan: String,
    pub region: String,
}

fn default_currency() -> String {
    "USD".into()
}

/// 读近 N 天流水；`None` 时省略 `days`，控制面按 30 天处理。
pub async fn ledger(days: Option<i64>) -> Result<BillingLedger, CpError> {
    let client = ControlPlane::new()?;
    let path = match days {
        Some(days) => format!("/v1/billing/ledger?days={days}"),
        None => "/v1/billing/ledger".to_string(),
    };
    let raw = client.get(&path).await?;
    parse_ledger(raw)
}

fn parse_ledger(raw: Value) -> Result<BillingLedger, CpError> {
    /// 顶层先按宽松形状收，`entries` 逐条再解析：一条脏数据只丢那一行，不让整页白屏。
    /// `totals` 是控制面的独立聚合，丢一行不会让它失真。
    #[derive(Deserialize)]
    struct RawLedger {
        balance_cents: i64,
        #[serde(default)]
        currency: Option<String>,
        window_days: i64,
        #[serde(default)]
        truncated: bool,
        totals: BillingLedgerTotals,
        #[serde(default)]
        entries: Vec<Value>,
    }

    let raw: RawLedger =
        serde_json::from_value(raw).map_err(|_| CpError::invalid_response("账单响应格式不正确"))?;
    if raw.balance_cents < 0 {
        return Err(CpError::invalid_response("账单余额不能为负"));
    }
    // 越界的入参由控制面回落，所以这里只认它回给我们的实际窗口。
    if !(MIN_WINDOW_DAYS..=MAX_WINDOW_DAYS).contains(&raw.window_days) {
        return Err(CpError::invalid_response("账单窗口天数不合法"));
    }
    if raw.totals.topup_cents < 0 || raw.totals.charge_cents < 0 {
        return Err(CpError::invalid_response("账单合计不能为负"));
    }

    let mut skipped = 0usize;
    let entries = raw
        .entries
        .into_iter()
        .filter_map(
            |entry| match serde_json::from_value::<BillingLedgerEntry>(entry) {
                Ok(entry) => Some(entry),
                Err(_) => {
                    skipped += 1;
                    None
                }
            },
        )
        .collect();
    if skipped > 0 {
        log::warn!("[billing] 账单有 {skipped} 条流水形状不对，已跳过，其余照常返回");
    }

    let currency = raw
        .currency
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(default_currency);
    Ok(BillingLedger {
        balance_cents: raw.balance_cents,
        currency,
        window_days: raw.window_days,
        truncated: raw.truncated,
        totals: raw.totals,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "balance_cents": 11806,
            "currency": "USD",
            "window_days": 30,
            "truncated": false,
            "totals": { "topup_cents": 12000, "charge_cents": 294 },
            "entries": [
                {
                    "id": "wl_2",
                    "kind": "machine_day",
                    "amount_cents": -20,
                    "at": 1_764_000_000_000_i64,
                    "server": {
                        "id": "srv_1",
                        "name": "新加坡 1",
                        "plan": "s-1vcpu-1gb",
                        "region": "sgp1"
                    },
                    "note": null
                },
                {
                    "id": "wl_1",
                    "kind": "topup",
                    "amount_cents": 12000,
                    "at": 1_763_000_000_000_i64,
                    "server": null,
                    "note": "充值"
                }
            ]
        })
    }

    #[test]
    fn a_ledger_response_is_passed_through_untouched() {
        let ledger = parse_ledger(sample()).unwrap();
        assert_eq!(ledger.balance_cents, 11806);
        assert_eq!(ledger.window_days, 30);
        assert_eq!(ledger.totals.charge_cents, 294);
        assert_eq!(ledger.entries.len(), 2);
        // 毫秒原样透出，不按秒处理。
        assert_eq!(ledger.entries[0].at, 1_764_000_000_000);
        assert_eq!(ledger.entries[0].server.as_ref().unwrap().region, "sgp1");
        assert!(ledger.entries[1].server.is_none());
        assert!(!ledger.truncated);
    }

    #[test]
    fn an_unknown_kind_is_not_dropped_here() {
        let mut raw = sample();
        raw["entries"][0]["kind"] = json!("promo");
        let ledger = parse_ledger(raw).unwrap();
        assert_eq!(ledger.entries[0].kind, "promo");
    }

    #[test]
    fn a_bad_entry_is_skipped_without_failing_the_page() {
        let mut raw = sample();
        raw["entries"][0]
            .as_object_mut()
            .unwrap()
            .remove("amount_cents");
        let ledger = parse_ledger(raw).unwrap();
        assert_eq!(ledger.entries.len(), 1);
        assert_eq!(ledger.entries[0].id, "wl_1");
        // totals 是独立聚合：丢一行不会让它失真。
        assert_eq!(ledger.totals.topup_cents, 12000);
    }

    #[test]
    fn a_malformed_response_is_an_invalid_response() {
        for broken in [
            json!({ "window_days": 30, "totals": { "topup_cents": 0, "charge_cents": 0 } }),
            json!({
                "balance_cents": -1,
                "window_days": 30,
                "totals": { "topup_cents": 0, "charge_cents": 0 }
            }),
            json!({
                "balance_cents": 0,
                "window_days": 0,
                "totals": { "topup_cents": 0, "charge_cents": 0 }
            }),
            json!({
                "balance_cents": 0,
                "window_days": 31,
                "totals": { "topup_cents": 0, "charge_cents": 0 }
            }),
            json!({
                "balance_cents": 0,
                "window_days": 30,
                "totals": { "topup_cents": -1, "charge_cents": 0 }
            }),
        ] {
            let error = parse_ledger(broken).unwrap_err();
            assert_eq!(error.code, "UPSTREAM_ERROR");
            assert_eq!(error.reason(), Some("invalid_response"));
        }
    }

    #[test]
    fn a_missing_currency_falls_back_to_usd() {
        let mut raw = sample();
        raw.as_object_mut().unwrap().remove("currency");
        assert_eq!(parse_ledger(raw).unwrap().currency, "USD");
    }
}
