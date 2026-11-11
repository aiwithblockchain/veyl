# 契约：Runtime Manager

> 契约版本：`2.6.0`
> 状态：已定稿（批 0 + 批 3，2026-11-03）
> 冻结前评审：PM / Alice / Bob
> 上游：`docs/architecture.md` §2、`docs/phase-1-technical-design.md` §4.5、`docs/tun-mode.md`
> 实现方：Rust（Host）与 TypeScript（UI）共用本文件
> 变更记录：见 §12

---

## 0. 本契约的地位

本文档定义 **Host ↔ UI ↔ Agent 三方关于 sing-box 运行时的唯一事实来源**。

- 状态枚举、字段名、错误码一经冻结，双方按此实现，不得各写一套。
- 所有 JSON 字段使用 **snake_case**；所有时间是 **ISO 8601 UTC，带 `Z` 后缀**（`2026-11-02T09:15:03Z`），不带毫秒之外的其他格式。
- 所有错误码是 **大写下划线**（`RUNTIME_START_TIMEOUT`）。
- `contract_version` 出现在每一个对外结构里；破坏性变更必须升次版本号并同步本文档。
- **本文件里所有 `contract_version` 的字面量恒等于本文件版本**（当前 `2.6.0`），升版时全文替换。实现侧只允许有一个常量对应本文件，不得按结构分别发不同版本号。

**P1 范围**：单版本、单进程、系统代理模式。多版本并行、TUN、外部 MCP 宿主不在本契约内。

> **2.0 范围变化**：`tun` 模式进入契约（批 5 接线），`profile` 概念换成 `config` + `node`。多版本并行与外部 MCP 宿主仍不在范围内。

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
type RuntimeMode = "system_proxy" | "tun";
```

| 取值 | 含义 | 进入条件 |
|---|---|---|
| `system_proxy` | 起 mixed 入站 + 设置系统代理 | 配置的 `connection_mode = "system_proxy"` |
| `tun` | 起 TUN 入站，接管全部流量 | 配置的 `connection_mode = "tun"`（批 5；特权助手不可用时报 `tun_helper_missing`） |

`disabled`（只起进程不设代理）保留给诊断用，不出现在工具入参里。

**两种模式的字段差异**

| 字段 | `system_proxy` | `tun` |
|---|---|---|
| `mixed_port` | 非空（实际监听端口） | `null`（没有代理入站） |
| `system_proxy_enabled` | 连接后为 `true` | 恒为 `false` |
| `proxy_params` 命令 | `available = true` | `available = false`，`reason = "tun_mode"` |

### 2.3 健康快照

```ts
type HealthCheckName =
  | "process"
  | "clash_api"
  | "data_plane"
  | "exit_ip"
  | "traffic";

type HealthSnapshot = {
  contract_version: "2.6.0";
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
  up_bytes: number;      // 本次运行累计上行字节（/connections 的 uploadTotal）
  down_bytes: number;    // 本次运行累计下行字节（/connections 的 downloadTotal）
  up_rate: number;       // 字节/秒：相邻两次采样差值 ÷ 实际间隔（约 2s）
  down_rate: number;     // 同上
  sampled_at: string;    // ISO 8601 UTC
};
```

**数据来源与频率（按实现，不是设想）：**

| 项 | 值 |
|---|---|
| 数据源 | `GET /connections` 的累计值 `uploadTotal` / `downloadTotal`，单位字节，从 sing-box 进程启动起累加 |
| 采样频率 | **2 秒一次**，与 `clash_api` 健康检查同频（`health_interval`）；不单独起定时器 |
| 速率算法 | 相邻两次采样的差值 ÷ 两次采样的实际间隔。间隔不一定正好 2.000 秒，所以 `up_rate` / `down_rate` 是**约 2 秒的平均值，不是每秒精确值** |
| 第一个样本 | 还没有可比较的上一次采样时，两个速率为 `0`，累计字节是真实值 |
| 采样失败 | **保留上一次的值**，不清零、不报错。失败只影响展示，不影响运行时状态 |
| 重置时机 | 断开时清空；开始新一次连接时清空。上一次连接的流量**不得**带进这一次 |
| TUN 模式 | 恒为 `null`：TUN 的 sing-box 进程不归 `RuntimeManager` 管，采样只覆盖代理模式 |

> **`null` 是「没有数据」，不是「用了 0 字节」。** UI 必须把两者分开显示——把 `null` 渲染成 `0 B/s` 会让用户以为连接没在走流量。

### 2.5 运行时状态快照（`RuntimeStatus` 的 `data`）

```ts
type RuntimeSnapshot = {
  contract_version: "2.6.0";
  state: RuntimeState;
  mode: RuntimeMode | null;
  pid: number | null;
  upstream_version: string | null;   // 例 "1.14.4"；运行中为进程版本，未运行时为可用运行时版本
  runtime_source: "installed" | "bundled" | "none"; // 可用运行时的来源；没有可用运行时为 none
  uptime_seconds: number | null;
  config_id: string | null;          // 2.0：原 profile_id
  config_name: string | null;        // 2.0：原 profile_name
  node_id: string | null;            // 2.0 新增：本次实际连接的节点
  node_name: string | null;          // 2.0 新增
  connected_since: string | null;    // 本次进入 running 的 ISO 8601 UTC 时刻
  mixed_port: number | null;         // 本地 mixed 入站实际监听端口；tun 模式为 null
  port_fallback: {                   // 用户设置端口没用上、本次使用别的端口时非 null
    requested: number;               // settings.proxy_port
    actual: number;                  // = mixed_port
    reason: "occupied" | "unavailable"; // 被占用 / 环境绑不上（如 <1024 无权限）
  } | null;
  latency_ms: number | null;         // 出口 IP 探测往返耗时
  node_latency_ms: number | null;    // 2.3：到节点的真实延迟（Clash API delay 测试）
  direct_ip: string | null;          // 不经代理的直连出口 IP
  config_hash: string | null;        // "sha256:<hex>"，配置文件的摘要
  applied_route_revision: number | null; // 2.1：建连时 configs.route_revision 的值
  route_region: string | null;       // 2.5：生成当前配置时判定的地区（小写 cc；未知为 null）
  system_proxy_enabled: boolean;
  system_dns: "tunnel" | "unchanged" | null; // 2.6：连接期系统解析器是否已指向隧道
  health: HealthSnapshot;
  traffic: TrafficStats | null;
  connections: number | null;        // 活动连接数，来自 /connections
  restart_count: number;             // 本次启动周期内的崩溃重启次数
  last_error: AivpnError | null;
  last_transition_at: string;        // ISO 8601 UTC
};
```

实现要求：

- `pid` / `uptime_seconds` 在 `idle` 与 `failed` 下**必须为 `null`**，不得为 0 或空串。
- `upstream_version` 未运行时**不得为 `null`**（只要还有可用运行时）：取当前可用运行时的版本，来源见 `runtime_source`。只有既没有已安装版本、随包也不可用时才为 `null`。
- `runtime_source` 恒存在，取值只有 `installed` / `bundled` / `none`。**「未运行」不等于「不可用」**：`state = idle` 且 `runtime_source = bundled` 表示运行时可用、只是没连接。
- `traffic` 为 `null` 表示**没有数据**，不是 0 字节。具体是：未连接（`idle` / `failed`）、刚连上还没采到第一个样本、TUN 模式（采样不覆盖）。采样失败时保留上一次的值，**不得清成 0**。
- `config_hash` 用于 UI 判断「配置是否变化」，不是安全校验手段。
- `mode` 在 `idle` / `failed` 下为 `null`；在 `starting` / `running` / `restarting` / `degraded` / `stopping` 下非 `null`。

#### 2.5.1 字段语义（**每条都必须按此实现**）

| 字段 | 取值 | 不变量 |
|---|---|---|
| `upstream_version` | sing-box 版本号 | 运行中 = 进程实际版本；未运行 = 当前可用运行时版本（已安装且可执行 > 随包）。只有两份都不可用时才为 `null`。**不得**把「未运行」写成 `null` 或「未安装」 |
| `runtime_source` | `installed` / `bundled` / `none` | 描述当前可用运行时的来源。`none` 表示既没有已安装版本、随包也不可用——这是**唯一**可以对外说「运行时不可用」的情形 |
| `config_id` / `config_name` | 当前连接所用的配置 | 与 `node_id` 同生同灭；未连接时为 `null`。2.0 之前叫 `profile_id` / `profile_name`，**没有默认配置包的特殊情形**——没有配置就报 `no_config`，不存在 `config_id = null` 但 `config_name` 非空的合法状态 |
| `node_id` / `node_name` | 本次实际连接的节点 | 未连接时为 `null`；连接中切换节点后立即变新值（热切换不重启进程） |
| `connected_since` | 本次进入 `running` 的时刻，ISO 8601 UTC | 仅在 `running` / `degraded` 下非 `null`；与 `uptime_seconds` **同源**：`uptime_seconds ≈ now − connected_since`。两者不得互相矛盾 |
| `mixed_port` | 本次实际监听的本地 mixed 入站端口 | `mode = "system_proxy"` 且状态为 `running` / `degraded` 时非 `null`；`tun` 模式恒为 `null`。端口来自用户设置 + 候选链（§5.1），**禁止写常量** |
| `port_fallback` | 用户设置的端口没用上、本次改用别的端口 | `mode = "system_proxy"`、`running` / `degraded` 且 `actual != requested` 时非 `null`；TUN 与未连接恒为 `null`。`requested` 是 `settings.proxy_port`，`actual` 等于 `mixed_port`，`reason` 只有 `"occupied"` / `"unavailable"` 两个值 |
| `latency_ms` | 最近一次**出口 IP 探测**的往返耗时（毫秒） | 未探测/探测失败为 `null`。**不是**节点 ping 延迟 |
| `node_latency_ms` | 最近一次 **Clash API delay 测试**的毫秒数：`GET /proxies/node-<id>/delay?url=<generate_204>`，由 sing-box 自己去连节点 | 未连接、还没测到、或当前没有选中节点（`node_id = null`）时为 `null`。**与 `latency_ms` 是两个指标，不得互相填充**：`latency_ms` 是含 DNS + TLS 的整次 HTTP 往返（实测常在 2000 ms 量级），`node_latency_ms` 是节点本身的可达性与往返。断开、失败、节点热切换后必须复位为 `null`，不能把上一个节点的数字留在面板上 |
| `applied_route_revision` | 本次连接生成配置时的 `configs.route_revision` | 建连时读入并随进程保存；未连接为 `null`。与库里的 `route_revision` 比较：相等 = 分流规则已生效，不等 = 改了但当前连接还没用上，UI 显示「下次连接生效」 |
| `route_region` | 生成本次运行配置时判定的地区（小写 cc，未知为 `null`） | 建连时随 plan 保存，**不因用户中途改系统时区而重算**。已连接时界面显示的地区与直连口径以它为准；`route_get.detected_region` 是实时重算值，两者可能不同。**`null` 表示当时判不出地区，不是「回退到实时值」的开关**——已连接时按「未知」显示。地区未知时本次连接**不做本地直连层**（`geoip-<cc>`/`geosite-cn` 为空，DNS 走国际组） |
| `direct_ip` | 不经代理测得的**直连**出口 IP | 与 `exit_ip` 配对展示，用于让用户判断「是否真的走了代理」。未测到为 `null`。**不得**在探测时带上系统代理，否则两个值会相同、失去意义 |
| `system_dns` | `"tunnel"` / `"unchanged"` / `null` | **只有真的把系统解析器切到隧道才报 `"tunnel"`**（TUN 连接期把当前网络服务的 DNS 指向 utun 对端，查询进 TUN 后被 `hijack-dns` 接住）。切不过去（降级）报 `"unchanged"`——**界面必须据此常驻一行提示，不能静默**：此时境外域名仍走运营商 DNS，可能解析到污染地址、国外网站变慢。未连接、`failed`、`system_proxy` 模式恒为 `null`。DNS 接管是优化项，失败**不**影响连接状态（见 `tun-backend.md` §5.2.2） |

**`latency_ms` 的定义必须固定为「出口 IP 探测往返耗时」**，理由是它已经有实现、有含义，且能在没有额外网络请求的前提下反映链路质量。

> 若要展示「到节点的 ping / 握手延迟」，用 `node_latency_ms`（2.3 新增）或 `node_probe` 的 `latency_ms`，**不能复用 `latency_ms`**。两个不同含义共用一个字段名，会让状态面板的数字无法解释。

**字段恒存在**：所有字段在任何状态下都必须出现在 JSON 里，不可省略键。没有值写 `null`——省略键会让 TypeScript 消费方拿到 `undefined`，绕过类型检查、静默失败。

**与 `last_transition_at` 的区别**：`last_transition_at` 是**任何**状态迁移的时刻（含 `stopping`），`connected_since` 只在进入 `running` 时刷新。断开再连，`connected_since` 变新，`last_transition_at` 也变——两者不同源，不要互相推导。

### 2.6 错误对象（全契约共用）

```ts
type AivpnError = {
  contract_version: "2.6.0";
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
| `node_latency` | 连接成功后一次 + 每 30s | 6s（上游 `timeout=3000`） | `GET /proxies/node-<id>/delay` 返回 200 且 `delay` ≥ 0。非 200 表示**节点不可达**——那是业务结果，写进 `node_latency_ms = null`，**不判 `HEALTH_FAIL`**（同 §4.3 的延迟测试特殊语义）。单独 spawn，不阻塞 2s 健康循环 |
| `traffic` | 2s（与 `clash_api` 同频） | 2s | `GET /connections` 返回 200 且 body 可解析；取 `uploadTotal` / `downloadTotal` 算累计与速率 |

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
| 端口冲突重试 | 本地代理（mixed）端口：`[用户设置] → 7890–7899 → 系统分配`，先预检查；启动时被抢（bind 竞态）最多试 3 个候选，全失败返回 `RUNTIME_PORT_UNAVAILABLE`（`details.tried_ports`）。Clash API 端口仍随机选取，且不得与 mixed 端口相同 |
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
| GET | `/connections` | 活动连接数；**累计流量 `uploadTotal` / `downloadTotal`**（`traffic` 的唯一数据源） | 2s |
| GET | `/proxies` | 出站列表 | 2s |
| GET | `/proxies/{name}/delay?url=<u>&timeout=<ms>` | 延迟测试（`node_latency_ms` 与 `NodeProbe` 的唯一数据源） | 6s（上游 `timeout=3000`） |
| PUT | `/configs?force=true` | 热更新配置 | 5s |
| GET | `/logs?level=<lvl>` | 流式日志 | 长连接 |
| POST | `/close`（若版本支持） | 优雅退出；不支持则发信号 | 2s |

> **`/traffic`（NDJSON 流式，约 1s 一条）当前不使用——它是路线图项，不是现状。** 现有实现用 `/connections` 的累计值做差分（见 §2.4）：2 秒一个样本、速率取平均值，已能满足展示需要。将来若要更细的每秒速率，可以改用 `/traffic`，那是一次独立的优化，不影响本契约的 `TrafficStats` 形状。**实现方不要把它当成已接通的端点。**

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
| `RUNTIME_PORT_UNAVAILABLE` | 候选链最多 3 个候选都失败 | 是 | `{ "tried_ports": [...] }` |
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
| `RUNTIME_SWITCH_FAILED` | 在线切换节点失败（进程未重启，出口未变） | 是 | `{ "from_node_id": "...", "to_node_id": "..." }` |

### 6.3 错误码命名规则

- `RUNTIME_*` 前缀只用于 Runtime Manager 直接产出的错误。
- 工具层不得重新发明错误码；只能透传或映射到通用码。

---

## 7. 对外事件

Runtime Manager 通过 Host 发出以下事件，payload 定义见 `docs/contracts/events.md`：

| 事件 | 时机 | 载荷 |
|---|---|---|
| `runtime-state-changed` | 任意状态迁移 | `RuntimeStateChangedPayload`，**必须带 `snapshot`**（`events.md` §4.1） |
| `runtime-health-changed` | 健康快照变化（去抖 ≥ 1s） | `RuntimeHealthChangedPayload` |

去抖要求：同一秒内的多次健康变化只发一次，`health.checked_at` 取最新值。

**在线切换节点不发 `runtime-state-changed`**：进程没停、状态没迁移，只是出口换了。它由 `node-switched`（`events.md` §4.11）表达，载荷里带切换后的 `RuntimeSnapshot`。

---

## 8. 持久化契约

### 8.1 `runtime-state.json`

```json
{
  "contract_version": "2.1.0",
  "state": "running",
  "mode": "system_proxy",
  "pid": 1234,
  "upstream_version": "1.14.4",
  "config_id": "cfg_1a2b3c4d5e6f7788",
  "node_id": "nod_1a2b3c4d5e6f7788",
  "config_hash": "sha256:9a1c...",
  "applied_route_revision": 3,
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
| 缺 | `mode` / `config_id` / `node_id` / `config_hash` / `health` / `traffic` / `connections` / `last_transition_at` | 按 §2.5 补齐 |
| `RuntimeEvent::StateChanged { state, detail }` | `runtime-state-changed` payload 的 `from` / `to` / `event` / `error` | `detail` 拆成结构化的 `reason` 与 `error` |
| `RuntimeEvent::Restarting { attempt, reason }` | 用 `runtime-state-changed` 表达（`to = "starting"`，`reason` 带退避说明） | 不为重启单独开事件，UI 少一条分支 |
| `RuntimeEvent::Failed { reason }` | `runtime-state-changed`（`to = "failed"`，`error: AivpnError`） | 同上 |

另需补一个 `impl RuntimeError { pub fn code(&self) -> &'static str }`，把 Rust 错误枚举映射到 §6.2 的错误码；这是 Host → UI → Agent 三层共享的唯一错误标识。

---

## 12. 变更记录

### 2.6.0（2026-11-09，连接期系统 DNS 状态）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 契约版本升到 `2.6.0`；`RuntimeSnapshot` 新增 `system_dns: "tunnel" \| "unchanged" \| null` | 字段新增（非破坏性） | TUN 连接期把系统解析器指向隧道，接管失败必须可见；DNS 是优化项，失败不阻断连接 |
| 2 | 语义：`"tunnel"` 仅表示系统解析器已真的指向隧道；`"unchanged"` 表示降级，界面必须常驻提示；未连接 / `failed` / `system_proxy` 恒为 `null` | 语义说明 | 不让降级变成静默 |

### 2.5.0（2026-11-07，记录本次连接所用地区）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 契约版本升到 `2.5.0`；`RuntimeSnapshot` 新增 `route_region: string \| null` | 字段新增 | 运行配置不会因用户中途改时区而重算，界面要显示**实际生效**的地区 |
| 2 | 地区未知时本次连接不做本地直连层（无 `geosite-cn` / `geoip-<cc>`，DNS 用国际组）；判定来源见 `commands.md` §10.10 与 `routing.md` §3.7 | 语义说明 | `design/create-config.md` §7.5 |

### 2.4.0（2026-11-06，本地代理端口可设置）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 契约版本升到 `2.4.0` | 元数据 | 端口设置落地 |
| 2 | §5.1 端口冲突重试改为：本地代理端口候选链 `[设置] → 7890–7899 → 系统分配`，预检查 + bind 竞态最多 3 个候选；Clash API 端口仍随机且不得与 mixed 相同 | 语义变更 | 用户设置的端口被占时顺延并说明，不再随机换掉 |
| 3 | `RUNTIME_PORT_UNAVAILABLE` 从「已定义未实现」变为真实现：`details.tried_ports` 为本轮试过的端口 | 实现约束 | 预检查通过后 bind 前仍可能被抢 |
| 4 | `RuntimeSnapshot.port_fallback`（`commands.md` §7.3）：设置端口没用上、本次用别的值时回显 `{ requested, actual, reason }`；`reason` 区分 `occupied`（被占）与 `unavailable`（环境绑不上，如 <1024 无权限）；TUN 与未连接为 null | 字段扩展 | 界面不能把权限失败说成「被别的软件占用了」 |

### 2.3.0（2026-11-05，节点延迟与出口延迟分开）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 契约版本升到 `2.3.0` | 元数据 | 产品：「2098 毫秒」那类数字是出口 IP 探测，不是节点延迟 |
| 2 | §2.5 / §2.5.1 新增 `node_latency_ms: number \| null`：Clash API delay 测试的毫秒数 | 字段新增 | 同上 |
| 3 | 明确 `latency_ms` 与 `node_latency_ms` **不得互相填充**；断开 / 失败 / 节点热切换后 `node_latency_ms` 必须复位为 `null` | 不变量 | 防止把上一个节点的数字留在面板上 |
| 4 | §4.1 健康检查表新增 `node_latency`：连接后一次 + 每 30s，6s 超时（上游 `timeout=3000`），测不到不等于不健康；§5.3 的 delay 超时由 2s 修正为实际的 6s | 新增检查项 | 与实现一致（`LATENCY_REFRESH_INTERVAL`），避免对节点另起一套探测节奏 |
| 5 | §2.3 / §2.5 / §2.6 的 `contract_version` 字面量统一为本文件版本 | 元数据 | 见 §0 的版本约定 |
| 6 | §2.5 / §2.5.1 新增 `runtime_source`；`upstream_version` 未运行时改为报告可用运行时版本，不再恒为 `null` | 字段新增 / 语义修正 | 真机缺陷：未连接时被误报成「运行时未安装」，AI 因此提议安装已内置的运行时 |

### 2.2.0（2026-11-04，流量采样的真实口径）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 契约版本升到 `2.2.0`（与 `events.md` 2.2.0 同一次改动） | 元数据 | 流量采样落地 |
| 2 | §2.4 改成按实现写：数据源 `GET /connections` 的 `uploadTotal` / `downloadTotal`，2 秒一次，速率是相邻两次差值的平均值（首样本为 0；失败保留上次值；断开与新连接都重置；TUN 恒 `null`） | 语义修正 | 实现 `0576da4` |
| 3 | §2.5 删除「其余状态不得为 `null`」：`null` 表示没有数据，未连接 / 尚未采到 / TUN 都是 `null`，不是 0 字节 | 语义修正 | 同上；把 `null` 渲染成 0 会让用户误判 |
| 4 | §4.1 健康检查表：`traffic` 由「30s 一次、探测 `/traffic` 可连通」改为「2s 一次、`/connections` 可解析」 | 修正 | 同上 |
| 5 | §5.3 把 `/traffic` 从「使用的端点」移出，明确标为**未实现的可选优化**，不是现状 | 澄清 | 代码里除注释外没有任何 `/traffic` 引用 |

> 本文件版本升到 `2.2.0` 表示**语义**已更新；线上 `RuntimeSnapshot.contract_version` 当时仍是 `2.1.0`，已在 2.3.0 这次一并改齐。

### 2.1.0（2026-11-03，批 3 · 分流与 DNS）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.1.0` | 元数据 | 批 3 |
| 2 | `RuntimeSnapshot` 增加 `applied_route_revision`，回答「当前连接用的是哪一版分流规则」 | 字段新增 | PM 裁定 6 |
| 3 | `runtime-state.json` 同步持久化该字段 | 持久化 | 崩溃恢复后仍能比较 |

### 2.0.0（2026-11-03，批 0 · 契约与数据模型）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.0.0` | 元数据 | 数据单位从 profile 换成 config + node |
| 2 | `RuntimeMode` 扩展为 `"system_proxy" \| "tun"`，并写明两种模式的字段差异 | 枚举扩展 | `docs/tun-mode.md`；批 5 接线 |
| 3 | `RuntimeSnapshot.profile_id` / `profile_name` 改名 `config_id` / `config_name` | 不兼容 | 同一实体只能有一个名字 |
| 4 | 新增 `node_id` / `node_name`：本次实际连接的节点 | 字段新增 | `node_switch` 需要表达「连的是哪台」 |
| 5 | 删除「默认配置包连接时 `profile_id = null` 而 `profile_name` 非空」的特例 | 语义修正 | `runtime_start` 不再有无配置回退（`commands.md` §7.1） |
| 6 | `mixed_port` 不变量改为「`system_proxy` 且 running/degraded 时非空；`tun` 恒为 null」 | 语义修正 | TUN 没有代理入站 |
| 7 | 新增错误码 `RUNTIME_SWITCH_FAILED` | 新增错误码 | 在线换节点失败必须可区分于「启动失败」 |
| 8 | §7 明确在线切换节点不发 `runtime-state-changed` | 澄清 | 进程没迁移，只有出口变了 |
| 9 | `runtime-state.json` 字段同步改名 | 持久化 | 崩溃恢复 |

### 1.1.0（2026-11-02，P1.5 wave1）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.1.0` | 元数据 | PM |
| 2 | `RuntimeSnapshot` 新增 `mixed_port` / `profile_name` / `connected_since` / `latency_ms` 四个字段 | 字段新增 | 需求 §9.6、§10 |
| 2b | **架构补入** `direct_ip`：需求 §9.2 要求「出口 IP 与直连 IP 都要显示」，而 PM 的四字段清单里没有它 | 字段新增 | 需求 §9.2；待 PM 确认 |
| 3 | 新增 §2.5.1 固定四个新字段的语义与不变量（含 `latency_ms` = 出口 IP 探测耗时，**不是**节点 ping） | 语义定案 | 架构 |
| 4 | 明确「四个新字段在任何状态下都必须出现，无值写 `null`，不得省略键」 | 约束 | 省略键会让 TS 侧拿到 `undefined` |
| 5 | `connected_since` 与 `uptime_seconds` 同源；与 `last_transition_at` 不同源，不得互相推导 | 约束 | 防止两套时间互相打架 |
| 6 | `profile_name` 的不变量放宽：默认配置包连接时 `profile_id` 为 `null` 而 `profile_name` 非空 | 语义修正 | `runtime_start` 支持无 profile 时用默认包连接 |

### 1.0.10（2026-11-02）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `contract_version` 升到 `1.0.10` | 元数据 |
| 2 | 无接口变更；与 events 的 `import_seed_file` 同步版本 | 同步 |

### 1.0.9（2026-11-02）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `contract_version` 升到 `1.0.9` | 元数据 |
| 2 | 无接口变更；与 catalog / tools / events 保持版本一致 | 同步 |

### 1.0.8（2026-11-02，用户决定移除审批）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.8` | 元数据 | PM |
| 2 | 通用错误码表删除 `APPROVAL_REQUIRED` —— 审批机制移除后 Host 不再产生该码 | 移除 | 用户：彻底移除审批 |
| 3 | 其余接口不变；与 tools / events / catalog 保持版本一致 | 同步 | 同上 |

### 1.0.7（2026-11-02）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `contract_version` 升到 `1.0.7` | 元数据 |
| 2 | 无接口变更；与 events / tools / catalog 保持版本一致 | 同步 |

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
