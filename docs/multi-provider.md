# 多 Provider 设计（Anthropic / OpenAI 兼容）

> 版本：v1.1
> 日期：2026-11-02
> 参考：TweetPilot 工程的 `src-tauri/src/services/`（`claurst_provider.rs`、`ai_config.rs`）与 `src/types/ai-settings.ts`
> 范围：只做设计，不改代码

---

> ⚠️ **P2 设计，P1 不实施。**
>
> P1 的用户决定是**写死 DeepSeek**。本文档是后续版本的蓝图，**看到它不要当成任务开工**。
>
> **provider 抽象不在 P1 范围。** 但 P1 要做三件事（§9）：把 Key 存储从钥匙串换成 `secrets.enc`（用户要求，正式版不弹密码框）、存储键定为 `provider:deepseek`、配置读取返回结构体。**不做** protocol 分支、不改命令名、不建 provider 列表 UI。

---

## 0. 结论摘要

| # | 问题 | 结论 |
|---|---|---|
| 1 | 配置存哪 | **SQLite `settings` 表，单行 JSON**（key = `ai_settings`）。不新建表 |
| 2 | Key 存哪 | 本地加密文件 `<data_dir>/secrets.enc`（0600，AES-256-GCM）；**配置 JSON 里不存 Key** |
| 3 | 旧 Key 怎么办 | 首次读取时回退 `deepseek_api_key`，写入新 account 后删除旧条目 |
| 4 | 运行时怎么切 | `provider.rs::build` 按 `protocol` 分支；切换时整体替换 `AppState` 里的 `Arc<ActiveProvider>` |
| 5 | 已有会话怎么办 | 不中断。下一条消息发送前惰性重建 session |
| 6 | 验收顺序 | 按 PM 的顺序走，但 P-1 的结论写成「密钥存储通路已验证」，抽象后必须重验命令名与存储键（§6） |

与 TweetPilot 最大的一处不同：**它的 `ProviderConfig.api_key` 是明文存在 settings JSON 里的，我们不这么做**。Key 只进本地加密文件，配置里只留 `has_key: bool` 的派生状态。

---

## 1. 现状

Veyl 已经有一份和 TweetPilot 结构几乎一致的实现，只是写死了 OpenAI 协议：

```
src-tauri/src/claurst_session/provider.rs
  DeepSeekCredentials { api_key, base_url, model }
  build(&credentials) -> ProviderSetup { client, registry, core_provider, provider_configs }
```

`registry` / `core_provider` / `provider_configs` 三件套已经齐了，`claurst_session/mod.rs:82` 也在用 `query_config.provider_registry = Some(Arc::clone(&setup.registry))`。

所以这不是从零设计，是**把写死的 DeepSeek 泛化成按 protocol 分支**。工作量集中在一个文件。

`AppState` 里现在是：

```rust
credentials: parking_lot::RwLock<Option<DeepSeekCredentials>>,
```

单一凭据 + `set_credentials()`，已经有热更新的骨架。

---

## 2. 数据模型

### 2.1 存哪：SQLite `settings` 表

**结论：复用 `settings(key, value)`，不新建表。**

理由：

- 项目已有先例 —— `catalog_base_url` 就是这么存的（`lib.rs:33`）
- 这是一份几十行的配置，不是可查询的实体，建表只会带来迁移成本
- provider 数量是个位数，不需要按字段索引

```sql
-- 已有表，不新增
INSERT INTO settings (key, value) VALUES ('ai_settings', '<json>');
```

### 2.2 结构

```ts
type ProviderProtocol = "anthropic" | "openai";
type ProviderEffort = "low" | "medium" | "high";

type ProviderConfig = {
  id: string;             // 内置 "deepseek"；自定义 "custom-<ts>-<rand>"
  name: string;           // 展示名
  protocol: ProviderProtocol;
  base_url: string | null;  // null = 用协议默认
  model: string;
  effort_level: ProviderEffort;
  enabled: boolean;
};

type AiSettings = {
  active_provider: string;     // "" = 未配置
  providers: ProviderConfig[];
};
```

**没有 `api_key` 字段。** 这是与 TweetPilot 的关键差异。

### 2.3 默认值与归一化

| 项 | 规则 |
|---|---|
| `base_url` 为空串 / null | anthropic → `https://api.anthropic.com`；openai → 由调用方决定（DeepSeek 内置项填 `https://api.deepseek.com`） |
| `base_url` 末尾 `/v1` | **去掉**，避免 `OpenAiProvider` 内部拼出 `/v1/v1` |
| 未知 `effort_level` | 回落 `"medium"`（与 TweetPilot 一致） |
| `active_provider` 指向不存在的 id | 回落第一个 `enabled` 的 provider；没有则 `""` |
| 未配置任何 provider | 进入「无 AI 模式」，不阻塞连接 |

### 2.4 内置 provider

| id | name | protocol | base_url | model |
|---|---|---|---|---|
| `deepseek` | DeepSeek | `openai` | `https://api.deepseek.com` | `deepseek-chat` |

内置项可以在设置页改 model，但 id 不可改。用户可新增任意数量的自定义项。

---

## 3. Key 存储

> **2026-11-02 变更**：早期版本用系统钥匙串存 Key，**作废**。用户要求正式版也不能弹系统密码框，改为机器绑定的本地加密文件。参考 TweetPilot 的 `src-tauri/src/services/crypto.rs`。

### 3.1 存储布局

```
<data_dir>/secrets.enc        权限 0600
```

内容是一份 JSON 映射，值是密文：

```json
{
  "provider:deepseek": "<base64(nonce || ciphertext)>",
  "provider:custom-abc123": "<...>",
  "device_token": "<base64(nonce || ciphertext)>"
}
```

> **这是 P1 的最终布局，不是过渡形态。** P1 就实现 `provider:deepseek` + `device_token` 两个键，不等 provider 抽象。P2 只往这个映射里加键，不改结构、不改文件位置、不写迁移。

- **一个文件存所有 provider**，不按 provider 分文件 —— 文件数越少，权限与原子写的坑越少。
- 键用 `provider:<id>` 与 `<用途>` 两种前缀（`provider:deepseek`、`device_token`），不做嵌套结构，后续加新类别只需加键。
- 权限 `0600`，写入用「临时文件 + fsync + `rename`」，与 `runtime-state.json` 同一套原子写。

### 3.2 加密与机器绑定

| 项 | 值 |
|---|---|
| 算法 | AES-256-GCM |
| nonce | 12 字节随机，每次加密重新生成，放在密文前面 |
| 密钥派生 | PBKDF2-HMAC-SHA256，100 000 次迭代 |
| 盐 | 固定串 `veyl:secret-store:v1`（写在代码里，不是秘密） |
| 机器标识 | macOS `ioreg -rd1 -c IOPlatformExpertDevice` 取 `IOPlatformUUID`；Windows 取 `MachineGuid` |
| 序列化 | `base64(nonce ‖ ciphertext)` |

参考实现里 `derive_key` / `get_machine_id` 的结构可以直接沿用，**只换盐串和文件布局**。

失败处理：

- 机器标识取不到 → 返回 `SECRET_STORE`，**不回落成明文**，也不偷偷用固定密钥
- 解密失败（文件损坏 / 换了机器 / 手工改过）→ 当作「无 Key」，删掉该条并让用户重输，**不 panic**

### 3.3 威胁模型（必须写清楚，别让人误以为是硬件级保护）

**这套方案防的是：**

| 攻击 | 是否防住 |
|---|---|
| 文件被拷到另一台机器 | ✅ 机器标识不同，解不开 |
| 云备份 / 同步盘翻看 | ✅ 只看到密文 |
| 误把 `secrets.enc` 发到聊天工具或提交进仓库 | ✅ 只泄露密文 |
| 同一台机器上的其他用户账户 | ✅ 文件 0600，且拿不到当前用户的用户目录 |

**这套方案不防：**

| 攻击 | 说明 |
|---|---|
| **以同一用户身份运行的恶意程序** | 它能读文件、也能读机器标识、还能直接调我们的解密函数 —— 加密对它无效 |
| 内存抓取 / 调试器附加 | Key 在内存里是明文 |
| root / 管理员权限 | 同上，且可读任意用户文件 |
| 物理接触 + 已登录的会话 | 同第一行 |

**结论**：这是桌面客户端的常规取舍 —— **用「文件离开这台机器就失效」换取「不打扰用户」**。它不是硬件级保护（那需要 Secure Enclave / TPM + 用户交互），AIVPN 也不承诺做到那一层。

用户如果要求更高强度的保护，唯一的补偿手段是**使用可随时吊销的 API Key**（DeepSeek 控制台可删除重建），而不是指望本地加密。

### 3.4 迁移

**不做。**

应用尚未发布，没有存量用户。旧的钥匙串条目（如果开发机上还有）**直接忽略**，用户重新输入一次即可。

理由：写一段只服务开发机的迁移代码，会在发布后长期留在代码库里，增加一个永远不会被执行的路径和一份永久存在的钥匙串访问权限。

> 若将来从钥匙串版本升级，再补迁移；现在不做。

### 3.5 命令泛化

现有两个命令：

```
deepseek_save_key(key)      → { saved, validation, validation_detail }
deepseek_key_status()       → { has_key, masked }
```

改成 provider 级：

```
provider_save_key(provider_id, key)   → 同 KeySaveOutcome
provider_key_status(provider_id)      → { has_key, masked }
provider_validate(provider_id)        → { validation, validation_detail }
```

**不保留旧命令别名。** 应用尚未发布，没有外部调用方；留别名只会让两套语义长期并存。UI 同步改。

### 3.6 错误码

| 码 | 场景 | 复用/新增/改名 |
|---|---|---|
| `UNSUPPORTED` | 尚未接线 | 复用 |
| `SECRET_STORE` | 写入失败 / 解密失败 / 文件损坏 / 取不到机器标识 | **由 `KEYCHAIN` 改名而来** |
| `PROVIDER_NOT_FOUND` | `provider_id` 不在配置里 | 新增 |
| `NO_KEY` | 校验时没有 Key 可校验 | 新增 |

`KEYCHAIN` 这个名字在新方案下已经不准确 —— 没有 keychain 参与了。涉及它的代码、测试与文档一律改成 `SECRET_STORE`，不留兼容别名。

`validation` 三态（`ok` / `invalid` / `unverified`）与 `insufficient_balance` 的语义**完全不变**，见 `docs/contracts/tools.md` §4.15。

### 3.7 工具契约的影响

`DeepseekSaveKey` 是契约里已冻结的第 15 个工具。三个选项：

| 方案 | 契约影响 | 评价 |
|---|---|---|
| A. 工具名与参数不变，内部存到 active provider | **零改动** | 最省事，但调用方无法指定 provider |
| B. 加可选 `provider_id` 参数 | 加一个可选字段，向后兼容 → 1.0.6 | 推荐 |
| C. 改名 `AiProviderSaveKey` | 破坏性 → 2.0 | 不值 |

**推荐 B**：`provider_id` 可选，缺省 = `active_provider`。老调用行为不变，新调用可以指定。

工具的返回结构不变 —— `saved` / `validation` / `validation_detail` 与 Key 存在哪里无关。

---

## 4. 运行时

### 4.1 按 protocol 分支

把 `provider.rs` 的 `build` 从「只认 OpenAI」改成：

```rust
pub enum ActiveProvider {
    Anthropic { client: AnthropicClient, model: String, effort: EffortLevel },
    OpenAi    { client: AnthropicClient, registry: Arc<ProviderRegistry>,
                provider_configs: HashMap<String, ProviderConfig>,
                model: String, effort: EffortLevel },
}
```

两者的 `client` 字段类型相同（`AnthropicClient`），差别只在：

| 协议 | `registry` | `core_provider` | 实际请求走 |
|---|---|---|---|
| `anthropic` | `None` | `None` | `AnthropicClient` 直连 |
| `openai` | `Some(registry)` | `Some("openai")` | ProviderRegistry 分派 |

**必须保留 TweetPilot 踩过的那个坑的防护**：openai 协议下要把 App 自己的 key + base 同时写进 `provider_configs`，否则 claurst 会用 `api.openai.com` 重建一个空 key 的 provider，覆盖掉预注册的 registry。

### 4.2 热更新

现状是 `RwLock<Option<DeepSeekCredentials>>`，改成：

```rust
providers: parking_lot::RwLock<Arc<ActiveProvider>>,
```

切换 provider 时**整体替换 Arc**：

- 进行中的请求持有旧的 `Arc`，不受影响，正常跑完
- 新请求读最新的 `Arc`
- 不做「取消进行中请求」—— 用户切换 provider 不应该打断正在生成的回答

### 4.3 已有会话

`AppState.sessions: Mutex<HashMap<String, Arc<AivpnSession>>>` 里每个 session 建的时候就把 provider 定死了。

**结论：惰性重建。** 切换 provider 后不主动清理 session；`ai_send_message` 时比对该 session 创建时的 provider 指纹与当前是否一致，不一致就丢弃旧 session 重建。

代价：上下文（对话历史）在 session 内，重建会丢。所以要么把历史一并迁移，要么接受「切 provider 等于开新会话」。

**推荐接受后者**，并在 UI 上明确提示：「切换模型后当前会话将重新开始」。理由：不同协议的消息格式不保证兼容（thinking block、tool_use 结构都不同），强行迁移历史迟早出错。

---

## 5. UI 契约

### 5.1 命令

| 命令 | 入参 | 返回 |
|---|---|---|
| `ai_settings_get` | `{}` | `{ active_provider, providers: ProviderConfig[] }` |
| `ai_settings_save` | `{ settings: AiSettings }` | `{ ok: true }` |
| `provider_save_key` | `{ provider_id, key }` | `KeySaveOutcome` |
| `provider_key_status` | `{ provider_id }` | `{ has_key, masked }` |
| `provider_validate` | `{ provider_id }` | `{ validation, validation_detail }` |

### 5.2 设置页需要的状态

| 状态 | 用途 |
|---|---|
| `providers[]` | 列表渲染 |
| `active_provider` | 当前选中项 |
| `key_status[id]` | 每项显示「已保存 / 未保存」+ 掩码 |
| `validating[id]` | 校验中的 loading |
| `save_error[id]` | 单项错误，不阻塞其他项 |

### 5.3 表单字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| name | text | 是 | 展示名 |
| protocol | 单选 `anthropic` / `openai` | 是 | 默认 openai（P1 用户主要是 DeepSeek） |
| base_url | text | 否 | 空 = 用协议默认；本地 Ollama 填 `http://localhost:11434` |
| model | text | 是 | 自由输入，不做下拉 |
| effort_level | 三选一 | 是 | 默认 medium |
| api_key | password | 否 | **base_url 指向 localhost 时可空**（Ollama） |
| enabled | 开关 | 是 | 关掉的项不在 active 候选里 |

---

## 6. 验收顺序评估

### PM 的提议

> 先修 hot-reload 让 P-1 通过，再做 provider 抽象。

### 结论：**顺序可以照 PM 的走，但要改 P-1 的定性**

我最初想建议倒过来（先抽象再验），理由是「先验后改 = 白验一次」。核完代码后这个理由站不住：

**Alice 的单 Key 设置页已经做完了** —— `src/components/Settings.tsx:117` 有「DeepSeek API Key」整段，`tauriBridge.ts:92/106/117` 三个方法都接好了。也就是说 `provider_save_key` 的 UI 返工**无论什么顺序都要发生**，不是「先验」才多出来的成本。

那么 P-1 现在验，能拿到什么？

| 验的是什么 | 抽象后是否仍成立 |
|---|---|
| 加密文件能写、能读、能删 | ✅ 成立 —— 与存储键名无关 |
| `KeySaveOutcome` 三态分类正确 | ✅ 成立 —— 语义不变，见 §3.4 |
| 命令名 `deepseek_save_key` | ❌ 会变 |
| account 名 `deepseek_api_key` | ❌ 会变 |

**前三行是真价值，后两行本来就要重验。**

### 所以建议的排法

```
1. Bob 的 hot-reload 合入（已在做）                      ← P1
2. 验 P-1，结论写成「密钥存储通路已验证」                  ← P1
3. 抽象 provider（provider.rs 分支 + 配置读写 + Key 迁移）  ← P2
4. Alice 设置页改成 provider 列表                        ← P2
5. 对最终接口重验 P-1（只验命令名与迁移）                  ← P2
```

**第 1、2 步是 P1 本轮要做的；第 3–5 步是 P2 的排法，现在不动。** 保留这段是因为 P2 开工时要按这个顺序，否则会重蹈「先验后改」的返工。

第 2 步存在的意义：**它把「密钥存储这条路能不能走通」和「provider 抽象做得对不对」两件事分开了**。如果两者混在一起验，一旦失败会分不清是加密文件读写失败（权限、原子写、机器标识取不到）还是抽象逻辑问题。

今天 D-01 那次就是这样 —— 一个 FAIL 里混着「代码缺陷」和「拿旧二进制验证新代码」两个原因，拆开花了半小时。

### 第 5 步不能省

即使第 2 步 PASS，抽象改完仍要重验一次，验的是：

- `provider_save_key` 的 Key 真的进了 `provider:deepseek`
- 旧条目 `deepseek_api_key` 被正确迁移并删除
- 切换 provider 后旧 Key 不串到新 provider

这三条是抽象引入的**新风险**，第 2 步覆盖不到。

### 需要先确认的一个冲突

provider 抽象和 Bob 正在改的 hot-reload 都在 `AppState.credentials` 附近。**先合并 hot-reload 再动抽象**，否则同一个 `RwLock` 字段会被两边同时改。

---

## 7. 不做的事

| 项 | 理由 |
|---|---|
| 平台托管 provider（TweetPilot 的 managed 条目） | Veyl 是 BYOK，没有平台代付 |
| 多 provider 并行（同一会话内自动切换） | 复杂度高，P1 无需求 |
| 按会话选 provider | 会话与 provider 绑定，切换即重开 |
| provider 的连通性健康检查 | 校验只做一次最小请求，不做持续探测 |
| 把 Key 存进配置 JSON | 违反 secrets policy，见 §2.2 |

---

## 8. 已决议（2026-11-02，PM）

| 问题 | 决定 |
|---|---|
| 切换 provider 时对话历史 | **接受丢失**，UI 必须在切换确认里明确提示。不写转换器 —— 不同协议的消息结构（thinking block、tool_use、content block 形状）本来就不保证兼容，转换器是长期维护负担且必然有损 |
| 命令是否保留别名 | **不留**。应用未发布，没有外部调用方；留别名会让两套语义长期共存 |
| `deepseek` 内置项能否删除 | **不允许**。它是旧 Key 迁移的目标 id，删除会制造孤儿凭据 |
| P-1 的定性 | 写成「**密钥存储通路已验证**」，不写「DeepSeek Key 功能验收通过」。抽象后必须重验三条新风险 |
| 实施顺序 | 先合并 hot-reload，再动抽象，避免同一个 `AppState.credentials` 被两边同时改 |
| **本轮是否实施** | **不实施**。P1 写死 DeepSeek，本文档是 P2 蓝图 |

> 提示文案的要求：写在**切换确认对话框**里，不是只写进文档。用户点「切换」时就要知道当前会话会重新开始。

---

## 9. P1 要做的与不做的

P1 不做 provider 抽象，但下面三件事现在就要做——前一件是用户明确要求的，后两件几乎零成本。

### 9.1 把 Key 存储从钥匙串换成 `secrets.enc`（P1 必做）

**这不是预留，是用户要求**：正式版也不能弹系统密码框。详见 §3。

改动范围：

- `src-tauri/src/secrets/mod.rs` 重写存储层，接口签名不变（`set_secret` / `get_secret` / `delete_secret`）
- 新增 `crypto` 模块：AES-256-GCM + PBKDF2 + 机器标识（参考 TweetPilot `services/crypto.rs`）
- 错误码 `KEYCHAIN` → `SECRET_STORE`
- 命令名仍保持 `deepseek_save_key` / `deepseek_key_status` 不变（P1 不改名）

验收影响：P-1 的判据从「钥匙串能写能读」改成「加密文件能写能读」。**这是 P1 的真实验收内容**，不只是通路探测。

### 9.2 存储键用 `provider:deepseek` 而不是 `deepseek_api_key`（P1 预留）

在 §9.1 重写存储层时顺手定下来：

```json
{ "provider:deepseek": "<ciphertext>" }
```

而不是：

```json
{ "deepseek_api_key": "<ciphertext>" }
```

代价：零 —— 反正是新格式，键名随便定。

收益：P2 加第二个 provider 时，键名已经是统一格式，不需要再改一次文件格式（改格式就要写迁移）。

### 9.3 配置读取返回值用结构体，给默认值（P1 预留）

现在如果直接返回 `{ api_key, base_url, model }` 这种扁平结构，P2 要改成 `{ providers: [...], active_provider }`，所有调用点都要改。

预留做法：**读取时返回带 `Default` 的结构体，当下只有一个字段**。

```rust
#[derive(Default)]
pub struct AiSettings {
    pub active_provider: String,
    pub providers: Vec<ProviderConfig>,
}
```

代价：定义一个结构体，比返回 `Value` 多十几行。

收益：P2 不需要动调用方签名。

### 9.4 P1 一律不做

即使看起来"顺手"：

- 不改命令名（`deepseek_save_key` 保留）
- 不实现 `protocol` 分支
- 不加 `provider_id` 参数
- 不建 provider 列表 UI
- 不动 `AppState.credentials` 的结构

理由：这些每一项都会牵动验收重新跑一遍，而 P1 的价值是「能连上」，不是「架构完备」。
