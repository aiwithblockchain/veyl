# 契约：节点目录服务（Catalog）

> 契约版本：`1.0.9`
> 状态：已冻结（PM 审核通过，2026-11-02）
> 上游：`docs/phase-1-technical-design.md` §4.8、§5.2
> 实现方：Rust（Catalog Client）与 TypeScript / Hono（服务端）
> 变更记录：见 §12

---

## 0. 本契约的地位

本文档定义 **客户端 ↔ 目录服务** 的 HTTP 契约。P1 只包含：设备匿名注册、节点列表查询、节点详情查询、健康上报。

**不做**：账号、支付、节点上下架管理接口、订阅分发。这些属于 P3 / P4。

统一约定：

- 所有字段 **snake_case**；所有时间 **ISO 8601 UTC + `Z`**。
- 所有错误码 **大写下划线**。
- 所有 JSON 请求/响应 **必须**带 `contract_version`。
- 请求 ID：客户端发 `X-Request-Id`（UUID v4），服务端原样回填到响应体与响应头；缺省时服务端生成。

---

## 1. 基础信息

| 项 | 值 |
|---|---|
| Base URL | `https://api.veyl.<tld>/v1` |
| 传输 | HTTPS only，最低 TLS 1.2 |
| 内容类型 | `application/json; charset=utf-8` |
| 鉴权 | `Authorization: Bearer <device_token>` |
| 时间格式 | `2026-11-02T09:15:03Z` |
| 最大请求体 | 16 KB |
| 最大响应体 | 512 KB（节点列表分页上限 50） |

### 1.1 统一成功包

```ts
type ApiOk<T> = {
  contract_version: "1.0.9";
  ok: true;
  request_id: string;
  data: T;
};
```

### 1.2 统一错误包

```ts
type ApiError = {
  contract_version: "1.0.9";
  ok: false;
  request_id: string;
  error: {
    code: CatalogErrorCode;
    message: string;
    retryable: boolean;
    details: Record<string, unknown> | null;
  };
};
```

HTTP 状态码与错误码**同时**存在：状态码给网关与监控看，错误码给客户端逻辑用。客户端分支只认错误码。

> 与 `AivpnError` 的关系：`ApiError.error` 是传输层简化形式，不含 `contract_version` 与 `request_id`（后者在 `ApiError` 顶层）。Catalog Client 把它转成 `AivpnError` 时补上 `contract_version: "1.0.9"` 与 `request_id`，`details` 原样带过。Agent 看到的永远只有 `AivpnError`。

---

## 2. 设备注册

匿名注册。不采集账号、邮箱、手机号。

### 2.1 `POST /v1/devices`

无鉴权。

请求：

```ts
type RegisterDeviceRequest = {
  contract_version: "1.0.9";
  platform: "darwin" | "windows" | "linux";
  arch: "arm64" | "x86_64";
  app_version: string;        // semver，例 "0.1.0"
  device_fingerprint: string; // 见 2.3
};
```

响应 `201 Created`：

```ts
type RegisterDeviceResponse = ApiOk<{
  device_id: string;          // "dev_" + ULID
  device_token: string;       // 32 字节随机，base64url 无填充
  issued_at: string;
  expires_at: string;         // issued_at + 180 天
}>;
```

客户端要求：

1. `device_id` 存 SQLite（明文）。
2. `device_token` 存**本地加密文件** `<data_dir>/secrets.enc`（键 `device_token`，0600，AES-256-GCM）。不使用系统钥匙串——正式版不能弹系统密码框。不得落 SQLite 明文、不得进日志、不得进模型上下文。
3. 注册失败不阻塞应用启动：进入离线模式，用缓存节点列表（若有），否则提示手动导入。

### 2.2 `GET /v1/devices/me`（P2）

> **P1 不做。** 接口在此冻结备用，P2 再加。P1 客户端不调用；token 失效只在下一次目录查询时以 `DEVICE_TOKEN_INVALID` / `DEVICE_TOKEN_EXPIRED` 暴露。

带鉴权。用于启动时校验 token 是否仍有效。

```ts
type DeviceInfoResponse = ApiOk<{
  device_id: string;
  platform: string;
  app_version: string;
  created_at: string;
  last_seen_at: string;
  token_expires_at: string;
}>;
```

### 2.3 设备指纹

```ts
device_fingerprint = base64url(sha256(
  platform + "|" + arch + "|" + 机器稳定标识
))
```

- macOS：`IOPlatformUUID`。
- Windows：`MachineGuid`（`HKLM\SOFTWARE\Microsoft\Cryptography`）。
- **抓不到时用随机 UUID 并持久化到 SQLite**，不采集网卡 MAC、不采集用户名。
- 服务端只用它做「同设备重复注册」去重与滥用限制，不做跨设备关联。

### 2.4 Token 有效期与续期

| 项 | 决定（2026-11-02） |
|---|---|
| 有效期 | **180 天** |
| 续期方式 | **滑动续期**：任一带鉴权的成功调用都会把 `expires_at` 往后推 180 天，服务端在响应头回填 `X-Device-Token-Expires-At` |
| 主动轮换 | P1 **不做** `POST /v1/devices/token` |
| 失效处理 | 返回 `DEVICE_TOKEN_EXPIRED`，客户端清除 `secrets.enc` 中的 `device_token` 并重新注册（§2.1） |
| 客户端缓存 | 收到 `X-Device-Token-Expires-At` 时更新本地记录；距到期 < 7 天在设置页提示「需要重新连接以续期」 |

滑动续期的实现要求：

- 续期是**服务端行为**，客户端只需在收到响应头时更新本地展示。
- 续期只在**鉴权成功**的请求上发生；401 / 429 不续期。
- 续期不能无限延长一个已撤销的 token——撤销优先于续期。

---

## 3. 节点列表

### 3.1 `GET /v1/catalog/nodes`

查询参数：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `region` | string | — | ISO 3166-1 alpha-2 小写，例 `jp` |
| `protocol` | string | — | `vless_reality` \| `hysteria2` \| `shadowsocks` |
| `limit` | int | 10 | 1–50 |
| `cursor` | string | — | 上一页返回的 `next_cursor` |

请求头：

```
Authorization: Bearer <device_token>
If-None-Match: "v12"        # 可选，来自上次响应的 ETag
X-Request-Id: <uuid-v4>
```

响应 `200 OK`：

```
ETag: "v12"
Cache-Control: private, max-age=60
```

```ts
type NodeListResponse = ApiOk<{
  etag: string;              // 不带引号，与响应头去掉引号后一致
  nodes: NodeSummary[];
  next_cursor: string | null;
  fetched_at: string;
}>;
```

`304 Not Modified`：无 body。客户端沿用缓存，只把本地 `fetched_at` 更新为当前时间。

> **ETag 规则**：HTTP 头按 RFC 7232 必须是带双引号的 `"v12"`；响应体里的 `etag` 字段**不带引号**。客户端发 `If-None-Match` 时补引号。这是最容易实现错的点，两端都要有单测。

### 3.2 `NodeSummary`

```ts
type NodeProtocol = "vless_reality" | "hysteria2" | "shadowsocks";

type NodeSummary = {
  id: string;                // "seed-jp-01"
  name: string;              // 展示名，不可信数据
  region: string;            // "jp"
  city: string;              // "Tokyo"
  protocol: NodeProtocol;
  latency_ms: number | null; // 服务端最近一次探测结果
  health_score: number;      // 0.0–1.0
  tags: string[];            // 例 ["seed","streaming"]
  updated_at: string;
};
```

**`NodeSummary` 绝不包含凭据。** 列表接口只用于展示与选择，凭据必须走详情接口，且详情接口的结果不进入模型上下文。

### 3.3 可见性规则（服务端）

| 条件 | 行为 |
|---|---|
| `enabled = false` | 不返回 |
| `health_score < 0.3` 且连续失败 ≥ 3 | 不返回（降权直到恢复） |
| `0.3 ≤ health_score < 0.6` | 返回但排在末尾（P2 起生效；P1 只有 0/1） |
| 免费节点 | 受 5.2 限流约束 |

排序：`health_score DESC, latency_ms ASC NULLS LAST, id ASC`。**排序必须稳定**，否则分页会漏项。

> P1 **不提供运营可控的 `rank` 字段**；排序完全由上述规则决定。若 P2 需要人工置顶，再增加可选 `rank` 并让它优先于健康分。

---

## 4. 节点详情

### 4.1 `GET /v1/catalog/nodes/{node_id}`

返回可直接构建 sing-box 出站的完整描述。

```ts
type NodeDescriptorResponse = ApiOk<{
  etag: string;
  node: NodeDescriptor;
  fetched_at: string;
}>;
```

```ts
type VlessRealityCredentials = { uuid: string };
type Hysteria2Credentials = { password: string };
type ShadowsocksCredentials = { password: string; method: string };

type NodeTls =
  | {
      mode: "reality";
      server_name: string;
      utls_fingerprint: string;       // "chrome"
      reality_public_key: string;
      reality_short_id: string;       // 可为 ""
    }
  | {
      mode: "tls";
      server_name: string;
      utls_fingerprint: string | null;
    }
  | {
      mode: "insecure";               // 仅供内测节点
      server_name: string;
    };

type NodeDescriptor = NodeSummary & {
  server: string;                     // 域名或 IP
  server_port: number;                // 1–65535
  credentials: VlessRealityCredentials | Hysteria2Credentials | ShadowsocksCredentials;
  tls: NodeTls;
  flow: string | null;                // VLESS 专用，例 "xtls-rprx-vision"
  mux: { enabled: boolean; concurrency: number } | null;
};
```

约束：

- `credentials` 与 `tls` **只在详情接口返回**，且要求 Bearer token 有效。
- 客户端拿到后只能写进内存与 `0600` 临时配置，**不得写日志、不得返回给模型、不得写 SQLite 明文**（需要缓存时用 `secrets.enc`）。
- `NodeTls.mode = "reality"` 时 `reality_public_key` 必填且非空。
- **Shadowsocks 的 `method` 白名单**：P1 **只接受 `aes-256-gcm`**。其它 method（如 `chacha20-ietf-poly1305`、`aes-128-gcm`）返回 `UNSUPPORTED`，`details = { "method": "<原值>", "supported": ["aes-256-gcm"] }`，**不降级、不猜测、不尝试**。
- Shadowsocks 节点必须有 `server`、`server_port`、`credentials.password`、`credentials.method`；`tls` 字段对 shadowsocks 无意义，客户端必须忽略。

### 4.2 凭据轮换

凭据可能被服务端轮换。客户端请求详情时若 `etag` 变化，必须重新生成配置。

---

## 5. 健康上报

> **P1 不实现，P2 启用。** 本节接口在 1.0.1 中冻结，用于 Alice / Bob 提前对齐字段，但 P1 的客户端与服务端都**不调用**。P1 的节点健康完全由服务端主动探测（§5.3）产生。

### 5.1 `POST /v1/health/report`

客户端连上后可选上报，用于服务端调权与故障发现。**不参与计费。**（P2）

请求：

```ts
type HealthReportRequest = {
  contract_version: "1.0.9";
  device_id: string;
  node_id: string;
  ok: boolean;
  latency_ms: number | null;   // ok=false 时可为 null
  error_code: string | null;   // 我们侧的 AivpnErrorCode
  sampled_at: string;
};
```

响应 `202 Accepted`：

```ts
type HealthReportResponse = ApiOk<{ accepted: true }>;
```

客户端要求：

- 失败不上报、不重试、不阻塞主流程。
- 同一 `node_id` 最多 1 次 / 60s。
- 隐私模式下完全关闭上报。

### 5.2 服务端聚合（P2）

| 来源 | 权重 |
|---|---|
| 服务端主动探测 | 0.7 |
| 客户端上报 | 0.3 |

滑动窗口 15 分钟。`health_score = clamp(1 - failure_rate, 0, 1)`。

### 5.3 P1 的服务端主动探测

P1 只此一条来源：

| 项 | 规则 |
|---|---|
| 周期 | 每 60 秒 |
| 探测方式 | VLESS Reality 走 TCP 连接；Hysteria2 走 UDP/QUIC 探测 |
| 超时 | 5 秒 |
| 连续失败 | 3 次 → `health_score = 0`，从列表隐藏 |
| 恢复 | 成功一次即恢复，延迟取滑动平均（近 5 次） |
| 落库 | `node_health(node_id, score, latency_ms, consecutive_failures, checked_at)` |

`health_score` 在 P1 只有两种取值：`0`（隐藏）或 `1`（可见）。0.3 / 0.6 的分档是 P2 引入客户端上报后才有意义，P1 实现时不必预留。

---

## 6. 缓存与离线

| 项 | 规则 |
|---|---|
| 缓存位置 | SQLite 表 `catalog_cache` |
| 缓存键 | `region|protocol|limit|cursor` |
| 缓存内容 | 响应体原文 + `etag` + `fetched_at` + `http_status` |
| 过期判定 | `now - fetched_at > 15min` → 标记 `stale = true` |
| 网络失败 | 用缓存，`stale = true`，UI 必须显示「可能过期」 |
| 无缓存 | 返回 `CATALOG_UNAVAILABLE`，但**不阻塞**手动导入节点 |

SQLite 定义（客户端侧）：

```sql
CREATE TABLE catalog_cache (
  cache_key   TEXT PRIMARY KEY,
  etag        TEXT,
  body_json   TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  http_status INTEGER NOT NULL
);
```

---

## 7. 限流

### 7.1 服务端阈值

| 接口 | 维度 | 阈值 |
|---|---|---|
| `POST /v1/devices` | IP | 5 / 小时 |
| `GET /v1/catalog/nodes` | device | 60 / 分钟 |
| `GET /v1/catalog/nodes/{id}` | device | 60 / 分钟 |
| `GET /v1/devices/me` | device | 10 / 分钟（P2） |
| `POST /v1/health/report` | device | 120 / 分钟（P2） |

### 7.2 响应头

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 1762084533
Retry-After: 12
```

`X-RateLimit-Reset` 是 Unix 秒。仅 429 响应必须带 `Retry-After`。

### 7.3 客户端退避

- 429：按 `Retry-After` 等待，最多 3 次；超过则回退缓存。
- 5xx：指数退避 1s / 2s / 4s，最多 3 次。
- 4xx（非 429）：不重试。
- 所有重试共用 5s 的总预算（`phase-1-technical-design.md` §4.8 的请求超时 5 秒）。

---

## 8. 错误码表

| 码 | HTTP | 含义 | 可重试 |
|---|---|---|---|
| `INVALID_ARGUMENT` | 400 | 参数不合法 | 否 |
| `DEVICE_REGISTRATION_FAILED` | 400 / 500 | 注册失败 | 视情况 |
| `DEVICE_TOKEN_INVALID` | 401 | token 不存在或已撤销 | 否（需重新注册） |
| `DEVICE_TOKEN_EXPIRED` | 401 | token 过期 | 否（需重新注册） |
| `DEVICE_NOT_FOUND` | 404 | device_id 不存在 | 否 |
| `NODE_NOT_FOUND` | 404 | 节点不存在或已下线 | 否 |
| `NODE_DISABLED` | 410 | 节点被禁用 | 否 |
| `NODE_UNSUPPORTED_PROTOCOL` | 422 | 客户端不支持该协议 | 否 |
| `CATALOG_UNAVAILABLE` | 503 | 目录服务不可用 | 是 |
| `RATE_LIMITED` | 429 | 限流 | 是 |
| `NOT_MODIFIED` | 304 | 缓存有效（非错误，但作为状态码分支） | — |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超限 | 否 |
| `UNSUPPORTED_CONTRACT_VERSION` | 400 | 契约版本不匹配 | 否 |
| `UPSTREAM_ERROR` | 502 | 服务端内部依赖失败 | 是 |
| `INTERNAL` | 500 | 未预期错误 | 视情况 |

`UNSUPPORTED_CONTRACT_VERSION` 的 `details`：

```json
{ "client_version": "0.9.0", "server_supported": ["1.0.2"] }
```

---

## 9. 安全要求

| 风险 | 措施 |
|---|---|
| 凭据进模型上下文 | 列表接口不返回凭据；详情接口结果直接交给 Config Builder，不经 `ToolResult.content` |
| 提示注入 | `name` / `city` / `tags` 按不可信数据处理，只能用于展示与排序，禁止拼进系统提示 |
| token 泄露 | 只存本地加密文件（机器绑定，拷走无效）；日志脱敏；不上传 |
| 重放 | 所有写接口要求 `X-Request-Id`；服务端对同一 `request_id` 幂等 |
| 中间人 | TLS 1.2+；客户端不做证书 pinning（P1），但拒绝系统时间异常下的连接 |
| 白嫖 | device token + 分层限流 + 健康分降权 |

---

## 10. 与现有文档的差异

| # | 位置 | 现有文档写法 | 本契约写法 | 理由 |
|---|---|---|---|---|
| 1 | `phase-1-technical-design.md` §5.2 | 列表接口直接返回 `server`、`credentials`、`tls` | 拆成列表（摘要）+ 详情（全量凭据） | 现有写法会把 UUID/密码送进模型上下文；P1 的 `catalog_search` 必须无凭据 |
| 2 | 同上 | `protocol: "vless-reality"`（连字符） | `protocol: "vless_reality"`（下划线） | 统一 snake_case，避免前端枚举字符串两套写法 |
| 3 | 同上 | 健康上报无 `contract_version` | 全接口强制 `contract_version` | 便于 P2 演进时拒绝旧客户端 |
| 4 | `phase-1-requirements.md` FR-5.3 | 节点字段含「凭据」 | 明确凭据只在详情接口 | 同上 |
| 5 | 两处文档均未定义 | — | 新增 `X-Request-Id`、ETag 引号规则、限流响应头、`next_cursor` | 不定义就无法并行实现 |

---

## 11. 待 PM 拍板

### 11.1 已决议（1.0.1）

| 议题 | 决议 | 落点 |
|---|---|---|
| 列表接口是否返回凭据 | 不返回；凭据只在详情接口，且只给 Config Builder | §3.2、§4.1 |
| 健康上报何时启用 | **P1 只做服务端主动探测；客户端上报 P2 启用** | §5 全节、§7.1 |
| `protocol` 枚举命名 | `vless_reality` / `hysteria2`（下划线） | §3.2 |

### 11.2 仍需 PM 决定

**无。** 全部开放项已关闭。

| 议题 | 结论 | 关闭于 |
|---|---|---|
| `GET /v1/devices/me` | P1 不做，P2 再加 | 1.0.4 |
| token 有效期 | 180 天，成功调用滑动续期 | 1.0.4 |
| 运营排序 `rank` | P1 不做；客户端按 `health_score` / `latency_ms` 排序 | 1.0.4 |
| 健康上报 | P1 只做服务端探测，客户端上报 P2 | 1.0.1 |

---

## 12. 变更记录

### 1.0.9（2026-11-02，N-03）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.9` | 元数据 | PM |
| 2 | `NodeProtocol` 增加 `"shadowsocks"`（§3.1 查询参数、§3.2 类型） | 枚举扩展 | 用户：手上有真实 SS 节点需验证 |
| 3 | 新增 `ShadowsocksCredentials { password, method }`，并入 `NodeDescriptor.credentials` 联合类型 | 类型新增 | 同上 |
| 4 | 新增 method 白名单：**P1 只接受 `aes-256-gcm`**，其余 `UNSUPPORTED` 且不降级 | 约束 | 无测试覆盖的加密方式不得声明支持 |

### 1.0.8（2026-11-02）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `contract_version` 升到 `1.0.8` | 元数据 |
| 2 | 无接口变更；与 tools / events / runtime 保持版本一致 | 同步 |

### 1.0.7（2026-11-02）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `contract_version` 升到 `1.0.7` | 元数据 |
| 2 | 无接口变更；与 events / tools / runtime 保持版本一致 | 同步 |

### 1.0.6（2026-11-02，用户要求）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.6` | 元数据 | 用户 |
| 2 | `device_token` 从「系统钥匙串」改为本地加密文件 `secrets.enc` 的 `device_token` 键（§2.1、§2.4、§4.1、§9） | 实现约束 | 用户：正式版不能弹系统密码框 |

### 1.0.5（2026-11-02，PM 定案）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.5` | 元数据 | PM |
| 2 | 无接口变更；与其余三份保持版本一致 | 同步 | PM |

### 1.0.4（2026-11-02，PM 定案）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.4` | 元数据 | PM |
| 2 | `GET /v1/devices/me` 标为 **P2**，P1 不实现不调用 | 范围收缩 | PM 决议 3 |
| 3 | token 有效期定为 **180 天 + 成功调用滑动续期**；不做主动轮换接口；新增 `X-Device-Token-Expires-At` 响应头 | 定案 | PM 决议 3 |
| 4 | 明确 P1 **不提供** 运营排序 `rank`，排序由 health/latency 决定 | 定案 | PM 决议 3 |
| 5 | §11.2 清空，全部开放项关闭 | 结项 | PM 决议 3 |

### 1.0.3（2026-11-02，PM 定案）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.3` | 元数据 | PM |
| 2 | 修正 1.0.1 变更记录第 1 条的笔误（「升到 1.0.2」→「升到 1.0.1」） | 笔误 | PM |
| 3 | 无接口变更；与其余三份保持版本一致 | 同步 | PM |

> 当时（1.0.3）`catalog.md` 自身还有三项开放：`GET /v1/devices/me`、token 有效期、`rank`。三项已在 1.0.4 全部关闭，见 §11.2。

### 1.0.2（2026-11-02，用户拍板）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.2` | 元数据 | 用户 |
| 2 | 无内容变更；仅为与 runtime / tools / events 保持版本一致 | 同步 | 用户 |

> 本份受两条新决议的间接影响为零：健康上报已在 1.0.1 降为 P2，隐私模式不做不改变任何接口。

### 1.0.1（2026-11-02，PM 审核通过）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 全量升到 `1.0.1` | 元数据 | PM |
| 2 | 健康上报整节标为 **P2**，P1 不实现；新增 §5.3 描述 P1 唯一的服务端主动探测 | 范围收缩 | PM 决议 8 |
| 3 | `health_score` 在 P1 明确只有 `0` / `1` 两值，分档留到 P2 | 澄清 | PM 决议 8 |
| 4 | 在 §3.3 可见性表与 §7.1 限流表标注哪些条目属于 P2 | 澄清 | PM 决议 8 |
| 5 | 列表摘要 / 详情凭据的拆分维持 1.0.0 结论 | 确认 | PM 决议 3 |

### 1.0.0（2026-11-02，初版）

首次冻结：设备注册、节点列表（ETag）、节点详情、健康上报、缓存、限流、15 个错误码。
