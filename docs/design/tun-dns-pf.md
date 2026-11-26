# macOS TUN：系统 DNS 进隧道（pf route-to）— 方案作废

> 日期：2026-11-26
> 状态：**方案作废（2026-11-26 真机预检否定），不实现任何 pf 代码**。备选方案见 `tun-dns-forwarder.md`。
> 范围：`src-tauri/src/bin/veyl-helper/**`，必要时 `src-tauri/src/tun/**`
> 结论一句话：~~新增 `pf.rs`，用独立 anchor 把宿主本机产生的 53 端口流量 `route-to` 进当前 utun~~ —— 真机实测 `route-to` 会把 DNS 送进隧道但**应答回不到绑定物理网卡的本地 socket**，载入规则后整机断网（§3.1）。本文只作记录。

---

## 1. 现状与根因

- 症状：TUN 模式下 YouTube / Google / Dropbox / Instagram 稳定打不开，未被污染的站点正常，看起来像「部分网站不通」。
- 已证实（2026-11-26 实测，VPN 连接中）：
  - `dig @223.5.5.5 www.google.com` → 真实 `142.251.x`（包进 TUN，被 `hijack-dns` 接管，走 DoH over proxy）；
  - `dig -b <en0地址> @223.5.5.5 www.google.com` → `69.171.235.22`（Facebook 段，污染）；
  - `dscacheutil -q host -a name www.google.com` 与绑定 en0 的结果一致；`dscacheutil -flushcache; killall -HUP mDNSResponder` 后仍污染 → 不是缓存；
  - 运行中配置 `"/Library/Application Support/Veyl/tun/active.json"`：`dns_mode: hijack`、`dns.final = dns-remote-1`（DoH 1.1.1.1，detour proxy）都对；
  - 代码里没有任何 pf 层 53 端口重定向。
- 根因：`veyl-helper/macos/dns.rs` 把系统 DNS 改成公网 `223.5.5.5`，靠 `auto_route` 收进隧道；但 macOS 的 mDNSResponder 按网络服务绑接口发包，**绕过路由表**，查询根本不进 TUN。
- **为什么「有人觉得能用、有人觉得不能用」——同一台机器、同一个节点，分裂是按应用而不是按站点**（2026-11-26 实测）：
  - Chrome **没有开 DoH**（`doh_config.servers` 为空），但它用自建解析器直连 `223.5.5.5`，**socket 不绑定接口** → 走路由表 → 查询进隧道 → 拿到干净 IP；与不带 `-b` 的 `dig` 逐字一致，48MB net-log 里投毒 IP 出现 **0 次**；
  - 受影响的是所有走 `mDNSResponder`/`getaddrinfo` 的进程：**Safari、WebView、curl、App 自己的探测**。
  - 推论：修复必须覆盖 mDNSResponder 这条路（正是本方案的理由），而不是去调 DNS 地址或加路由。
- 关键事实：`route.rules` 里的 `{"protocol":"dns","action":"hijack-dns"}` 按**协议**匹配（53 端口），不挑目的地址——所以 pf 只需要把包送进 utun，不必改目的地址。

## 2. 方案

### 2.1 为什么是 `route-to` 而不是 `rdr`

pf 的 `rdr` 是 **in 方向**规则；本机进程产生的包只经过 out 方向，`rdr` 命不中。`route-to` 是 out 方向规则，正是为「本机/转发包的策略路由」设计的。

规则（v4，物理网卡集合 `{en0 en1 …}`，utun 名与对端都从运行时求）：

```
pass out quick on { en0 en1 } route-to (utun4 172.19.0.2) inet proto { udp tcp } from any to any port 53 keep state
```

- **`route-to` 必须写在 `proto/from/to` 之前**。macOS 的 pf 是旧版语法：写成 `pass out quick on en0 inet proto udp … route-to (…)` 会直接 `syntax error`（`pfctl -n -f -` 实测，2026-11-26）。`route-to (utun4)`、`route-to utun4`、`rdr-to`、`nat-to`、`dup-to`、`reply-to` 也都不解析；`rdr pass … -> …` 能解析但方向不对（in 方向，命不中本机进程的包）。顺序写错就是「规则静默不生效」——真机不报错但也不管用，所以 `rules_text()` 的单测必须断言 `route-to` 的下标小于 `proto`。
- 目的地址**保持原样**（用户路由器 DNS 或 223.5.5.5），进 TUN 后由 `hijack-dns` 接管。
- `keep state`：route-to 需要状态跟踪，显式写上。
- 只写 v4：TUN 只有 v4 地址（`TUN_ADDRESS_MACOS`），v6 DNS 见 §2.7。

### 2.2 anchor 名：`com.apple/veyl-dns`

pf 只评估主规则集里 `anchor "…"` 引用到的位置。macOS 自带 `/etc/pf.conf` 只有 `scrub/nat/rdr/dummynet/anchor "com.apple/*"` 五条通配：

- 名为 `com.veyl.dns` 的 anchor 可以用 `pfctl -a com.veyl.dns -f -` 载入，但**永远不会被评估**；
- 要它生效只有两条路：改 `/etc/pf.conf`（不做）或 `pfctl -f` 换掉整套规则（会把 Apple 自带 anchor 一起干掉，不做）。

`com.apple/veyl-dns` 命中 `anchor "com.apple/*"` 通配、自动被评估；Apple 自己的 Application Firewall 就是 `com.apple/250.ApplicationFirewall`，同一机制。它仍是「独立 anchor」：`pfctl -a 'com.apple/veyl-dns' -F all` 只清我们这两条。

### 2.3 网卡集合（不写死 en0）

两个来源取并集，去重排序：

1. `networksetup -listnetworkserviceorder` 里每个 `Device: enX`（按服务取）；
2. `ifconfig -l` 里的 `en*`、`bridge*`（兜住没有网络服务的接口）。

两者都只做文本解析（`Device: en0` 与名字过滤），不依赖服务名语言。载入时只保留当前**存在**的接口；连接期间接口集合变了由 §2.5 的热重载补上。

### 2.4 utun 名与对端地址

- utun 名：扫 `ifconfig -a`，找持有 TUN 地址的 `utunN`（现有 `diag_tun_interface` 的逻辑提升为生产路径）；spawn 后最多等 3 秒，100ms 一轮。
- 对端：从 `prepare_config` 产出的 `inbounds[type=tun].address` 取 v4 CIDR（数组或字符串两种形态已有解析），`/30` → `network+2`，`/31` → 另一端，其他前缀按 `addr+1` 兜底。**不写死 172.19.0.2**。
- 任一取不到 → pf 视为失败（回退 + 原因）。

### 2.5 生命周期

| 时机 | 动作 |
|---|---|
| helper 启动（`sweep_stale` 一带） | `pfctl -a 'com.apple/veyl-dns' -F all`，清崩溃残留（幂等） |
| 连接 start（spawn sing-box 之后） | 解析 utun+对端 → `pfctl -e`（"already enabled" 视为成功）→ 再清一次 anchor → 从 stdin 载入规则 → `pfctl -a … -sr` 回读确认两条都在 |
| 载入确认之后 | 清一次 DNS 缓存：`dscacheutil -flushcache` + `killall -HUP mDNSResponder`（复用 `dns.rs` 的 flush 助手）。只在真的 (re)load 成功后做，不做定时 HUP |
| 连接期间（status 的 5s 复核里） | 每 ≥30s 做一次：utun 还在？物理网卡集合变了？`pfctl -a … -sr` 还读得到？任一不满足就 flush+reload+回读+清缓存。pf 掉线（`pfctl -s info` 显示 Disabled）就重载并重 `-e` |
| stop | `pfctl -a 'com.apple/veyl-dns' -F all`（不禁用 pf，别人可能在用） |
| 进程退出（atexit，与 `restore_dns_at_exit` 并列） | 同上，2 秒预算 |

系统可能在某个时刻重载 `/etc/pf.anchors/com.apple`，是否会连带清掉 `com.apple/*` 子 anchor 无法从文档确认——所以「每次连接都重新载入 + 回读确认 + 5s 复核周期性确认」是硬要求，不能只首次连接载入一次。

所有 pfctl 调用走现有命令执行器（1.5s 预算、超时 kill）；载入规则需要新增一个带 stdin 的变体（`pfctl -a … -f -`）。

### 2.6 失败语义与状态

- **失败不阻断连接**：任何一步失败只记日志 + 回退到现有 `dns.rs` 改 DNS 路径。
- XPC 状态沿用 `dns_applied` / `dns_reason`，语义改成「**系统解析器的查询确实被送进隧道**」：
  - pf 生效 → `applied=true`，`reason=None`；
  - pf 失败但改 DNS 成功 → `applied=false`，`reason="pf 未生效：<原因>（DNS 已指向 223.5.5.5，仍可能被污染）"`；
  - 两者都失败 → `applied=false`，`reason` 带两条原因。
- **新增 `dns_via: "pf" | "system" | "none"`**（诊断必需）。`system` 指回退到 dns.rs 改 DNS 的路径。App 按可选键读。
- **语义变更提示**：`dns_applied` 从「已改系统 DNS」变成「查询确实进了隧道」，它是 XPC 内部字段、不是对外契约；App 侧若有展示文案引用它，需要同步措辞，否则会出现「显示已接管但其实没接管」（或反之）的误导。

### 2.7 与 `dns.rs` 的分工

**pf 生效时完全不改系统 DNS；pf 失败才回退到今天的改法。**

理由：

- pf 覆盖「本机产生的所有 53 端口包」，包括 mDNSResponder 绑接口发的那种——这正是改 DNS 做不到的；
- 不改系统 DNS，就不存在「崩溃后 DNS 残留指向 223.5.5.5」；隧道正常退出时用户网络立刻回到自己的解析器，「隧道挂了不断网」自然成立；
- pf 的记录只有 anchor 一个，stop/启动清扫都幂等，比 State 键的捕获-还原状态机简单。

条件回退（唯一例外）：如果当前服务只配了 **IPv6** 的 nameserver（规则只写 v4，v6 查询会漏），这时仍执行改 DNS，把解析器拉到 v4。

备选（未采用）：pf + 保留改 DNS 的双保险，行为与今天最接近，但保留了脆弱的捕获/还原状态机。

## 3. 真机预检（已执行：否定）

`route-to` 对**绑定了接口的 socket** 是否有效，是本案唯一没有被实测过的假设（FreeBSD 系内核里 `pf_route()` 会绕开 `inp_boundifp`，但 macOS 是自家分支）。2026-11-26 在已连接 TUN 的真机上执行，**结论是否定**，见 §3.1。

> **教训（已记入项目记忆）**：会改系统网络状态的命令必须自带无条件清理，不能拆成多步让用户手动恢复。下面这段原封不动保留作记录，但**不要再照抄执行**——当时没有 `trap` 兜底，结果整机断网、只能重启恢复。今后任何需要 sudo 的同类预检，必须写成一条命令、用 `trap '清理' EXIT` 无条件收尾。

```bash
# 1) 看 tun 设备名与地址（确认 172.19.0.1 在哪个 utun 上）
ifconfig -a | grep -B 3 172.19.0.1

# 2) 启用 pf 并载入一条临时规则（utunN 换成上一步看到的）
sudo pfctl -e
# 可先干跑校验语法（-n 只解析不装载）；macOS 对规则顺序很挑，见 §2.1
printf '%s\n' 'pass out quick on en0 route-to (utunN 172.19.0.2) inet proto { udp tcp } from any to any port 53 keep state' | sudo pfctl -a 'com.apple/veyl-dns' -n -f -
printf '%s\n' 'pass out quick on en0 route-to (utunN 172.19.0.2) inet proto { udp tcp } from any to any port 53 keep state' | sudo pfctl -a 'com.apple/veyl-dns' -f -

# 3) 清 DNS 缓存：不清的话 mDNSResponder 会继续用旧（被污染）的答案
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder

# 4) 决定性检查：真正要治的是 mDNSResponder，不是 dig
dscacheutil -q host -a name www.google.com

# 5) 对照：绑定 en0 源的 dig（只是近似，不能替代第 4 步）
dig -b <en0 的地址> @223.5.5.5 www.google.com +short

# 6) 回程抓包（第二个未验证假设：出 en0、回 utun 的半连接，内核认不认）
#    另开终端跑这两条，然后在第三个终端再触发一次查询：
sudo tcpdump -ni utunN port 53
sudo tcpdump -ni en0 port 53
#    期望：请求出现在 utun、不出现在 en0（en0 也看得到说明 route-to 没生效）；
#    应答从 utun 回来、被本地 socket 收下（tcpdump 里 udp 双向各一条为正常）。

# 7) 清掉
sudo pfctl -a 'com.apple/veyl-dns' -F all
```

### 3.1 结果：route-to 不成立（2026-11-26）

| 项 | 值 |
|---|---|
| 日期 / 执行人 | 2026-11-26，用户真机执行 |
| 实测规则 | `pass out quick on en0 route-to (utun4 172.19.0.2) inet proto { udp tcp } from any to any port 53 keep state` |
| 载入确认 | `pfctl -a com.apple/veyl-dns -sr` 回读两条都在（udp/tcp 各一条） |
| 清缓存后现象 | **整机断网**：所有解析超时，浏览器/命令行全部失效，只能重启电脑恢复 |
| 第 4 步 `dscacheutil` | 无法完成（解析超时） |
| 第 5 步 `dig -b` | 失败（同上） |
| 回程 | 请求进了隧道，**应答回不到绑定 en0 地址的本地 socket**——每笔查询都失败 |
| 结论 | **route-to 不成立，pf 方案作废**。不是语法问题，是 macOS 内核在这条路径上的行为，调规则写不回来 |
| 收尾 | 重启后确认 `pfctl -a com.apple/veyl-dns -sr` 为空 |

判定说明（原计划的三个分支，实际落在第三个）：`route-to` 把出方向送进 utun，但「出 en0、回 utun」的半连接被内核丢弃，于是**加上规则 = 全机失去解析**。这条路在 macOS 上关死。

**处置**：不实现任何 pf 代码，`pf.rs` 不新建；§4–§6 只作原计划留档。备选方案见 `tun-dns-forwarder.md`。

## 4. 代码落点（作废，仅留档，不实现）

> `pf.rs` 不新建，`macos.rs` 不接入任何 pf 调用。以下是原计划，仅供将来重开时参考。

- 新增 `src-tauri/src/bin/veyl-helper/macos/pf.rs`：
  - `activate(config) -> PfHijack`（解析 utun/对端、`-e`、flush、load、回读）；
  - `deactivate()`、`sweep()`（启动清扫）、`recheck(deadline) -> Option<PfHijack>`（5s 复核里的热重载）；
  - 纯函数：`rules_text(interfaces, utun, peer)`、`physical_interfaces(networksetup, ifconfig)`、`tun_peer(cidr)`、`pf_enabled(pfctl_info)`——全部可单测。
  - `rules_text()` 必须按 macOS 语法把 `route-to` 放在 `proto/from/to` 之前（§2.1），单测里断言这个顺序。
- `macos.rs`：start 里接入（**pf 成功则跳过改 DNS**）；stop / 启动清扫 / atexit 三处加 `pf::…`；status 复核改走 `pf::recheck`；`Started.dns` 语义按 §2.6。
- `dns.rs`：逻辑不动，由调用方决定是否调用 `activate()`；其 `restore*` 保持幂等空转。
- 无协议变更（XPC 仍回 `dns_applied`/`dns_reason`，新增可选 `dns_via`）。

## 5. 测试（作废，仅留档）

单测（不需要 root，命令注入照 `dns.rs` 的 `install_command_fake` 模式）：规则文本（多网卡/`proto { udp tcp }`/keep state）、**`route-to` 的下标小于 `proto` 的下标**（macOS 语法，写错就静默失效）、接口集合解析（networksetup 与 ifconfig 两种文本、去重、排除 utun/lo）、utun 名解析、CIDR → 对端、`pfctl -s info` 的 Enabled 判定、pf 失败 → 回退改 DNS 的决策、status 组装。

真机验收（用户在场）：

1. 连接后 `dscacheutil -q host -a name www.youtube.com` 的地址与不带 `-b` 的 `dig` 一致；
2. `curl -s -o /dev/null -w '%{http_code}' https://www.youtube.com` → `200`；
3. 断开后 `sudo pfctl -a 'com.apple/veyl-dns' -sr` 为空；系统 DNS 与连接前一致；
4. 连续开关 5 次：anchor 空、无 utun 残留、解析正常；
5. 断网重连（切 Wi-Fi / 插拔网线）后第 1 条仍成立（热重载）；
6. 代理模式下 `pfctl -a 'com.apple/veyl-dns' -sr` 始终为空（helper 不参与代理）。

## 6. 风险

1. **route-to 对绑定接口 socket 无效**——唯一未验证假设，§3 预检决定；失败则转本地转发器。
2. **helper 被 SIGKILL**：atexit 不跑，anchor 残留；utun 不在时规则会黑洞 DNS，直到下次 start/sweep。缓解：helper 每次启动都 sweep；launchd 按需拉起成本很低。可接受。
3. **连接后新增物理接口**（如插上 USB 网卡）：5s 复核 + 30s 节流内补上；窗口内该接口的 DNS 可能漏。
4. `pfctl -e` 在 Managed/MDM 限制下可能被拒；按失败处理并回退。
5. IPv6-only DNS 的例外见 §2.7。
6. anchor 名与 Apple 规则共处一个子树；我们用 `quick` 且只匹配 53，冲突面很小，但真机需顺带确认 Application Firewall 行为不变。

## 7. 不在本文范围

- **pf 相关代码一律不上**：`pf.rs` 不新建、`macos.rs` 不接任何 pfctl 调用、anchor `com.apple/veyl-dns` 不再出现在任何实现里。本文所有规则文本只作记录。
- 系统级加密 DNS（DoH/DoT 配置描述文件）：不经过 53 端口，本期不做。
- 只覆盖 IPv4 传输；IPv6-only 解析器的回退见备选设计。
- macOS 是否补 QUIC reject：已评估并**不采纳**，见 `tun-quic-reject.md`。与本方案互不依赖。
