//! `StageSelect`（`tools.md` §4.52）与 `ServerOptions`（§4.53）。
//!
//! `StageSelect` 只把地区 / 规格选进「新建节点」舞台：不建机、不扣费、不写业务表。
//! Host 没有舞台当前选择的镜像，所以只回本次请求的字段，未请求的为 `null`。

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::{Changed, Fact, FactKey};
use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::ServerCatalogSource;
use super::turn_guard;
use crate::claurst_session::events::{self, EV_STAGE_SELECT};
use crate::control_plane::catalog::{Catalog, CatalogError};

const MAX_FIELD_CHARS: usize = 40;

fn invalid(reason: &str, message: &str) -> AivpnError {
    AivpnError::new("INVALID_ARGUMENT", message).with_details(json!({ "reason": reason }))
}

fn unavailable(region: &str, plan: &str) -> AivpnError {
    AivpnError::new("INVALID_ARGUMENT", "这个地区没有这个规格").with_details(
        json!({ "reason": "plan_unavailable_in_region", "region": region, "plan": plan }),
    )
}

fn catalog_failure(error: CatalogError) -> AivpnError {
    let retryable = error.retryable;
    let failure = AivpnError::new(error.code, error.message).with_details(error.details);
    if retryable {
        failure.retryable()
    } else {
        failure
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StageRequest {
    region: Option<String>,
    plan: Option<String>,
}

fn parse_field(value: Option<&Value>, key: &str) -> Result<Option<String>, AivpnError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            let length = trimmed.chars().count();
            if length == 0 || length > MAX_FIELD_CHARS {
                return Err(invalid(
                    "invalid_payload",
                    &format!("{key} 必须是 1–{MAX_FIELD_CHARS} 个字符"),
                ));
            }
            Ok(Some(trimmed.to_string()))
        }
        Some(_) => Err(invalid("invalid_payload", &format!("{key} 必须是字符串"))),
    }
}

fn parse_input(input: &Value) -> Result<StageRequest, AivpnError> {
    let Some(object) = input.as_object() else {
        return Err(invalid("invalid_payload", "参数必须是一个对象"));
    };
    for key in object.keys() {
        if key != "region" && key != "plan" {
            return Err(invalid("invalid_payload", &format!("不支持的参数 {key}")));
        }
    }
    let region = parse_field(object.get("region"), "region")?;
    let plan = parse_field(object.get("plan"), "plan")?;
    if region.is_none() && plan.is_none() {
        return Err(invalid(
            "invalid_payload",
            "region 与 plan 至少要给一个；先调 ServerOptions 拿真实 id",
        ));
    }
    Ok(StageRequest { region, plan })
}

/// 目录校验：出现的字段必须在目录里；返回给文案用的名称。
fn resolve(
    request: &StageRequest,
    catalog: &Catalog,
) -> Result<(Option<(String, String)>, Option<(String, String)>), AivpnError> {
    let region = match &request.region {
        Some(id) => {
            let found = catalog
                .regions
                .iter()
                .find(|region| &region.id == id)
                .ok_or_else(|| invalid("unknown_region", "目录里没有这个地区"))?;
            Some((found.id.clone(), found.name.clone()))
        }
        None => None,
    };
    let plan = match &request.plan {
        Some(id) => {
            let found = catalog
                .plans
                .iter()
                .find(|plan| &plan.id == id)
                .ok_or_else(|| invalid("unknown_plan", "目录里没有这个规格"))?;
            Some((found.id.clone(), found.label.clone(), found.regions.clone()))
        }
        None => None,
    };
    // 地区和规格同时出现时，必须是目录里真实存在的组合：不能假设每个地区都能开每一档。
    if let (Some((region_id, _)), Some((plan_id, _, plan_regions))) = (&region, &plan) {
        if !plan_regions.iter().any(|id| id == region_id) {
            return Err(unavailable(region_id, plan_id));
        }
    }
    Ok((
        region.map(|(id, name)| (id, name)),
        plan.map(|(id, label, _)| (id, label)),
    ))
}

type Emitter = Arc<dyn Fn(Value) + Send + Sync>;

pub struct StageSelectTool {
    catalog: Arc<dyn ServerCatalogSource>,
    emit: Emitter,
}

impl StageSelectTool {
    pub fn new(catalog: Arc<dyn ServerCatalogSource>) -> Self {
        Self {
            catalog,
            emit: Arc::new(|payload| {
                crate::agent::app_handle::emit(EV_STAGE_SELECT, payload);
            }),
        }
    }

    #[cfg(test)]
    pub fn with_emitter(catalog: Arc<dyn ServerCatalogSource>, emit: Emitter) -> Self {
        Self { catalog, emit }
    }
}

#[async_trait]
impl Tool for StageSelectTool {
    fn name(&self) -> &str {
        "StageSelect"
    }

    fn description(&self) -> &str {
        "用户说「帮我选 / 换成东京 / 用标准档」，或点了新建节点卡片上的对应按钮时，\
         把地区 / 规格选进「新建节点」舞台。只改界面选择，不建机、不扣费、不调用任何命令。\
         region / plan 至少要给一个，值必须是 ServerOptions 返回的真实 id；\
         不知道 id 就先调 ServerOptions，不要凭印象拼。同一轮最多成功一次。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "region": { "type": "string", "minLength": 1, "maxLength": 40 },
                "plan": { "type": "string", "minLength": 1, "maxLength": 40 }
            },
            "anyOf": [
                { "required": ["region"] },
                { "required": ["plan"] }
            ],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match parse_input(&input) {
            Err(error) => ToolOutcome::fail(error).with_display(Vec::new(), Changed::None),
            Ok(request) => match self.catalog.fetch().await {
                Err(error) => ToolOutcome::fail(catalog_failure(error))
                    .with_display(Vec::new(), Changed::None),
                Ok(catalog) => match resolve(&request, &catalog) {
                    Err(error) => ToolOutcome::fail(error).with_display(Vec::new(), Changed::None),
                    // 校验全部通过后才占名额：模型用错 id 时还能在同一轮重试。
                    Ok(_) if !turn_guard::claim("StageSelect", ctx) => ToolOutcome::fail(
                        AivpnError::new("PRECONDITION_FAILED", "这一轮已经选过一次了")
                            .with_details(json!({ "reason": "already_called_this_turn" })),
                    )
                    .with_display(Vec::new(), Changed::None),
                    Ok((region, plan)) => {
                        let region_id = region.as_ref().map(|(id, _)| id.clone());
                        let plan_id = plan.as_ref().map(|(id, _)| id.clone());
                        (self.emit)(json!({
                            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                            "screen": "new_node",
                            "region": &region_id,
                            "plan": &plan_id,
                            "emitted_at": events::now(),
                        }));

                        let labels: Vec<String> = region
                            .as_ref()
                            .map(|(_, name)| format!("「{name}」"))
                            .into_iter()
                            .chain(plan.as_ref().map(|(_, label)| format!("「{label}」")))
                            .collect();
                        let what = labels.join("");
                        let mut facts = Vec::new();
                        if let Some((_, name)) = &region {
                            facts.push(Fact::with_params(
                                FactKey::RegionName,
                                json!({ "name": name }),
                            ));
                        }
                        if let Some((_, label)) = &plan {
                            facts.push(Fact::with_params(
                                FactKey::PlanLabel,
                                json!({ "label": label }),
                            ));
                        }
                        ToolOutcome::ok(
                            format!("已把{what}发给新建节点舞台。"),
                            json!({
                                "screen": "new_node",
                                "region": region_id,
                                "plan": plan_id,
                            }),
                        )
                        .with_display(facts, Changed::None)
                    }
                },
            },
        };
        envelope::finish(ctx, "StageSelect", outcome)
    }
}

/// 模型只能看到 `ToolResult.content`（`tools.md` §1.2）；目录异常膨胀时截断，
/// 结构化全量仍在信封 `data` 里给 UI。
const MAX_CONTENT_CHARS: usize = 2000;
const TRUNCATION_MARKER: &str = "……（已截断）";

fn usd(cents: i64) -> String {
    format!("${:.2}", cents as f64 / 100.0)
}

fn regions_block(catalog: &Catalog) -> String {
    if catalog.regions.is_empty() {
        return "地区：暂无".to_string();
    }

    let mut order: Vec<&str> = Vec::new();
    let mut groups: HashMap<&str, Vec<String>> = HashMap::new();
    for region in &catalog.regions {
        let continent = region.continent.trim();
        let key = if continent.is_empty() {
            "其他"
        } else {
            continent
        };
        if !groups.contains_key(key) {
            order.push(key);
        }
        groups
            .entry(key)
            .or_default()
            .push(format!("{}（{}）", region.name, region.id));
    }

    let body = order
        .iter()
        .copied()
        .map(|continent| {
            format!(
                "{continent}：{}",
                groups
                    .get(continent)
                    .map(|items| items.join("、"))
                    .unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("；");
    format!("地区（{} 个）：{body}", catalog.regions.len())
}

fn plans_block(catalog: &Catalog) -> String {
    if catalog.plans.is_empty() {
        return "规格：暂无".to_string();
    }

    let names: HashMap<&str, &str> = catalog
        .regions
        .iter()
        .map(|region| (region.id.as_str(), region.name.as_str()))
        .collect();
    let lines = catalog
        .plans
        .iter()
        .map(|plan| {
            // 可用性只按 plans[].regions 说话；没列出的组合就是不能开。
            let availability = if plan.regions.is_empty() {
                "无".to_string()
            } else {
                plan.regions
                    .iter()
                    .map(|id| match names.get(id.as_str()) {
                        Some(name) => format!("{name}（{id}）"),
                        None => id.clone(),
                    })
                    .collect::<Vec<_>>()
                    .join("、")
            };
            let transfer = if plan.transfer_gib > 0 {
                format!("每月 {} GB", plan.transfer_gib)
            } else {
                "每月额度未知".to_string()
            };
            format!(
                "- {}（{}） 每天 {} · {} · 可用地区：{}",
                plan.label,
                plan.id,
                usd(plan.daily_price_cents),
                transfer,
                availability
            )
        })
        .collect::<Vec<_>>();
    format!("规格（{} 个）：\n{}", lines.len(), lines.join("\n"))
}

fn truncate_with_marker(text: &str) -> String {
    let keep = MAX_CONTENT_CHARS.saturating_sub(TRUNCATION_MARKER.chars().count());
    let mut out: String = text.chars().take(keep).collect();
    out.push_str(TRUNCATION_MARKER);
    out
}

fn catalog_summary(catalog: &Catalog) -> String {
    let regions = regions_block(catalog);
    let plans = plans_block(catalog);
    let full = format!("{regions}\n{plans}");
    if full.chars().count() <= MAX_CONTENT_CHARS {
        return full;
    }

    // 超长时优先保住规格与「可用地区」，压缩地区清单。
    let plans_len = plans.chars().count();
    let marker_len = TRUNCATION_MARKER.chars().count();
    let budget = MAX_CONTENT_CHARS.saturating_sub(plans_len + 1 + marker_len);
    if budget > 1 {
        let regions_keep: String = regions.chars().take(budget).collect();
        return format!("{regions_keep}\n{plans}{TRUNCATION_MARKER}");
    }

    // 规格本身已超长：退化为只保留规格前段（首个规格仍带可用地区）。
    truncate_with_marker(&plans)
}

pub struct ServerOptionsTool {
    catalog: Arc<dyn ServerCatalogSource>,
}

impl ServerOptionsTool {
    pub fn new(catalog: Arc<dyn ServerCatalogSource>) -> Self {
        Self { catalog }
    }
}

#[async_trait]
impl Tool for ServerOptionsTool {
    fn name(&self) -> &str {
        "ServerOptions"
    }

    fn description(&self) -> &str {
        "读取新建节点可选的真实地区与规格，或用户问「有哪些地区 / 多少钱」时调用。\
         只返回 id、名称、大洲、日价与每月流量额度；不返回成本价，也没有「售罄」判断。\
         调 StageSelect 之前先用它拿 id，不要凭印象拼。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match input.as_object() {
            None => ToolOutcome::fail(invalid("invalid_payload", "参数必须是一个对象"))
                .with_display(Vec::new(), Changed::None),
            Some(object) if !object.is_empty() => {
                let key = object.keys().next().cloned().unwrap_or_default();
                ToolOutcome::fail(invalid("invalid_payload", &format!("不支持的参数 {key}")))
                    .with_display(Vec::new(), Changed::None)
            }
            Some(_) => match self.catalog.fetch().await {
                Err(error) => ToolOutcome::fail(catalog_failure(error))
                    .with_display(Vec::new(), Changed::None),
                Ok(catalog) => {
                    let regions: Vec<Value> = catalog
                        .regions
                        .iter()
                        .map(|region| {
                            json!({
                                "id": region.id,
                                "name": region.name,
                                "continent": region.continent,
                            })
                        })
                        .collect();
                    let plans: Vec<Value> = catalog
                        .plans
                        .iter()
                        .map(|plan| {
                            json!({
                                "id": plan.id,
                                "label": plan.label,
                                "daily_price_cents": plan.daily_price_cents,
                                "transfer_gib": plan.transfer_gib,
                                "regions": plan.regions,
                            })
                        })
                        .collect();
                    ToolOutcome::ok(
                        catalog_summary(&catalog),
                        json!({ "regions": regions, "plans": plans }),
                    )
                    .with_facts(vec![
                        Fact::with_params(
                            FactKey::CatalogRegionCount,
                            json!({ "count": regions.len() }),
                        ),
                        Fact::with_params(
                            FactKey::CatalogPlanCount,
                            json!({ "count": plans.len() }),
                        ),
                    ])
                }
            },
        };
        envelope::finish(ctx, "ServerOptions", outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::permission_handler::AivpnPermissionHandler;
    use claurst_core::file_history::FileHistory;
    use claurst_core::{CostTracker, PermissionMode};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    struct FakeCatalog {
        result: Result<Catalog, CatalogError>,
    }

    #[async_trait]
    impl ServerCatalogSource for FakeCatalog {
        async fn fetch(&self) -> Result<Catalog, CatalogError> {
            self.result.clone()
        }
    }

    fn catalog() -> Catalog {
        Catalog {
            currency: "USD".into(),
            updated_at: "2026-11-17T00:00:00Z".into(),
            regions: vec![crate::control_plane::catalog::Region {
                id: "tyo".into(),
                name: "Tokyo".into(),
                continent: "asia".into(),
            }],
            plans: vec![crate::control_plane::catalog::Plan {
                id: "vc2-1c-1gb".into(),
                label: "1 vCPU · 1 GB".into(),
                hourly_usd: 0.007,
                monthly_usd: 5.0,
                daily_price_cents: 17,
                transfer_gib: 1000,
                regions: vec!["tyo".into()],
            }],
        }
    }

    fn big_catalog() -> Catalog {
        Catalog {
            currency: "USD".into(),
            updated_at: "2026-11-17T00:00:00Z".into(),
            regions: (0..400)
                .map(|i| crate::control_plane::catalog::Region {
                    id: format!("r{i}"),
                    name: format!("Region {i}"),
                    continent: "asia".into(),
                })
                .collect(),
            plans: vec![crate::control_plane::catalog::Plan {
                id: "big-plan".into(),
                label: "Big".into(),
                hourly_usd: 0.001,
                monthly_usd: 1.0,
                daily_price_cents: 3,
                transfer_gib: 100,
                regions: vec!["r0".into()],
            }],
        }
    }

    fn source(result: Result<Catalog, CatalogError>) -> Arc<dyn ServerCatalogSource> {
        Arc::new(FakeCatalog { result })
    }

    fn context(session: &str, turn: usize) -> ToolContext {
        let dir = std::env::temp_dir();
        ToolContext {
            working_dir: dir.clone(),
            permission_mode: PermissionMode::BypassPermissions,
            permission_handler: Arc::new(AivpnPermissionHandler::new(dir)),
            cost_tracker: CostTracker::with_model("test"),
            session_id: session.to_string(),
            file_history: Arc::new(parking_lot::Mutex::new(FileHistory::new())),
            current_turn: Arc::new(AtomicUsize::new(turn)),
            non_interactive: true,
            mcp_manager: None,
            config: Default::default(),
            managed_agent_config: None,
            completion_notifier: None,
            pending_permissions: None,
            permission_manager: None,
            user_question_tx: None,
            cancel_token: tokio_util::sync::CancellationToken::new(),
            batch_rejection: Default::default(),
        }
    }

    fn recorder() -> (Emitter, Arc<Mutex<Vec<Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        (
            Arc::new(move |payload| sink.lock().unwrap().push(payload)),
            events,
        )
    }

    fn session(tag: &str) -> String {
        format!("stage-{tag}-{:016x}", rand::random::<u64>())
    }

    #[tokio::test]
    async fn partial_fields_are_emitted_and_missing_ones_are_null() {
        let (emit, events) = recorder();
        let tool = StageSelectTool::with_emitter(source(Ok(catalog())), emit);
        let ctx = context(&session("partial"), 1);

        let result = tool.execute(json!({ "region": "tyo" }), &ctx).await;
        assert!(!result.is_error, "{}", result.content);
        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0]["screen"], "new_node");
        assert_eq!(emitted[0]["region"], "tyo");
        assert_eq!(emitted[0]["plan"], Value::Null);
    }

    #[tokio::test]
    async fn an_unknown_id_does_not_consume_the_turn() {
        let (emit, events) = recorder();
        let tool = StageSelectTool::with_emitter(source(Ok(catalog())), emit);
        let ctx = context(&session("retry"), 1);

        let bad = tool.execute(json!({ "region": "东京" }), &ctx).await;
        assert!(bad.is_error);
        let meta = bad.metadata.clone().unwrap();
        assert_eq!(meta["aivpn"]["error"]["code"], "INVALID_ARGUMENT");
        assert_eq!(meta["aivpn"]["error"]["details"]["reason"], "unknown_region");
        assert!(events.lock().unwrap().is_empty());

        // 校验失败不占名额：同一轮用正确 id 仍然能成功。
        let good = tool.execute(json!({ "region": "tyo" }), &ctx).await;
        assert!(!good.is_error, "{}", good.content);
        assert_eq!(events.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_region_without_the_plan_is_rejected_without_consuming_the_turn() {
        let mut catalog = catalog();
        catalog.plans[0].regions = vec!["fra".into()];
        let (emit, events) = recorder();
        let tool = StageSelectTool::with_emitter(source(Ok(catalog)), emit);
        let ctx = context(&session("pair"), 1);

        let result = tool
            .execute(json!({ "region": "tyo", "plan": "vc2-1c-1gb" }), &ctx)
            .await;
        assert!(result.is_error);
        let meta = result.metadata.unwrap();
        assert_eq!(meta["aivpn"]["error"]["code"], "INVALID_ARGUMENT");
        assert_eq!(
            meta["aivpn"]["error"]["details"]["reason"],
            "plan_unavailable_in_region"
        );
        assert_eq!(meta["aivpn"]["error"]["details"]["region"], "tyo");
        assert_eq!(meta["aivpn"]["error"]["details"]["plan"], "vc2-1c-1gb");
        assert!(events.lock().unwrap().is_empty());

        // 校验失败不占名额：同一轮换成目录支持的组合仍然能成功。
        let good = tool.execute(json!({ "region": "tyo" }), &ctx).await;
        assert!(!good.is_error, "{}", good.content);
        assert_eq!(events.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_same_tool_succeeds_once_per_turn() {
        let (emit, events) = recorder();
        let tool = StageSelectTool::with_emitter(source(Ok(catalog())), emit);
        let ctx = context(&session("once"), 2);

        assert!(!tool
            .execute(json!({ "region": "tyo" }), &ctx)
            .await
            .is_error);
        let second = tool.execute(json!({ "plan": "vc2-1c-1gb" }), &ctx).await;
        assert!(second.is_error);
        let meta = second.metadata.unwrap();
        assert_eq!(meta["aivpn"]["error"]["code"], "PRECONDITION_FAILED");
        assert_eq!(
            meta["aivpn"]["error"]["details"]["reason"],
            "already_called_this_turn"
        );
        assert_eq!(events.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn open_settings_and_stage_select_do_not_collide_in_one_turn() {
        let (emit, events) = recorder();
        let stage = StageSelectTool::with_emitter(source(Ok(catalog())), emit);
        let open = super::super::settings::OpenSettingsTool::with_emitter(Arc::new(|_| {}));
        let ctx = context(&session("collide"), 5);

        assert!(!open
            .execute(json!({ "section": "connection" }), &ctx)
            .await
            .is_error);
        assert!(
            !stage
                .execute(json!({ "region": "tyo" }), &ctx)
                .await
                .is_error,
            "不同工具不能互相顶掉"
        );
        assert_eq!(events.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_catalog_failure_uses_the_contract_codes() {
        let cases = [
            ("TIMEOUT", "timeout", true),
            ("UPSTREAM_ERROR", "network", true),
            ("RATE_LIMITED", "rate_limited", true),
            ("UPSTREAM_ERROR", "invalid_response", false),
        ];
        for (code, reason, retryable) in cases {
            let (emit, events) = recorder();
            let tool = StageSelectTool::with_emitter(
                source(Err(CatalogError {
                    code,
                    message: "目录取不到".into(),
                    retryable,
                    details: json!({ "reason": reason }),
                })),
                emit,
            );
            let result = tool
                .execute(
                    json!({ "region": "tyo" }),
                    &context(&session(reason), 1),
                )
                .await;
            assert!(result.is_error);
            let meta = result.metadata.unwrap();
            assert_eq!(meta["aivpn"]["error"]["code"], code, "{reason}");
            assert_eq!(
                meta["aivpn"]["error"]["details"]["reason"], reason,
                "{reason}"
            );
            assert_eq!(
                meta["aivpn"]["error"]["retryable"], retryable,
                "{reason}"
            );
            assert!(events.lock().unwrap().is_empty(), "{reason} 不能发事件");
        }
    }

    #[tokio::test]
    async fn catalog_options_returns_only_display_fields() {
        let tool = ServerOptionsTool::new(source(Ok(catalog())));
        let result = tool
            .execute(json!({}), &context(&session("options"), 1))
            .await;
        assert!(!result.is_error, "{}", result.content);
        let meta = result.metadata.unwrap();
        let data = &meta["aivpn"]["data"];
        assert_eq!(data["regions"][0]["id"], "tyo");
        assert_eq!(data["plans"][0]["daily_price_cents"], 17);
        assert_eq!(data["plans"][0]["transfer_gib"], 1000);
        assert_eq!(data["plans"][0]["regions"][0], "tyo");
        assert!(
            data["plans"][0].get("hourly_usd").is_none(),
            "成本口径不能返回"
        );
        assert!(data["plans"][0].get("monthly_usd").is_none());
    }

    #[tokio::test]
    async fn catalog_options_content_lists_real_ids_and_daily_price() {
        let tool = ServerOptionsTool::new(source(Ok(catalog())));
        let result = tool
            .execute(json!({}), &context(&session("options-content"), 1))
            .await;
        assert!(!result.is_error, "{}", result.content);

        // 模型必须能直接拿到可调用的 id 与展示价。
        assert!(
            result.content.contains("Tokyo（tyo）"),
            "{}",
            result.content
        );
        assert!(result.content.contains("vc2-1c-1gb"), "{}", result.content);
        assert!(result.content.contains("$0.17"), "{}", result.content);
        assert!(
            result.content.contains("可用地区：Tokyo（tyo）"),
            "{}",
            result.content
        );

        // 成本口径与原始 JSON 不进 content。
        assert!(!result.content.contains("hourly_usd"), "{}", result.content);
        assert!(
            !result.content.contains("monthly_usd"),
            "{}",
            result.content
        );
        assert!(
            !result.content.contains("\"regions\""),
            "{}",
            result.content
        );
    }

    #[tokio::test]
    async fn catalog_options_truncates_oversized_catalog_but_keeps_availability() {
        let tool = ServerOptionsTool::new(source(Ok(big_catalog())));
        let result = tool
            .execute(json!({}), &context(&session("options-big"), 1))
            .await;
        assert!(!result.is_error, "{}", result.content);

        assert!(
            result.content.chars().count() <= MAX_CONTENT_CHARS,
            "content 超过 {} 字符：{}",
            MAX_CONTENT_CHARS,
            result.content.chars().count()
        );
        assert!(result.content.contains("已截断"), "{}", result.content);
        assert!(
            result.content.contains("可用地区：Region 0（r0）"),
            "截断后仍要保留可用地区：{}",
            result.content
        );
        assert!(result.content.contains("big-plan"), "{}", result.content);
        assert!(
            !result.content.contains("Region 399（r399）"),
            "超长地区清单应被截断：{}",
            result.content
        );
    }

    #[tokio::test]
    async fn catalog_options_rejects_unknown_arguments() {
        let tool = ServerOptionsTool::new(source(Ok(catalog())));
        let result = tool
            .execute(json!({ "region": "tyo" }), &context(&session("options-bad"), 1))
            .await;
        assert!(result.is_error);
    }
}
