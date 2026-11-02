# 契约：Runtime Manager

> 契约版本：`1.0.6`
> 状态：已冻结（PM 审核通过，2026-11-02）
> 冻结前评审：PM / Alice / Bob
> 上游：`docs/architecture.md` §2、`docs/phase-1-technical-design.md` §4.5
> 实现方：Rust（Host）与 TypeScript（UI）共用本文件
> 变更记录：见 §12

---

## 0. 本契约的地位

本文档定义 **Host ↔ UI ↔ Agent 三方关于 sing-box 运行时的唯一事实来源**。

- 状态枚举、字段名、错误码一经冻结，双方按此实现，不得各写一套。
- 所有 JSON 字段使用 **snake_case**；所有时间是 **ISO 8601 UTC，带 `Z` 后缀**（`2026-11-02T09:15:03Z`），不带毫秒之外的其他格式。
- 所有错误码是 **大写下划线**（`RUNTIME_START_TIMEOUT`）。
- `contract_version` 出现在每一个对外结构里；破坏性变更必须升次版本号并同步本文档。

**P1 范围**：单版本、单进程、系统代理模式。多版本并行、TUN、外部 MCP 宿主不在本契约内。

---

## 1. 名词与边界

| 名词 | 定义 |
|---|---|
| Runtime | 一个正在运行的 `sing-box` 子进程实例 |
| Runtime Version | 磁盘上的一份 sing-box 发行版目录（P1 同时只允许一个 active） |
| Runtime Manager | Host 内唯一能 spawn / kill `sing-box` 的组件 |
| Clash API | sing-box 的 `experimental.clash_api` HTTP 接口，仅回环 TCP |
| Health | 由 Runtime Manager 周期性产出的健康快照 |

硬边界：

1. 除 Runtime Manager 外，任何模块不得直接 spawn / kill `sing-box`。
2. Clash API 只监听 `127.0.0.1`，端口随机，`secret` 每次启动随机生成。
3. Runtime Manager 的任何失败都必须最终关闭系统代理，不允许「断网且不知情」。

---

## 2. 类型定义

### 2.1 状态枚举

```ts
type RuntimeState =
  | "idle"
  | "starting"
  | "running"
  | "degraded"
  | "restarting"
  | "stopping"
  | "failed";
```

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Idle,
    Starting,
    Running,
    Degraded,
    Restarting,
    Stopping,
    Failed,
}
```

| 状态 | 含义 | UI 语义 |
|---|---|---|
| `idle` | 没有运行中的 sing-box | 未连接 |
| `starting` | 进程已拉起，等待 Clash API 就绪 | 连接中 |
| `running` | 健康检查通过，可承载流量 | 已连接 |
| `degraded` | 进程存活但健康检查连续失败 | 连接异常，可继续但会告警 |
| `restarting` | 收到重启请求，先停后起 | 重连中 |
| `stopping` | 正在优雅退出 | 断开中 |
| `failed` | 无法启动或已放弃重启 | 连接失败，需人工介入 |

> `failed` **不会自动重试**。只有用户显式操作（`RuntimeStart` 或 UI 按钮）才能离开 `failed`。

### 2.2 运行模式

```ts
type RuntimeMode = "system_proxy";
```

P1 只有一种模式。`disabled`（只起进程不设代理）保留给诊断用，不出现在工具入参里。

### 2.3 健康快照

```ts
type HealthCheckName =
  | "process"
  | "clash_api"
  | "data_plane"
  | "exit_ip"
  | "traffic";

type HealthSnapshot = {
  contract_version: "1.0.6";
  process: boolean;
  clash_api: boolean;
  data_plane: boolean;
  exit_ip: string | null;          // 最近一次探测到的出口 IP，未探测时为 null
  consecutive_failures: number;    // 连续失败次数，成功即清零
  checked_at: string;              // ISO 8601 UTC
};
```

### 2.4 流量快照

```ts
type TrafficStats = {
  up_bytes: number;      // 本次运行累计上行字节
  down_bytes: number;    // 本次运行累计下行字节
  up_rate: number;       // 字节/秒，来自 /traffic
  down_rate: number;     // 字节/秒
  sampled_at: string;    // ISO 8601 UTC
};
```

### 2.5 运行时状态快照（`RuntimeStatus` 的 `data`）

```ts
type RuntimeSnapshot = {
  contract_version: "1.0.6";
  state: RuntimeState;
  mode: RuntimeMode | null;
  pid: number | null;
  upstream_version: string | null;   // 例 "1.14.4"；未启动时 null
  uptime_seconds: number | null;
  profile_id: string | null;
  config_hash: string | null;        // "sha256:<hex>"，配置文件的摘要
  system_proxy_enabled: boolean;
  health: HealthSnapshot;
  traffic: TrafficStats | null;
  connections: number | null;        // 活动连接数，来自 /connections
  restart_count: number;             // 本次启动周期内的崩溃重启次数
  last_error: AivpnError | null;
  last_transition_at: string;        // ISO 8601 UTC
};
```

实现要求：

- `pid` / `upstream_version` / `uptime_seconds` 在 `idle` 与 `failed` 下**必须为 `null`**，不得为 0 或空串。
- `traffic` 在 `idle` / `failed` 下为 `null`；其余状态不得为 `null`。
- `config_hash` 用于 UI 判断「配置是否变化」，不是安全校验手段。

### 2.6 错误对象（全契约共用）

```ts
type AivpnError = {
  contract_version: "1.0.6";
  code: AivpnErrorCode;
  message: string;        // 面向用户，可本地化
  retryable: boolean;
  details: Record<string, unknown> | null;
  request_id: string;     // 与服务端日志对应
};
```

---

## 3. 状态机

### 3.1 事件

| 事件 | 触发来源 |
|---|---|
| `START_REQ` | `RuntimeStart` 工具 / UI「连接」/ 启动恢复 |
| `PROCESS_READY` | Clash API `GET /version` 首次返回 200 |
| `HEALTH_OK` | 一次完整健康检查全部通过 |
| `HEALTH_FAIL` | 一次健康检查失败 |
| `CRASH` | 进程非预期退出，或启动超时 |
| `STOP_REQ` | `RuntimeStop` 工具 / UI「断开」/ 应用退出 |
| `RESTART_REQ` | `RuntimeRestart` 工具 / 恢复策略 |
| `STOPPED` | 进程已退出并被回收 |
| `GIVE_UP` | 重启次数耗尽 |

### 3.2 迁移表（实现即照抄）

| 当前 | 事件 | 下一状态 | 动作 |
|---|---|---|---|
| `idle` | `START_REQ` | `starting` | 选版本 → 校验配置 → spawn；启动超时 10s |
| `idle` | `RESTART_REQ` | `starting` | 等价于启动 |
| `starting` | `PROCESS_READY` | `running` | 启动 2s 健康检查循环 |
| `starting` | `CRASH` | `failed` | 启动失败不重试；写 `last_error` |
| `running` | `HEALTH_FAIL` | `running` | 失败计数 +1 |
| `running` | `HEALTH_FAIL`（计数 ≥ 3） | `degraded` | 发 `runtime-health-changed`；启动 30s 恢复计时 |
| `running` | `CRASH` | `starting` | 重启计数 +1；退避 1s / 2s / 4s |
| `running` | `RESTART_REQ` | `restarting` | `restart_intent = true`；关闭系统代理 |
| `running` | `STOP_REQ` | `stopping` | 先关系统代理，再 `POST /close` |
| `degraded` | `HEALTH_OK` | `running` | 计数清零，取消恢复计时 |
| `degraded` | 30s 未恢复 | `restarting` | 自动重启；次数耗尽转 `failed` |
| `degraded` | `RESTART_REQ` | `restarting` | `restart_intent = true` |
| `degraded` | `STOP_REQ` | `stopping` | 同 `running` |
| `restarting` | `STOPPED` | `starting` | 用同版本同配置重新拉起 |
| `restarting` | `CRASH` | `failed` | 重启失败；若存在 standby 版本则回滚 |
| `stopping` | `STOPPED` | `idle` | 清除 secret、临时配置、`restart_intent` |
| `starting` / `running` / `restarting` | `GIVE_UP` | `failed` | 上报错误；关闭系统代理 |
| `failed` | `START_REQ` | `starting` | 先自检（二进制存在、端口可用）再启动 |

### 3.3 不变量（测试必须覆盖）

1. 同一时刻最多一个 `sing-box` 进程。
2. 进入 `stopping` 之前，系统代理必须已关闭。
3. `failed` 状态不自动重试。
4. `restart_intent` 只能由 `RESTART_REQ` 置位，`STOP_REQ` 必须清除。
5. 每次状态迁移都写一行 `runtime-events.log`，含 `from`、`to`、`event`、`pid`、`code`、`at`。
6. 状态迁移是**单写者**：只有一个 tokio task 持有状态机，其余模块发事件，不直接改状态。

### 3.4 重启策略

| 项 | 值 |
|---|---|
| 启动超时 | 10 000 ms |
| 崩溃后最大重启次数 | 3 |
| 退避 | 1 000 / 2 000 / 4 000 ms |
| 重启计数重置条件 | 连续 `running` 满 60s |
| 跨应用重启 | **不保留**，每次应用启动 `restart_count = 0` |
| 优雅停止等待 | 5 000 ms |

超过最大重启次数 → `GIVE_UP` → `failed`。

---

## 4. 健康检查契约

### 4.1 检查项与判定

| 检查 | 频率 | 超时 | 通过条件 |
|---|---|---|---|
| `process` | 1s | — | `kill(pid, 0)` 成功 |
| `clash_api` | 2s | 1s | `GET /version` 返回 200 且 body 可解析 |
| `data_plane` | 10s | 5s | 经本地 mixed 入站访问探测 URL 成功 |
| `exit_ip` | 连接成功后一次 + 每 60s | 5s | 返回合法 IP |
| `traffic` | 30s | 1s | `/traffic` 连接可建立 |

判定规则：

- `process` 或 `clash_api` 失败 → 该次检查直接判 `HEALTH_FAIL`。
- `data_plane` 失败 → 记失败，但不单独判 `HEALTH_FAIL`（可能只是探测 URL 不可达）。
- `exit_ip` / `traffic` 失败只影响展示，不影响状态。
- 连续 3 次 `HEALTH_FAIL` → `degraded`。

### 4.2 隐私模式（P1 不做）

**结论（2026-11-02 用户拍板）**：P1 **不提供隐私模式开关**，`data_plane` 与 `exit_ip` 检查**默认开启**。设置页里没有对应项。

契约仍然保留 `null` 语义，为 P2 留口子：

| 值 | 含义 |
|---|---|
| `health.exit_ip = null` | **未探测**（检查被关闭，或尚未跑过） |
| `health.exit_ip = "<ip>"` | 探测成功 |
| `health.data_plane = true` | 通过，**或未探测** |
| `health.data_plane = false` | 探测过且失败 |

UI 必须能区分「未探测」与「探测失败」——前者在 P1 不会出现（因为检查恒开），但 P2 加开关后会出现，届时前端不需要改。

> 实现时不要写「`exit_ip == null` 就当失败」的逻辑；`null` 只表示没有数据。

---

## 5. Clash API 封装契约

### 5.1 端口与凭据

| 项 | 规则 |
|---|---|
| 监听地址 | `127.0.0.1`，禁止 `0.0.0.0` / `::` |
| 端口范围 | 49152–65535 |
| 端口选取 | 随机试选 → 以 `SO_REUSEADDR` 绑定探测 → 立即释放 → 交给 sing-box |
| 端口冲突重试 | 最多 5 次，全失败返回 `RUNTIME_PORT_UNAVAILABLE` |
| `secret` | 32 字节 CSPRNG → base64url 无填充（43 字符） |
| 认证头 | `Authorization: Bearer <secret>` |
| `secret` 生命周期 | 仅在本次进程存活期间有效；`stopping` 时清除内存中的副本 |

> Clash API **不支持 Unix socket**，因此必须用回环 TCP。安全依赖三点：只绑回环 + 随机端口 + 随机 secret。

### 5.2 客户端配置

```ts
type ClashApiConfig = {
  base_url: string;        // "http://127.0.0.1:<port>"
  secret: string;
  connect_timeout_ms: number;   // 500
  request_timeout_ms: number;   // 2000
  version_timeout_ms: number;   // 1000
};
```

所有请求：

```
GET <base_url><path>
Authorization: Bearer <secret>
Accept: application/json
```

### 5.3 使用的端点

| 方法 | 路径 | 用途 | 超时 |
|---|---|---|---|
| GET | `/version` | 就绪探测、运行版本 | 1s |
| GET | `/traffic` | 流式上下行速率（NDJSON，约 1s 一条） | 长连接 |
| GET | `/connections` | 活动连接数 | 2s |
| GET | `/proxies` | 出站列表 | 2s |
| GET | `/proxies/{name}/delay?url=<u>&timeout=<ms>` | 延迟测试 | 2s |
| PUT | `/configs?force=true` | 热更新配置 | 5s |
| GET | `/logs?level=<lvl>` | 流式日志 | 长连接 |
| POST | `/close`（若版本支持） | 优雅退出；不支持则发信号 | 2s |

### 5.4 响应类型

```ts
type ClashVersion = {
  version: string;          // 上游版本号，例 "1.14.4"
  meta?: boolean;
};

type ClashDelayResult = {
  delay: number;            // 毫秒；超时或失败时上游返回 4xx/5xx
};

type ClashConnections = {
  download_total: number;
  upload_total: number;
  connections: Array<{ id: string; upload: number; download: number }>;
};
```

### 5.5 上游状态码 → 我们的错误码

| Clash API 返回 | 映射错误码 | 说明 |
|---|---|---|
| 200 | — | 成功 |
| 401 | `RUNTIME_CLASH_UNAUTHORIZED` | secret 不匹配，通常意味着进程被替换 |
| 404 | `NOT_FOUND` | 端点或代理名不存在 |
| 408 / 504 | `TIMEOUT` | 延迟测试超时属于正常业务结果，不当作故障 |
| 其他 4xx | `RUNTIME_CLASH_BAD_REQUEST` | 我们构造的请求体不合法 |
| 5xx | `RUNTIME_CLASH_UPSTREAM_ERROR` | sing-box 内部错误 |
| 连接被拒绝 | `RUNTIME_NOT_RUNNING` | 进程未起或已退出 |

**延迟测试特殊语义**：`/proxies/{name}/delay` 返回非 200 表示「该节点不可用」，这是业务结果，工具层必须返回 `ok: true` + `latency_ms: null`，而不是错误。

### 5.6 日志脱敏

`GET /logs` 的每一行在交给 UI 或 Agent 前必须过脱敏：

- 命中键名 `password`、`uuid`、`short_id`、`private_key`、`token`、`secret`、`key`、`auth` 的值替换为 `***`。
- 不返回目标域名/IP，只返回连接 ID。
- 一行超过 4 KB 时截断并追加 `…(truncated)`。

---

## 6. 错误码表

### 6.1 通用（所有契约共用）

| 码 | 含义 | 可重试 |
|---|---|---|
| `INVALID_ARGUMENT` | 参数不合法 | 否 |
| `NOT_FOUND` | 资源不存在 | 否 |
| `CONFLICT` | 状态冲突（正在启动/停止） | 是 |
| `PRECONDITION_FAILED` | 前置条件不满足 | 否 |
| `PERMISSION_DENIED` | 无权限或审批被拒 | 否 |
| `APPROVAL_REQUIRED` | 需要用户确认 | 确认后重试 |
| `UNSUPPORTED` | 平台/版本不支持 | 否 |
| `TIMEOUT` | 超时 | 是 |
| `CANCELLED` | 用户取消 | 否 |
| `UPSTREAM_ERROR` | 上游错误 | 视情况 |
| `RATE_LIMITED` | 限流 | 是 |
| `INTERNAL` | 未预期错误 | 视情况 |

### 6.2 Runtime 专属

| 码 | 含义 | 可重试 | `details` |
|---|---|---|---|
| `RUNTIME_NOT_INSTALLED` | 磁盘上没有可用版本 | 否 | `{ "hint": "call CoreInstall" }` |
| `RUNTIME_ALREADY_RUNNING` | 已在运行（幂等返回时用 `ok: true`） | 否 | `{ "pid": 1234 }` |
| `RUNTIME_NOT_RUNNING` | 操作要求进程在跑，但当前不在 | 否 | `{ "state": "idle" }` |
| `RUNTIME_BUSY` | 正在 `starting` / `restarting` / `stopping` | 是 | `{ "state": "starting", "retry_after_ms": 1000 }` |
| `RUNTIME_START_TIMEOUT` | 10s 内 Clash API 未就绪 | 是 | `{ "elapsed_ms": 10000 }` |
| `RUNTIME_CRASH_LOOP` | 重启次数耗尽 | 否 | `{ "restart_count": 3 }` |
| `RUNTIME_PORT_UNAVAILABLE` | 5 次都选不到可用端口 | 是 | `{ "tried_ports": [...] }` |
| `RUNTIME_CONFIG_INVALID` | `sing-box check` 失败 | 否 | `{ "field": "outbounds[0].uuid", "stderr": "..." }` |
| `RUNTIME_BINARY_MISSING` | 版本目录里没有可执行文件 | 否 | `{ "version": "1.14.4", "path": "..." }` |
| `RUNTIME_BINARY_NOT_EXECUTABLE` | 有文件但无法执行（权限/架构） | 否 | `{ "os_error": "..." }` |
| `RUNTIME_VERSION_UNSUPPORTED` | 版本不在兼容矩阵内 | 否 | `{ "version": "1.13.0", "supported": "≥1.14.0" }` |
| `RUNTIME_CLASH_UNAUTHORIZED` | Clash API 返回 401 | 否 | `{}` |
| `RUNTIME_CLASH_BAD_REQUEST` | Clash API 返回 4xx | 否 | `{ "path": "/configs" }` |
| `RUNTIME_CLASH_UPSTREAM_ERROR` | Clash API 返回 5xx | 是 | `{ "status": 500 }` |
| `RUNTIME_HEALTH_FAILED` | 连续健康检查失败 | 是 | `{ "failing_checks": ["clash_api"] }` |
| `RUNTIME_EXITED` | 进程已退出 | 视情况 | `{ "exit_code": 1, "signal": null }` |
| `RUNTIME_STOP_TIMEOUT` | 优雅停止 5s 超时 | 是 | `{ "pid": 1234 }` |

### 6.3 错误码命名规则

- `RUNTIME_*` 前缀只用于 Runtime Manager 直接产出的错误。
- 工具层不得重新发明错误码；只能透传或映射到通用码。

---

## 7. 对外事件

Runtime Manager 通过 Host 发出以下事件，payload 定义见 `docs/contracts/events.md`：

| 事件 | 时机 | 载荷 |
|---|---|---|
| `runtime-state-changed` | 任意状态迁移 | `RuntimeStateChangedPayload` |
| `runtime-health-changed` | 健康快照变化（去抖 ≥ 1s） | `RuntimeHealthChangedPayload` |

去抖要求：同一秒内的多次健康变化只发一次，`health.checked_at` 取最新值。

---

## 8. 持久化契约

### 8.1 `runtime-state.json`

```json
{
  "contract_version": "1.0.6",
  "state": "running",
  "pid": 1234,
  "upstream_version": "1.14.4",
  "profile_id": "prf_1",
  "config_hash": "sha256:9a1c...",
  "restart_intent": false,
  "restart_count": 1,
  "system_proxy_enabled": true,
  "last_error": null,
  "updated_at": "2026-11-02T09:15:03Z"
}
```

写入规则：临时文件 + `fsync` + `rename`，权限 `0600`。

### 8.2 崩溃恢复矩阵

| 上次持久化状态 | 应用启动时行为 |
|---|---|
| `running` / `starting` / `restarting` | 尝试恢复 `active` 版本；失败 3 次则回滚 standby |
| `running` + `system_proxy_enabled = true` | 先检查系统代理是否仍指向我们；是则按恢复结果处理 |
| `idle` / `stopping` | 不自动启动；若代理仍指向我们则恢复备份 |
| `failed` | 不自动启动，UI 提示运行诊断 |

---

## 9. 与现有文档的差异

| # | 位置 | 现有文档写法 | 本契约写法 | 理由 |
|---|---|---|---|---|
| 1 | `phase-1-technical-design.md` §4.5 | 状态机画了 `not_installed → installing → installed` | 拆成两套：运行时状态机（本文 §3）+ 版本状态机（Architecture §2.3） | 混在一起无法实现单写者；安装态属于版本，不属于进程 |
| 2 | `architecture.md` §2.2 | `starting` + `CRASH → failed`，但表格里也写「未超限则退避重启」 | 明确：启动阶段崩溃**不重试**，直接 `failed` | 消除歧义；启动即崩通常是配置或架构问题，重试无意义 |
| 3 | `architecture.md` §4.3 | 错误码无 `RUNTIME_*` 系列 | 补齐 17 个 Runtime 专属码 | 通用码无法表达「端口选不到」「secret 不匹配」 |
| 4 | `architecture.md` §2.5 | 健康检查「连续 3 次失败 → degraded」但没定义单项权重 | 定义 `process`/`clash_api` 为硬失败，其余为软失败 | 否则探测 URL 抖动会把正常连接判成 degraded |

---

## 10. 待 PM 拍板

### 10.1 已决议

| 议题 | 决议 | 落点 |
|---|---|---|
| 状态字段用 `upstream_version` 而非 `version` | 采纳 | §2.5、§11 |
| `clash_addr` 不进 UI 快照 | 采纳 | §11 |
| 隐私模式 | **P1 不做，不提供开关**；`data_plane` 与 `exit_ip` 检查默认开启；`null` 语义保留给 P2 | §4.2 |

> P1 实现时按「检查恒开」做，不需要为开关预留配置项；但 `exit_ip: null` 的读取逻辑必须写成「未探测」，不能写成「失败」，否则 P2 加开关时要回头改前端。

### 10.2 仍需 PM 决定

1. **`POST /close` 是否在当前 sing-box 版本可用**。若不可用，停止流程退化为发 `SIGTERM` + 5s 后 `SIGKILL`；需 Bob 在 W1 实测后确认，本文 §5.3 已标注「若版本支持」。

**崩溃重启计数已定**（2026-11-02）：不跨应用持久化，每次应用启动重置为 0，见 §3.4。

---

### 10.3 已关闭的开放项

| 议题 | 结论 | 关闭于 |
|---|---|---|
| 隐私模式 P1 是否启用 | 不做，不提供开关 | 1.0.2 |
| 崩溃重启计数是否持久化 | 不持久化，启动重置 | 1.0.4 |

---

## 11. 对现有实现的字段映射

`src-tauri/src/runtime/manager.rs` 里的 `RuntimeState` 已与本契约完全一致，无需改动。`RuntimeStatus` 与 `RuntimeEvent` 需要对齐：

| 现有（`manager.rs`） | 契约 | 说明 |
|---|---|---|
| `version: Option<String>` | `upstream_version` | 避免与 `app_version` 混淆；清单里也叫 `upstream_version` |
| `restarts: u32` | `restart_count` | 统一名词 |
| `started_at: Option<i64>` | `uptime_seconds` + `last_transition_at` | UI 不需要 unix 时间戳，需要「运行多久」 |
| `last_error: Option<String>` | `last_error: AivpnError \| null` | 字符串无法让 UI 分流（例如区分「端口占用」与「配置错误」） |
| `clash_addr: Option<String>` | **从 UI 快照中移除** | Clash API 地址与 secret 只应在 Host 内部可见；出现在快照里就有被写进日志或事件的风险 |
| 缺 | `mode` / `profile_id` / `config_hash` / `health` / `traffic` / `connections` / `last_transition_at` | 按 §2.5 补齐 |
| `RuntimeEvent::StateChanged { state, detail }` | `runtime-state-changed` payload 的 `from` / `to` / `event` / `error` | `detail` 拆成结构化的 `reason` 与 `error` |
| `RuntimeEvent::Restarting { attempt, reason }` | 用 `runtime-state-changed` 表达（`to = "starting"`，`reason` 带退避说明） | 不为重启单独开事件，UI 少一条分支 |
| `RuntimeEvent::Failed { reason }` | `runtime-state-changed`（`to = "failed"`，`error: AivpnError`） | 同上 |

另需补一个 `impl RuntimeError { pub fn code(&self) -> &'static str }`，把 Rust 错误枚举映射到 §6.2 的错误码；这是 Host → UI → Agent 三层共享的唯一错误标识。

---

## 12. 变更记录

### 1.0.6（2026-11-02）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `contract_version` 升到 `1.0.6` | 元数据 |
| 2 | 无接口变更；与 tools / catalog / events 保持版本一致 | 同步 |

### 1.0.5（2026-11-02，PM 定案）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.5` | 元数据 | PM |
| 2 | 无接口变更；与 tools / events / catalog 保持版本一致 | 同步 | PM |

### 1.0.4（2026-11-02，PM 定案）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.4` | 元数据 | PM |
| 2 | 崩溃重启计数**不跨应用持久化**，每次应用启动重置为 0 | 定案 | PM 决议 3 |
| 3 | 关闭「重启计数是否持久化」开放项，记入 §10.3 | 结项 | PM 决议 3 |

### 1.0.3（2026-11-02，PM 定案）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.3` | 元数据 | PM |
| 2 | 修正 1.0.1 变更记录第 1 条的笔误（「升到 1.0.2」→「升到 1.0.1」） | 笔误 | PM |
| 3 | 无接口变更；与 tools / events / catalog 保持版本一致 | 同步 | PM |

> `runtime.md` 自身仍有两项开放（§10.2）：`POST /close` 可用性、崩溃重启计数是否跨应用持久化。

### 1.0.2（2026-11-02，用户拍板）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.2` | 元数据 | 用户 |
| 2 | 隐私模式**P1 不做**：不提供开关，`data_plane` 与 `exit_ip` 检查默认开启 | 范围收缩 | 用户决议 2 |
| 3 | `null` 语义保留：`exit_ip = null` 只表示「未探测」，实现不得当成失败 | 澄清 | 用户决议 2 |
| 4 | §4.2 由「隐私开关」改写为「隐私模式（P1 不做）」 | 改写 | 用户决议 2 |

### 1.0.1（2026-11-02，PM 审核通过）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 全量升到 `1.0.1` | 元数据 | PM |
| 2 | 明确 `RuntimeStatus` 字段名用 `upstream_version`，并给出对 `manager.rs` 的映射表（§11） | 澄清 | PM 决议 6 |
| 3 | 明确 `clash_addr` 不进 UI 快照 | 澄清 | PM 决议 6 |
| 4 | 隐私模式改为「暂挂」：保留 `null` 语义，P1 按启用实现但可不暴露开关 | 澄清 | PM 决议 9 |
| 5 | 「无字段名冲突仍待定」的两项（`POST /close`、重启计数持久化）保留在 §10.2 | — | — |

### 1.0.0（2026-11-02，初版）

首次冻结：7 态状态机、19 行迁移表、健康检查、Clash API 封装、25 个错误码、持久化与崩溃恢复。
