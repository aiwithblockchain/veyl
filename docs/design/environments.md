# 控制面环境：dev / prod 如何区分

> 日期：2026-11-14
> 状态：已定稿，与 `src-tauri/src/control_plane/env.rs` 对齐；不改 `src/`、不 commit
> 关联：`docs/design/my-servers.md` §2–§3（控制面与可达性）、`docs/contracts/commands.md`、`docs/contracts/tools.md`

---

## 0. 结论先行

| # | 问题 | 结论 |
|---|---|---|
| 1 | 谁是环境判定的唯一来源 | **Rust 侧 `cfg!(debug_assertions)`**。前端 `import.meta.env.DEV` 不可用——Tauri 的 debug 构建也会用生产模式打包前端，`import.meta.env.DEV` 在 dev 包里同样是 `false` |
| 2 | 环境 ↔ 构建的映射 | debug 构建（`tauri dev`、`scripts/dev/tun-dev.sh` 的 `tauri build --debug`）→ **dev 控制面**；release 构建 / 安装包 → **prod 控制面** |
| 3 | 覆盖优先级 | `VEYL_CONTROL_PLANE_URL` → `VEYL_CONTROL_PLANE_ENV` → `cfg!(debug_assertions)` |
| 4 | release 下能不能覆盖 | **都不能**。release 忽略 `VEYL_CONTROL_PLANE_ENV=dev`，也忽略 `VEYL_CONTROL_PLANE_URL`。**M1 不提供 QA 覆盖特性**；release 只认 Prod |
| 5 | 环境对用户可见吗 | 只在**启动日志**与**设置 › 关于/诊断**出现；界面不做切换，也不暴露给 AI 工具 |
| 6 | 测试怎么做 | 判定抽成纯函数 `resolve(debug, env_override, url_override)`，单测覆盖优先级与 release 忽略；不靠构建 release 包来测 |

一句话：**环境是构建属性，不是运行时状态。** 用户不能切、AI 不能读、release 不能被环境变量骗到测试端点。

---

## 1. 端点常量

| 环境 | 常量（`src-tauri/src/control_plane/env.rs`） | 值 |
|---|---|---|
| dev | `DEV_URL` | `https://veyl-control-plane-dev.ribencong.workers.dev` |
| prod | `PROD_URL` | `https://veyl-control-plane.ribencong.workers.dev` |

- 基础路径仍是 `/v1`（`my-servers.md` §3），常量只到 origin，不带尾斜杠。
- 两个都是 `workers.dev` 域名。**大陆不可直连（2026-11-13 实测 TLS 中断）**；正式上线前换成自有域名（`my-servers.md` §2.3 已列为必须项）。
- 换域名时**只改这两个常量**，不改判定逻辑、不改调用方。

---

## 2. 判定逻辑

### 2.1 纯函数（与实现同形）

```rust
pub enum ControlPlaneEnv { Dev, Prod }

pub enum Sources { Default, EnvOverride, UrlOverride }

pub struct Resolved {
    pub env: ControlPlaneEnv,
    pub base_url: String,
    pub source: Sources,   // 只用于日志 / 设置页，便于回答「连到了哪个环境、为什么」
}

pub fn resolve(
    debug: bool,
    env_override: Option<&str>,
    url_override: Option<&str>,
) -> Resolved;

pub fn current() -> Resolved {
    resolve(
        cfg!(debug_assertions),
        std::env::var("VEYL_CONTROL_PLANE_ENV").ok().as_deref(),
        std::env::var("VEYL_CONTROL_PLANE_URL").ok().as_deref(),
    )
}
```

- 函数不读进程环境变量，环境变量由 `current()` 读好后传入——单测不需要 `set_var`（并行测试下会互相污染）。
- 返回值只含环境、URL、来源；**不含任何凭据**。

### 2.2 覆盖规则（从高到低）

| 优先级 | 输入 | 生效条件 | 结果 |
|---|---|---|---|
| 1 | `VEYL_CONTROL_PLANE_URL` | **仅 debug 构建** | URL 使用该值；环境名仍由 env 覆盖或编译期标志决定 |
| 2 | `VEYL_CONTROL_PLANE_ENV` | 值解析为 `dev` / `production`；release 只接受 `production` | 切到对应环境及其常量 |
| 3 | `cfg!(debug_assertions)` | 总是 | debug → Dev；release → Prod |

**细节（按实现）**

1. **env 值大小写不敏感、前后空白忽略**：`  DeV  `、`PRODUCTION`、`Production\n` 都合法（`trim` + 小写后匹配）。
2. **env 只认 `dev` / `production`**：`prod`、`development`、`staging`、空串等一律忽略并回落编译期环境，**不 panic、不回落 dev**。
3. **release 忽略 `env = dev`**：正式用户机器上残留的 `VEYL_CONTROL_PLANE_ENV=dev` 不能把客户端骗到测试端点。
4. **release 接受冗余的 `env = production`**：结果与默认一致，但 `source` 记为 `EnvOverride`（日志能看出是环境变量显式指定的）。
5. **URL 覆盖只在 debug 构建生效**：release 下一律忽略 `VEYL_CONTROL_PLANE_URL`。
6. **URL 必须是 `https://` 开头、非空、不含空白**：`http://`、`https://`（空 host）、`https://exa mple.test`、无 scheme 一律忽略，回落 env 或编译期环境。
7. **URL 覆盖不改环境名**：debug + 无 env 覆盖 + 自定义 URL → 环境仍是 Dev、URL 是自定义值；debug + `env=production` + 自定义 URL → 环境 Prod、URL 是自定义值。
8. **M1 没有 QA 构建特性**：不存在 `qa-endpoint-override` 之类的编译期后门。要连 prod 端点，只有两条路：
   - 直接用 **release 包**（环境与 URL 都是 prod）；
   - 用 **debug 包 + `VEYL_CONTROL_PLANE_ENV=production`**。注意这条**同时切换环境与 URL**（`base_url` 变成 `PROD_URL`），不是只改标签；它适合在 debug 包里验证 prod 链路，但不能指向任意域名。

### 2.3 为什么 release 下 URL 覆盖也不允许

- 覆盖值的来源是环境变量，任何能启动 App 的人都能设置；一个「指向任意 URL 的控制面」等于把账户令牌与节点凭据交给该 URL。这不是测试便利问题，是凭据外流问题。
- M1 不做 QA 覆盖特性，是为了让「这个包到底连哪」只由构建产物决定：release = prod，debug = dev（或显式 `ENV=production`）。要测真实 prod 就用 release 包，不需要在正式包里留后门。
- 将来若确有预发布域名需求，再单独设计编译期标志并补验收；不把它混进 M1。

---

## 3. 调用方与生命周期

- 判定在 Host 启动时**做一次**（`lib.rs` 调 `control_plane::env::current()`），结果放进 `AppState`；运行期不重读环境变量、不重算。
- 所有控制面请求从这一个值取 origin；不在各命令里重复读环境变量（禁止第二处判定）。
- 前端**不参与判定**：它拿到的只是展示用的环境与域名（§4）。前端的 `import.meta.env.DEV` 在本项目里只用于开发期调试，不作为任何控制面选择的依据。
- 读取环境变量的代码只允许出现在 `control_plane` 模块；`grep` 到第二处即视为缺陷。

---

## 4. 可见性

### 4.1 启动日志

启动时打一行（不含令牌、不含查询串）：

```
控制面：dev · https://veyl-control-plane-dev.ribencong.workers.dev
控制面：prod · https://veyl-control-plane.ribencong.workers.dev（env 覆盖）
```

- `source = default` 不追加后缀；`env_override` 追加 `（env 覆盖）`；`url_override` 追加 `（URL 覆盖）`。
- 被忽略的覆盖各打一行 warning：`控制面：release 构建忽略 VEYL_CONTROL_PLANE_ENV`。
- 日志里**不出现** access token、refresh token、enrollment token。

### 4.2 设置 › 关于 / 诊断

| 行 | 值 | 编辑 |
|---|---|---|
| 环境 | `开发` / `正式` | 只读 |
| 控制面 | 域名（只显示 host，不显示完整路径与查询串） | 只读，可复制 |

- 只读、不可切换；不新增设置项、不写 `localStorage`。
- 前端通过一个 **UI 专用只读命令**取这两个值（见 §5），不自己推断。

---

## 5. 契约影响（仅记录，实施时随批改）

- `commands.md`：新增 **`control_plane_info {}`** → `{ env: "dev" | "production", base_url: string, source: "default" | "env_override" | "url_override" }`，**仅 UI**，不注册 AI 工具。可与 `commands` 3.0.0 同批发布；若单独发则升 2.22.0（非破坏）。
- `events.md`：不变。环境在进程生命周期内不变，不需要事件。
- `tools.md`：**不变**。环境名不进入任何工具入参与结果，模型无法读取或利用。
- `data-model.md`：不变。环境不落库（它是构建属性，不是用户设置）。

---

## 6. 测试要求

### 6.1 单测（与实现的 10 条一一对应）

| # | 用例 | 输入 | 期望 |
|---|---|---|---|
| T1 | debug → dev | `true, None, None` | Dev + `DEV_URL` + `Default` |
| T2 | release → prod | `false, None, None` | Prod + `PROD_URL` + `Default` |
| T3 | debug 可切 production | `true, Some("production"), None` | Prod + `PROD_URL` + `EnvOverride` |
| T4 | release 忽略 `env=dev` | `false, Some("dev"), None` | **Prod** + `PROD_URL` + `Default` |
| T5 | release 接受冗余 `env=production` | `false, Some("PRODUCTION"), None` | Prod + `EnvOverride` |
| T6 | env 值大小写不敏感、trim | `true, Some("  DeV  ")` / `"Production\n"` / `"PRODUCTION"` | Dev / Prod / Prod |
| T7 | 非法 env 值被忽略 | `true` + `""` / `"staging"` / `"devops"` / `"1"` / `"prod"` / `"production-ish"` | Dev + `Default`（逐值断言） |
| T8 | debug 下 URL 覆盖优先级最高 | `true, Some("production"), Some("https://example.test/api")`；再 `true, None, Some("https://example.test")` | 前者 Prod + 自定义 URL + `UrlOverride`；后者 Dev + 自定义 URL + `UrlOverride` |
| T9 | release 忽略 URL 覆盖 | `false, None, Some("https://example.test")` | Prod + `PROD_URL` + `Default` |
| T10 | 非 https / 空 URL 被忽略 | `true, None, Some("")` / `"   "` / `"http://example.test"` / `"https://"` / `"https://exa mple.test"` / `"example.test"` | Dev + `DEV_URL` + `Default`（逐值断言） |

- 测试直接调用 `resolve`，**不设置进程环境变量**；不在单测里构建 release 包。
- 每条都断言「环境 + URL + source」三件事实，不能只断言 URL。

### 6.2 集成冒烟（人工，交用户执行）

1. `tauri dev` 启动：设置页显示 `开发` + dev 域名；启动日志一行 `控制面：dev`。
2. `tauri build`（release）启动：显示 `正式` + prod 域名。
3. release 包上设 `VEYL_CONTROL_PLANE_ENV=dev` 再启动：仍是 `正式`，日志出现「已忽略」。
4. debug 包上设 `VEYL_CONTROL_PLANE_ENV=production` 再启动：显示 `正式` + prod 域名，日志标 `（env 覆盖）`——环境与 URL 都切到 prod。
5. debug 包上设 `VEYL_CONTROL_PLANE_URL=https://example.test`：显示 `开发` + 该域名，日志标 `（URL 覆盖）`。
6. 以上各步都不改变本地配置、不触发迁移、不影响连接。

---

## 7. 不做

| 不做 | 原因 |
|---|---|
| 运行时切换环境 | 环境是构建属性；能切就会被当成产品功能，也会让「这个包连哪」不可预测 |
| 多环境并行（同时连 dev 与 prod） | 账户与订单属于单一控制面；并行会让服务器归属无法解释 |
| QA 构建标志 / release 下的任何环境变量后门 | M1 不提供；正式包只认 Prod，避免凭据外流 |
| 把环境名暴露给 AI 工具 | 模型不需要它；暴露会诱导模型在回答里说「你在测试环境」 |
| 用前端 `import.meta.env.DEV` 判定 | Tauri debug 构建的前端也是生产模式，判不出来 |
| 第三个编译期端点常量或预发布域名 | M1 两个环境足够；需要时再单独设计 |

---

## 8. 验收

| # | 断言 |
|---|---|
| E1 | 判定只有一处实现（`control_plane::env`）；全仓没有第二处读 `VEYL_CONTROL_PLANE_*` |
| E2 | `resolve` 是纯函数，单测 T1–T10 全过 |
| E3 | release 构建下 `VEYL_CONTROL_PLANE_ENV` 与 `VEYL_CONTROL_PLANE_URL` 都不生效 |
| E4 | debug 构建下 `VEYL_CONTROL_PLANE_ENV=production` 把环境与 URL 都切到 prod；`VEYL_CONTROL_PLANE_URL` 只改 URL |
| E5 | 启动日志一行环境 + 域名 + 来源；设置 › 关于/诊断 同值只读、可复制 |
| E6 | 环境名不出现在任何 AI 工具 schema、工具结果或对话上下文中 |
