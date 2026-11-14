# Veyl 架构文档

> 版本：v0.2
> 日期：2026-10-30
> 对应需求：`docs/requirements.md` v0.5
> 范围：进程边界、Runtime Manager 状态机、版本清单格式、MCP 工具接口

---

## 0. 本文档解决什么

需求文档确定了「做什么」，本文档确定「怎么拼起来」。四个核心问题：

1. **进程边界**：谁跑在哪个进程里，谁能杀谁，崩溃时谁活着。
2. **Runtime Manager 状态机**：sing-box 从安装到激活到回滚的完整状态与迁移条件，以及启动/停止/重启的语义。
3. **版本清单格式**：如何签名、如何校验、如何防止被降级或投毒。
4. **MCP 工具接口**：Agent 能调用什么、参数与返回长什么样、哪些必须人工确认。

> 前提（v0.5 变更）：**不使用 fork，不修改 sing-box 源码**。App 下载官方发行版，用官方公开 API 控制。

---

## 1. 组件与进程边界

### 1.1 进程拓扑

```
┌──────────────────────────────────────────────────────────────┐
│ veyl-app（Tauri 主进程，Rust + WebView）                     │
│                                                              │
│  ┌────────────────┐   Tauri invoke   ┌────────────────────┐  │
│  │ WebView (TS)   │ ◄──────────────► │ Rust Host          │  │
│  │ 对话/状态/向导  │   Tauri events   │  ├ AivpnSession    │  │
│  └────────────────┘                  │  │  (Claurst crates)│  │
│                                      │  ├ VPN Tools        │  │
│                                      │  ├ Runtime Manager  │  │
│                                      │  ├ Approval Broker  │  │
│                                      │  └ SQLite / Keychain│  │
│                                      └─────┬──────────────┘  │
└────────────────────────────────────────────┼─────────────────┘
                                             │ HTTP 127.0.0.1:<随机端口>
                                             ▼
                                  ┌──────────────────────────┐
                                  │ sing-box（子进程）        │
                                  │ 官方发行版，未修改         │
                                  │ Clash API / 数据面         │
                                  └──────────────────────────┘
```

> Claurst 以 Rust crate 形式链接进主进程（参考 TweetPilot 的 `claurst_session.rs`），不再是子进程。外部宿主接入用的 MCP 桥属于 P2。

### 1.2 进程职责与生存期

| 进程 | 语言 | 职责 | 崩溃影响 | 谁负责重启 |
|---|---|---|---|---|
| `veyl-app` | Rust + TS | UI、Agent（Claurst crates）、工具、Runtime Manager、审批、存储 | 全部结束 | 用户 / 系统 |
| `sing-box` | Go（官方） | 代理数据面、Clash API、V2Ray Stats API | 连接中断，UI 仍可用 | Runtime Manager |
| `veyl-mcp`（P2） | Rust | 外部宿主的 MCP 桥 | 外部 Agent 中断 | 外部宿主 |

**设计约束**

- 任何子进程崩溃都**不得**带走主进程。
- Runtime Manager 是**唯一**能启动/停止 `sing-box` 的组件。
- Agent 通过 Claurst `Tool` trait 调用工具，不直接操作进程。
- Agent 只注册 VPN 相关工具，不注册 shell / 文件工具。

> **安全边界说明**：Claurst 与主进程同地址空间，所谓「无 shell、无文件」是靠**不注册相应工具**实现的逻辑约束，不是 OS 级沙箱。因此工具实现必须自己做参数校验，不能把任意输入拼进命令行。

### 1.3 IPC 契约

| 链路 | 协议 | 端点 | 认证 |
|---|---|---|---|
| UI ↔ Host | Tauri invoke / events | 进程内 | 无 |
| Agent ↔ 工具 | 直接函数调用（Claurst `Tool` trait） | 进程内 | 无 |
| Host ↔ sing-box | HTTP over TCP | `127.0.0.1:<随机端口>` | `Authorization: Bearer <随机 secret>` |
| 外部宿主 ↔ Host（P2） | MCP stdio → 本地 JSON-RPC | `veyl.sock`（0600） | 文件权限 + 一次性握手 Token |
| Host ↔ 控制面 | HTTPS + WebSocket | `api.veyl.*` | 钱包签名会话 |

> 注意：sing-box 的 Clash API 官方只支持 TCP 监听地址，**不支持 Unix socket**。因此控制通道用回环 TCP：端口随机、`secret` 每次启动随机生成、只绑 `127.0.0.1`。

**使用的 Clash API 端点**

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/version` | 就绪探测、运行版本 |
| GET | `/connections` | 活动连接（默认脱敏）；累计流量取 `uploadTotal` / `downloadTotal` |
| GET | `/proxies` | 出站列表 |
| GET | `/proxies/{name}/delay` | 节点延迟测试 |
| PUT | `/configs?force=true` | 热更新配置 |
| GET | `/logs?level=` | 流式日志（用于 `runtime.logs`，脱敏后返回） |

**V2Ray Stats API（仅节点侧）**

- 在服务端配置中启用 `experimental.v2ray_api`。
- 通过 gRPC `StatsService` 查询按用户维度的上下行累计值。
- 绑定 `127.0.0.1`，只允许本机 agent 访问。

### 1.4 信任边界

| 区域 | 信任级别 | 能做什么 | 限制 |
|---|---|---|---|
| WebView | 低 | 渲染、发 invoke | 不能直接读写文件/进程 |
| Rust Host | 高 | 全部控制逻辑 | 需校验所有外部输入 |
| Agent (claurst，进程内) | 中 | 调 VPN 工具 | 逻辑约束：不注册 shell/文件工具；工具参数必须强校验 |
| sing-box | 中 | 数据面 | 只受回环 Clash API 控制 |
| 控制面 | 外部 | 元数据 | 不下发可执行命令 |

**规则**：Agent 的输出是不可信输入；Tool Server 必须按 schema 校验参数，并对高风险工具走审批。

---

## 2. Runtime Manager

> **已冻结**：状态机、健康检查、Clash API 封装与错误码以 `docs/contracts/runtime.md` v1.0.5 为准。本节保留设计意图；两者冲突时以契约为准（差异清单见契约 §9）。

### 2.1 职责

1. 维护版本目录（已安装、可用、隔离）。
2. 下载、校验、解压、探活、安装、激活、回滚。
3. 管理 `sing-box` 进程生命周期（启动 / 停止 / 重启）。
4. 生成配置、做 schema 兼容检查、下发配置。
5. 健康检查与看门狗。
6. 向 UI 与 Agent 发布状态事件。

### 2.2 状态机 A：运行时（Runtime）

| 状态 | 含义 |
|---|---|
| `idle` | 没有运行中的 sing-box |
| `starting` | 进程已拉起，等待 Clash API 就绪 |
| `running` | 健康检查通过，可承载流量 |
| `degraded` | 进程存活但健康检查连续失败 |
| `restarting` | 收到重启请求，先停后起 |
| `stopping` | 正在优雅退出 |
| `failed` | 无法启动或已放弃重启 |

事件：

| 事件 | 触发 |
|---|---|
| `START_REQ` | 用户连接 / `runtime.start` / 启动恢复 |
| `PROCESS_READY` | Clash API `/version` 首次成功 |
| `HEALTH_OK` | 周期检查成功 |
| `HEALTH_FAIL` | 周期检查失败 |
| `CRASH` | 进程退出或启动超时 |
| `STOP_REQ` | 用户断开 / `runtime.stop` / 退出应用 |
| `RESTART_REQ` | `runtime.restart` / 恢复策略 |
| `STOPPED` | 进程已退出 |
| `GIVE_UP` | 重启次数耗尽 |

迁移表：

| 当前 | 事件 | 下一状态 | 动作 |
|---|---|---|---|
| `idle` | `START_REQ` | `starting` | 选版本 → 写配置 → spawn；启动超时 10s |
| `idle` | `RESTART_REQ` | `starting` | 等价于启动 |
| `starting` | `PROCESS_READY` | `running` | 启动健康检查（2s） |
| `starting` | `CRASH` | `failed` | 计数 +1；未超限则退避重启 |
| `running` | `HEALTH_FAIL` | `degraded` | 连续失败计数 +1；≥3 进入 degraded |
| `running` | `CRASH` | `starting` | 退避 1s/2s/4s，最多 3 次 |
| `running` | `RESTART_REQ` | `restarting` | 记录 `restart_intent=true`，执行停止 |
| `running`/`degraded` | `STOP_REQ` | `stopping` | 先关系统代理，再 `/close` |
| `degraded` | `HEALTH_OK` | `running` | 清零计数 |
| `degraded` | 30s 未恢复 | `restarting` | 自动重启；次数耗尽转 `failed` |
| `degraded` | `RESTART_REQ` | `restarting` | 记录 `restart_intent=true` |
| `restarting` | `STOPPED` | `starting` | 用同一版本重新拉起 |
| `restarting` | `CRASH` | `failed` | 重启失败，进入 failed |
| `stopping` | `STOPPED` | `idle` | 清理临时配置与 secret |
| `starting`/`running`/`restarting` | `GIVE_UP` | `failed` | 上报错误；若存在上一版本则触发回滚 |
| `failed` | `START_REQ` | `starting` | 用户手动重试；先做一次自检 |

不变量：

- 同一时刻最多一个 `sing-box` 进程。
- 进入 `stopping` 前必须已关闭系统代理。
- `failed` 状态不自动重试，避免无限循环。
- `restart_intent` 只能由 `RESTART_REQ` 置位，`STOP_REQ` 必须清除，防止「以为在重启其实已停止」。
- 所有迁移写 `runtime-events.log`（结构化，含版本号与错误码）。

### 2.3 状态机 B：版本（Runtime Version）

```
available → downloading → verifying → installed → probing → standby ⇄ active
                                  │                    │
                                  └──── failed ◄───────┘
active → quarantined（运行期多次失败）
```

| 状态 | 含义 | 可执行操作 |
|---|---|---|
| `available` | 清单中存在，未下载 | install |
| `downloading` | 下载中（可断点/可取消） | cancel |
| `verifying` | 校验签名、sha256、大小 | — |
| `installed` | 已解压，未验证可运行 | uninstall |
| `probing` | `sing-box version` + `sing-box check` | — |
| `standby` | 可用但非当前 | activate |
| `active` | 当前使用 | rollback / quarantine |
| `failed` | 校验或探活失败 | 删除 |
| `quarantined` | 运行期多次失败，禁止自动使用 | 手动解除或删除 |

**激活规则**

- 激活前必须处于 `standby` 或 `installed` 且探活通过。
- 激活 = 停止当前进程 → 原子写 `runtime-state.json` → 启动新进程 → 健康检查 → 成功则标记 `active`，旧版本置 `standby`。
- 健康检查失败 → 恢复旧版本指针 → 启动旧版本 → 记录 `rollback` 事件。

**清理策略**

- 保留：`active` + 最近 1 个 `standby` + 正在下载的。
- `quarantined` 保留二进制与日志供排障，不自动使用。

### 2.4 配置生成与兼容

```
Profile（用户配置）
  → 归一化为内部模型
  → 按目标 sing-box 版本做兼容检查（schema 矩阵）
  → 渲染为 sing-box JSON
  → 写临时文件（0600）
  → sing-box check -c <tmp>
  → PUT /configs?force=true
  → 成功后删除临时文件
```

- 我们的 `schemaVersion` 写在**旁路元数据文件** `profile-<id>.meta.json`，**不写进 sing-box 配置**（未知字段会报错）。
- 兼容矩阵：`schemaVersion ↔ upstreamVersion` 区间；不在区间内则阻止切换版本。
- 迁移失败或 `check` 失败：不应用，返回 `PRECONDITION_FAILED` + 具体字段。

### 2.5 健康检查

| 检查 | 频率 | 判定 |
|---|---|---|
| 进程存活 | 1s | `kill(pid, 0)` |
| Clash API | 2s | `GET /version` 200 |
| 数据面 | 10s | 通过本地 mixed 入站发一次探测请求 |
| 出口 | 30s | 查询出口 IP（隐私模式下跳过） |
| 流量采样 | 2s（与 Clash API 同频） | `GET /connections` 返回累计值；失败只影响展示，不影响状态 |

连续 3 次失败 → `degraded`。

### 2.6 崩溃恢复

应用启动时读取 `runtime-state.json`：

| 上次状态 | 行为 |
|---|---|
| `running` / `starting` / `restarting` | 尝试用当前 `active` 版本恢复 |
| 恢复失败 3 次 | 回滚到 `standby` 版本 |
| 回滚也失败 | 进入 `failed`，关闭系统代理，提示用户运行诊断 |
| `idle` / `stopping` | 不自动启动 |

---

## 3. 版本清单格式

### 3.1 分发结构

```
https://cdn.veyl.local/runtime/{channel}/{platform}-{arch}/manifest.json
https://cdn.veyl.local/runtime/{channel}/{platform}-{arch}/manifest.json.sig
https://cdn.veyl.local/runtime/artifacts/{upstream_version}/{platform}-{arch}.{ext}
```

- `channel`：`stable` | `beta`
- `platform`：`darwin` | `windows` | `linux`
- `arch`：`arm64` | `x86_64`
- 归档格式沿用官方：macOS/Linux `.tar.gz`，Windows `.zip`

### 3.2 清单示例

```json
{
  "schema": 1,
  "channel": "stable",
  "generated_at": "2026-10-30T12:00:00Z",
  "key_id": "veyl-2026-01",
  "releases": [
    {
      "upstream_version": "1.14.4",
      "platform": "darwin",
      "arch": "arm64",
      "artifact": {
        "url": "https://cdn.veyl.local/runtime/artifacts/1.14.4/darwin-arm64.tar.gz",
        "sha256": "3f9a...c21e",
        "size": 29186204,
        "format": "tar.gz"
      },
      "upstream_asset": "sing-box-1.14.4-darwin-arm64.tar.gz",
      "source_url": "https://github.com/SagerNet/sing-box/tree/v1.14.4",
      "license": "GPL-3.0-or-later",
      "config_schema": { "min": 1, "max": 2 },
      "min_app_version": "1.0.0",
      "breaking": false,
      "yanked": false,
      "rollout": { "percentage": 100, "cohorts": [] },
      "changelog_summary": "上游 1.14.4；修复 Hysteria2 重连抖动。",
      "changelog_url": "https://github.com/SagerNet/sing-box/releases/tag/v1.14.4",
      "published_at": "2026-10-30T10:00:00Z"
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `upstream_version` | 官方 sing-box 版本，**不再有我们自己的版本号** |
| `artifact.sha256` | **我们自己计算**的压缩包摘要；不依赖上游是否提供校验和 |
| `artifact.size` | 校验下载完整性 |
| `upstream_asset` | 官方资产文件名，便于溯源与重新镜像 |
| `source_url` | 对应源码地址（GPL 义务） |
| `license` | 许可证标识 |
| `config_schema` | 我们配置模型支持的区间 |
| `min_app_version` | 低于此版本的应用不得安装 |
| `breaking` | 是否包含破坏性配置变更 |
| `yanked` | 已撤回，禁止新安装 |
| `rollout.percentage` | 灰度比例 |

### 3.3 签名与验签

- 算法：Ed25519。
- 签名对象：**manifest.json 的原始字节**（不做 JSON 规范化）。
- 签名文件：

```json
{
  "key_id": "veyl-2026-01",
  "alg": "ed25519",
  "signature": "base64..."
}
```

- 客户端内置公钥列表，支持轮换。
- 验签顺序（任一步失败即中止）：

```
1. 下载原始字节（上限 1MB）
2. 用 key_id 对应公钥验签
3. 解析 JSON
4. 校验 schema=1 与必填字段
5. 过滤 platform/arch 不匹配
6. 过滤 yanked
7. 过滤 min_app_version > 当前应用版本
8. 过滤 rollout 未命中
9. 按 upstream_version 排序，得到候选
```

- 下载 artifact 后校验 `sha256` 与 `size`。
- 解压防路径穿越：拒绝 `..`、绝对路径、指向目录外的符号链接。
- 只信任内置 CDN；**不接受用户或 Agent 传入的 URL**。

### 3.4 版本选择策略

| 场景 | 规则 |
|---|---|
| 自动升级 | 同渠道、`breaking=false`、rollout 命中、版本号更高 |
| 手动升级 | 用户指定版本，允许 `breaking`（需确认） |
| 降级 | 仅在当前版本 `quarantined` 或用户显式操作时允许 |
| 渠道切换 | stable ↔ beta，不自动跨渠道升级 |

### 3.5 镜像与发布流水线

```
定时任务拉取上游 GitHub Release 元数据
  → 下载对应平台资产
  → 计算 sha256 / size
  → 上传 CDN
  → 生成 manifest（含 source_url、license）
  → 离线签名（私钥不在 CI）
  → 发布到 stable/beta 渠道
  → 灰度：1% → 10% → 50% → 100%
  → 监控：启动失败率、回滚率、崩溃率
```

- 镜像必须保留官方资产名与源码地址，便于审计与 GPL 合规。
- 私钥放独立签名环境或 HSM。

---

## 4. 工具接口

> **已冻结**：P1 工具清单、入参 schema、返回结构、权限与审批以 `docs/contracts/tools.md` v1.0.5 为准；Tauri 事件以 `docs/contracts/events.md` v1.0.5 为准。
>
> **重要更正**：Claurst 的 `ToolResult` 实际是 `{ content, is_error, metadata, images }`，不是本节 §4.2 写的 `{ ok, data, summary, next_actions }`。Veyl 的结构化信封放在 `metadata.aivpn`，模型只读 `content`。本节 §4.2 仅作为「信封内容长什么样」的示意，不是 Rust 类型。

### 4.1 传输与命名

- 传输：应用内为 `Tool::execute` 直接调用；外部宿主走 MCP over stdio（P2）。
- Rust 类型名使用 PascalCase（`RuntimeStartTool`）；文档中的点号写法（`runtime.start`）仅作分组展示。
- 请求带 `_meta.progressToken` 时，长任务通过 `notifications/progress` 上报。
- 所有工具同步返回；长任务返回 `job_id`。

### 4.2 统一响应包

成功：

```json
{
  "ok": true,
  "data": {},
  "summary": "已连接到 东京-01，延迟 42ms",
  "next_actions": [
    { "label": "断开", "tool": "vpn_disconnect", "args": {} }
  ]
}
```

失败：

```json
{
  "ok": false,
  "error": {
    "code": "APPROVAL_REQUIRED",
    "message": "升级运行时需要确认",
    "retryable": false,
    "details": {
      "approval_id": "apr_01J...",
      "risk": "high",
      "summary": "将 sing-box 1.13.2 升级到 1.14.4",
      "expires_at": "2026-10-30T12:05:00Z"
    }
  }
}
```

### 4.3 错误码

| 码 | 含义 | 是否可重试 |
|---|---|---|
| `INVALID_ARGUMENT` | 参数不合法 | 否 |
| `NOT_FOUND` | 资源不存在 | 否 |
| `CONFLICT` | 状态冲突（如正在升级） | 是 |
| `PRECONDITION_FAILED` | 前置条件不满足（配置不兼容、无公网 IP） | 否 |
| `PERMISSION_DENIED` | Agent 无权调用 | 否 |
| `APPROVAL_REQUIRED` | 需要用户确认 | 确认后重试 |
| `UNSUPPORTED` | 当前版本/平台不支持 | 否 |
| `TIMEOUT` | 超时 | 是 |
| `UPSTREAM_ERROR` | 控制面/云厂商/DeepSeek 错误 | 视情况 |
| `CANCELLED` | 用户取消 | 否 |
| `INTERNAL` | 未预期错误 | 视情况 |

### 4.4 审批协议

高风险工具采用两阶段调用：

```
1. Agent 调 core_upgrade({version:"1.14.4"})
   → { ok:false, error:{ code:"APPROVAL_REQUIRED",
        details:{ approval_id:"apr_x", summary:"..." } } }
2. UI 渲染确认卡；用户同意
3. Host 将 apr_x 标记为 approved（TTL 5 分钟，绑定工具名 + 参数哈希）
4. Agent 重试 core_upgrade({version:"1.14.4", approval_id:"apr_x"})
   → 执行
```

- `approval_id` 只能用于**完全相同的参数**。
- 被拒绝的审批返回 `PERMISSION_DENIED`，不得重复弹出。
- 审批记录写入 `ToolCallAudit`。

### 4.5 工具清单与权限矩阵

| 工具 | 分组 | 风险 | Agent 可直接调用 | 需要审批 |
|---|---|---|---|---|
| `runtime_status` | runtime | 只读 | ✅ | — |
| `runtime_start` | runtime | 中 | ✅ | — |
| `runtime_stop` | runtime | 中 | ✅ | — |
| `runtime_restart` | runtime | 中 | ✅ | — |
| `runtime_reload` | runtime | 低 | ✅ | — |
| `runtime_logs` | runtime | 只读 | ✅ | — |
| `vpn_status` | vpn | 只读 | ✅ | — |
| `vpn_connect` | vpn | 低 | ✅ | 会话内首次 |
| `vpn_disconnect` | vpn | 低 | ✅ | — |
| `profile_list` | profile | 只读 | ✅ | — |
| `profile_import` | profile | 低 | ✅ | — |
| `profile_test` | profile | 低 | ✅ | — |
| `core_status` | core | 只读 | ✅ | — |
| `core_list_versions` | core | 只读 | ✅ | — |
| `core_check_update` | core | 只读 | ✅ | — |
| `core_install` | core | 中 | ✅ | — |
| `core_upgrade` | core | 高 | ✅ | ✅ |
| `core_rollback` | core | 高 | ✅ | ✅ |
| `core_set_channel` | core | 中 | ✅ | — |
| `node_check_local` | node | 只读 | ✅ | — |
| `node_prepare_local` | node | 中高 | ✅ | ✅ |
| `node_local_status` | node | 只读 | ✅ | — |
| `node_local_stop` | node | 低 | ✅ | — |
| `node_destroy` | node | 高 | ✅ | ✅ |
| `guide_start` | guide | 只读 | ✅ | — |
| `guide_open_console` | guide | 低 | ✅ | — |
| `guide_verify` | guide | 只读 | ✅ | — |
| `diag_run` | diag | 低 | ✅ | — |
| `market_search` | market | 只读 | ✅ | — |
| `market_publish` | market | 中 | ✅ | — |
| `market_purchase` | market | 高 | ✅ | ✅ |
| `wallet_balance` | wallet | 只读 | ✅ | — |
| `deepseek_setup_key` | ai | 低 | ✅ | — |
| `deepseek_save_key` | ai | 中 | ✅ | — |
| `job_get` | job | 只读 | ✅ | — |
| `job_cancel` | job | 低 | ✅ | — |

### 4.6 运行时工具定义

#### `runtime_status`

只读快照。Agent 用它「感知」sing-box 的状态。

输出：

```json
{
  "ok": true,
  "data": {
    "state": "running",
    "pid": 12345,
    "version": "1.14.4",
    "uptime_seconds": 3721,
    "mode": "system-proxy",
    "profile_id": "prf_123",
    "config_hash": "sha256:9a1c...",
    "system_proxy": true,
    "health": {
      "process": true,
      "clash_api": true,
      "data_plane": true,
      "exit_ip": "203.0.113.7"
    },
    "traffic": {
      "up_bytes": 12345678,
      "down_bytes": 98765432,
      "up_rate": 1024,
      "down_rate": 20480
    },
    "connections": 12,
    "last_error": null,
    "last_transition_at": "2026-10-30T11:58:03Z"
  },
  "summary": "运行中，sing-box 1.14.4，已运行 1 小时 2 分"
}
```

`state` 枚举与 2.2 一致。

#### `runtime_start`

输入：

```json
{ "profile_id": "prf_123", "mode": "system-proxy" }
```

- `profile_id` 省略时使用当前配置。
- 已处于 `running`：返回 `ok=true` 且 `already_running=true`（幂等）。
- 处于 `starting` / `restarting`：返回 `CONFLICT`，`retryable=true`。
- 处于 `failed`：先做一次自检，再尝试启动。

输出：`runtime_status` 的子集（`state`、`pid`、`version`）。

#### `runtime_stop`

输入：

```json
{ "force": false }
```

- 默认优雅退出：先关闭系统代理，再 `POST /close`，等待 5s。
- `force=true`：超时后强制结束进程（需确认）。
- 已处于 `idle`：返回 `ok=true`（幂等）。

#### `runtime_restart`

输入：

```json
{ "reason": "配置变更" }
```

- 等价于 `stop` + `start`，使用同一版本与配置。
- 处于 `idle` 时等价于 `start`。
- 处于 `starting` 时返回 `CONFLICT`。

#### `runtime_reload`

输入：

```json
{ "profile_id": "prf_123" }
```

- 生成新配置 → `sing-box check` → `PUT /configs?force=true`。
- 失败保持旧配置不变，返回 `PRECONDITION_FAILED`。
- 不断开现有连接（由 sing-box 决定热更新行为）。

#### `runtime_logs`

输入：

```json
{ "lines": 200, "level": "info" }
```

输出脱敏后的日志行。脱敏规则：

- 移除 `password`、`uuid`、`short_id`、`private_key`、`token`、`secret` 的值。
- 保留时间、级别、模块、事件。
- 不返回访问目标地址（只返回连接 ID）。

### 4.7 其他关键工具

#### `core_upgrade`

```json
{
  "version": "1.14.4",
  "channel": "stable",
  "allow_breaking": false,
  "approval_id": "apr_01J..."
}
```

阶段：`downloading` → `verifying` → `unpacking` → `probing` → `activating` → `health_check` → `done` | `rolled_back` | `failed`。

#### `vpn_connect`

```json
{
  "profile_id": "prf_123",
  "mode": "system-proxy",
  "strategy": "latency"
}
```

语义：确保运行时启动 → 应用配置 → 设置系统代理。与 `runtime_start` 的区别是后者只管理进程，不碰节点选择与系统代理。

#### `node_check_local`

```json
{
  "can_host": true,
  "mode": "public-ip",
  "public_ipv4": "203.0.113.7",
  "public_ipv6": null,
  "nat_type": "full-cone",
  "cgnat": false,
  "upnp": true,
  "upstream_mbps": 42.5,
  "port_reachable": true,
  "estimated_capacity_mbps": 30,
  "blockers": [],
  "warnings": ["设备为笔记本，休眠会中断节点"]
}
```

#### `guide_start`

```json
{
  "guide_id": "gd_01J...",
  "recipe_version": "digitalocean/ubuntu-24.04/2026-11-14",
  "steps": [
    { "id": "signup", "title": "注册 DigitalOcean 账号", "url": "https://..." },
    { "id": "billing", "title": "绑定支付方式" },
    { "id": "deploy", "title": "创建服务器" },
    { "id": "userdata", "title": "粘贴启动脚本", "payload": "cloud-init..." },
    { "id": "firewall", "title": "开放 443 端口" },
    { "id": "verify", "title": "验证连接" }
  ]
}
```

### 4.8 状态推送（通知）

除轮询 `runtime_status` 外，Host 在状态变化时向 Agent 推送：

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/veyl.runtime_state",
  "params": {
    "state": "degraded",
    "version": "1.14.4",
    "reason": "clash_api_timeout",
    "at": "2026-10-30T12:00:00Z"
  }
}
```

长任务进度：

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/veyl.job_progress",
  "params": {
    "job_id": "job_01J...",
    "stage": "downloading",
    "progress": 0.42
  }
}
```

Agent 可选择订阅；不订阅时用 `job_get` 轮询。

### 4.9 数据对象

```ts
type Job = {
  job_id: string;
  kind: "core_upgrade" | "node_prepare" | "diag" | "market_purchase" | "guide_verify";
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "rolled_back";
  stage: string;
  progress: number;
  message?: string;
  result?: unknown;
  error?: { code: string; message: string };
  created_at: string;
  updated_at: string;
};

type NextAction = {
  label: string;
  tool: string;
  args: Record<string, unknown>;
};
```

---

## 5. 配额与计量（无内核修改）

计费不依赖计量。买家购买的是一张**预付费凭证**，节点在本地校验额度；计量只服务配额与展示。

### 5.1 凭证

```json
{
  "entitlement_id": "ent_01J...",
  "listing_id": "lst_123",
  "buyer_pubkey": "...",
  "quota_bytes": 53687091200,
  "expires_at": "2026-11-29T00:00:00Z",
  "issued_at": "2026-10-30T00:00:00Z",
  "seller_pubkey": "...",
  "sig": "base64..."
}
```

- 卖家密钥签名；节点用注册表里的 `seller_pubkey` 离线校验。
- 买家首次连接时提交凭证；节点拒绝过期或超额的凭证。
- 平台不参与每次准入，只负责签发前的支付确认。

### 5.2 配额执行

- 流量包：节点侧启用 `experimental.v2ray_api`，按用户统计上下行，超过 `quota_bytes` 即限流或断开。
- 时长包：节点侧记录会话时长，超过 `expires_at` 即失效，不需要流量统计。
- 额度状态定期回写控制面，供用户查看与续购。

### 5.3 计量只用于展示

```
sing-box (server) ──gRPC StatsService──► node-agent
                                           │ 每 60s 采样
                                           ▼
                                UsageSample {entitlement, up, down, t}
                                           │ 仅展示 / 配额
                                           ▼
                                     控制面
```

- 不要求双方签名，不做逐笔结算。
- 统计口径漂移、进程重启归零，只影响「还剩多少」的显示，不影响已经收到的钱。
- 若 stats 不可靠，流量包退化为时长包。

---

## 6. 关键时序

### 6.1 启动

```
UI/Agent     RuntimeMgr            sing-box
   │ runtime_start │                  │
   ├──────────────►│ 校验状态/版本     │
   │              │ 生成配置(0600)     │
   │              │ spawn ───────────►│
   │              │ GET /version ────►│
   │              │◄──── 200 ─────────┤
   │              │ 设置系统代理        │
   │◄─ state=running ─────────────────┤
```

### 6.2 重启

```
runtime_restart
  → state=restarting，restart_intent=true
  → 关闭系统代理
  → POST /close
  → 等待退出（5s，超时可选 force）
  → state=starting
  → spawn 同版本同配置
  → /version 200
  → state=running，恢复系统代理
```

### 6.3 升级与回滚

```
Agent → core_upgrade → 审批 → RuntimeMgr
  → 拉清单 → 验签 → 下载 → 校验 sha256 → 安全解压
  → sing-box version / check
  → 写 active 指针
  → 停旧进程 → 启新进程 → 健康检查
  → 失败：恢复旧指针 → 启旧进程 → 上报 rolled_back
```

### 6.4 连接

```
vpn_connect → 确保 running → 选 profile → 生成配置
            → sing-box check → PUT /configs
            → 设置系统代理 → 返回延迟/出口 IP
```

### 6.5 向导建节点

```
guide_start → steps + cloud-init
guide_open_console → 系统浏览器
用户操作网页
guide_verify → 有 Token 查 API；无则等控制面注册/探测 IP:22
注册成功 → 生成 profile → 导入 → 连接测试
```

---

## 7. 存储布局

```
<appdata>/
  runtime/
    <version>/
      sing-box
      VERSION
  runtime-state.json       # 原子写：临时文件 + rename
  config/
    profile-<id>.json      # 0600
    profile-<id>.meta.json # schemaVersion 等旁路元数据
  db.sqlite
  logs/
    app-YYYY-MM-DD.log
    runtime-events.log
    runtime-<version>.log
  helper-logs/             # 特权 helper 与 sing-box（0755）
    helper.log
    sing-box.log
```

| 平台 | 路径 |
|---|---|
| macOS | `~/.veyl/` |
| Windows | `%USERPROFILE%\.veyl\` |
| Linux | `~/.veyl/` |

**原子性**：`runtime-state.json` 与 active 指针必须写临时文件后 `rename`。

---

## 8. 安全边界

| 边界 | 措施 |
|---|---|
| 发行物投毒 | 签名清单 + 自算 sha256 + 内置公钥 + 禁止任意 URL |
| 解压攻击 | 拒绝路径穿越、绝对路径、外部符号链接 |
| 控制 API 暴露 | 只绑 `127.0.0.1`，随机端口 + 随机 secret |
| 配置泄露 | 临时文件 0600，应用后删除；密钥不过日志 |
| 子进程提权 | 子进程以当前用户运行；TUN helper 独立签名（二期） |
| Agent 越权 | MCP 白名单 + schema 校验 + 审批；无 shell |
| 外部宿主接入 | 本地 socket 0600 + 一次性握手 Token |
| 控制面下发 | 只下发数据（清单、向导内容），不下发可执行代码 |

---

## 9. 故障与恢复

| 故障 | 检测 | 处理 |
|---|---|---|
| 启动失败 | 10s 超时 / 非零退出 | 重试 3 次 → 回滚 → 告警 |
| 运行中崩溃 | 进程退出 | 退避重启 3 次 → 回滚 |
| Clash API 无响应 | `/version` 超时 | 视为 degraded → 重启 |
| 配置不兼容 | `sing-box check` 失败 | 阻止应用/升级，保持旧配置 |
| 升级后健康检查失败 | 三段检查 | 自动回滚并上报 |
| 清单验签失败 | 签名不匹配 | 中止，使用缓存清单 |
| 下载中断 | sha256/大小不符 | 删除临时文件，可重试 |
| 应用崩溃 | 启动时读状态 | 按 2.6 恢复 |
| 磁盘写满 | 安装前检查剩余空间 | 拒绝安装并提示 |

**降级原则**：任何自动恢复都不得让用户「断网且不知情」。失败时必须关闭系统代理、恢复旧版本、在 UI 上给出明确原因。

---

## 10. 附录：配置骨架

> 以下仅示意结构，具体字段随 sing-box 版本变化，应用前一律执行 `sing-box check`。

### 10.1 客户端

```json
{
  "log": { "level": "info", "timestamp": true },
  "inbounds": [
    {
      "type": "mixed",
      "tag": "mixed-in",
      "listen": "127.0.0.1",
      "listen_port": 2080
    }
  ],
  "outbounds": [
    { "type": "vless", "tag": "proxy", "server": "...", "server_port": 443, "uuid": "...", "tls": { "enabled": true, "server_name": "..." } },
    { "type": "direct", "tag": "direct" }
  ],
  "route": { "final": "proxy" },
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:19090",
      "secret": "<启动时随机生成>"
    }
  }
}
```

### 10.2 节点（服务端）

```json
{
  "log": { "level": "info", "timestamp": true },
  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-in",
      "listen": "::",
      "listen_port": 443,
      "users": [
        { "name": "buyer-0001", "uuid": "<每买家独立>" }
      ],
      "tls": { "enabled": true, "server_name": "...", "reality": { "enabled": true } }
    }
  ],
  "outbounds": [{ "type": "direct", "tag": "direct" }],
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:19090",
      "secret": "<随机>"
    },
    "v2ray_api": {
      "listen": "127.0.0.1:18080",
      "stats": {
        "enabled": true,
        "inbounds": ["vless-in"],
        "users": ["buyer-0001"]
      }
    }
  }
}
```

---

## 11. 待定

1. 镜像 CDN 的合规与成本；是否需要多区域。
2. 上游安全公告的订阅与自动清单更新。
3. 外部 MCP 桥的握手协议细节。
4. `tun` 模式的 helper 架构（M6）。
5. 打洞组件（M7）与 Runtime Manager 的接口。
6. `runtime.logs` 的脱敏规则是否需要更严格（如完全不返回 host）。
