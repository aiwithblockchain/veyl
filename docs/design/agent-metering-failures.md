# 节点计量失败的现状清单

> 日期：2026-11-26
> 状态：**讨论中，未定稿**。本文只记录「现在会发生什么」，不下结论、不提方案。
> 逐条讨论的题目列在最后一节。
> 范围：agent 侧的流量计量与上报。
> **不包含**「在 DO 后台删除机器」：那种情况 agent 随机器一起消失，没有任何本机动作可执行。那条线归 `provider-gone.md`。

---

## 1. 失败发生在三处

| 位置 | 代码 | 典型原因 |
|---|---|---|
| 本机读计量 | `agent/src/traffic.rs` `tick()` | `nft` 命令失败、默认路由变化导致网卡名解析不到、权限 |
| 本机存进度 | `agent/src/traffic.rs` `save()` | 磁盘满、状态文件权限 |
| 上报到控制面 | `agent/src/control.rs` → 控制面 `handleTraffic` | 见第 4 节 |

每 30 秒一个窗口（`traffic.read_secs` 默认 30）。上报时机：待发字节 ≥ 256 MiB（`report_bytes`），或空闲满 30 分钟（`REPORT_IDLE_SECS`）。

---

## 2. 读计量失败

- 代码：`traffic.rs:162`，`traffic: counter read failed; skipping this window`
- 现在：打一行 warn，跳过这个窗口，**sing-box 照常服务**。
- 已确认的事实：nft 计数器是累计值，下一次成功读到的是更大的数，这段会在那次 delta 里补上，不会丢账。
- 例外：如果网卡被重建、计数器从头开始，`counter < counter_last` 分支会把新计数器的值整体当作新流量（偏保守）。

---

## 3. 存进度失败

- 代码：`traffic.rs:303`，`traffic: state save failed`
- 现在：打一行 warn，继续跑，**sing-box 照常服务**。
- 已确认的事实：最多丢掉上次保存之后的流量，默认 300 秒（`traffic.save_secs`）。
- 另有 `metering_state_lost`（`traffic.rs:259` / `:267`）：状态文件不存在或读不出时，以当前计数器为新基线，不把历史读数当作 delta。

---

## 4. 上报失败：控制面可能返回的每一种

控制面 `/v1/agent/traffic` 的全部返回，以及 agent 当前的反应：

| # | 控制面返回 | 出现条件 | 控制面位置 | agent 当前行为 |
|---|---|---|---|---|
| 1 | `200 {ok:true}` | 正常记账；或 `seq <= last_seq` 被去重 | `traffic.ts:189` | 推进 seq、清掉待发批次、刷新 `last_ok_at` |
| 2 | `409 server_destroyed` | 该行 `destroyed_at` 非空 | `traffic.ts:156` | **停止上报**（内存标志，进程重启才清）；sing-box 继续跑 |
| 3 | `401 unknown_token` | `server_token_hash` 在 `servers` 表里查不到 | `traffic.ts:154` | 无限重试，每 30 秒一次；sing-box 继续跑 |
| 4 | `401 missing_token` | 请求没带 `Authorization: Bearer` | `traffic.ts:148` | 同上 |
| 5 | `503 unavailable` | 控制面 `env.DB` 未绑定 | `traffic.ts:145` | 同上 |
| 6 | `5xx`（其它） | 未捕获异常等 | — | 同上 |
| 7 | 传输层失败 | DNS、连接超时、TLS、连接被拒 | `control.rs` `ControlError::Transport` | 同上 |
| 8 | 解码失败 | 响应不是预期 JSON | `control.rs` `ControlError::Decode` | 同上 |
| 9 | `400 invalid_body` | `seq` / `delta_bytes` 不是非负安全整数 | `traffic.ts:163` / `:175` | 同上 |

重试的机制：失败时不推进 seq，`pending_attempt` 保留，**下一个 30 秒窗口重发同一批**，直到成功或被 409 拦下。

---

## 5. 现在只有两种反应

- 第 2 条（409）→ **停止上报**，`traffic.rs:229`。sing-box 不动。
- 其余全部 → **无限重试**，`traffic.rs:238`。sing-box 不动。

也就是说：**目前没有任何一种上报失败会让 sing-box 停下来。**

---

## 6. 待逐条讨论

> 每条只列问题与现状，不写建议。

- **Q1** 本机读计量失败（第 2 节）：现在跳过窗口、不丢账、不停服。这一条要不要再做什么？
- **Q2** 本机存进度失败（第 3 节）：现在最多丢 300 秒、不停服。这一条要不要再做什么？
- **Q3** 409 `server_destroyed`（第 2 条）：现在停上报、不停服务。服务该不该一起停？
- **Q4** 401 `unknown_token`（第 3 条）：现在无限重试。它可能来自凭据轮换的短暂窗口，也可能是 token 被彻底吊销。要不要区分？分别怎么处理？
- **Q5** 401 `missing_token`（第 4 条）：本地配置坏了。现在无限重试。
- **Q6** 503 / 其它 5xx / 传输层 / 解码（第 5–8 条）：这一组的共同点是「说不上话」，分不清是对端故障还是我们自己的控制面挂了。现在无限重试、不停服。
- **Q7** 400 `invalid_body`（第 9 条）：我们自己发的 body 不合法，重试永远不可能成功。现在也是无限重试。
- **Q8** 如果要停服：停的具体动作是什么（`sing-box` 服务目前只有 `is_active` 和 `restart`，没有 `stop`），恢复由什么触发。
- **Q9** 停服期间用户看到什么：客户端侧、控制面侧是否需要相应表现。

---

## 附：相关代码位置

| 主题 | 位置 |
|---|---|
| 窗口与上报时机 | `agent/src/traffic.rs` `tick()`，`agent/src/config.rs` `TrafficConfig` |
| 控制面返回 | `cloudflare/control-plane/src/traffic.ts` `handleTraffic` |
| 控制面错误类型 | `agent/src/control.rs` `ControlError` |
| sing-box 服务控制 | `agent/src/singbox.rs`（现有 `is_active` / `restart`） |
