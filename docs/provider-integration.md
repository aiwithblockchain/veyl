# 第三方服务商接入调研

> 日期：2026-11-03
> 执行：Bob（sing-box 1.14.4 实机验证 + 各家官方资料）
> 结论用于判断「自带服务商」这条路走不走得通。

---

## 1. 一句话结论

**最大障碍不是协议，是账号体系；其次是订阅格式转换。**

协议层要的东西 sing-box 基本都有；难的是大厂把配置锁在自己账号后台，以及机场的订阅格式它不认。

---

## 2. 协议支持

| 类别 | 协议 |
|---|---|
| **稳定** | direct、block、socks、http、shadowsocks(AEAD)、vmess、vless、trojan、hysteria、hysteria2、tuic、anytls、shadowtls、naive、ssh、tor、selector、urltest；wireguard 走 endpoint |
| **实验** | openvpn-client、openconnect（需构建 tag，且要结构化 JSON，不吃 `.ovpn`） |
| **已废弃 / 移除** | **WireGuard outbound**（1.13 移除，改用 endpoint）、ShadowsocksR（1.6 移除）、`geoip`/`geosite` 规则字段（1.12 移除） |

REALITY、hysteria2 端口跳跃与 obfs、TUIC、WireGuard endpoint 均已实测 `check` 通过。

---

## 3. 主流大厂：都不能用账号直连

**没有一家支持「在第三方客户端里输账号密码自动拉配置」。** 账号体系在服务商网页端，客户端只能消费导出物。

| 服务商 | 私有协议 | 能否接入 | 路径 |
|---|---|---|---|
| **NordVPN** | NordLynx | 私有协议**不能**；**标准 WireGuard 可以** | 官网后台导出 WG `.conf`（需 Verified 服务器） |
| **ExpressVPN** | Lightway | 私有协议**不能**；仅有 OpenVPN | `.ovpn` → 实验性，不建议承诺 |
| **Surfshark** | — | **可以** | 手动设置 → 生成 WireGuard `.conf` |
| **Mullvad** | — | **可以** | 官网下载 WireGuard 配置 |
| **Proton VPN** | — | **可以** | Router 平台生成 WireGuard 配置 |

无法接入的根本原因：**NordLynx、Lightway、IKEv2/IPSec 是协议级缺失**，不是配置问题。

---

## 4. 机场类：协议全通，门槛在格式

卖 SS / VMess / VLESS / Trojan / Hysteria2 / TUIC 的机场，**协议层全部能接**。
门槛只有一个：它们发的都是订阅格式，不是 sing-box 配置。

例外：含 SIP003 插件（obfs / v2ray-plugin）的 SS，需要额外插件可执行文件，sing-box 只认 `plugin` 字段、不内置插件。

---

## 5. 订阅格式与工作量

| 格式 | sing-box 能否直接吃 | 转换工作量 |
|---|---|---|
| **sing-box JSON** | ✅ 唯一可直接吃 | — |
| **SIP008** | ❌ | 0.5–1 天（SS-only，映射直接） |
| **base64 节点列表** | ❌ | 常用子集 3–5 天 / 健壮版 1–2 周 |
| **Clash YAML** | ❌ | MVP 1–2 周 / 较完整 2–4 周 / 完全对齐数月 |
| **WireGuard `.conf`** | ❌（但可机械映射） | **低风险**，见 §6 |
| **OpenVPN `.ovpn`** | ❌ | 无解析器，实验性 |

Clash YAML 会丢的东西：load-balance / smart 组、SCRIPT 规则、部分 DNS 策略、sniffer、tun 与进程规则；classical rule-provider 需展开成 sing-box 规则。

---

## 6. WireGuard `.conf` 是最有价值的转换

字段能一一对上，属于机械映射：

```
PrivateKey   → endpoints[].private_key
Address      → address[]
MTU          → mtu
Peer.PublicKey → peers[].public_key
PresharedKey → pre_shared_key
Endpoint     → address + port
AllowedIPs   → allowed_ips
PersistentKeepalive → persistent_keepalive_interval
```

`DNS` / `Table` / `PostUp` 不进 endpoint：DNS 写到 route/dns，其余忽略。多 Peer 支持。

**意义**：这是接入大厂唯一现实的路径——Nord、Surfshark、Mullvad、Proton 都提供标准 WG 配置。

---

## 7. 能力差异（影响二级需求）

- **UDP**：SS / VMess / VLESS / Trojan 支持；Hysteria2 / TUIC 原生 QUIC 最佳；WireGuard 传输层只有 UDP（纯 TCP 网络会挂）；HTTP 无 UDP；SSH / Tor / AnyTLS / ShadowTLS / Naive 仅 TCP。
- **CDN 中转**：VMess / VLESS / Trojan 可走 ws/grpc/httpupgrade；REALITY、Hysteria2、TUIC、WireGuard **不能**走 CDN。
- **REALITY**：只有 VLESS 支持，`public_key` 必须是无 padding 的 base64，带 `=` 会报错。
- **端口跳跃**：只有 Hysteria2 与 Hysteria v1 支持。

---

## 8. 三类清单

| 分类 | 内容 |
|---|---|
| **可直接接入** | 用户提供 sing-box JSON 配置或节点 |
| **转换后可接入** | Clash YAML、base64 节点列表、SIP008、标准 WireGuard `.conf`、标准 OpenVPN `.ovpn`（实验性）、Nord/Surfshark/Mullvad/Proton 的官方 WG 配置 |
| **无法接入** | NordLynx、ExpressVPN Lightway、任何 IKEv2/IPSec、仅自家 App 可用的私有协议、ShadowsocksR、依赖服务商在线握手且不导出配置的客户端 |

---

## 9. 对本产品「文档驱动接入」方案的影响

服务商交一份 MD 说明、AI 据此改本地配置——这条路成立，但 MD 要覆盖**两种形态**：

| 形态 | 适用 | MD 里写什么 |
|---|---|---|
| **订阅型** | 机场 | 订阅链接的获取方式、格式类型（base64 / Clash / SIP008）、字段说明 |
| **导出型** | 大厂 | 如何在官网后台生成并下载 WireGuard `.conf`，以及服务商特有的注意事项 |

第一种需要转换层；第二种只需要解析 `.conf` 并机械映射，**成本低得多，却覆盖了最有名的几家服务商**。

---

## 10. 服务商的接入形态：AI 可读的 MD 文档

服务商不提供 API，而是提供一份**给用户的 AI 阅读的 Markdown 文档**。用户的 AI 读这份文档，据此修改本地配置，连上该服务商。

- 支付走区块链 x402 协议——**本期不展开**，先记方向。
- MD 分两种形态，见 §9：订阅型（机场）与导出型（大厂）。

## 11. 版本协商

服务商在 MD 中**声明所适配的 sing-box 版本区间**。用户选中该服务商时：

1. 读取本地当前 sing-box 版本。
2. 与声明的区间比对。
3. 不匹配则安装对应版本并切换；预置的基线版本始终保留，作为兜底。

**三条配套规则：**

| # | 规则 | 原因 |
|---|---|---|
| 1 | 版本声明用**区间**（如 `>=1.14,<1.16`），不用精确版本 | 精确版本把用户锁死在一个点上；相邻版本大多兼容 |
| 2 | **配置按目标版本生成**，不是一套配置打天下 | 我们现在的配置用了 1.14 的 `http_clients`、`rule_set`，降到 1.12 直接不认 |
| 3 | 切换失败自动**回落到预置基线版** | 新版本 `check` 不过，或连续两次连接失败，就退回并说明原因 |

**闭环**：预置版负责「第一次一定能连」，联网后按服务商要求换版本，换坏了退回。

## 12. 待决策

1. **OpenVPN 是否作为「实验性」承诺** —— 建议不承诺，无 `.ovpn` 解析器，做出来也只能覆盖部分配置。
2. **订阅转换的先后顺序** —— 建议 SIP008 + base64 先做（机场最通用、成本最低），Clash YAML 第二。
