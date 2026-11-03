# TUN 模式设计

> 日期：2026-11-03
> 依据：Bob 在 sing-box 1.14.4 上的实测（配置均以 `sing-box check` 退出码 0 验证）
> 适用：二级用户（不会配置代理、需要所有桌面应用自动可用）

---

## 1. 为什么必须做 TUN

二级用户不会在客户端软件里填代理，也不会设环境变量。独立桌面应用（Electron、自带网络栈、命令行工具）不读系统代理，所以对这批人，**TUN 是唯一不需要用户配合的方案**。

---

## 2. 与系统代理模式的四处差异

| # | 差异 | 说明 |
|---|---|---|
| 1 | **TUN 入站** | `type: "tun"`，`auto_route: true`，`auto_detect_interface: true` |
| 2 | **必须嗅探** | 入站的 `sniff` 字段在 1.13 已删除；写成 `route.rules` 的 `action: "sniff"`，且**必须排在域名规则与 DNS 劫持规则之前** |
| 3 | **必须显式 DNS 劫持** | macOS 命令行版 `dns_mode` 不生效，要写 `protocol: "dns" → action: "hijack-dns"` |
| 4 | **内网排除** | `route_exclude_address` + `ip_is_private` 双保险 |

`sni` 嗅探对 QUIC/HTTP3 有效；ECH/ESNI 会藏掉 SNI，这是协议限制，不是实现问题。

---

## 3. 固定参数

这些**不是适配出来的，是我们定死的**，写进配置模板：

| 项 | 值 | 原因 |
|---|---|---|
| `interface_name` | **留空** | macOS 只接受 `utunN`；写 `veyl-tun` 会报 `bad tun name` |
| `auto_route` | `true` | 否则流量不进 TUN |
| `auto_detect_interface` | `true` | **必开**，否则 direct 出口可能绕回 TUN |
| `address` | `172.19.0.1/30` | 私有段，固定值 |
| sniffer 列表 | `["http","tls","quic","dns"]` | **必须含 `dns`**，否则 DNS 劫持规则不命中 |
| 规则顺序 | sniff → hijack-dns → ip_is_private → 分流 | 顺序错会静默失效 |

---

## 4. 权限：常驻特权助手

macOS 上起 TUN 需要 **root**——要开 utun 控制 socket、改路由表。非 root 实测报：

```
configure tun interface: Connect: operation not permitted
```

**方案：首次使用时安装常驻特权助手**，管理员授权一次，之后 App 通过 XPC 调用，不再提示。

- macOS 13+ 用 `SMAppService`；更老的系统用 `SMJobBless`（已废弃但仍可用）
- App 与 helper 用**同一个开发者证书**签名（已有签名）
- 不采用「每次弹管理员密码」：对二级用户是灾难
- 不采用 NetworkExtension：需要 Apple 授权 entitlement，门槛过高

**必须处理的四件事：**

1. **首次授权要用一句话解释**——用户看到一个陌生的系统框会点取消
2. **卸载要清 helper**——它是系统级的，不主动删会一直留在机器上
3. **App 或 helper 更新后可能再次要求授权**，要能正确处理而不是报错
4. **启动前先判 euid**——非 root 直接给「需要管理员权限」，不要等它失败再报错

---

## 5. DNS 在 TUN 下的行为

- TUN 会抓发往**公网 DNS** 的 53 端口流量；发往路由器/局域网 DNS 的查询走更具体的直连路由，**不进 TUN**
- **不配 `dns` 段会走隐式 local**（系统 DNS）：能解析，但没有按域名分流、没有防污染
- **配了多条 DNS server 或 rules 后，缺 `route.default_domain_resolver` 会直接 FATAL 起不来**——不是降级，是启动失败
- 境外 DNS 用 `detour` 指向 proxy outbound，走代理查询
- DNS 查询失败是**硬失败**：被劫持的 UDP DNS 不回包（客户端表现为超时），不会回退系统 DNS

---

## 6. 内网排除

`ip_is_private` 覆盖私有段、回环、链路本地、组播，但**不覆盖**：

- `100.64.0.0/10`（CGNAT，**Tailscale 用的就是这段**）
- `198.18.0.0/15`（fakeip 段）
- 广播地址、`0.0.0.0/8` 里的非零地址

所以两层一起用：

| 层 | 手段 | 作用 |
|---|---|---|
| 路由表 | `route_exclude_address` | 内网流量完全不进 TUN，内核级，开销最低 |
| sing-box | `ip_is_private: true → direct` | 兜底仍进了 TUN 的包 |

只用一个的缺口：只用前者，`auto_route: false` 时无效且要自己列全网段；只用后者，CGNAT 和 fakeip 会被当公网走代理，Tailscale 直接坏。

---

## 7. 失败处理

探测到异常时，中间区域由**本地规则**插入一张「网络异常」卡，带「让 AI 定位」按钮。详见 `docs/user-flows.md` §5.2。
