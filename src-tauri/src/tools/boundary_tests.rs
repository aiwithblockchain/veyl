//! AI 工具层的输入边界测试。
//!
//! `input` 是**模型生成的裸 JSON**，模型是不可信输入：可能少字段、给错类型、
//! 给超长字符串、给路径穿越的名字，也可能整个返回一段没意义的 JSON。
//! 这一层是外部输入进入系统的边界。
//!
//! 判定标准不是「别崩」，而是**返回一个结构化的失败信封**——AI 拿到结构化错误
//! 能自己纠正，拿到 panic 整个会话就断了。
//!
//! 服务层用 `FakeServices`（记录调用 + 返回固定数据），只测工具层本身。

use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use claurst_core::file_history::FileHistory;
use claurst_core::{CostTracker, PermissionMode};
use claurst_tools::{Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use crate::agent::permission_handler::AivpnPermissionHandler;
use crate::control_plane::catalog::{Catalog, CatalogError, Plan, Region};
use crate::tools::permission_level_of;
use crate::tools::services::{
    CatalogQuery, ConfigCreateInput, ConfigUpdateInput, NodeCreateInput, ServerCatalogSource,
    VpnToolServices,
};

// ---------- 测试上下文 ----------

fn context() -> ToolContext {
    let dir = std::env::temp_dir();
    ToolContext {
        working_dir: dir.clone(),
        permission_mode: PermissionMode::BypassPermissions,
        permission_handler: Arc::new(AivpnPermissionHandler::new(dir.clone())),
        cost_tracker: CostTracker::with_model("test"),
        session_id: "boundary-test".to_string(),
        file_history: Arc::new(parking_lot::Mutex::new(FileHistory::new())),
        current_turn: Arc::new(AtomicUsize::new(0)),
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

// ---------- 记录调用的假服务 ----------

/// 建机目录替身：固定一份可预测的目录，工具层测试不联网。
struct FakeServerCatalog;

#[async_trait]
impl ServerCatalogSource for FakeServerCatalog {
    async fn fetch(&self) -> Result<Catalog, CatalogError> {
        Ok(Catalog {
            currency: "USD".into(),
            updated_at: "2026-11-17T00:00:00Z".into(),
            regions: vec![Region {
                id: "tyo".into(),
                name: "Tokyo".into(),
                continent: "asia".into(),
            }],
            plans: vec![Plan {
                id: "vc2-1c-1gb".into(),
                label: "1 vCPU · 1 GB".into(),
                hourly_usd: 0.007,
                monthly_usd: 5.0,
                daily_price_cents: 17,
                transfer_gib: 1000,
                regions: vec!["tyo".into()],
            }],
        })
    }
}

#[derive(Default)]
struct Recorder {
    calls: Mutex<Vec<String>>,
}

impl Recorder {
    fn record(&self, call: impl Into<String>) {
        self.calls.lock().unwrap().push(call.into());
    }
    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
}

/// 所有方法都返回同一份 `data`，只记录被调用了什么。
struct FakeServices {
    rec: Arc<Recorder>,
    data: Value,
    /// `trial_status` 单独返回：`None` 模拟读不到试用状态。
    trial: Option<Value>,
    /// `node_import_text` 专用：模拟解析失败时返回的错误码。
    text_error: Option<&'static str>,
}

impl FakeServices {
    fn new() -> (Arc<Self>, Arc<Recorder>) {
        Self::with_data(json!({}))
    }

    fn with_data(data: Value) -> (Arc<Self>, Arc<Recorder>) {
        let rec = Arc::new(Recorder::default());
        let services = Arc::new(Self {
            rec: Arc::clone(&rec),
            data,
            trial: None,
            text_error: None,
        });
        (services, rec)
    }

    fn with_trial(data: Value, trial: Value) -> (Arc<Self>, Arc<Recorder>) {
        let rec = Arc::new(Recorder::default());
        let services = Arc::new(Self {
            rec: Arc::clone(&rec),
            data,
            trial: Some(trial),
            text_error: None,
        });
        (services, rec)
    }

    /// 模拟「整段都解析不出节点」：服务层返回结构化错误。
    fn with_text_error(code: &'static str) -> (Arc<Self>, Arc<Recorder>) {
        let (services, rec) = Self::with_data(json!({}));
        let services = Arc::new(Self {
            rec: services.rec.clone(),
            data: json!({}),
            trial: None,
            text_error: Some(code),
        });
        (services, rec)
    }
}

#[async_trait]
impl VpnToolServices for FakeServices {
    async fn runtime_status(&self) -> anyhow::Result<Value> {
        self.rec.record("runtime_status");
        Ok(self.data.clone())
    }
    async fn runtime_start(&self, config_id: Option<String>) -> anyhow::Result<Value> {
        self.rec.record(format!("runtime_start({config_id:?})"));
        Ok(self.data.clone())
    }
    async fn runtime_stop(&self, force: bool) -> anyhow::Result<Value> {
        self.rec.record(format!("runtime_stop({force})"));
        Ok(self.data.clone())
    }
    async fn runtime_restart(&self, reason: Option<String>) -> anyhow::Result<Value> {
        self.rec.record(format!("runtime_restart({reason:?})"));
        Ok(self.data.clone())
    }
    async fn runtime_logs(&self, lines: u32, level: Option<String>) -> anyhow::Result<Value> {
        self.rec.record(format!("runtime_logs({lines},{level:?})"));
        Ok(self.data.clone())
    }

    async fn my_server_failure(&self, server_id: &str) -> anyhow::Result<Value> {
        self.rec.record(format!("my_server_failure({server_id})"));
        Ok(self.data.clone())
    }
    async fn core_list_versions(&self) -> anyhow::Result<Value> {
        self.rec.record("core_list_versions");
        Ok(self.data.clone())
    }
    async fn core_info(&self) -> anyhow::Result<Value> {
        self.rec.record("core_info");
        Ok(self.data.clone())
    }
    async fn core_check_updates(&self) -> anyhow::Result<Value> {
        self.rec.record("core_check_updates");
        Ok(self.data.clone())
    }
    async fn core_upgrade(
        &self,
        version: &str,
        origin: &str,
        expected_sha256: Option<&str>,
    ) -> anyhow::Result<Value> {
        self.rec.record(format!("core_upgrade({version},{origin},{expected_sha256:?})"));
        Ok(self.data.clone())
    }
    async fn core_cancel_upgrade(&self, job_id: &str) -> anyhow::Result<Value> {
        self.rec.record(format!("core_cancel_upgrade({job_id})"));
        Ok(self.data.clone())
    }
    async fn core_rollback(&self) -> anyhow::Result<Value> {
        self.rec.record("core_rollback");
        Ok(self.data.clone())
    }
    async fn tun_helper_info(&self) -> anyhow::Result<Value> {
        self.rec.record("tun_helper_info");
        Ok(self.data.clone())
    }
    async fn tun_helper_restart(&self) -> anyhow::Result<Value> {
        self.rec.record("tun_helper_restart");
        Ok(self.data.clone())
    }
    #[cfg(debug_assertions)]
    async fn tun_probe(&self) -> anyhow::Result<Value> {
        self.rec.record("tun_probe");
        Ok(self.data.clone())
    }
    async fn catalog_search(&self, query: CatalogQuery) -> anyhow::Result<Value> {
        self.rec.record(format!(
            "catalog_search(region={:?},limit={:?})",
            query.region, query.limit
        ));
        Ok(self.data.clone())
    }

    fn server_catalog(&self) -> Arc<dyn ServerCatalogSource> {
        Arc::new(FakeServerCatalog)
    }
    async fn config_list(&self) -> anyhow::Result<Value> {
        self.rec.record("config_list");
        Ok(self.data.clone())
    }
    async fn config_detail(&self, config_id: Option<String>) -> anyhow::Result<Value> {
        let label = config_id.as_deref().unwrap_or("active");
        self.rec.record(format!("config_detail({label})"));
        Ok(self.data.clone())
    }
    async fn config_create(&self, input: ConfigCreateInput) -> anyhow::Result<Value> {
        self.rec.record(format!(
            "config_create(name={},mode={},routing={})",
            input.name, input.connect_mode, input.routing_mode
        ));
        Ok(self.data.clone())
    }
    async fn config_update(
        &self,
        config_id: &str,
        input: ConfigUpdateInput,
    ) -> anyhow::Result<Value> {
        self.rec
            .record(format!("config_update({config_id},{:?})", input.name));
        Ok(self.data.clone())
    }
    async fn config_delete(&self, config_id: &str) -> anyhow::Result<Value> {
        self.rec.record(format!("config_delete({config_id})"));
        Ok(self.data.clone())
    }
    async fn config_activate(&self, config_id: &str) -> anyhow::Result<Value> {
        self.rec.record(format!("config_activate({config_id})"));
        Ok(self.data.clone())
    }
    async fn node_import_url(
        &self,
        config_id: Option<String>,
        url: &str,
    ) -> anyhow::Result<Value> {
        self.rec.record(format!(
            "node_import_url({config_id:?},{}chars)",
            url.chars().count()
        ));
        Ok(self.data.clone())
    }
    async fn node_import_text(
        &self,
        config_id: Option<String>,
        text: &str,
    ) -> anyhow::Result<Value> {
        self.rec.record(format!(
            "node_import_text({config_id:?},{}chars)",
            text.chars().count()
        ));
        if let Some(code) = self.text_error {
            return Err(anyhow::anyhow!(
                "{code}: 粘贴的内容里没有可用的节点（支持多行 ss:// 链接）"
            ));
        }
        Ok(self.data.clone())
    }
    async fn node_create(&self, input: NodeCreateInput) -> anyhow::Result<Value> {
        self.rec.record(format!(
            "node_create({:?},name={},server={},port={})",
            input.config_id, input.name, input.server, input.port
        ));
        Ok(self.data.clone())
    }
    async fn node_switch(&self, config_id: &str, node_id: &str) -> anyhow::Result<Value> {
        self.rec
            .record(format!("node_switch({config_id},{node_id})"));
        Ok(self.data.clone())
    }
    async fn node_probe(&self, node_id: &str) -> anyhow::Result<Value> {
        self.rec.record(format!("node_probe({node_id})"));
        Ok(self.data.clone())
    }
    async fn default_profile_status(&self) -> anyhow::Result<Value> {
        self.rec.record("default_profile_status");
        Ok(self.data.clone())
    }
    async fn trial_status(&self) -> anyhow::Result<Value> {
        self.rec.record("trial_status");
        self.trial
            .clone()
            .ok_or_else(|| anyhow::anyhow!("not wired"))
    }
    async fn default_profile_refresh(&self, force: bool) -> anyhow::Result<Value> {
        self.rec.record(format!("default_profile_refresh({force})"));
        Ok(self.data.clone())
    }
    async fn import_seed_file(&self, path: &str) -> anyhow::Result<Value> {
        self.rec.record(format!("import_seed_file({path})"));
        Ok(self.data.clone())
    }
    async fn rules_status(&self) -> anyhow::Result<Value> {
        self.rec.record("rules_status");
        Ok(self.data.clone())
    }
    async fn category_list(
        &self,
        query: Option<String>,
        limit: Option<u32>,
    ) -> anyhow::Result<Value> {
        self.rec
            .record(format!("category_list({query:?},{limit:?})"));
        Ok(self.data.clone())
    }
    async fn route_get(&self, config_id: Option<String>) -> anyhow::Result<Value> {
        self.rec.record(format!("route_get({config_id:?})"));
        Ok(self.data.clone())
    }
    async fn route_set_mode(
        &self,
        config_id: Option<String>,
        mode: &str,
        confirm_reconnect: bool,
    ) -> anyhow::Result<Value> {
        self.rec.record(format!(
            "route_set_mode({config_id:?},{mode},{confirm_reconnect})"
        ));
        Ok(self.data.clone())
    }
    async fn config_set_mode(
        &self,
        config_id: Option<String>,
        mode: &str,
        confirmed: bool,
    ) -> anyhow::Result<Value> {
        self.rec
            .record(format!("config_set_mode({config_id:?},{mode},{confirmed})"));
        // 模拟服务层门禁：正在连（含启动窗口）且没确认时，先要求确认。
        let live = matches!(
            self.data.get("state").and_then(Value::as_str),
            Some("running" | "degraded" | "starting" | "restarting")
        );
        if live && !confirmed {
            let id = config_id.unwrap_or_default();
            return Err(anyhow::Error::new(
                crate::tools::services::ServiceError {
                    code: "PRECONDITION_FAILED".into(),
                    message: "切换接管方式会短暂断开当前连接，需要用户确认".into(),
                    retryable: false,
                    details: Some(json!({
                        "reason": "confirmation_required",
                        "config_id": id,
                        "mode": mode,
                        "previous_mode": self
                            .data
                            .get("connect_mode")
                            .and_then(Value::as_str)
                            .unwrap_or("system_proxy"),
                        "will_disconnect": true,
                    })),
                },
            ));
        }
        Ok(self.data.clone())
    }
    async fn route_targets_set(
        &self,
        config_id: &str,
        categories: Vec<String>,
    ) -> anyhow::Result<Value> {
        self.rec.record(format!(
            "route_targets_set({config_id},{:?})",
            categories
        ));
        Ok(self.data.clone())
    }
    async fn net_config_get(&self) -> anyhow::Result<Value> {
        self.rec.record("net_config_get");
        Ok(self.data.clone())
    }
    async fn net_repair(&self, action: &str, port: Option<u16>) -> anyhow::Result<Value> {
        self.rec.record(format!("net_repair({action},{port:?})"));
        Ok(self.data.clone())
    }
    async fn network_force_reset(&self) -> anyhow::Result<Value> {
        self.rec.record("network_force_reset()".to_string());
        Ok(self.data.clone())
    }
    async fn vpn_connect(&self, config_id: Option<String>) -> anyhow::Result<Value> {
        self.rec.record(format!("vpn_connect({config_id:?})"));
        Ok(self.data.clone())
    }
    async fn vpn_disconnect(&self) -> anyhow::Result<Value> {
        self.rec.record("vpn_disconnect");
        Ok(self.data.clone())
    }
    async fn issue_report(
        &self,
        _session_id: &str,
        _input: crate::reports::IssueReportInput,
    ) -> anyhow::Result<Value> {
        self.rec.record("issue_report");
        Ok(self.data.clone())
    }

    async fn set_user_region(&self, region: &str) -> anyhow::Result<Value> {
        self.rec.record(format!("set_user_region({region})"));
        Ok(json!({
            "region": region.to_ascii_lowercase(),
            "source": "ai",
        }))
    }

    async fn diag_run(&self, include_logs: bool) -> anyhow::Result<Value> {
        self.rec.record(format!("diag_run({include_logs})"));
        Ok(self.data.clone())
    }
    async fn save_deepseek_key(&self, key: &str) -> anyhow::Result<Value> {
        self.rec
            .record(format!("save_deepseek_key({}chars)", key.chars().count()));
        Ok(self.data.clone())
    }
    async fn job_get(&self, job_id: &str) -> anyhow::Result<Value> {
        self.rec.record(format!("job_get({job_id})"));
        Ok(self.data.clone())
    }
}

// ---------- 断言工具 ----------

fn envelope(result: &ToolResult) -> Value {
    let meta = result
        .metadata
        .as_ref()
        .unwrap_or_else(|| panic!("工具结果必须带 metadata"));
    let env = meta
        .get("aivpn")
        .unwrap_or_else(|| panic!("metadata 里必须有 aivpn 信封：{meta}"));
    for key in [
        "contract_version",
        "ok",
        "summary",
        "data",
        "error",
        "next_actions",
        "request_id",
        "duration_ms",
    ] {
        assert!(
            env.get(key).is_some(),
            "信封缺字段 {key}：{env}"
        );
    }
    env.clone()
}

/// 调一次工具，返回 (是否错误, 信封信封)。
async fn run(tool: &dyn Tool, input: Value) -> (bool, Value) {
    run_in_session(tool, input, "boundary-test").await
}

/// 指定会话 id 运行：进程级结果登记表按 (session_id, tool) 排队，
/// 需要读 `take_outcome` 的用例必须用自己的 id，避免并行时取到别人的记录。
async fn run_in_session(tool: &dyn Tool, input: Value, session_id: &str) -> (bool, Value) {
    let mut ctx = context();
    ctx.session_id = session_id.to_string();
    let result = tool.execute(input, &ctx).await;
    let env = envelope(&result);
    assert_eq!(
        env["ok"].as_bool(),
        Some(!result.is_error),
        "信封的 ok 与 ToolResult.is_error 必须一致：{env}"
    );
    (result.is_error, env)
}

/// 断言这是一次**结构化的**拒绝：不是 panic，不是空结果，而且带可读的错误码。
async fn expect_rejected(tool: &dyn Tool, input: Value, why: &str) -> Value {
    let (is_error, env) = run(tool, input.clone()).await;
    assert!(is_error, "{why}：输入 {input} 应当被拒绝，实际返回 {env}");
    let code = env["error"]["code"].as_str().unwrap_or_default();
    assert!(
        !code.is_empty(),
        "{why}：拒绝必须带错误码，实际 {env}"
    );
    assert!(
        !env["summary"].as_str().unwrap_or_default().is_empty(),
        "{why}：拒绝必须带一句人能看懂的话，实际 {env}"
    );
    env
}

fn tools(svc: Arc<dyn VpnToolServices>) -> Vec<Box<dyn Tool>> {
    crate::tools::vpn_tools(svc)
}

fn tool<'a>(tools: &'a [Box<dyn Tool>], name: &str) -> &'a dyn Tool {
    tools
        .iter()
        .find(|tool| tool.name() == name)
        .map(|tool| tool.as_ref())
        .unwrap_or_else(|| panic!("找不到工具 {name}"))
}

fn names(tools: &[Box<dyn Tool>]) -> Vec<String> {
    tools.iter().map(|t| t.name().to_string()).collect()
}

// ---------- 1. 全工具垃圾输入扫荡 ----------

/// 模型返回的东西什么样都可能。这里对**每一个已注册工具**喂一组畸形输入，
/// 只要求一件事：返回结构化信封，不许 panic、不许静默成功。
#[tokio::test]
async fn every_tool_survives_garbage_input() {
    let (svc, _) = FakeServices::new();
    let all = tools(svc);
    assert!(all.len() >= 20, "工具清单比预期少：{}", all.len());

    let garbage = vec![
        json!(null),
        json!([]),
        json!([1, 2, 3]),
        json!("不是对象"),
        json!(42),
        json!(true),
        json!({}),
        json!({ "foo": "bar", "baz": [1, 2, 3] }),
        json!({ "config_id": null, "node_id": null }),
        json!({ "config_id": [], "node_id": {} }),
    ];

    for name in names(&all) {
        // AskUserQuestion 是 Claurst 自带的工具，不经过我们的信封，单独对待。
        if name == "AskUserQuestion" {
            for input in &garbage {
                let _ = tool(&all, &name).execute(input.clone(), &context()).await;
            }
            continue;
        }
        for input in &garbage {
            let result = tool(&all, &name).execute(input.clone(), &context()).await;
            // 这里不能调用 `envelope()` 里的断言以外的东西——只要不 panic 就说明过了最硬的一条。
            let env = envelope(&result);
            // 盯文档字面量，而不是常量自己：常量漏改时这条才会红。
            assert_eq!(
                env["contract_version"], "3.28.0",
                "{name} 的信封契约版本不对：{env}"
            );
            assert!(
                env["ok"].is_boolean(),
                "{name} 的 ok 不是布尔：{env}"
            );
        }
    }
}

// ---------- 2. 必填参数：缺失 / 类型错 ----------

#[tokio::test]
async fn required_fields_must_be_present_and_strings() {
    let (svc, rec) = FakeServices::new();
    let all = tools(svc);

    // (工具名, 必填字段, 一份「只有其他字段」的合法底稿)
    let cases: &[(&str, &str, Value)] = &[
        ("ConfigUpdate", "config_id", json!({})),
        ("NodeSwitch", "config_id", json!({ "node_id": "nod_1" })),
        ("NodeProbe", "node_id", json!({})),
        ("NodeImport", "source", json!({})),
        ("JobGet", "job_id", json!({})),
    ];

    for (name, field, base) in cases {
        // 完全不给
        rec.take();
        expect_rejected(tool(&all, name), base.clone(), &format!("{name} 缺 {field}")).await;
        assert!(
            rec.take().is_empty(),
            "{name} 在缺 {field} 时不应调用服务层"
        );

        // 给了但类型错
        for wrong in [json!(123), json!(null), json!([]), json!({}), json!(true)] {
            rec.take();
            let mut input = base.clone();
            input[field] = wrong.clone();
            expect_rejected(
                tool(&all, name),
                input,
                &format!("{name} 的 {field} 给了 {}", wrong),
            )
            .await;
            assert!(
                rec.take().is_empty(),
                "{name} 在 {field} 类型错（{}）时仍然调用了服务层",
                wrong
            );
        }
    }
}

#[tokio::test]
async fn node_import_manual_requires_all_five_fields() {
    let (svc, rec) = FakeServices::new();
    let all = tools(svc);

    let valid = json!({
        "source": "manual",
        "name": "东京", "server": "198.51.100.20", "port": 8388,
        "password": "pw", "method": "aes-256-gcm"
    });
    for field in ["name", "server", "port", "password", "method"] {
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove(field);
        rec.take();
        expect_rejected(
            tool(&all, "NodeImport"),
            missing,
            &format!("NodeImport 缺 {field}"),
        )
        .await;
        assert!(rec.take().is_empty(), "缺 {field} 时不应调用服务层");
    }

    // port 给了字符串：不能当成数字用
    let mut wrong_port = valid.clone();
    wrong_port["port"] = json!("8388");
    rec.take();
    expect_rejected(
        tool(&all, "NodeImport"),
        wrong_port,
        "NodeImport 的 port 是字符串",
    )
    .await;
    assert!(rec.take().is_empty(), "port 类型错时不应调用服务层");
}

#[tokio::test]
async fn net_repair_and_route_set_mode_require_their_enums() {
    let (svc, rec) = FakeServices::new();
    let all = tools(svc);

    for (name, field) in [("NetRepair", "action"), ("RouteSetMode", "mode")] {
        rec.take();
        expect_rejected(tool(&all, name), json!({}), &format!("{name} 缺 {field}")).await;
        assert!(rec.take().is_empty(), "{name} 缺 {field} 时不应调用服务层");

        rec.take();
        expect_rejected(
            tool(&all, name),
            json!({ field: 42 }),
            &format!("{name} 的 {field} 是数字"),
        )
        .await;
        assert!(rec.take().is_empty(), "{name} 的 {field} 类型错时不应调用服务层");
    }
}

// ---------- 3. 超长与恶意字符串 ----------

/// 10 万字符的字段值。工具层不负责截断业务字段（那是服务层的事），
/// 但**绝不能因此 panic 或超时**，并且必须照常返回结构化信封。
#[tokio::test]
async fn oversized_strings_do_not_break_the_envelope() {
    let huge = "A".repeat(100_000);
    let (svc, _) = FakeServices::new();
    let all = tools(svc);

    let cases: &[(&str, Value)] = &[
        ("ConfigDetail", json!({ "config_id": huge })),
        ("ConfigUpdate", json!({ "config_id": huge })),
        ("NodeImport", json!({ "source": "url", "url": huge })),
        ("JobGet", json!({ "job_id": huge })),
        ("RouteGet", json!({ "config_id": huge })),
    ];

    for (name, input) in cases {
        let result = tool(&all, name).execute(input.clone(), &context()).await;
        let env = envelope(&result);
        assert!(
            env["ok"].is_boolean(),
            "{name} 遇到 10 万字符输入时没有返回正常信封：{env}"
        );
    }
}

/// 名字字段里塞路径穿越与控制字符。工具层不做路径拼接，所以这里只要求
/// 「不崩、结构化返回」——真正的拦截在服务层与文件系统层。
#[tokio::test]
async fn path_traversal_and_control_characters_do_not_panic() {
    let (svc, _) = FakeServices::new();
    let all = tools(svc);

    let nasty = [
        "../../etc/passwd",
        "..\\..\\windows\\system32",
        "/etc/passwd\u{0}",
        "名字\u{7}\u{1b}[31m",
        "\u{202e}gnp.exe",
        ".",
        "..",
        "",
    ];

    for value in nasty {
        {
            let input = json!({
                "source": "manual",
                "name": value, "server": "198.51.100.20", "port": 8388,
                "password": "pw", "method": "aes-256-gcm"
            });
            let name = "NodeImport";
            let result = tool(&all, name).execute(input, &context()).await;
            let env = envelope(&result);
            assert!(
                env["ok"].is_boolean(),
                "{name} 遇到 {value:?} 时没有返回正常信封"
            );
        }
    }
}

// ---------- 4. 可选字段给错类型 ----------

/// 可选字段给错类型**不该**被静默当成「没给」。
///
/// **可选字符串参数**的类型错误不能被当成「没给」。
///
/// 这条测试**从各工具的 schema 推导要测哪些字段**，不是手写列表——
/// 上一版手写了四个工具，结果漏掉了 `RouteSetMode`，而它的后果和
/// `VpnConnect` 一样严重：用户指定配置 A、传了错类型，实际改的是配置 B。
///
/// 新增一个带可选字符串参数的工具时，这条会直接红，逼着补 `base_input` 与实现。
#[tokio::test]
async fn wrong_typed_optional_strings_are_not_silently_ignored() {
    let (svc, rec) = FakeServices::new();
    let all = tools(svc);

    let mut covered = 0usize;
    for entry in all.iter() {
        let name = entry.name();
        for field in optional_string_params(&entry.input_schema()) {
            let base = base_input(name).unwrap_or_else(|| {
                panic!("工具 {name} 有可选字符串参数 {field}，但测试没有它的最小输入；请在 base_input 里补一条")
            });

            for wrong in [json!(123), json!([]), json!({}), json!(true)] {
                let mut input = base.clone();
                input[&field] = wrong.clone();
                rec.take();
                let (is_error, env) = run(tool(&all, name), input).await;
                let calls = rec.take();

                assert!(
                    is_error,
                    "{name}.{field}={wrong} 应当拒绝，实际 {env}"
                );
                assert!(
                    calls.is_empty(),
                    "{name}.{field}={wrong} 仍然调用了服务层（{calls:?}）\
                     ——错类型被当成「没给」，会落到另一套配置上"
                );
            }
            covered += 1;
        }
    }

    assert!(
        covered >= 5,
        "可选字符串参数至少覆盖 VpnConnect / NodeImport / RouteGet / RouteSetMode，实际 {covered} 个"
    );
}

/// schema 里「类型是 string 且不在 required 里」的属性。
fn optional_string_params(schema: &Value) -> Vec<String> {
    let required: Vec<&str> = schema["required"]
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_str()).collect())
        .unwrap_or_default();
    schema["properties"]
        .as_object()
        .map(|props| {
            props
                .iter()
                .filter(|(key, value)| {
                    value["type"] == json!("string") && !required.contains(&key.as_str())
                })
                .map(|(key, _)| key.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// 每个「有可选字符串参数」的工具的最小合法输入。
fn base_input(name: &str) -> Option<Value> {
    let value = match name {
        "VpnConnect" | "RouteGet" | "RuntimeLogs" | "CatalogSearch" => json!({}),
        // 问题墙的检索参数全部可选，最小输入是空对象。
        "read_public_issue_wall" => json!({}),
        "IssueReport" => json!({}),
        "CoreUpgrade" => json!({}),
        "ConfigSetMode" => json!({ "mode": "tun" }),
        "OpenSettings" => json!({ "section": "connection" }),
        "StageSelect" => json!({ "region": "tyo" }),
        "RouteSetMode" => json!({ "mode": "proxy_all" }),
        "NodeImport" => json!({ "source": "url", "url": "https://example.com/sub" }),
        "ConfigUpdate" => json!({ "config_id": "cfg_1" }),
        // config_id 可选（3.21.4）：最小输入就是空对象。
        "ConfigDetail" => json!({}),
        _ => return None,
    };
    Some(value)
}

// ---------- 5. 主路径 ----------

/// 每个有必填参数的工具，给一份合法输入必须走到服务层并返回 ok。
#[tokio::test]
async fn valid_input_reaches_the_service_and_succeeds() {
    let (svc, rec) = FakeServices::new();
    let all = tools(svc);

    let cases: &[(&str, Value, &str)] = &[
        ("ConfigDetail", json!({ "config_id": "cfg_1" }), "config_detail(cfg_1)"),
        ("ConfigDetail", json!({}), "config_detail(active)"),
        ("NodeSwitch", json!({ "config_id": "cfg_1", "node_id": "nod_1" }), "node_switch(cfg_1,nod_1)"),
        ("NodeProbe", json!({ "node_id": "nod_1" }), "node_probe(nod_1)"),
        ("NodeImport", json!({ "source": "url", "url": "https://example.com/sub" }), "node_import_url(None,23chars)"),
        ("JobGet", json!({ "job_id": "job_1" }), "job_get(job_1)"),
        ("VpnConnect", json!({ "config_id": "cfg_1" }), "vpn_connect(Some(\"cfg_1\"))"),
    ];

    for (name, input, expected_call) in cases {
        rec.take();
        let (is_error, env) = run(tool(&all, name), input.clone()).await;
        assert!(!is_error, "{name} 的合法输入应当成功，实际 {env}");
        assert_eq!(env["ok"], true, "{name}：{env}");
        let calls = rec.take();
        assert_eq!(
            calls,
            vec![expected_call.to_string()],
            "{name} 应当把参数原样交给服务层"
        );
    }
}

/// 收集阶段也要带两个动作：AI 写报告失败时按钮仍可用。
#[tokio::test]
async fn issue_report_shows_actions_while_collecting() {
    let (svc, _rec) = FakeServices::with_data(json!({
        "report_id": "rpt-1",
        "report_dir": "~/Desktop/Veyl 问题报告/2026-11-12-1530",
        "phase": "collected",
        "files": [],
        "redactions": {},
        "ai_report": false
    }));
    let all = tools(svc);
    const SESSION: &str = "boundary-issue-report";
    let (is_error, env) = run_in_session(tool(&all, "IssueReport"), json!({}), SESSION).await;
    assert!(!is_error, "{env}");
    // display 不在给模型的信封里，从进程内结果登记表取（用本用例专属的会话 id）。
    let outcome = crate::tools::envelope::take_outcome(SESSION, "IssueReport")
        .expect("工具结果应当已登记");
    let actions = outcome.display.actions;
    assert_eq!(actions.len(), 2);
    match &actions[0] {
        crate::tools::DisplayAction::RevealReportDir { report_id } => {
            assert_eq!(report_id, "rpt-1")
        }
        other => panic!("第一个动作不对：{other:?}"),
    }
    match &actions[1] {
        crate::tools::DisplayAction::ComposeReportMail { report_id } => {
            assert_eq!(report_id, "rpt-1")
        }
        other => panic!("第二个动作不对：{other:?}"),
    }
    let rendered = serde_json::to_string(&actions).unwrap();
    assert!(!rendered.contains('/'), "动作里不能带路径：{rendered}");
}

/// 等到工具弹出确认卡再回答。用于验证「确认前不产生任何副作用」。
async fn answer_when_asked(session: &str, answer: &str) {
    for _ in 0..500 {
        let pending = crate::agent::questions::list_pending(session);
        if let Some(id) = pending["questions"]
            .as_array()
            .and_then(|items| items.first())
            .and_then(|question| question["question_id"].as_str())
        {
            crate::agent::questions::reply(session, id, answer).unwrap();
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    panic!("没有等到确认卡");
}

fn mode_service_data() -> Value {
    json!({
        "active_config_id": "cfg_1",
        "state": "running",
        "config_id": "cfg_1",
        "connect_mode": "system_proxy",
        "mode": "tun",
        "previous_mode": "system_proxy",
        "changed": true,
        "connected": true,
        "restored": true,
        "confirmation": "accepted",
    })
}

/// 已连接时用户取消：不执行、不改库（服务层一次都不能被调用）。
#[tokio::test]
async fn config_set_mode_cancelled_never_reaches_the_service() {
    let (svc, rec) = FakeServices::with_data(mode_service_data());
    let all = tools(svc);
    const SESSION: &str = "boundary-mode-cancel";
    const REQUEST: &str = "req_mode_cancel";
    crate::tools::policy::set_current_request(SESSION, REQUEST);

    let mut ctx = context();
    ctx.session_id = SESSION.to_string();
    let (result, ()) = tokio::join!(
        tool(&all, "ConfigSetMode").execute(json!({ "config_id": "cfg_1", "mode": "tun" }), &ctx),
        answer_when_asked(SESSION, "取消"),
    );
    let env = envelope(&result);
    assert!(result.is_error, "{env}");
    assert_eq!(env["error"]["code"], "CANCELLED", "{env}");
    let calls = rec.take();
    assert!(
        calls.iter().all(|call| !call.ends_with(",true)")),
        "取消后不能带着确认再调一次：{calls:?}"
    );
    assert!(
        calls
            .iter()
            .any(|call| call.starts_with("config_set_mode") && call.ends_with(",false)")),
        "取消前应当先经过服务层的确认门禁：{calls:?}"
    );

    crate::tools::policy::clear_current_request(SESSION);
    crate::agent::questions::cleanup_request(SESSION, REQUEST);
}

/// 已连接时用户点「切换」：才把参数交给服务层。
#[tokio::test]
async fn config_set_mode_confirmed_reaches_the_service() {
    let (svc, rec) = FakeServices::with_data(mode_service_data());
    let all = tools(svc);
    const SESSION: &str = "boundary-mode-accept";
    const REQUEST: &str = "req_mode_accept";
    crate::tools::policy::set_current_request(SESSION, REQUEST);

    let mut ctx = context();
    ctx.session_id = SESSION.to_string();
    let (result, ()) = tokio::join!(
        tool(&all, "ConfigSetMode").execute(json!({ "config_id": "cfg_1", "mode": "tun" }), &ctx),
        answer_when_asked(SESSION, "切换"),
    );
    let env = envelope(&result);
    assert!(!result.is_error, "{env}");
    assert_eq!(
        rec.take().last().map(String::as_str),
        Some("config_set_mode(Some(\"cfg_1\"),tun,true)"),
        "{env}"
    );

    crate::tools::policy::clear_current_request(SESSION);
    crate::agent::questions::cleanup_request(SESSION, REQUEST);
}

/// 启动窗口（launching / starting）也必须先弹卡：不能无卡停掉正在起来的连接。
#[tokio::test]
async fn config_set_mode_asks_while_the_connection_is_starting() {
    let mut data = mode_service_data();
    data["state"] = json!("starting");
    let (svc, rec) = FakeServices::with_data(data);
    let all = tools(svc);
    const SESSION: &str = "boundary-mode-starting";
    const REQUEST: &str = "req_mode_starting";
    crate::tools::policy::set_current_request(SESSION, REQUEST);

    let mut ctx = context();
    ctx.session_id = SESSION.to_string();
    let (result, ()) = tokio::join!(
        tool(&all, "ConfigSetMode").execute(json!({ "config_id": "cfg_1", "mode": "tun" }), &ctx),
        answer_when_asked(SESSION, "取消"),
    );
    let env = envelope(&result);
    assert!(result.is_error, "{env}");
    assert_eq!(env["error"]["code"], "CANCELLED", "{env}");
    let calls = rec.take();
    assert!(
        calls.iter().all(|call| !call.ends_with(",true)")),
        "取消后不能带着确认再调一次：{calls:?}"
    );

    crate::tools::policy::clear_current_request(SESSION);
    crate::agent::questions::cleanup_request(SESSION, REQUEST);
}

/// 未连接时不弹卡：直接写库，确认卡不能拦着用户。
#[tokio::test]
async fn config_set_mode_does_not_ask_when_disconnected() {
    let mut data = mode_service_data();
    data["state"] = json!("idle");
    let (svc, rec) = FakeServices::with_data(data);
    let all = tools(svc);

    let (is_error, env) = run(
        tool(&all, "ConfigSetMode"),
        json!({ "config_id": "cfg_1", "mode": "system_proxy" }),
    )
    .await;
    assert!(!is_error, "{env}");
    assert_eq!(
        rec.take().last().map(String::as_str),
        Some("config_set_mode(Some(\"cfg_1\"),system_proxy,false)"),
        "{env}"
    );
}

/// 三个写入路径的 schema 只收两档；`proxy_selected` 已下线。
#[test]
fn routing_mode_schemas_only_allow_two_values() {
    let (svc, _rec) = FakeServices::new();
    let all = tools(svc);
    for (name, key) in [
        ("ConfigUpdate", "routing_mode"),
        ("RouteSetMode", "mode"),
    ] {
        let schema = tool(&all, name).input_schema();
        assert_eq!(
            schema["properties"][key]["enum"],
            json!(["direct", "proxy_all"]),
            "{name}"
        );
    }
}

#[tokio::test]
async fn set_user_region_is_a_write_tool_with_the_contract_shape() {    let (svc, rec) = FakeServices::with_data(json!({}));
    let all = tools(svc);
    const SESSION: &str = "boundary-set-region";

    let (is_error, env) = run_in_session(
        tool(&all, "SetUserRegion"),
        json!({ "region": "JP" }),
        SESSION,
    )
    .await;
    assert!(!is_error, "{env}");
    assert_eq!(env["data"]["region"], "jp");
    assert_eq!(env["data"]["source"], "ai");
    assert_eq!(rec.take(), vec!["set_user_region(JP)"]);
    assert_eq!(permission_level_of(&all, "SetUserRegion"), "write");

    let outcome = crate::tools::envelope::take_outcome(SESSION, "SetUserRegion")
        .expect("工具结果应当已登记");
    assert_eq!(
        outcome.display.facts,
        vec![crate::tools::Fact::with_params(
            crate::tools::FactKey::RegionCode,
            json!({ "code": "jp", "label": "Japan" })
        )]
    );
    assert_eq!(outcome.display.changed, crate::tools::Changed::None);
}

/// 设备身份 / 会话过期：MyServers 必须要求登录，不能拿空列表冒充。
#[tokio::test]
async fn my_servers_requires_a_logged_in_account() {
    use crate::control_plane::auth;
    let _guard = crate::test_support::AUTH_STATE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    crate::test_support::install_test_secrets();
    auth::clear_tokens_for_test();
    auth::store_device_for_test("dev_boundary");

    let (svc, _rec) = FakeServices::new();
    let all = tools(svc);

    // 匿名设备身份不是登录态。
    let device_tokens = auth::TokenSet {
        account_id: "acct_dev".into(),
        device_id: "dev_boundary".into(),
        access_token: "access".into(),
        access_expires_at: "2099-01-01T00:00:00Z".into(),
        refresh_token: "refresh".into(),
        refresh_expires_at: "2099-01-01T00:00:00Z".into(),
        account_kind: "device".into(),
        email: None,
    };
    auth::store_tokens_for_test(&device_tokens);
    let (is_error, env) = run(tool(&all, "MyServers"), json!({})).await;
    assert!(is_error, "{env}");
    assert_eq!(env["error"]["code"], "PRECONDITION_FAILED");
    assert_eq!(env["error"]["details"]["reason"], "auth_required");

    // 邮箱会话过期同样拦。
    let expired = auth::TokenSet {
        account_kind: "email".into(),
        email: Some("a@example.com".into()),
        refresh_expires_at: "2020-01-01T00:00:00Z".into(),
        ..device_tokens
    };
    auth::store_tokens_for_test(&expired);
    let (is_error, env) = run(tool(&all, "MyServers"), json!({})).await;
    assert!(is_error, "{env}");
    assert_eq!(env["error"]["details"]["reason"], "auth_required");

    auth::clear_tokens_for_test();
}

#[tokio::test]
async fn node_import_text_reports_imported_and_skipped() {
    let (svc, rec) = FakeServices::with_data(json!({
        "imported": 2,
        "skipped": [
            { "name": "B", "reason": "unsupported_method" },
            { "name": null, "reason": "malformed" }
        ],
        "nodes": [
            { "name": "A", "server": "203.0.113.10", "port": 8388, "method": "aes-256-gcm" },
            { "name": "C", "server": "203.0.113.12", "port": 8388, "method": "chacha20-ietf-poly1305" }
        ]
    }));
    let all = tools(svc);
    let text = "ss://aes-256-gcm:pw@203.0.113.10:8388#A\n\
                坏行\n\
                ss://chacha20-ietf-poly1305:pw@203.0.113.12:8388#C";

    rec.take();
    let (is_error, env) = run(
        tool(&all, "NodeImport"),
        json!({ "source": "text", "text": text }),
    )
    .await;
    assert!(!is_error, "{env}");
    assert_eq!(env["ok"], true);
    assert_eq!(env["data"]["imported"], 2);
    let content = env["summary"].as_str().unwrap_or_default();
    assert!(content.contains("导入 2 个节点，跳过 2 个"), "{env}");
    // content 必须自足：模型只看得到它，逐节点一行 + 跳过原因汇总。
    assert!(
        content.contains("- A | 203.0.113.10:8388 | aes-256-gcm"),
        "content 缺逐节点行：{content}"
    );
    assert!(
        content.contains("- C | 203.0.113.12:8388 | chacha20-ietf-poly1305"),
        "content 缺逐节点行：{content}"
    );
    assert!(
        content.contains("跳过原因：malformed × 1、unsupported_method × 1。"),
        "content 缺跳过原因汇总：{content}"
    );
    assert_eq!(
        rec.take(),
        vec![format!("node_import_text(None,{}chars)", text.chars().count())]
    );
}

/// 整段都解析不出节点时必须是结构化错误，不能当成「导入 0 个」的成功。
#[tokio::test]
async fn node_import_text_rejects_unusable_text() {
    let (svc, rec) = FakeServices::with_text_error("INVALID_ARGUMENT");
    let all = tools(svc);

    rec.take();
    let (is_error, env) = run(
        tool(&all, "NodeImport"),
        json!({ "source": "text", "text": "hello" }),
    )
    .await;
    assert!(is_error, "{env}");
    assert_eq!(env["error"]["code"], "INVALID_ARGUMENT");
    assert_eq!(
        env["error"]["message"],
        "粘贴的内容里没有可用的节点（支持多行 ss:// 链接）"
    );
    assert_eq!(rec.take(), vec!["node_import_text(None,5chars)".to_string()]);
}

/// 写操作：不能是只读。
#[test]
fn node_import_is_a_write_tool() {
    let (svc, _) = FakeServices::new();
    let all = tools(svc);
    assert_eq!(permission_level_of(&all, "NodeImport"), "write");
}

#[tokio::test]
async fn node_import_manual_passes_parsed_fields() {
    let (svc, rec) = FakeServices::new();
    let all = tools(svc);

    rec.take();
    let (is_error, env) = run(
        tool(&all, "NodeImport"),
        json!({
            "source": "manual",
            "name": "东京", "server": "198.51.100.20", "port": 8388,
            "password": "pw", "method": "aes-256-gcm"
        }),
    )
    .await;
    assert!(!is_error, "{env}");
    // 手动来源给一行节点摘要；密码永不出现在 content。
    let content = env["summary"].as_str().unwrap_or_default();
    assert!(
        content.contains("节点「东京」已创建：198.51.100.20:8388 | aes-256-gcm"),
        "{content}"
    );
    assert!(!content.contains("pw"), "content 不能带密码：{content}");
    assert_eq!(
        rec.take(),
        vec!["node_create(None,name=东京,server=198.51.100.20,port=8388)"]
    );
}

/// `NodeImport` 按 `source` 路由到三条既有服务路径；缺来源专属字段要指名报错；
/// schema 仍只要求 `source` 且拒绝多余字段。
#[tokio::test]
async fn node_import_dispatches_by_source() {
    let (svc, rec) = FakeServices::new();
    let all = tools(svc);
    let text = "ss://aes-256-gcm:pw@203.0.113.10:8388#A";

    let cases: &[(Value, String)] = &[
        (
            json!({ "source": "url", "url": "https://example.com/sub" }),
            "node_import_url(None,23chars)".to_string(),
        ),
        (
            json!({ "source": "text", "text": text }),
            format!("node_import_text(None,{}chars)", text.chars().count()),
        ),
        (
            json!({
                "source": "manual",
                "name": "东京", "server": "198.51.100.20", "port": 8388,
                "password": "pw", "method": "aes-256-gcm"
            }),
            "node_create(None,name=东京,server=198.51.100.20,port=8388)".to_string(),
        ),
    ];
    for (input, expected) in cases {
        rec.take();
        let (is_error, env) = run(tool(&all, "NodeImport"), input.clone()).await;
        assert!(!is_error, "{input} 应当成功，实际 {env}");
        assert_eq!(env["ok"], true, "{input}：{env}");
        assert_eq!(rec.take(), vec![expected.clone()], "{input} 没有走到对应服务");
    }

    // 缺来源专属字段：指名道姓地拒绝，不调用服务层。
    for (input, field) in [
        (json!({ "source": "url" }), "url"),
        (json!({ "source": "text" }), "text"),
        (
            json!({
                "source": "manual",
                "name": "东京", "server": "198.51.100.20", "port": 8388,
                "password": "pw"
            }),
            "method",
        ),
    ] {
        rec.take();
        let source = input["source"].as_str().unwrap_or_default();
        let env = expect_rejected(
            tool(&all, "NodeImport"),
            input.clone(),
            &format!("NodeImport 缺 {field}"),
        )
        .await;
        assert_eq!(env["error"]["code"], "INVALID_ARGUMENT", "{env}");
        assert!(
            env["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains(field),
            "错误信息要点名缺的字段 {field}：{env}"
        );
        assert_eq!(
            env["error"]["details"],
            json!({ "reason": "missing_source_field", "source": source, "field": field }),
            "{env}"
        );
        assert!(rec.take().is_empty(), "缺 {field} 时不应调用服务层");
    }

    // 来源专属字段串了来源：按 unknown_argument 拒绝，不静默忽略。
    for input in [
        json!({ "source": "url", "url": "https://example.com/sub", "password": "pw" }),
        json!({ "source": "text", "text": text, "name": "东京" }),
        json!({
            "source": "manual",
            "name": "东京", "server": "198.51.100.20", "port": 8388,
            "password": "pw", "method": "aes-256-gcm", "url": "https://example.com/sub"
        }),
    ] {
        rec.take();
        let env = expect_rejected(tool(&all, "NodeImport"), input.clone(), "串来源字段").await;
        assert_eq!(
            env["error"]["details"]["reason"], "unknown_argument",
            "{env}"
        );
        assert!(rec.take().is_empty(), "串来源字段时不应调用服务层");
    }

    // 未知 source：拒绝，不调用服务层。
    rec.take();
    let env = expect_rejected(
        tool(&all, "NodeImport"),
        json!({ "source": "ftp" }),
        "未知 source",
    )
    .await;
    assert_eq!(
        env["error"]["details"]["reason"], "invalid_argument",
        "{env}"
    );
    assert!(rec.take().is_empty(), "未知 source 不应调用服务层");

    // source 类型错：说「必须是字符串」，不能和「缺少 source」混为一谈。
    let env = expect_rejected(
        tool(&all, "NodeImport"),
        json!({ "source": 42 }),
        "source 类型错",
    )
    .await;
    assert!(
        env["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("字符串"),
        "{env}"
    );

    // schema：只有 source 必填，多余字段仍然被拒。
    let schema = tool(&all, "NodeImport").input_schema();
    assert_eq!(schema["required"], json!(["source"]));
    assert_eq!(schema["additionalProperties"], false);
}

/// `config_id` 在三种来源下都要透传给服务层。
#[tokio::test]
async fn node_import_passes_config_id_for_every_source() {
    let (svc, rec) = FakeServices::new();
    let all = tools(svc);
    let text = "ss://aes-256-gcm:pw@203.0.113.10:8388#A";

    let cases: &[(Value, String)] = &[
        (
            json!({ "source": "url", "url": "https://example.com/sub", "config_id": "cfg_1" }),
            "node_import_url(Some(\"cfg_1\"),23chars)".to_string(),
        ),
        (
            json!({ "source": "text", "text": text, "config_id": "cfg_1" }),
            format!(
                "node_import_text(Some(\"cfg_1\"),{}chars)",
                text.chars().count()
            ),
        ),
        (
            json!({
                "source": "manual",
                "name": "东京", "server": "198.51.100.20", "port": 8388,
                "password": "pw", "method": "aes-256-gcm", "config_id": "cfg_1"
            }),
            "node_create(Some(\"cfg_1\"),name=东京,server=198.51.100.20,port=8388)".to_string(),
        ),
    ];
    for (input, expected) in cases {
        rec.take();
        let (is_error, env) = run(tool(&all, "NodeImport"), input.clone()).await;
        assert!(!is_error, "{input} 应当成功，实际 {env}");
        assert_eq!(
            rec.take(),
            vec![expected.clone()],
            "{input} 没有把 config_id 透传给服务层"
        );
    }
}

/// 无参数工具也要能正常跑通，并且**不接受**多余参数导致崩。
#[tokio::test]
async fn zero_argument_tools_work() {
    let (svc, _) = FakeServices::new();
    let all = tools(svc);

    for name in [
        "RuntimeStatus",
        "RuntimeStop",
        "VpnDisconnect",
        "NetConfigGet",
        "RouteGet",
        "DefaultProfileStatus",
        "CoreListVersions",
    ] {
        let (is_error, env) = run(tool(&all, name), json!({})).await;
        assert!(!is_error, "{name} 无参数调用应当成功，实际 {env}");
        assert_eq!(env["ok"], true, "{name}：{env}");
    }
}

/// 服务层失败时必须转成结构化错误并带下一步动作，而不是把错误原样抛给模型。
#[tokio::test]
async fn service_failure_becomes_a_structured_error_with_next_actions() {
    struct Boom;
    #[async_trait]
    impl VpnToolServices for Boom {
        async fn runtime_status(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn runtime_start(&self, _: Option<String>) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn runtime_stop(&self, _: bool) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn runtime_restart(&self, _: Option<String>) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn runtime_logs(&self, _: u32, _: Option<String>) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn core_list_versions(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn core_info(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn core_check_updates(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn core_upgrade(&self, _: &str, _: &str, _: Option<&str>) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn core_cancel_upgrade(&self, _: &str) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn core_rollback(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn tun_helper_info(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn tun_helper_restart(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        #[cfg(debug_assertions)]
        async fn tun_probe(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn catalog_search(&self, _: CatalogQuery) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn config_list(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn config_detail(&self, _: Option<String>) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn config_create(&self, _: ConfigCreateInput) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn config_update(&self, _: &str, _: ConfigUpdateInput) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn config_delete(&self, _: &str) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn config_activate(&self, _: &str) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn node_import_url(&self, _: Option<String>, _: &str) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn node_import_text(&self, _: Option<String>, _: &str) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn node_create(&self, _: NodeCreateInput) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn node_switch(&self, _: &str, _: &str) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn node_probe(&self, _: &str) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn default_profile_status(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn default_profile_refresh(&self, _: bool) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn import_seed_file(&self, _: &str) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn rules_status(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn category_list(&self, _: Option<String>, _: Option<u32>) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn route_get(&self, _: Option<String>) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn route_set_mode(
            &self,
            _: Option<String>,
            _: &str,
            _: bool,
        ) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn route_targets_set(&self, _: &str, _: Vec<String>) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn net_config_get(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn net_repair(&self, _: &str, _: Option<u16>) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn network_force_reset(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn vpn_connect(&self, _: Option<String>) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn vpn_disconnect(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn diag_run(&self, _: bool) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn save_deepseek_key(&self, _: &str) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn job_get(&self, _: &str) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
    }

    let all = tools(Arc::new(Boom));
    for name in ["VpnConnect", "CatalogSearch", "RuntimeStatus", "DiagRun"] {
        let (is_error, env) = run(tool(&all, name), json!({})).await;
        assert!(is_error, "{name} 服务失败时必须是错误信封，实际 {env}");
        assert!(!env["error"]["code"].as_str().unwrap_or_default().is_empty());
        assert!(
            env["summary"].as_str().unwrap_or_default().contains("磁盘满了"),
            "{name} 的错误摘要里要带上服务层的原话，实际 {env}"
        );
        assert!(
            env["next_actions"].is_array(),
            "{name} 的 next_actions 必须是数组"
        );
    }
}

/// `MyServerFailure`：结构化失败给卡片事实，`log_available` 原样透出 false。
#[tokio::test]
async fn my_server_failure_returns_failure_facts_without_logs() {
    let (svc, _rec) = FakeServices::with_data(json!({
        "server_id": "srv_1",
        "name": "东京",
        "region": "东京",
        "plan": "入门",
        "state": "error",
        "failure": {
            "stage": "installing",
            "code": "install_failed",
            "message": "装环境失败",
            "retryable": true
        },
        "order": {
            "order_id": "ord_1",
            "state": "failed",
            "failure": { "code": "install_failed", "message": "装环境失败", "retryable": true }
        },
        "recent_events": [
            { "at": "2026-11-16T00:00:02Z", "state": "failed", "detail": "装环境失败" },
            { "at": "2026-11-16T00:00:01Z", "state": "provisioning", "detail": null }
        ],
        "log_available": false
    }));
    let all = tools(svc);
    const SESSION: &str = "boundary-failure-ok";
    let (is_error, env) =
        run_in_session(tool(&all, "MyServerFailure"), json!({ "serverId": "srv_1" }), SESSION).await;
    assert!(!is_error, "{env}");
    assert_eq!(env["data"]["log_available"], false);
    assert_eq!(env["data"]["failure"]["stage"], "installing");

    let outcome = crate::tools::envelope::take_outcome(SESSION, "MyServerFailure")
        .expect("工具结果必须登记到进程内注册表");
    assert!(outcome
        .display
        .facts
        .contains(&crate::tools::Fact::with_params(
            crate::tools::FactKey::ServerStage,
            json!({ "stage": "installing" })
        )));
    assert!(outcome
        .display
        .facts
        .iter()
        .any(|fact| fact.key == crate::tools::FactKey::ServerFailureCode));
    assert!(outcome
        .display
        .facts
        .contains(&crate::tools::Fact::with_params(
            crate::tools::FactKey::ServerRetryable,
            json!({ "value": "yes" })
        )));
}

/// 健康服务器没有失败记录：`failure`/`order` 为 null 也是合法成功。
#[tokio::test]
async fn my_server_failure_accepts_a_healthy_server_without_records() {
    let (svc, _rec) = FakeServices::with_data(json!({
        "server_id": "srv_2",
        "name": "新加坡",
        "region": "新加坡",
        "plan": "入门",
        "state": "healthy",
        "failure": Value::Null,
        "order": Value::Null,
        "recent_events": [],
        "log_available": false
    }));
    let all = tools(svc);
    const SESSION: &str = "boundary-failure-none";
    let (is_error, env) =
        run_in_session(tool(&all, "MyServerFailure"), json!({ "serverId": "srv_2" }), SESSION).await;
    assert!(!is_error, "{env}");
    assert!(env["data"]["failure"].is_null());
    assert!(env["data"]["order"].is_null());
    assert!(env["data"]["recent_events"].as_array().unwrap().is_empty());
    assert_eq!(env["data"]["log_available"], false);
}

/// `state = error` 但 `failure = null`：只能说记录不完整，不能说「没有失败」。
#[tokio::test]
async fn my_server_failure_says_records_are_incomplete_for_an_error_without_failure() {
    let (svc, _rec) = FakeServices::with_data(json!({
        "server_id": "srv_3",
        "name": "东京",
        "region": "东京",
        "plan": "入门",
        "state": "error",
        "failure": Value::Null,
        "order": Value::Null,
        "recent_events": [],
        "log_available": false
    }));
    let all = tools(svc);
    const SESSION: &str = "boundary-failure-incomplete";
    let (is_error, env) =
        run_in_session(tool(&all, "MyServerFailure"), json!({ "serverId": "srv_3" }), SESSION).await;
    assert!(!is_error, "{env}");
    let summary = env["summary"].as_str().unwrap_or_default();
    assert!(
        summary.contains("记录不完整，建议重建或联系支持"),
        "error + null 必须说记录不完整：{summary}"
    );
    assert!(
        !summary.contains("没有失败"),
        "不能把 failure=null 说成「没有失败」：{summary}"
    );
}

/// 工具层的参数边界：缺 serverId、空字符串、多传字段都必须结构化拒绝。
#[tokio::test]
async fn my_server_failure_rejects_bad_input() {
    let (svc, _rec) = FakeServices::new();
    let all = tools(svc);
    let tool = tool(&all, "MyServerFailure");
    for input in [
        json!({}),
        json!({ "serverId": "" }),
        json!({ "serverId": "srv_1", "orderId": "ord_1" }),
    ] {
        let env = expect_rejected(tool, input, "MyServerFailure 只能接受非空 serverId").await;
        assert_eq!(env["error"]["code"], "INVALID_ARGUMENT");
    }
}

/// 幂等切换（点的就是当前节点）：文案必须是「没变化」，不能声称未连接或下次生效。
#[tokio::test]
async fn node_switch_to_the_current_node_reads_as_unchanged() {
    let (svc, rec) = FakeServices::with_data(json!({
        "config_id": "cfg_1",
        "node_id": "nod_1",
        "previous_node_id": "nod_1",
        "connected": false,
    }));
    let all = tools(svc);
    const SESSION: &str = "boundary-node-switch-same";
    let (is_error, env) = run_in_session(
        tool(&all, "NodeSwitch"),
        json!({ "config_id": "cfg_1", "node_id": "nod_1" }),
        SESSION,
    )
    .await;
    assert!(!is_error, "{env}");
    assert_eq!(env["summary"], "当前节点没有变化。");
    // display 不在给模型的信封里：从进程内结果登记表取（用本用例专属会话 id）。
    let outcome = crate::tools::envelope::take_outcome(SESSION, "NodeSwitch")
        .expect("工具结果应当已登记");
    assert_eq!(
        outcome.display.facts,
        vec![crate::tools::Fact::with_params(
            crate::tools::FactKey::ConnectionState,
            json!({ "state": "unchanged" })
        )]
    );
    assert_eq!(rec.take(), vec!["node_switch(cfg_1,nod_1)"]);

    // 真切换（节点不同）保持原文案不变。
    let (svc, _rec) = FakeServices::with_data(json!({
        "config_id": "cfg_1",
        "node_id": "nod_2",
        "previous_node_id": "nod_1",
        "connected": false,
    }));
    let all = tools(svc);
    const SESSION2: &str = "boundary-node-switch-diff";
    let (is_error, env) = run_in_session(
        tool(&all, "NodeSwitch"),
        json!({ "config_id": "cfg_1", "node_id": "nod_2" }),
        SESSION2,
    )
    .await;
    assert!(!is_error, "{env}");
    assert_eq!(env["summary"], "已切换当前节点（未连接，未启动 VPN）。");
    let outcome = crate::tools::envelope::take_outcome(SESSION2, "NodeSwitch")
        .expect("工具结果应当已登记");
    assert_eq!(
        outcome.display.facts,
        vec![crate::tools::Fact::new(
            crate::tools::FactKey::EffectNextConnect
        )]
    );
}

/// `DiagRun` 的模型可见文字必须逐项列出 `checks`：状态、实测值与建议都落在
/// `summary`（即 `content`）里，模型不用去读它看不到的 `data`。
#[tokio::test]
async fn diag_run_writes_every_check_into_the_model_visible_summary() {
    let (svc, _rec) = FakeServices::with_data(json!({
        "checks": [
            {
                "name": "system.dns",
                "group": "system",
                "status": "failed",
                "ok": false,
                "detail": "3 个解析器，example.com 无法解析",
                "remediation": "刷新 DNS 缓存后重试",
                "action": { "kind": "flush_dns" }
            },
            {
                "name": "app.process_alive",
                "group": "app",
                "status": "ok",
                "ok": true,
                "detail": "进程在运行",
                "remediation": null,
                "action": null
            },
            {
                "name": "app.clash_api",
                "group": "app",
                "status": "skipped",
                "ok": false,
                "detail": "未连接",
                "remediation": null,
                "action": null
            }
        ]
    }));
    let all = tools(svc);
    let (is_error, env) = run(tool(&all, "DiagRun"), json!({})).await;
    assert!(!is_error, "{env}");
    let summary = env["summary"].as_str().unwrap_or_default();
    assert!(
        summary.contains("诊断完成：共 3 项检查，1 项未通过，1 项没检查。"),
        "{summary}"
    );
    assert!(
        summary.contains("- DNS：失败 —— 3 个解析器，example.com 无法解析 → 刷新 DNS 缓存后重试"),
        "{summary}"
    );
    assert!(
        summary.contains("- 后台进程：正常 —— 进程在运行"),
        "{summary}"
    );
    assert!(summary.contains("- 控制面：没检查（未连接）"), "{summary}");
    assert!(
        summary.contains("下一步：刷新 DNS 缓存后重试。"),
        "{summary}"
    );
    assert!(!summary.contains("data"), "{summary}");
    assert!(!summary.contains("checks"), "{summary}");
}

/// `DefaultProfileStatus` 的出口把试用状态带进模型可见内容：到期后不能只报缓存。
#[tokio::test]
async fn default_profile_status_carries_the_trial_state() {
    let (svc, _rec) = FakeServices::with_trial(
        json!({ "content_sha256": "abc", "node_count": 2, "checked_at": 0 }),
        json!({
            "state": "expired",
            "started_at": "2026-11-17T05:44:07Z",
            "expires_at": "2026-11-24T05:48:46Z",
            "remaining_ms": 0,
            "seed_node_count": 0
        }),
    );
    let all = tools(svc);
    let (is_error, env) = run(tool(&all, "DefaultProfileStatus"), json!({})).await;
    assert!(!is_error, "{env}");
    let summary = env["summary"].as_str().unwrap_or_default();
    assert!(summary.contains("试用已到期"), "{summary}");
    assert!(summary.contains("刷新不会加回"), "{summary}");
    assert!(summary.contains("池内免费节点 0 个"), "{summary}");
    assert!(summary.contains("缓存里 2 个"), "{summary}");
    assert!(!summary.contains("data"), "{summary}");
    assert!(!summary.contains("checks"), "{summary}");
}
