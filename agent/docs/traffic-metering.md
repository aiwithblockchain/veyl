# Agent 流量计量：读取网卡

> 日期：2026-11-27
> 状态：`read_counter` 只输出两种结果——`Ok` 是读到值，`Err` 是没读到。判定所依赖的 nft 输出格式已在真机验证，见 §5。
> 代码：`agent/src/traffic.rs`、`agent/src/agent.rs`、`agent/src/config.rs`
> 上游设计：`docs/design/traffic-billing.md` §6.2–§6.6；失败清单 `agent/docs/agent-metering-failures.md`

---

## 0. 一句话

agent 每 30 秒读一次 nft 计数器。这一步只有两种结果：`Ok(字节)` 表示这一轮真的读到了计数器，`Err` 表示这一轮没读到。

---

## 1. 定时驱动：常驻进程里的 tokio interval，不是 cron

**既不是 `for` 循环 + `sleep`，也不是 systemd timer，更不是 cron。**

agent 是一个常驻的 systemd 服务，内部跑一个 tokio 事件循环：

```rust
// agent/src/agent.rs:287
let mut traffic_tick = tokio::time::interval(Duration::from_secs(cfg.traffic.read_secs));
traffic_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
traffic_tick.tick().await;          // 吃掉 interval 的"立即触发"那一次

loop {
    tokio::select! {
        _ = tokio::signal::ctrl_c() => break,
        stopped = crate::supervise_mcp(&mut handle.task) => { /* 退出，交给 systemd 重启 */ },
        _ = ip_retry.tick(), if ... => { /* 公网 IP 重探 */ },
        _ = traffic_tick.tick() => { meter.tick_now().await; ... }   // agent.rs:345
    }
}
```

| 项 | 值 | 位置 |
|---|---|---|
| 周期来源 | `traffic.read_secs` | `config.rs` `TrafficConfig` |
| 默认值 | **30 秒** | `config.rs:129 default_traffic_read_secs()` |
| 下限 | ≥ 1 秒（0 会启动失败） | `config.rs` 校验 |
| 错过补发 | **不补发** | `MissedTickBehavior::Delay`（`agent.rs:288`） |

**为什么用 `Delay` 而不是默认的 `Burst`**：一次读取若因 nft 卡住超时，`Burst` 会在恢复后连续补跑多个 tick。`Delay` 让下一次从当前时刻重新计 30 秒，实际周期因此 **≥ 30 秒且永不突发**。

**为什么循环前要手动跑一次**：`agent.rs:254` 在申请 desired state、装机之前先调用一次 `meter.tick_now()`，把 nft 计数器表建起来。注意：**建表的那一轮是读失败**，真正开始计账要等到下一个窗口（见 §3.1），所以**只有建表后的第一个窗口不计入**——装机期间的流量通常正好落在这一段。

这一次**不一定只记录基线**：

- **首次安装**（磁盘上没有状态文件）：只记基线，不产生上报。
- **磁盘上已有状态文件**：`seed()` 直接加载它，这一次可能顺带做三件事之一——`pending_bytes` 已达阈值 → 立即上报；距上次成功上报满 30 分钟 → 发一次空闲心跳（可能 0 字节）；崩溃前冻结过批次 → 立即重发那一批。

**为什么循环前先 `tick()` 一次**：`interval` 的第一次 tick 是立即返回的。先消费掉它，循环体才不会在启动瞬间多跑一轮。

---

## 2. 一次读取的完整流程

入口：`TrafficMeter::tick()`（`traffic.rs:153`）→ `read_counter()`（`traffic.rs:332`）→ `read_table()`（`traffic.rs:385`）。

```
tick(now)
│
├─ ① 解析默认路由网卡
│     ip route show default  →  取 "dev" 后面的网卡名
│        （`eth0@if3` 这类 veth 在 '@' 处截断）
│     失败 ────────────────────────→ Err
│
├─ ② nft -j list table inet veyl_meter
│     ├─ 退出码 0，且能解析出 (网卡, 字节) ──→ 计数器
│     ├─ 退出码 0，但解析不出来 ───────────→ Broken
│     └─ 退出码非 0
│          └─ ③ nft -j list tables（JSON，主信号）
│               ├─ 列表里有 veyl_meter ────→ Broken
│               └─ 没有 / 拿不到
│                    └─ ④ nft list tables（文本，兜底）
│                         ├─ 有 veyl_meter ─→ Broken
│                         ├─ 没有 ──────────→ Missing
│                         └─ 命令失败 ──────→ JSON 明确说没有 → Missing；否则 Broken
│
├─ 计数器.网卡 == 默认路由网卡 ────────────→ Ok(字节)     ← 唯一成功出口
├─ 计数器.网卡 != 默认路由网卡 → 重建表 ──→ Err
├─ Missing                    → 重建表 ──→ Err
└─ Broken                     → bail!  ──→ Err
```

重建**仍然发生**在返回 `Err` 的那一轮——表该建还是会建，只是不再把「重建之后」伪装成本轮读数。调用方永远拿不到一个语义模糊的 `0`。

`Broken` 与 `Missing` 的区分是这一版修掉的核心问题：以前两者都被当成「表不存在」，于是 nft 输出格式一变（内核升级、nft 版本变化），每个窗口都会删表重建、每轮读数归零——**永远上报 0 字节，一行错误都没有**。

**表只在 `Missing` 时重建。** 重建动作是 **4 条 `nft` 命令**：1 次 `nft delete table`，然后 3 次 `nft add`（table / chain / rule）。

---

## 3. 读取之后发生什么

拿到读数后，`tick()` 在同一把锁里完成累积：

```
delta        = counter < counter_last ? counter : counter - counter_last
                 // 负数增量 = 表被重建过，新计数器的值全部算新流量
counter_last = counter
pending      = pending + delta
```

- **落盘**：每 `save_secs`（默认 300 秒）一次，另加「发请求前」和「上报成功后」各一次；原子写（临时文件 + rename，0600）。
- **上报触发**：`pending ≥ report_bytes`（默认 256 MiB）或距离上次成功上报满 30 分钟（空闲也报 0 字节，控制面按上报激活账号池额度）。
- **上报失败**：不推进 `seq`、保留同一批，下一个窗口原样重发。
- **读失败**：**跳过本窗口，不写 `counter_last`**。重建也走这条路径——重建的那一轮同样算读失败，那一轮不更新基线。

**重启会丢什么**，分三种情况：

| 情况 | 丢不丢 | 原因 |
|---|---|---|
| 进程被杀后重启 | **不丢** | nft 计数器在内核里没消失，磁盘基线是上次落盘时的值；重启后读到的差值自动覆盖「上次落盘之后」这一段 |
| 整机重启 / nft 表被清 | 丢「上次落盘至今」，≤ `save_secs`（默认 5 分钟） | 计数器从 0 重新计数，旧值无法恢复 |
| 状态文件损坏或丢失 | 丢上次保存前未上报的部分 | 有意为之：以当前计数器为新基线，避免重复计费（见 `traffic-billing.md` §6.4） |

### 3.1 重建靠什么被吸收

重建会把计数器清零。为了让新计数器的值不丢，「读失败不更新 `counter_last`」和 `tick()` 里的负数分支（`counter < counter_last`）配合起来：下一轮读到的 `C` 小于旧基线 `L` 时，把整个 `C` 当作增量。

**这是吸收重建的唯一机制**，删掉或"简化"它，重建就会被重复计账或凭空丢掉。

代价是**少算**，方向与 `traffic-billing.md` §6.6「宁可少算，不可多算」一致：

- **中途重建**：只有 `C > L` 时才有差异，少算量 = `L`；因为 `C > L`，所以少算量小于一个窗口的流量。
- **首次安装**：建表那一轮是失败、不入账；下一轮的第一个读数被当作基线，**建表后第一个窗口的流量全部不计数**（通常是装机下载 sing-box 的十几 MB）。

### 3.2 409 不做特殊处理

控制面返回 `409 server_destroyed` 时，agent 当成普通失败：warn 一行、保留这一批、下一个窗口重试。

理由：控制面只在 droplet 删除成功（或返回 404）之后才写 `destroyed_at`，所以**活着的机器不该收到 409**。真收到了，说明「库里说销毁了、机器还在跑」——这正是最需要继续计量的时刻。用进程级的单向开关把上报永久停掉，只会把这个问题藏起来，而且**不会自己恢复**。

控制面继续返回 409 是对的：它是个有价值的信号，只是不该由 agent 来消化。

---

## 4. 结果只有两种

`read_counter()` 的返回值：

| 情况 | 返回 |
|---|---|
| 读到计数器，且它数的是当前默认路由网卡 | `Ok(字节)` |
| 默认路由网卡解析失败 | `Err` |
| 表不存在 → 已重建 | `Err` |
| 计数器数的是旧网卡 → 已重建 | `Err` |
| 表读不出来（命令失败但表还在 / 输出不可解析） | `Err` |

`Ok` 一定是读数，`Err` 一定不是。重建是**修**，不是**读**，所以它落在 `Err` 里。

---

## 5. 判定所依赖的输出格式（已在真机验证）

2026-11-27 在节点 `veyl-iiIXYokol5Ss`（nft 1.0.9，`Old Doc Yak #3`）上实测，与代码里的假设一致：

```
$ nft -j list tables
{"nftables": [{"metainfo": {"version": "1.0.9", "release_name": "Old Doc Yak #3", "json_schema_version": 1}}, {"table": {"family": "inet", "name": "veyl_meter", "handle": 1}}]}

$ nft list tables
table inet veyl_meter
```

- `json_lists_table()` 只看 `nftables[].table.family == "inet"` 且 `name == "veyl_meter"`；`json_schema_version`、`handle` 这类额外字段被忽略。
- `lists_table()` 匹配的是去掉首尾空白后**整行等于** `table inet veyl_meter`。

判 `Missing` 的前提仍然是「**没有任何信号给出『表在』**」，共三种组合：

| # | JSON 列表 | 文本列表 | 结果 |
|---|---|---|---|
| ① | 说没有 | 说没有 | `Missing`（重建） |
| ② | 拿不到 | 说没有 | `Missing`（重建） |
| ③ | 说没有 | 命令失败 | `Missing`（重建，日志 `warn`） |

②③ 只需一个信号出问题——另一个是「没答案」，不是「假阴性」。误判的后果是每 30 秒重建一次表、计量实际停摆、**不自愈**；但每轮都报读失败，方向是**少收费**不是多收。判 `Missing` 前会把两个列表的真实输出按路径打进 `info` 或 `warn`，格式真变了也看得见。

**这条验证只覆盖一种 nft 版本。** 换发行版或内核版本后，若输出格式变化，需要重跑上面两条命令确认；代码的两个信号互相兜底，单边失效不会直接导致重建。

---

## 6. 日志速查

| 事件 | 级别 | 消息文本 |
|---|---|---|
| 读失败（跳过本窗口） | warn | `traffic: counter read failed; skipping this window` |
| 表不存在（两个列表都说没有） | info | `traffic: no counter table; creating it`（带 `json_listing=` 和 `listing=`） |
| 表不存在（JSON 说没有，但文本列表不可用） | **warn** | 同一句消息，只带 `json_listing=`——这是唯一「文本列表拿不到却仍然重建」的路径，要让人看得见 |
| 网卡变了，重建 | info | `traffic: counter follows a stale interface; rebuilding` |
| 表建好 | info | `traffic: created the outbound counter table` |
| 状态文件不存在（首次运行） | warn | `traffic: no state file; using the current counter as the new baseline` |
| 状态文件读不出 | error | `traffic: state file is unreadable; using the current counter as the new baseline` |
| 初始状态写失败 | warn | `traffic: could not write the initial state` |
| 状态保存失败 | warn | `traffic: state save failed` |
| 上报成功 | debug | `traffic: reported` |
| 上报失败（含连续次数） | warn | `traffic: report failed; retrying the same batch next window`（带 `failures=`） |
| 上报恢复 | info | `traffic: reporting recovered; the earlier failures are cleared` |

收到 **409 `server_destroyed`** 不单独记一条：它走上面「上报失败」那一行，`error=` 里会带上 409 和响应体。这是有意的，见 §3.2。

「读失败」那一条的 `error=` 字段是 `read_counter` 返回的原因，五类：网卡解析失败 / `ip` 或 `nft` 命令本身失败或超时 / 重建后跳过本窗口 / 表读不出来 / 重建本身失败。

前两种「状态文件」事件都带 `event="metering_state_lost"` 字段，但消息文本不同、级别也不同——按文本区分，不要只看 event。

日志落在 `/var/log/veyl-agent/agent.log`（轮转，逐行脱敏），同时写 stdout。
