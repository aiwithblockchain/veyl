# Agent 流量计量：读取网卡

> 日期：2026-11-27
> 状态：`read_counter` 已保证二元结果（`c722c1f` 修掉解析失败被当成「表不存在」，本次修掉另外两处 `Ok(0)`）。**剩两处待验证项**，见 §5。
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
│          └─ ③ nft list tables
│               ├─ 也失败 ─────────────────→ Broken
│               ├─ 列表里有 veyl_meter ────→ Broken
│               └─ 列表里没有 ─────────────→ Missing
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

## 5. 待验证项

| # | 项 | 后果 | 处理 |
|---|---|---|---|
| 1 | 判 `Missing` 依赖 `nft list tables` 的文本格式 `table inet veyl_meter` | 假阴性 → 每 30 秒重建一次表（每窗口至少 6 个 `nft` 进程：读表 1 + 列表 1 + 重建 4，外加 1 个 `ip`）、计量实际停摆、**不自愈**；但每轮都报读失败，不再静默，方向是**少收费**不是多收 | 改用 `nft -j list tables` 解析 JSON（与 `parse_counter` 同一类假设）。**不要**加重建冷却：那会掩盖真正的删除，还引入新的可变状态 |
| 2 | `nft list tables` / `nft -j list tables` 的真实输出**未在真机验证过** | 同上 | 在 Linux 节点上跑一次这两个命令，把输出样例补进本节，然后删掉本行 |

第 1 项的兜底：判 `Missing` 之前会把 `nft list tables` 的**真实输出**打进 info 日志，假设错了每轮都看得见。

这一项与「二元结果」正交，单独开待办，不绑在同一次评审和回滚里。

---

## 6. 日志速查

| 事件 | 级别 | 消息文本 |
|---|---|---|
| 读失败（跳过本窗口） | warn | `traffic: counter read failed; skipping this window` |
| 表不存在，即将创建 | info | `traffic: no counter table; creating it`（带 `listing=` 真实输出） |
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
