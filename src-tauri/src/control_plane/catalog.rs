//! 控制面公开目录：`GET /v1/catalog`（地区 + 套餐，只读、服务端缓存 5 分钟）。
//!
//! 这一层只做「取回 + 校验成强类型」；环境与 base_url 由 [`super::env::current`]
//! 决定，本文件不写死任何域名，也不绕过 release 只认 prod 的规则。

use std::time::Duration;

use serde::{Deserialize, Serialize};

const CATALOG_PATH: &str = "/v1/catalog";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// 目录只有几十条，2 MiB 足够；防止上游异常时把整页 HTML 读进内存。
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// 契约里固定的六个大洲取值。
pub const CONTINENTS: [&str; 6] = [
    "asia",
    "europe",
    "north_america",
    "south_america",
    "oceania",
    "africa",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub id: String,
    pub name: String,
    pub continent: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Plan {
    pub id: String,
    pub label: String,
    pub hourly_usd: f64,
    pub monthly_usd: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Catalog {
    pub currency: String,
    pub updated_at: String,
    pub regions: Vec<Region>,
    pub plans: Vec<Plan>,
}

/// 命令层原样搬进 AivpnError 信封的错误信息。
///
/// 码只取 `runtime.md` §6.1 的通用码；细分用 `details.reason`，不新造错误码。
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: serde_json::Value,
}

impl CatalogError {
    fn new(
        code: &'static str,
        message: impl Into<String>,
        retryable: bool,
        details: serde_json::Value,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            details,
        }
    }

    /// 响应格式 / 字段 / 取值问题：上游错误，不可重试。
    fn invalid(message: impl Into<String>) -> Self {
        Self::new(
            "UPSTREAM_ERROR",
            message,
            false,
            serde_json::json!({ "reason": "invalid_response" }),
        )
    }
}

/// 上游状态码 → 错误。2xx 返回 `None`。
pub fn map_status(status: u16) -> Option<CatalogError> {
    match status {
        200..=299 => None,
        429 => Some(CatalogError::new(
            "RATE_LIMITED",
            "控制面目录请求过于频繁，请稍后重试",
            true,
            serde_json::json!({ "status": status, "reason": "rate_limited" }),
        )),
        500..=599 => Some(CatalogError::new(
            "UPSTREAM_ERROR",
            "控制面目录暂时不可用",
            true,
            serde_json::json!({ "status": status, "reason": "upstream_status" }),
        )),
        _ => Some(CatalogError::new(
            "UPSTREAM_ERROR",
            "控制面拒绝了目录请求",
            false,
            serde_json::json!({ "status": status, "reason": "upstream_status" }),
        )),
    }
}

/// 解析并校验。单独暴露，便于在没有网络时单测。
pub fn parse_catalog(body: &str) -> Result<Catalog, CatalogError> {
    let catalog: Catalog = serde_json::from_str(body)
        .map_err(|error| CatalogError::invalid(format!("目录格式不正确：{error}")))?;
    validate(catalog)
}

fn validate(catalog: Catalog) -> Result<Catalog, CatalogError> {
    if catalog.currency.trim().is_empty() {
        return Err(CatalogError::invalid("目录缺少 currency"));
    }
    if catalog.updated_at.trim().is_empty() {
        return Err(CatalogError::invalid("目录缺少 updated_at"));
    }

    let mut region_ids = std::collections::HashSet::new();
    for region in &catalog.regions {
        if region.id.trim().is_empty() || region.name.trim().is_empty() {
            return Err(CatalogError::invalid("地区缺少 id 或 name"));
        }
        if !CONTINENTS.contains(&region.continent.as_str()) {
            return Err(CatalogError::invalid(format!(
                "地区 {} 的大洲取值不合法：{}",
                region.id, region.continent
            )));
        }
        if !region_ids.insert(region.id.as_str()) {
            return Err(CatalogError::invalid(format!("地区 id 重复：{}", region.id)));
        }
    }

    let mut plan_ids = std::collections::HashSet::new();
    for plan in &catalog.plans {
        if plan.id.trim().is_empty() || plan.label.trim().is_empty() {
            return Err(CatalogError::invalid("套餐缺少 id 或 label"));
        }
        if !plan.hourly_usd.is_finite() || plan.hourly_usd < 0.0 {
            return Err(CatalogError::invalid(format!(
                "套餐 {} 的 hourly_usd 不合法",
                plan.id
            )));
        }
        if !plan.monthly_usd.is_finite() || plan.monthly_usd < 0.0 {
            return Err(CatalogError::invalid(format!(
                "套餐 {} 的 monthly_usd 不合法",
                plan.id
            )));
        }
        if !plan_ids.insert(plan.id.as_str()) {
            return Err(CatalogError::invalid(format!("套餐 id 重复：{}", plan.id)));
        }
    }

    Ok(catalog)
}

/// GET `${base_url}/v1/catalog`，8 秒超时。
pub async fn fetch_catalog(base_url: &str) -> Result<Catalog, CatalogError> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(CatalogError::new(
            "INTERNAL",
            "控制面地址为空",
            false,
            serde_json::json!({ "reason": "invalid_config" }),
        ));
    }
    let url = format!("{base}{CATALOG_PATH}");

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| {
            CatalogError::new(
                "INTERNAL",
                format!("创建控制面客户端失败：{error}"),
                false,
                serde_json::json!({ "reason": "client" }),
            )
        })?;

    let response = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                CatalogError::new(
                    "TIMEOUT",
                    "控制面目录请求超时",
                    true,
                    serde_json::json!({ "reason": "timeout", "endpoint": CATALOG_PATH }),
                )
            } else {
                let kind = if error.is_connect() {
                    "连接失败"
                } else {
                    "请求失败"
                };
                CatalogError::new(
                    "UPSTREAM_ERROR",
                    format!("{kind}（控制面目录）"),
                    true,
                    serde_json::json!({ "reason": "network", "endpoint": CATALOG_PATH }),
                )
            }
        })?;

    let status = response.status().as_u16();
    if let Some(error) = map_status(status) {
        return Err(error);
    }
    if let Some(length) = response.content_length() {
        if length as usize > MAX_RESPONSE_BYTES {
            return Err(CatalogError::invalid("控制面目录响应过大"));
        }
    }

    let bytes = response.bytes().await.map_err(|error| {
        CatalogError::new(
            "UPSTREAM_ERROR",
            format!("读取控制面目录响应失败：{error}"),
            true,
            serde_json::json!({ "reason": "network", "endpoint": CATALOG_PATH }),
        )
    })?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(CatalogError::invalid("控制面目录响应过大"));
    }
    let body = String::from_utf8(bytes.to_vec())
        .map_err(|_| CatalogError::invalid("控制面目录不是 UTF-8"))?;
    parse_catalog(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_body() -> String {
        serde_json::json!({
            "currency": "USD",
            "updated_at": "2026-11-14T00:00:00Z",
            "regions": [
                { "id": "tyo", "name": "Tokyo", "continent": "asia" },
                { "id": "fra", "name": "Frankfurt", "continent": "europe" }
            ],
            "plans": [
                { "id": "vc2-1c-1gb", "label": "1 vCPU · 1 GB", "hourly_usd": 0.007, "monthly_usd": 5.0 }
            ]
        })
        .to_string()
    }

    #[test]
    fn parses_a_valid_catalog() {
        let catalog = parse_catalog(&valid_body()).unwrap();
        assert_eq!(catalog.currency, "USD");
        assert_eq!(catalog.regions.len(), 2);
        assert_eq!(catalog.regions[0].id, "tyo");
        assert_eq!(catalog.regions[0].continent, "asia");
        assert_eq!(catalog.plans.len(), 1);
        assert_eq!(catalog.plans[0].monthly_usd, 5.0);
    }

    #[test]
    fn a_missing_field_is_rejected() {
        let mut value: serde_json::Value = serde_json::from_str(&valid_body()).unwrap();
        value["regions"][0].as_object_mut().unwrap().remove("continent");
        let error = parse_catalog(&value.to_string()).unwrap_err();
        assert_eq!(error.code, "UPSTREAM_ERROR");
        assert_eq!(error.details["reason"], "invalid_response");
        assert!(!error.retryable);
        assert!(error.message.contains("continent"));

        // currency 缺失同样是硬错误，不能补默认值。
        let mut value: serde_json::Value = serde_json::from_str(&valid_body()).unwrap();
        value.as_object_mut().unwrap().remove("currency");
        let error = parse_catalog(&value.to_string()).unwrap_err();
        assert_eq!(error.code, "UPSTREAM_ERROR");
        assert_eq!(error.details["reason"], "invalid_response");
    }

    #[test]
    fn an_unknown_continent_is_rejected() {
        let mut value: serde_json::Value = serde_json::from_str(&valid_body()).unwrap();
        value["regions"][0]["continent"] = serde_json::json!("atlantis");
        let error = parse_catalog(&value.to_string()).unwrap_err();
        assert_eq!(error.details["reason"], "invalid_response");
        assert!(error.message.contains("atlantis"));
    }

    #[test]
    fn duplicate_ids_are_rejected() {
        let mut value: serde_json::Value = serde_json::from_str(&valid_body()).unwrap();
        value["regions"][1]["id"] = serde_json::json!("tyo");
        assert_eq!(
            parse_catalog(&value.to_string()).unwrap_err().details["reason"],
            "invalid_response"
        );

        let mut value: serde_json::Value = serde_json::from_str(&valid_body()).unwrap();
        value["plans"] = serde_json::json!([
            { "id": "p", "label": "a", "hourly_usd": 0.1, "monthly_usd": 1.0 },
            { "id": "p", "label": "b", "hourly_usd": 0.2, "monthly_usd": 2.0 }
        ]);
        assert_eq!(
            parse_catalog(&value.to_string()).unwrap_err().details["reason"],
            "invalid_response"
        );
    }

    #[test]
    fn a_negative_price_is_rejected() {
        let mut value: serde_json::Value = serde_json::from_str(&valid_body()).unwrap();
        value["plans"][0]["hourly_usd"] = serde_json::json!(-0.1);
        assert_eq!(
            parse_catalog(&value.to_string()).unwrap_err().details["reason"],
            "invalid_response"
        );
    }

    #[test]
    fn a_503_is_retryable() {
        let error = map_status(503).expect("503 必须报错");
        assert_eq!(error.code, "UPSTREAM_ERROR");
        assert_eq!(error.details["reason"], "upstream_status");
        assert!(error.retryable);
        assert_eq!(error.details["status"], 503);

        assert!(map_status(200).is_none());
        assert!(map_status(204).is_none());
    }

    #[test]
    fn a_429_uses_the_rate_limited_code() {
        let error = map_status(429).expect("429 必须报错");
        assert_eq!(error.code, "RATE_LIMITED");
        assert_eq!(error.details["reason"], "rate_limited");
        assert!(error.retryable);
    }

    #[test]
    fn a_4xx_is_not_retryable() {
        let error = map_status(404).expect("404 必须报错");
        assert_eq!(error.code, "UPSTREAM_ERROR");
        assert_eq!(error.details["reason"], "upstream_status");
        assert!(!error.retryable);
    }
}
