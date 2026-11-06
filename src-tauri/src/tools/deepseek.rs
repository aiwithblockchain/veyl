use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::Changed;
use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::VpnToolServices;

const DEEPSEEK_KEY_URL: &str = "https://platform.deepseek.com/api_keys";

pub struct DeepseekSetupKeyTool;

#[async_trait]
impl Tool for DeepseekSetupKeyTool {
    fn name(&self) -> &str {
        "DeepseekSetupKey"
    }

    fn description(&self) -> &str {
        "给出创建 DeepSeek API Key 的步骤。不打开浏览器，也不要代为注册或索要账号信息。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        envelope::finish(
            ctx,
            "DeepseekSetupKey",
            ToolOutcome::ok(
                "已给出获取 Key 的步骤，拿到后直接粘贴到输入框即可。",
                json!({
                    "url": DEEPSEEK_KEY_URL,
                    "steps": [
                        "打开 DeepSeek 开放平台并登录",
                        "进入 API Keys 页面，创建一个新的 Key",
                        "复制以 sk- 开头的字符串",
                        "粘贴到 Veyl 的输入框发送，我会帮你存进系统钥匙串"
                    ],
                    "key_prefix": "sk-"
                }),
            ),
        )
    }
}

pub struct DeepseekSaveKeyTool {
    services: Arc<dyn VpnToolServices>,
}

impl DeepseekSaveKeyTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for DeepseekSaveKeyTool {
    fn name(&self) -> &str {
        "DeepseekSaveKey"
    }

    fn description(&self) -> &str {
        "把用户提供的 DeepSeek API Key 存进系统钥匙串，并尽量验证一次。\
         返回结果不含 Key。验证不通过时要如实告诉用户「Key 可能无效」或「已保存但未验证」。\n不复述密钥，不说保存路径。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "minLength": 20,
                    "maxLength": 200,
                    "sensitive": true
                }
            },
            "required": ["key"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(key) = input.get("key").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "DeepseekSaveKey",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 key 参数"))
                    .with_changed(Changed::None),
            );
        };
        if key.len() < 20 || !key.starts_with("sk-") {
            return envelope::finish(
                ctx,
                "DeepseekSaveKey",
                ToolOutcome::fail(AivpnError::new(
                    "INVALID_ARGUMENT",
                    "Key 格式看起来不对，应以 sk- 开头",
                ))
                .with_changed(Changed::None),
            );
        }

        let outcome = match self.services.save_deepseek_key(key).await {
            Ok(data) => {
                let validation = data
                    .get("validation")
                    .and_then(Value::as_str)
                    .unwrap_or("unverified");
                let summary = match validation {
                    "ok" => "Key 已保存到系统钥匙串，并验证可用。",
                    "invalid" => "Key 已保存，但验证失败：这个 Key 无效，请检查后重发。",
                    _ => "Key 已保存，但当前无法联网验证，稍后可以再试。",
                };
                let (text, fact) = match validation {
                    "ok" => ("密钥已保存", "验证：可用"),
                    "invalid" => ("密钥已保存但无效", "验证：失败"),
                    _ => ("密钥已保存，未验证", "验证：暂时无法完成"),
                };
                ToolOutcome::ok(summary, data).with_display(
                    text,
                    vec![fact.to_string()],
                    Changed::None,
                )
            }
            Err(error) => ToolOutcome::fail(AivpnError::new("INTERNAL", error.to_string()))
                .with_changed(Changed::Unknown),
        };
        envelope::finish(ctx, "DeepseekSaveKey", outcome)
    }
}
