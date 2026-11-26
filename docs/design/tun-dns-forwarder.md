# macOS TUN：helper 内置 DNS 转发器（备选方案）

> 日期：2026-11-26
> 状态：**已实现，未提交，待交叉评审**。预检 A/B 均通过（2026-11-26）；真机验收清单见 §9。
> 上游：`tun-dns-pf.md`（pf `route-to` 方案已被真机否定：出 en0、回 utun 的半连接被内核丢弃，载入即整机断网）
> 范围：`src-tauri/src/bin/veyl-helper/**`，必要时 `src-tauri/src/tun/**`
> 结论一句话：系统 DNS 指向 `127.0.0.1`（次选 `223.5.5.5`），helper 内的转发器用 `IP_BOUND_IF` 把查询绑定到 utun 送进隧道，由 `hijack-dns` 回答；转发器只做字节中继，不解析、不缓存、不分流。

---

## 1. 为什么这条路能绕过接口绑定

- mDNSResponder 按网络服务绑接口发查询，发往物理网卡之外的地址时绕过路由表（这是 pf 方案要解决的问题）。
- 但发往 **`127.0.0.1`** 时，包直接由本机 loopback 投递，不经过任何物理接口——**接口绑定不再起作用**。
  **预检 A 已通过（2026-11-26）**，两种绑定方式都能送达 loopback：
  - `IP_BOUND_IF` 绑 en0 接口索引 → `received b'ping'`；
  - socket 绑 en0 的地址 `192.168.18.98` → `received b'ping'`。
- 由此可以确认因果：**绑接口本身不会丢包，它只是让路由选择绕开 TUN**；loopback 没有路由选择这回事，所以直达。这也是 pf 方案在「出 en0、回 utun」上失败、而本方案不受影响的原因。
- 隧道侧：转发器自己开的 socket 用 `IP_BOUND_IF` 绑定 utun，包直接写进 tun；`hijack-dns` 按协议匹配 53 端口，不挑目的地址（已有实测：不绑源的 `dig @223.5.5.5` 能拿到真实 IP）。
- 回程：sing-box 把应答写回 utun（目的地址是 utun 自己的地址），内核交给**绑定在 utun 上的那个 socket**。与 pf 方案的关键差别是：收应答的 socket 就在 utun 上，不存在「出 en0、回 utun」的半连接。

数据流：

```
mDNSResponder --127.0.0.1:53--> 转发器 --IP_BOUND_IF(utunN)--> 223.5.5.5:53（进 TUN）
                            <--应答（写在 utun 上，dst=172.19.0.1）---
```

上游地址用 `223.5.5.5`（当前 `SYSTEM_DNS_TARGET`），**不用** `172.19.0.2`：对端地址在排除段里、且 gvisor 是否接受发往对端地址的包未经验证。

## 2. 系统 DNS 怎么写

主服务的 `State:/Network/Service/<uuid>/DNS` 写成**两条**：

```
["127.0.0.1", "223.5.5.5"]
```

- 首选 `127.0.0.1`：命中转发器 → 干净答案（DoH over proxy）。
- 次选 `223.5.5.5`：转发器不在/挂掉时，mDNSResponder 退到它，**机器不会失去解析**（可能被污染，与今天一致）。这条是「转发器自己挂掉时用户不能断网」的兜底。

写入后必须 flush 缓存（`dscacheutil -flushcache` + `killall -HUP mDNSResponder`），否则 mDNSResponder 手里的旧投毒答案会继续用。

**还原**：沿用 `dns.rs` 现有的快照/还原状态机，但 `SavedDns.written` 从单个字符串扩展成 `Vec<String>`；`RestoreAction` 的「当前值还是不是我们的」判定按集合处理：
- 当前值完全等于写入集合 → 还原快照；
- 当前值只包含其中一条（用户连接期间手动改过）→ 摘掉我们的两条、保留其余；
- 当前值与我们无关 → 什么都不做。

## 3. 与 `hijack-dns` / sing-box 的关系

- 转发器**不解析、不缓存、不做分流**：只把 UDP/TCP 53 的字节原样中继进 TUN（保留 DNS ID 与 EDNS，不做任何改写）。
- 真正的解析链仍是 sing-box 的 `dns`（`dns-local` / `dns-remote` DoH over proxy），`hijack-dns` 是入口。**不改 sing-box 配置**，不引入第二套分流规则。
- 查询进 TUN 时的源地址变成 utun 的地址（`172.19.0.1`），`hijack-dns` 不关心源地址。

## 4. 失败与兜底

| 场景 | 行为 |
|---|---|
| `127.0.0.1:53` 绑定失败（端口被占） | 不改系统 DNS，回退到今天的单条 `223.5.5.5` 路径，`dns_via="system"`，日志写明被谁占用 |
| 转发器线程 panic / 监听退出 | 监听缺失 → mDNSResponder 退到次选 `223.5.5.5`，不断网；5s 复核发现后标 `dns_applied=false`，并尝试重启监听 |
| sing-box 退出 / utun 不存在 | 转发器检测不到 utun → 改为**不绑接口**直接发 `223.5.5.5`（走物理网卡），解析不中断 |
| 隧道内查询超时（≤3s） | 同一条查询改走直连再试一次，仍失败就回 SERVFAIL |
| 并发打满（UDP/TCP 各 64） | 回 SERVFAIL（保留 ID 与问题段），不是静默丢弃；客户端立刻走次选 |
| **转发器不在但系统 DNS 仍含 `127.0.0.1`** | **不变量兜底**：立刻把服务级 DNS 改写成剩下的公网地址并 flush（幂等）。复核重建失败、启动接管失败、stop 之后、启动清扫都调用它 |
| helper 被 SIGKILL | 系统 DNS 停在两条：转发器已死，但次选仍能解析；下次 helper 启动的 sweep 会还原，并按不变量兜底把回环摘掉 |
| helper 正常退出 | **先还原系统 DNS、flush，再停监听**（顺序不能反，否则关监听瞬间的查询会失败） |

## 5. IPv6

- 监听只绑 `127.0.0.1`（v4）。AAAA 查询照常走转发器，由 sing-box 的 `ipv4_only` 策略处理。
- 隧道出站只 v4（`TUN_ADDRESS` 只有 v4）。
- 某个网络服务只配了 IPv6 nameserver 时也成立：我们写入的是 v4 回环，不依赖原 nameserver。

## 6. 生命周期

| 时机 | 动作 |
|---|---|
| start | 绑定监听 → 起线程 → 写系统 DNS（两条）→ flush 缓存 → 状态 `dns_via=forwarder` |
| stop | 还原系统 DNS → flush → 停监听 → 清状态 |
| helper 启动清扫 | 若发现系统 DNS 已是我们的两条（上次残留）→ 先还原 |
| 进程退出（atexit） | 同 stop，2 秒预算 |
| 5s 状态复核（与代码一致：每 5s 一次） | 监听还活着？系统 DNS 还指向 `127.0.0.1`？utun 还在？任一不满足就修复；重建失败立刻走不变量兜底 |

## 7. 状态字段

- `dns_applied`：`true` 仅当「监听活着 **且** 系统 DNS 指向它」——语义仍是「系统解析器的查询确实会进隧道」。
- `dns_via`：`forwarder` | `system` | `none`（`system` = 回退到今天的单条 `223.5.5.5`）。
- 与 pf 设计一样，`dns_applied` 语义变更需 App 侧文案同步。

## 8. 预检（不修改系统状态）

**A. loopback 是否被接口绑定挡住**（决定性假设：mDNSResponder 绑了 en0 还能不能把包送到 127.0.0.1）

**状态：已通过（2026-11-26）。**

```
A/if_bound:   received b'ping'   # IP_BOUND_IF 绑 en0 接口索引，发往 127.0.0.1
A/addr_bound: received b'ping'   # bind 到 en0 的地址 192.168.18.98，发往 127.0.0.1
```

两种绑定方式都能送达，结论见 §1：绑接口只是让路由选择绕开 TUN，loopback 没有路由选择，所以直达。

原命令（留档）：

```bash
python3 - <<'PY'
import socket
srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
srv.bind(("127.0.0.1", 0)); srv.settimeout(2)
port = srv.getsockname()[1]
cli = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
cli.setsockopt(socket.IPPROTO_IP, 25, socket.if_nametoindex("en0"))  # IP_BOUND_IF
cli.sendto(b"ping", ("127.0.0.1", port))
try:
    print("A: received", srv.recvfrom(16))
except socket.timeout:
    print("A: NOT received —— loopback 也被绑定挡住，本方案作废")
PY
```

**B. 绑定 utun 的 socket 能否把查询送进隧道并收到应答**（在已连接的 TUN 上跑，`utunN` 换成实际的）

**状态：已通过（2026-11-26，utun4）。**

```
B / 绑 utun4 : 161B  A=['142.251.157.4','142.251.152.4','142.251.151.4']
B / 不绑     : 161B  A=['142.251.157.4','142.251.152.4','142.251.151.4']
```

绑在 utun 上的 socket 能进隧道并拿到真实 Google 地址，同时证明 `hijack-dns` + DoH over proxy 这条链是好的。

```bash
python3 - <<'PY'
import socket, struct
ifn = socket.if_nametoindex("utunN")
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
s.setsockopt(socket.IPPROTO_IP, 25, ifn)
name = b"".join(bytes([len(p)]) + p.encode() for p in "www.google.com".split(".")) + b"\0"
q = struct.pack("!HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + name + struct.pack("!HH", 1, 1)
s.sendto(q, ("223.5.5.5", 53))
try:
    data, _ = s.recvfrom(4096)
    print("B: got", len(data), "bytes, tail:", data.hex()[-32:])
except socket.timeout:
    print("B: timeout —— 隧道侧不通，本方案作废")
PY
```

**C. 53 端口占用：改为运行时判定，不做一次性预检。**

非 root 的 `lsof -nP -iUDP:53 -iTCP:53` 只能看到本用户可见的进程，说明不了系统级占用（实测无输出）。实现里按 §4 的兜底执行：**启动时直接尝试 bind `127.0.0.1:53`，失败记录占用方并回退旧路径**（`dns_via="system"`）；`sudo lsof` 只作为失败后的诊断手段写进日志。

**预检纪律**：以上三条都不改系统状态，可以安全反复跑。**任何会改系统 DNS 的验证步骤必须写成一条命令、用 `trap` 无条件还原**——pf 那次就是因为拆成多步、没有兜底，载入规则后整机断网只能重启恢复。

## 9. 代码落点（已实现）

- 新增 `src-tauri/src/bin/veyl-helper/macos/dns_forwarder.rs`：
  - 全局单例 `start(utun_index) / stop() / is_running() / set_utun(index)`（atexit 也要能停它）；
  - 内部 `Core` 持有监听线程；UDP/TCP 53 各一个监听线程，每查询一个短命工作线程，`MAX_INFLIGHT=16` 封顶；
  - UDP 出站用 `IP_BOUND_IF` 绑 utun，失败/超时改走不绑接口的直发路径；TCP 用 `connect_timeout` 走路由表（std 无法「先绑接口再 connect」，而 `auto_route` 已把 `223.5.5.5` 指向 utun）；
  - 报文**不解析**（只校验长度 ≥ 12、≤64KB 并原样转发），没有 DNS 解析器的攻击面；
  - `tun_index(config)` 从 sing-box 配置取 TUN 地址，再从 `ifconfig -a` 找持有它的 utun（纯解析函数 `tun_interface_for` 可单测）。
- `dns.rs`：`SavedDns.written` 与 `RestoreReport.target` 改成 `Vec<String>`；`activate()` 改为 `activate_with_targets(&[..])`；还原判定按集合（整组都是我们的 → 还原快照；含我们的 → 摘掉；都不是 → 不动）；新增 `strip_stale_loopback`：崩溃残留的回环地址不会被当成「原始值」。
- `macos.rs`：start 先起转发器（utun 索引最多等 1 秒）再写两条 DNS，成功后 flush 缓存；失败则回退单条公网地址并停转发器；stop/atexit **先还原 DNS 再停监听**；5 秒复核会确认监听活着、必要时重建、并刷新 utun 索引；`dns_via` 随 start/status 回复给 App。

## 10. 实现记录（2026-11-26）

- 新增单测：UDP 中继回环（假上游）、短包丢弃、TCP 长度前缀与端到端、绑接口的 TCP 连接、端口被占报错与退避、stop 及时退出、写死上游不 panic、**绑 utun 失败→直发**、**并发打满→SERVFAIL（含 EDNS 截断、问题段损坏回退头部）**、TUN 地址/接口解析、双地址还原「整组/含一条/都不是」、崩溃残留清理（含公网次选）、**回环不变量兜底**、回滚失败进上报原因、`dns_via` 标签。
- `cargo test -p veyl --bin veyl-helper`：**146 passed / 0 failed**。
- `cargo test -p veyl --lib`：**1401 passed / 0 failed / 3 ignored**（89s，评审后复跑）。
- 未改 sing-box 配置、未改 XPC 契约（只是多回一个可选键 `dns_via`）。
- 接管失败时**回滚失败不静默**：`activate_once` 把「写/回读失败」与「回滚结果」拼成一条原因（`join_restore_error`），不会只报前半段。

### 评审后修复（Felix，1 P1 + 3 P2 + 6 P3；delta 复核再 2 P3）

- **P1 不变量**：`dns::ensure_no_dangling_loopback()` —— 转发器不在运行且服务级 DNS 仍含 `127.0.0.1` 时，立刻改写成剩下的公网地址并 flush，同时把快照里的回环摘掉（否则后续 restore 会判错）。接入六处：复核重建失败、start 接管失败、stop 之后、atexit、启动清扫、`restore_dns` RPC。退出路径用 `ensure_no_dangling_loopback_at_exit()`（try_lock + 500ms 总预算），绝不拖慢 launchd 拉起。
- **P2**：EINTR 归 `continue`；并发上限 16→64 且 UDP/TCP 分开计数，超限回 SERVFAIL（保留 ID 与问题段）；重建带 6 次 ×100ms 退避，`is_running` 同时反映 TCP 监听。
- **P3**：UDP 接收缓冲 4096→65535；`ifconfig` 加 1.5s 超时；`connect_tcp_bound` 恢复阻塞模式失败即放弃；崩溃残留清理覆盖公网次选（有回环在列即视为我们的整组）。

### Delta 复核修复（再 2 P3，1 条记录不改）

- **P3-1**：`servfail` 改为按 QDCOUNT **精确截到问题段**——带 EDNS 的查询不再生成「ARCOUNT=0 但尾部留着 OPT」的畸形应答；问题段解析不了就只回 12 字节头（QDCOUNT=0）。新增两条单测（EDNS 截断、问题段损坏回退）。
- **P3-2**：退出路径的兜底改成 `ensure_no_dangling_loopback_at_exit()`——`try_lock` 自旋 + 500ms 总预算，`scutil` 与写入都用带 deadline 的变体，超时直接放弃（残留交给下次 sweep）。不再让 atexit 有阻塞锁 + 无界 scutil。
- **P3-3（不改，记此备查）**：`Core::start` 重建时持 `ACTIVE` 锁做最多 6×100ms 退避；并发场景多等半秒可接受，不值得为它加锁外状态机。

## 11. 真机验收清单（按这个顺序）

**先测兜底，再测主路径**——顺序反过来会让用户再一次整机断网。

### 第 1 步：转发器消失时网络不断（兜底）

1. 连上 TUN，确认 `scutil --dns | grep nameserver` 里能看到 `127.0.0.1` 和 `223.5.5.5` 两条（`dns_via=forwarder`）。
2. `pgrep -f veyl-helper` 记下 pid，`sudo kill -9 <pid>`（模拟转发器随 helper 一起消失）。
3. 立刻跑 `dscacheutil -q host -a name www.example.com` —— **必须能解析**（走次选 `223.5.5.5`）。这一步就是「被杀掉后不断网」的复现。
4. `scutil --dns` 里仍应看到两条；恢复方式：重新连接（start 会重建转发器并重新写 DNS），或点 App 的「断开」。

**变体：监听还在但不响应**（`sudo kill -STOP <pid>`，模拟假死 / 打满）：

1. 连上 TUN，`sudo kill -STOP $(pgrep -f veyl-helper)`（helper 暂停，监听在但没人接）。
2. `dscacheutil -q host -a name www.example.com`：应在客户端超时预算内拿到答案或明确失败（进程暂停时查询会超时；`kill -CONT` 后必须恢复）。**不允许长时间挂起不回**。
3. `sudo kill -CONT $(pgrep -f veyl-helper)` 后立刻再查一次：应恢复正常（主路径或兜底都算通过）。
4. 真正的并发打满由单测覆盖（`MAX_INFLIGHT_UDP`/`TCP` 超限回 SERVFAIL），真机不人为制造。

### 第 2 步：主路径（查询真的进隧道）

1. 连上 TUN，`scutil --dns` 首选是 `127.0.0.1`。
2. `dscacheutil -q host -a name www.google.com` 返回真实 `142.251.x`（与不带 `-b` 的 `dig` 一致）。
3. `curl -s -o /dev/null -w '%{http_code}' https://www.youtube.com` → `200`；Safari/WebView 打开同一站点正常。
4. 断开后 `scutil --dns` 恢复成连接前的 DNS（用户路由器），`127.0.0.1` 不残留；`pfctl` 无关、无 anchor。
5. 连续开关 5 次：每次都能解析，断开后无 `127.0.0.1` 残留。
6. 断网重连（切 Wi-Fi / 插拔网线）：5 秒复核内恢复，`dscacheutil` 仍拿干净地址。

## 12. 风险

1. **预检 A 不通过**（loopback 也被接口绑定挡住）→ 本方案同样作废，需要更激进的做法（例如系统级 resolver 配置或 Network Extension），另开设计。
2. helper 被 SIGKILL 期间转发器消失：次选 `223.5.5.5` 保证不断网，但答案可能被污染（与今天一致）；崩溃后原始 DNS 快照丢失，下次断开只会还原到公网地址，不会还原到用户路由器——与现有 `restore_or_clear` 的已知限制一致。
3. `127.0.0.1:53` 被其他软件占用：不抢端口，回退旧路径。
4. TCP DNS 大响应（少见）：最小中继要能处理 64KB 长度前缀；超时丢弃让客户端重试。
5. 多一跳本地中继，延迟在微秒级，可忽略。
