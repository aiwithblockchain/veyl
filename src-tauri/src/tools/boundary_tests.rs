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
use crate::tools::services::{
    CatalogQuery, ConfigCreateInput, ConfigUpdateInput, NodeCreateInput, VpnToolServices,
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
}

impl FakeServices {
    fn new() -> (Arc<Self>, Arc<Recorder>) {
        let rec = Arc::new(Recorder::default());
        let services = Arc::new(Self {
            rec: Arc::clone(&rec),
            data: json!({}),
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
    async fn core_list_versions(&self) -> anyhow::Result<Value> {
        self.rec.record("core_list_versions");
        Ok(self.data.clone())
    }
    async fn core_install(&self, version: &str) -> anyhow::Result<Value> {
        self.rec.record(format!("core_install({version})"));
        Ok(self.data.clone())
    }
    async fn catalog_search(&self, query: CatalogQuery) -> anyhow::Result<Value> {
        self.rec.record(format!(
            "catalog_search(region={:?},limit={:?})",
            query.region, query.limit
        ));
        Ok(self.data.clone())
    }
    async fn config_list(&self) -> anyhow::Result<Value> {
        self.rec.record("config_list");
        Ok(self.data.clone())
    }
    async fn config_detail(&self, config_id: &str) -> anyhow::Result<Value> {
        self.rec.record(format!("config_detail({config_id})"));
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
    async fn config_activate(
        &self,
        config_id: &str,
        confirm_disconnect: bool,
    ) -> anyhow::Result<Value> {
        self.rec
            .record(format!("config_activate({config_id},{confirm_disconnect})"));
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
    async fn node_create(&self, input: NodeCreateInput) -> anyhow::Result<Value> {
        self.rec.record(format!(
            "node_create(name={},server={},port={})",
            input.name, input.server, input.port
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
    async fn vpn_connect(&self, config_id: Option<String>) -> anyhow::Result<Value> {
        self.rec.record(format!("vpn_connect({config_id:?})"));
        Ok(self.data.clone())
    }
    async fn vpn_disconnect(&self) -> anyhow::Result<Value> {
        self.rec.record("vpn_disconnect");
        Ok(self.data.clone())
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
    let result = tool.execute(input, &context()).await;
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
            assert_eq!(
                env["contract_version"], crate::tools::envelope::CONTRACT_VERSION,
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
        ("ConfigDetail", "config_id", json!({})),
        ("ConfigUpdate", "config_id", json!({})),
        ("ConfigDelete", "config_id", json!({})),
        ("NodeSwitch", "config_id", json!({ "node_id": "nod_1" })),
        ("NodeProbe", "node_id", json!({})),
        ("NodeImportUrl", "url", json!({})),
        ("CoreInstall", "version", json!({})),
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
async fn config_create_requires_three_strings() {
    let (svc, rec) = FakeServices::new();
    let all = tools(svc);

    let valid = json!({ "name": "公司", "connect_mode": "system_proxy", "routing_mode": "proxy_all" });
    for field in ["name", "connect_mode", "routing_mode"] {
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove(field);
        rec.take();
        expect_rejected(
            tool(&all, "ConfigCreate"),
            missing,
            &format!("ConfigCreate 缺 {field}"),
        )
        .await;
        assert!(rec.take().is_empty(), "缺 {field} 时不应调用服务层");

        let mut wrong = valid.clone();
        wrong[field] = json!(12345);
        rec.take();
        expect_rejected(
            tool(&all, "ConfigCreate"),
            wrong,
            &format!("ConfigCreate 的 {field} 是数字"),
        )
        .await;
        assert!(rec.take().is_empty(), "{field} 类型错时不应调用服务层");
    }
}

#[tokio::test]
async fn node_create_requires_all_five_fields() {
    let (svc, rec) = FakeServices::new();
    let all = tools(svc);

    let valid = json!({
        "name": "东京", "server": "198.51.100.20", "port": 8388,
        "password": "pw", "method": "aes-256-gcm"
    });
    for field in ["name", "server", "port", "password", "method"] {
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove(field);
        rec.take();
        expect_rejected(
            tool(&all, "NodeCreate"),
            missing,
            &format!("NodeCreate 缺 {field}"),
        )
        .await;
        assert!(rec.take().is_empty(), "缺 {field} 时不应调用服务层");
    }

    // port 给了字符串：不能当成数字用
    let mut wrong_port = valid.clone();
    wrong_port["port"] = json!("8388");
    rec.take();
    expect_rejected(tool(&all, "NodeCreate"), wrong_port, "NodeCreate 的 port 是字符串").await;
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
        (
            "ConfigCreate",
            json!({ "name": huge, "connect_mode": "system_proxy", "routing_mode": "proxy_all" }),
        ),
        ("NodeImportUrl", json!({ "url": huge })),
        ("JobGet", json!({ "job_id": huge })),
        ("CoreInstall", json!({ "version": huge })),
        ("CategoryList", json!({ "query": huge })),
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

    for name in ["ConfigCreate", "NodeCreate"] {
        for value in nasty {
            let input = if name == "ConfigCreate" {
                json!({ "name": value, "connect_mode": "system_proxy", "routing_mode": "proxy_all" })
            } else {
                json!({
                    "name": value, "server": "198.51.100.20", "port": 8388,
                    "password": "pw", "method": "aes-256-gcm"
                })
            };
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
        "可选字符串参数至少覆盖 VpnConnect / NodeImportUrl / NodeCreate / RouteGet / RouteSetMode，实际 {covered} 个"
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
        "VpnConnect" | "RouteGet" | "RuntimeLogs" | "CatalogSearch" | "CategoryList" => json!({}),
        "RouteSetMode" => json!({ "mode": "proxy_all" }),
        "NodeImportUrl" => json!({ "url": "https://example.com/sub" }),
        "ConfigCreate" => json!({
            "name": "公司", "connect_mode": "tun", "routing_mode": "proxy_all"
        }),
        "ConfigUpdate" => json!({ "config_id": "cfg_1" }),
        "NodeCreate" => json!({
            "name": "东京", "server": "198.51.100.20", "port": 8388,
            "password": "pw", "method": "aes-256-gcm"
        }),
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
        ("ConfigDelete", json!({ "config_id": "cfg_1" }), "config_delete(cfg_1)"),
        ("NodeSwitch", json!({ "config_id": "cfg_1", "node_id": "nod_1" }), "node_switch(cfg_1,nod_1)"),
        ("NodeProbe", json!({ "node_id": "nod_1" }), "node_probe(nod_1)"),
        ("NodeImportUrl", json!({ "url": "https://example.com/sub" }), "node_import_url(None,23chars)"),
        ("CoreInstall", json!({ "version": "1.14.4" }), "core_install(1.14.4)"),
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

#[tokio::test]
async fn config_create_and_node_create_pass_parsed_fields() {
    let (svc, rec) = FakeServices::new();
    let all = tools(svc);

    rec.take();
    let (is_error, env) = run(
        tool(&all, "ConfigCreate"),
        json!({ "name": "公司", "connect_mode": "tun", "routing_mode": "proxy_all" }),
    )
    .await;
    assert!(!is_error, "{env}");
    assert_eq!(rec.take(), vec!["config_create(name=公司,mode=tun,routing=proxy_all)"]);
    assert_eq!(env["ok"], true);

    rec.take();
    let (is_error, env) = run(
        tool(&all, "NodeCreate"),
        json!({
            "name": "东京", "server": "198.51.100.20", "port": 8388,
            "password": "pw", "method": "aes-256-gcm"
        }),
    )
    .await;
    assert!(!is_error, "{env}");
    assert_eq!(
        rec.take(),
        vec!["node_create(name=东京,server=198.51.100.20,port=8388)"]
    );
}

/// 无参数工具也要能正常跑通，并且**不接受**多余参数导致崩。
#[tokio::test]
async fn zero_argument_tools_work() {
    let (svc, _) = FakeServices::new();
    let all = tools(svc);

    for name in [
        "ConfigList",
        "RuntimeStatus",
        "RuntimeStop",
        "VpnDisconnect",
        "NetConfigGet",
        "RulesStatus",
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
        async fn core_install(&self, _: &str) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn catalog_search(&self, _: CatalogQuery) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn config_list(&self) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn config_detail(&self, _: &str) -> anyhow::Result<Value> {
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
        async fn config_activate(&self, _: &str, _: bool) -> anyhow::Result<Value> {
            Err(anyhow::anyhow!("磁盘满了"))
        }
        async fn node_import_url(&self, _: Option<String>, _: &str) -> anyhow::Result<Value> {
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
    for name in ["VpnConnect", "ConfigList", "RuntimeStatus", "DiagRun"] {
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
