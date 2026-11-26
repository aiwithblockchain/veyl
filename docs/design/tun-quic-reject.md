# macOS TUN 是否补 QUIC reject：不采纳（记录）

> 日期：2026-11-26
> 状态：**不采纳，未提交，待评审（作为记录留档）**。曾实现后回滚，`src-tauri/src/config/builder.rs` 无改动。
> 上游：`tun-dns-pf.md`（同批的 DNS 问题）、`docs/design/mobile-export-technical.md:887`（手机端不跟随的既有决定）
> 结论一句话：**macOS 不加 `{"protocol":"quic","action":"reject"}`**——真机实测证明 macOS 上 UDP/QUIC 经节点有回程，加了只会让出海站点白丢 HTTP/3。Windows 那条规则保留不动。

---

## 1. 经过

- 线索：`signaler-pa.clients6.google.com` 解析到真实 IP `142.250.105.95`，走 `SS packet connection` 之后没有回程日志，看起来与 Windows 2026-11-20 的「YouTube 只用 QUIC、UDP 经节点无回包」同源。
- 当时的判断：macOS 缺这条规则是遗漏，应把 `builder.rs` 里被 `#[cfg(target_os = "windows")]` 锁死的规则放开到两个平台（位置保持在分流规则之后、`final` 之前，靠顺序只拒「会出海的 QUIC」）。
- 实现过一版（去 cfg + 测试取消平台门控 + 新增 Proxy 模式无此规则的用例），后用真机证据回滚。

## 2. 推翻依据（Tess，2026-11-26，macOS 真机端到端）

1. **STUN 双站点经节点 250ms 有回程**——UDP 经节点是通的；
2. `openssl` 对 google / youtube / signaler-pa **握手全部成功**；
3. Chrome 强制 HTTP/3 打开 YouTube：**发出 38 个请求、收到 36 个响应，页面渲染成功**。

即：macOS 上「无回程日志」不等于「UDP 经节点不通」。Windows 那个现象在 macOS 不存在，加 reject 只会让出海站点失去 HTTP/3（浏览器被迫回落 TCP）。

## 3. 结论与边界

- **不采纳**：macOS TUN 不加 QUIC reject；`src-tauri/src/config/builder.rs` 保持原样（已回滚并核对 `git diff` 为空）。
- **Windows 规则保留不动**：它有自己的真机依据（2026-11-20），本次结论仅限「不往 macOS 移植」。
- **手机端不跟随**：`mobile-export-technical.md:887` 已按 iPhone + sing-box 真机（含直播）决定不加；桌面与手机网络路径不同，三个平台各有自己的证据。

## 4. 将来重开的判据

只有在 **macOS 本机**复现下面全部三条时，才按本记录重新评估：

1. 经节点访问目标站点出现持续性 QUIC/UDP 无回程（不是单次日志缺失）；
2. 同一路径 TCP 正常、而 QUIC 长期不可用；
3. STUN / 强制 HTTP/3 的对照实验在**同一节点、同一网络**下也失败。

重开时不要沿用 Windows 的取证，必须补 macOS 自己的实测。届时改动位置仍是 `plan.route_rules` 之后、`final` 之前。

## 5. 当时评估过的替代（仍不适用）

- QUIC 改走 `direct`：会把真实 IP 暴露给被墙站点并直接被阻断，比拒绝更糟。
- 客户端按节点探测 UDP 能力决定：node 侧 UDP 回程是产品级现状，先不做；将来节点支持 UDP 再评估。
