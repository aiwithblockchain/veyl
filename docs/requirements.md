# Veyl 需求文档

> 版本：v0.5（草案）
> 日期：2026-10-30
> 状态：需求理解与方案对齐，待评审

---

## 0. 变更记录

**v0.7（2026-11-02）**

1. 产品名由 AIVPN 改为 **Veyl**；新增 §11.4「命名决策与已知风险」，记录商标冲突、域名状况与用户已知情下的决定。
2. 介绍页与下载改走 GitHub Pages，不做自有域名。
3. 契约信封键 `metadata.aivpn` **本期保留不改**，等契约升版再统一处理。

**v0.6（2026-10-30）**

1. 开发计划改为四阶段：**P1 能用 → P2 可测 → P3 可卖 → P4 去中心化**。
2. 计费改为**预付费套餐 + 卖家签名凭证 + 支付时拆分抽成**；计量只用于配额与展示，不再作为结算依据。
3. 新增 P1 详细文档：`docs/phase-1-requirements.md`、`docs/phase-1-technical-design.md`。

**v0.5（2026-10-30）**

1. **放弃 fork sing-box**：不维护、不修改其源码。App 直接下载**官方发布版本**，校验后启动客户端或服务端。
2. 版本管理对象从「我们的构建」改为「官方发行版 + 我们的签名清单」；计量改用官方 API。
3. Claurst 仍然内嵌在 App 中（git submodule，只使用不修改），此项不变。

**v0.4（2026-10-30）**：Claurst 改 submodule；内核确定进程隔离；新增版本管理；打洞降二期。

**v0.3（2026-10-30）**：取消中继；抽成可调；全球无 KYC 定位。

**v0.2（2026-10-30）**：收入改为供给侧抽成；AI 改为 BYOK；新增向导与本机自检。

**v0.1（2026-10-30）**：初稿。

---

## 1. 一句话定义

**Veyl 是一个以对话为操作界面的智能网络代理客户端：用户用自然语言就能建立 VPN 连接、在向导指导下开通并配置自己的云节点、在市场上买卖节点服务，并把自己的电脑变成可出租的出口节点；代理能力来自 App 自动下载并管理的官方 sing-box 运行时，上层由一个内嵌的 Claurst 驱动。**

客户端与工具层免费开源；平台不转发流量，收入来自节点服务交易的抽成（默认 30%，可调），通过区块链结算。

---

## 2. 我们对需求的理解

| # | 你的原始想法 | 我们的理解（工程语言） |
|---|---|---|
| 1 | 结合 AI + 区块链 + sing-box 做智能 VPN | 桌面客户端 + 控制面；代理能力来自**官方 sing-box 发行版**，由 App 管理版本 |
| 2 | 用户通过聊天建立 VPN 连接 | Agent 通过工具调用操作运行时，聊天是主入口 |
| 3 | 聊天即可开通云服务器并指导创建节点 | 用户自己网页注册付款；Agent 提供向导 + cloud-init + 校验 |
| 4 | 用户可在市场卖自己的服务配置 | 卖家上架，平台托管凭据、撮合、计量、结算，抽成 |
| 5 | 通过区块链收费 | 链上钱包 + 稳定币 + 托管合约；链下计量、批量结算 |
| 6 | 用户可把自家电脑作为出口节点 | v1 只支持公网 IPv4 / IPv6；打洞二期 |
| 7 | 收入 = 卖 DeepSeek API 差价 | **改为**：用户自带 Key、直连；我们只做注册与取 Key 引导 |
| 8 | 价值 = 把操作封装成 Agent 的 tool | 核心资产是**工具层**（Claurst `Tool` trait） |
| 9 | 大部分用户不会建云服务器 | 向导覆盖注册、绑卡、选型、粘脚本、开端口、取 IP、验证 |
| 10 | 不做中继 | 平台不在数据面；v1 不做兜底通道 |
| 11 | 区块链项目定位 | 全球、无 KYC、无内容审核 |
| 12 | **Claurst 用 submodule、不改代码** | 固定 commit，以 Rust crate 链接进 App（`claurst-core/api/query/tools`）；升级只改指针 |
| 13 | **App 管理 sing-box 版本、AI 升级** | 签名版本清单 + side-by-side 安装 + 健康检查 + 自动回滚 |
| 14 | **不管 sing-box 代码** | 不下发补丁、不维护 fork；只用官方发行版与其公开 API |

### 2.1 必须澄清的问题

1. **发行物来源**：直接从 GitHub Release 下载，还是全部镜像到我们的 CDN？建议镜像（可用性、速度、可追溯），但必须保留官方 URL 与源码地址。
2. **校验依据**：上游是否提供官方签名/校验和？无论有无，我们都在自己的签名清单里记录自算的 sha256。
3. **版本策略**：只跟随 stable，还是允许 beta 渠道？默认 stable。
4. **AI 升级权限**：补丁版本自动、大版本确认，还是全部确认？
5. **节点侧自更新**：云节点与住宅节点是否跟随同一清单？需要 canary。
6. **计量精度**：官方 V2Ray Stats API 的粒度是否满足结算（按用户、按秒/分钟）？
7. **抽成调整机制**：团队参数、治理投票还是合约升级？冷启动是否降档？
8. **应用分发渠道**：仅 GitHub Releases，还是也上应用商店？
9. **服务端是否开源**：客户端与工具层开源，服务端（市场索引/信令）未定。

---

## 3. 用户与场景

### 3.1 目标用户

| 角色 | 诉求 | 痛点 |
|---|---|---|
| 小白用户 | 连上就能用 | 不会开服务器、看不懂协议 |
| 普通用户 | 稳定上网、流媒体、跨境办公 | 选节点与排障门槛高 |
| 技术型用户 | 自己开节点、控成本 | 全流程手工 |
| 节点卖家 | 把节点变现 | 没有可信交易场所与收款手段 |
| 住宅节点提供者 | 用闲置带宽赚钱 | 不知道自己能不能做 |

### 3.2 核心场景

1. **S1 一句话连上**：「帮我连到日本节点」→ 选优 → 确认 → 连接。
2. **S2 向导建节点**：「开一台日本节点，预算 5 美元/月」→ 方案 → 引导网页注册付款 → 粘脚本 → 自动装好 → 自动导入。
3. **S3 排障**：「网很慢」→ 全套诊断 → 结论 + 一键修复。
4. **S4 买服务**：「找新加坡按流量计费的便宜节点」→ 检索比价 → 购买 → 接入。
5. **S5 卖服务**：上架节点，设价格限额，链上收款，平台抽成。
6. **S6 本机变节点**：「我这台电脑能当节点吗？」→ 检测公网可达性 → 可行则一键准备 → 上架。
7. **S7 配置 AI**：「怎么弄 DeepSeek 的 Key？」→ 引导注册、充值、创建、粘贴。
8. **S8 升级内核**：「内核有新版本吗？」→ 展示 changelog 与影响 → 确认 → 升级 → 健康检查，失败回滚。

---

## 4. 产品形态与边界

### 4.1 形态

- **桌面客户端**：左侧对话，右侧状态卡（连接、速率、节点地图、任务进度、向导步骤）。
- **菜单栏常驻**：快速切换、查看流量。
- **工具层**：应用内以 Claurst `Tool` trait 实现，供内置 Agent 直接调用；MCP 接口在 P2 提供给外部宿主（DSH / Claude Code）。
- **控制面服务端**：账号、市场索引、订单、计量聚合、节点注册、向导内容、版本清单。
- **不做中继服务**；v1 不做打洞信令。

### 4.2 明确不做（Non-goals）

- **不维护、不修改 sing-box 源码，不做 fork**。
- 不转发用户流量，不做中继、不做兜底通道。
- 不代用户注册云账号、不代付、不代实名。
- 不做实时链上计费。
- 不做匿名化承诺（但也**不收集身份**）。
- 不做 KYC、不做内容审核、不做地区限制。
- 不让模型直接执行任意 shell。
- 不转售、不代理 AI 额度。
- v1 不支持 CGNAT / 对称 NAT 的本机节点。

---

## 5. 功能需求

### 5.1 对话式 VPN 控制（P0）

**F-1.1 连接管理**
- 连接/断开/切换；按地区、延迟、协议、价格选优。
- 模式：`system-proxy`（mixed 入站 + 系统代理，无需提权，MVP 首选）；`tun`（二期）。
- 断线重连、开机自启、流量统计。
- **两层控制语义**：
  - `vpn.connect` / `vpn.disconnect` 是面向用户的语义操作（选节点、应用配置、设置系统代理）。
  - `runtime.start` / `runtime.stop` / `runtime.restart` 是面向进程的生命周期操作（只管理 sing-box 进程本身）。
  - `runtime.status` 提供进程状态、版本、uptime、健康检查、流量与连接数的快照；状态变化通过 Tauri event 推给前端。

**F-1.2 状态与诊断**
- 实时展示节点、上下行、累计流量、延迟、丢包、出口 IP/地区。
- 诊断：DNS / WebRTC / IPv6 泄漏、路由追踪、MTU、解锁、IP 纯净度。
- 输出「结论 + 建议」。

**F-1.3 自然语言交互**
- 解析意图 → 选工具 → 确认 → 执行 → 汇报。
- **确认门**：花钱、删节点、改系统代理、提权、上架、开共享、**升级内核**，必须弹确认卡。
- `vpn.connect` 在**会话内首次**需要确认，之后同一会话不再重复；新会话重置。
- 过程可见，失败可回滚。

**F-1.4 配置管理**
- 导入订阅、sing-box JSON、分享链接。
- 解析、去重、分组、测速、失效标记。
- 先校验再应用，热更新不断连。

### 5.2 向导式建节点（P0）

> 用户用自己的云账号、自己付款。我们不代注册、不代付、不碰卡号。

**F-2.1 方案规划**
- 用户给地区/预算/用途，Agent 给 2–3 个方案（厂商、套餐、月成本、网络质量）。
- 明确说明：注册、实名、绑卡、付款由用户完成。

**F-2.2 建节点剧本（Recipe）**

| 字段 | 说明 |
|---|---|
| 推荐区域/套餐 | 按预算与用途匹配 |
| 镜像 | Ubuntu 22.04/24.04 |
| 表单项说明 | 每一步填什么、在哪 |
| **cloud-init 脚本** | 粘到 User Data，开机自动装好并注册 |
| 防火墙 | 开放端口（443/TCP+UDP 等） |
| 验收信号 | 控制面收到注册 / SSH 可连 / 端口探活 |

**F-2.3 向导流程**

```
guide.start(provider, region, budget)
  → 生成剧本与 cloud-init（含一次性注册令牌）
  → 系统浏览器打开厂商创建页
  → 应用内分步卡片：注册 → 绑卡 → 选区域/配置/镜像
                     → 粘贴 User Data → 开端口 → 创建
  → 每步「我已完成」+ 自动校验
  → 机器开机后自动安装官方 sing-box 并注册
  → 控制面收到事件 → 生成订阅 → 自动导入 → 连接测试
```

**F-2.4 校验（按可用性降级）**

| 是否有 API Token | 校验方式 |
|---|---|
| 有 | 轮询厂商 API：实例存在、running、IP 已分配 |
| 无 | 检查控制面注册事件；或探测 `IP:22`；最后用户确认 |

- API Token 非必需：cloud-init + 注册事件已能闭环。
- 失败时读 cloud-init 日志，给出可执行原因。

**F-2.5 关键约束**
- 不代注册、不代实名、不代支付。
- 第三方登录只在系统浏览器。
- cloud-init 脚本可见、可审计、带签名（以 root 运行）。
- 一键销毁，二次确认。

**F-2.6 支持范围（v1）**
- 厂商：先接 Vultr，再扩 Hetzner、DigitalOcean、AWS Lightsail。
- 协议：`VLESS + Reality`、`Hysteria2`。
- 系统：Ubuntu 22.04/24.04。
- 服务端运行时：官方 sing-box，与客户端同版本清单。

### 5.3 节点市场（P1）

**F-3.1 商品模型**
Listing：区域、协议、带宽上限、卖家信誉、节点指纹、可达性类型、**套餐类型**（流量包 / 时长包）、额度、有效期、价格、币种。

- 凭据不公开，付款后由服务端解密下发。
- 卖家身份：钱包地址（无 KYC）。

**F-3.2 交易与抽成（预付费套餐）**
```
检索/比价 → 选择套餐 → 支付 → 平台与卖家按比例拆分
   → 签发访问凭证 → 用户连接 → 节点本地校验额度
```
- 平台抽成默认 30%，10%–30% 可调，**在支付时直接拆分**。
- P3 由中心化账本拆分；P4 由合约拆分。
- 未用完的额度归卖家所有，不退款（退款窗口除外）。

**F-3.3 计费：预付费套餐**
- 两种套餐：流量包（GB + 有效期）、时长包（天 + 有效期）。
- 买家一次支付获得 `Entitlement`（额度、到期时间、卖家签名凭证）。
- 节点离线校验凭证并扣减额度；额度耗尽或到期即限流。
- **计量只用于配额与展示，不用于结算**；V2Ray Stats API 不可靠时退化为时长包。
- 凭证由卖家密钥签名，公钥登记在节点注册表；平台不参与每次准入。
- 小额订单支付即拆分；大额订单可加 7 天托管与退款窗口。

**F-3.4 治理**
- 无人工内容审核；靠质押、信誉分、举报与客户端侧黑名单。
- 滥用由节点侧限速与熔断处理。
- 卖家协议与免责声明。

### 5.4 本机变节点（P1，v1 仅公网）

> **原则：平台不转发任何流量。机器必须自己能被人连上。**

**F-4.1 可达性分级**

| 模式 | 条件 | v1 |
|---|---|---|
| A. 公网 IPv4 | 独立公网 IP + 可端口映射（UPnP / NAT-PMP / 手动） | ✅ 支持 |
| B. 公网 IPv6 | 全局 IPv6，防火墙放行 | ✅ 支持 |
| C. NAT 打洞 | 双方交换候选地址并打孔 | ⏳ 二期 |
| D. 不可用 | CGNAT / 对称 NAT / 无公网 / 上行过低 | ❌ 明确拒绝 |

v1 的拒绝文案要具体：告诉用户缺的是公网 IPv4、IPv6 还是端口映射，并给出补法，**但不提供中继兜底**。

**F-4.2 可行性自检（`node.checkLocal`）**

| 类别 | 检查项 |
|---|---|
| 硬件 | CPU、内存、磁盘、当前负载、是否笔记本（休眠风险） |
| 网络 | 公网 IPv4、IPv6 全局地址、ASN/ISP、NAT 类型（STUN 双侧测试）、CGNAT 判定、UPnP/NAT-PMP、上行带宽 |
| 端口 | 尝试映射并做一次外部回连验证真实可达 |
| 环境 | Wi-Fi/有线、节能休眠、ISP 是否限制入站 |

输出：`{ canHost, mode: "public-ip"|"ipv6"|"unsupported", estimatedCapacityMbps, blockers[], warnings[] }`。

**F-4.3 一键准备（`node.prepareLocal`）**
- 下载并校验官方 sing-box（与客户端同一套版本管理）。
- 生成密钥与用户凭据、注册、领取 nodeId。
- 绑定公网地址/端口，配置防火墙（能自动则自动，否则给指引）。
- 生成服务端配置（VLESS/Hysteria2 入站 + V2Ray Stats API）。
- 注册为后台服务，配置开机自启、防休眠、健康检查、自动恢复。
- 完成后可直接上架。

**F-4.4 知情与风控**
- 明确告知：出口 IP 会关联到用户真实网络；需自行评估 ISP 条款与当地法律。
- 默认关闭，显式开启 + 风险确认。
- 平台侧：信誉分、配额上限、异常流量熔断。

**F-4.5 二期：打洞**
- 信令只交换候选地址与时序，不转发数据。
- UDP 优先；失败即「不支持」，不降级到中继。
- 上线前需真机统计成功率。

### 5.5 AI 接入（P0，BYOK）

**F-5.1 自带 Key**
- 用户用自己的 **DeepSeek API Key**，客户端直连（或用户指定的 OpenAI 兼容端点）。
- 我们不转发、不存储、不计费、不抽成。

**F-5.2 获取 Key 的引导（`deepseek.setupKey`）**
```
打开 https://platform.deepseek.com/（系统浏览器）
 → 注册 → 充值 → API Keys → 创建 → 复制 → 粘贴到客户端
 → 存系统钥匙串 → 发最小请求验证
```
- 链接与步骤做成可配置内容包。
- 也支持 OpenRouter、硅基流动等 OpenAI 兼容服务商。

**F-5.3 降级**
- 无 Key / 失效 / 余额不足：降级为「无 AI 模式」，VPN 功能仍可用。

### 5.6 sing-box 运行时管理（P0）

**F-6.1 发行版来源**
- 来自 sing-box 官方 GitHub Release（darwin / windows / linux，arm64 / x86_64）。
- 建议镜像到我们的 CDN，但清单必须保留官方 URL、上游版本、许可证与源码地址。
- **我们不构建、不修改、不打补丁**。

**F-6.2 版本清单**
- 控制面发布签名清单，字段：`upstreamVersion`、`platform`、`arch`、`artifactUrl`、`sha256`（我们自算）、`size`、`minAppVersion`、`configSchema`、`channel`、`sourceUrl`、`license`、`changelog`。
- 只接受签名清单，不接受任意 URL 或未签名的二进制。
- 建议同时在本地缓存最近一次成功校验的清单，离线可用。

**F-6.3 安装与切换**
- 每个版本独立目录，side-by-side；本地保留最近 2 个可用版本。
- 安装流程：验签清单 → 下载 → 校验 sha256/size → 安全解压 → `sing-box version` → `sing-box check -c` 试运行 → 标记可用。
- 激活：停旧进程 → 原子写 active 指针 → 启新进程 → 健康检查 → 成功；失败自动回滚。

**F-6.4 运行时控制**
- 启动：`sing-box run -c <config>`。
- 控制：Clash API 监听 `127.0.0.1:<随机端口>`，`secret` 随机生成，只绑回环。
- 用途：配置热更新、流量统计、连接列表、节点延迟测试。

**F-6.5 配置兼容**
- 我们的配置模型带 `schemaVersion`，保存在**旁路元数据文件**，不写进 sing-box 配置（避免未知字段报错）。
- 维护「配置 schema ↔ sing-box 版本区间」矩阵。
- 升级前用目标版本执行 `sing-box check`；不通过则阻止并说明原因。

**F-6.6 AI 升级（`core.*` 工具）**
- `core.checkUpdate`、`core.listVersions`、`core.status`、`core.upgrade`、`core.rollback`。
- 升级前展示 changelog、配置影响、风险，用户确认后执行；失败自动回滚并汇报。
- 默认策略：补丁版本可自动，次版本/大版本必须确认。

**F-6.7 节点侧版本**
- 云节点与住宅节点使用同一份签名清单。
- 先 canary 到少量节点，观察 24 小时再全量；自更新失败自动回退。

### 5.7 工具层（P0，核心资产）

| 工具 | 作用 | 风险 |
|---|---|---|
| `vpn.status` | 节点/速率/延迟/出口 IP | 只读 |
| `vpn.connect` / `vpn.disconnect` | 连接/断开 | 低 |
| `profile.import` / `profile.list` / `profile.test` | 配置管理 | 低 |
| `profile.delete` | 删除本地配置（幂等） | 中 |
| `guide.start` / `guide.openConsole` / `guide.verify` | 建节点向导 | 低 |
| `node.plan` | 云端节点方案 | 只读 |
| `node.registerExternal` | 登记已创建的机器 | 中 |
| `node.destroy` | 销毁节点 | **高** |
| `node.checkLocal` | 本机公网可达性自检 | 只读 |
| `node.prepareLocal` | 一键成为节点 | **中高** |
| `node.localStatus` / `node.localStop` | 本机节点管理 | 低 |
| `core.checkUpdate` / `core.listVersions` / `core.status` | 版本查询 | 只读 |
| `core.upgrade` / `core.rollback` | 升级/回滚运行时 | **高** |
| `runtime.status` | 进程状态、版本、uptime、健康、流量、连接数、最近错误 | 只读 |
| `runtime.start` / `runtime.stop` / `runtime.restart` | 启动 / 停止 / 重启 sing-box | 中 |
| `runtime.reload` | 热更新配置 | 低 |
| `runtime.logs` | 脱敏后的最近日志 | 只读 |
| `diag.run` | 网络诊断 | 低 |
| `market.search` / `market.publish` / `market.purchase` | 市场 | 购买为**高** |
| `wallet.balance` | 余额与账单 | 只读 |
| `deepseek.setupKey` | 引导配置 Key | 低 |

**设计原则**
- 应用内用 Claurst `Tool` trait；MCP 在 P2 对 DSH / Claude Code 等外部宿主开放。
- 结构化返回：`{ ok, data, summary, next_actions }`。
- 长任务返回 `jobId`，事件流推进度，可取消。
- 不可信输入隔离：商品描述、节点 banner、网页内容、changelog 都当数据。
- 不暴露任意 shell。
- 幂等与回滚。

---

## 6. 系统架构

### 6.1 三个平面（v1）

```
┌──────────────────── 控制面（我们的服务器） ────────────────────┐
│ 账号/钱包 │ 市场索引 │ 订单托管 │ 计量聚合 │ 节点注册 │ 向导内容 │
│                sing-box 版本清单（签名）                        │
│                    （Postgres + Redis）                          │
└──────────────┬──────────────────────────────────────────────────┘
               │ HTTPS / WebSocket（只传元数据）
┌──────────────▼──────────────────────────────┐
│              客户端（桌面）                   │
│  Tauri UI (TS)                               │
│  Agent：Claurst crates（进程内，submodule）   │
│  工具层（Claurst Tool trait）                 │
│  Runtime Manager（版本/健康/回滚，Rust）       │
│  sing-box（官方发行版，独立进程）              │
│  系统代理 / TUN（二期）                        │
└──────────────┬──────────────────────────────┘
               │ 数据面：直连（平台不在路径上）
               ▼
        ┌──────────────────┐
        │ 节点（云 / 住宅）  │
        │  官方 sing-box     │
        └──────────────────┘
```

**原则：平台既不在数据面，也不代管用户流量。**

### 6.2 客户端

| 模块 | 职责 | 语言 |
|---|---|---|
| UI Shell | 对话、状态卡、确认卡、向导卡片、设置、托盘 | TypeScript |
| Tauri Core | 窗口、IPC、自动更新、钥匙串、系统代理 | Rust |
| Runtime Manager | 版本清单校验、安装/切换/回滚、健康检查、看门狗 | Rust |
| `sing-box` | 官方运行时，独立进程，Clash API 控制 | Go（官方构建） |
| Agent | Claurst crates（`core` / `api` / `query` / `tools`），进程内 | Rust |
| 工具层 | 实现 Claurst `Tool` trait；MCP 接口在 P2 提供给外部宿主 | Rust |
| Local Store | 配置、会话、计量队列、版本记录（SQLite） | — |

**进程边界**：UI（Tauri）↔ Rust Host（Agent、工具、Runtime Manager）↔ `sing-box`（独立进程）。Agent 在进程内运行，但 `run_query_loop` 放在独立 tokio task 并用 `catch_unwind` 隔离；sing-box 崩溃由 Runtime Manager 重启，不影响 UI。

### 6.3 服务端

- TypeScript（Hono/Fastify）+ Drizzle + Postgres + Redis。
- 职责：认证、市场索引、订单托管、计量聚合、节点注册、向导内容、**版本清单**。
- 不存流量日志；只存计费与订单元数据。
- 不含 LLM 网关（BYOK 直连）。
- v1 不含打洞信令（二期）。

### 6.4 链上

| 组件 | 说明 |
|---|---|
| 链 | EVM L2（Base 或 Arbitrum）+ USDC |
| 身份 | 智能账户 + Passkey；SIWE |
| 合约 | `MarketEscrow`、`NodeRegistry`（质押）、`Settlement`、`Treasury` |
| 结算 | 会话计量 → 双方签名回执 → 链下聚合 → 批量上链 |
| 不上链 | 流量目的地址、用户身份、会话内容 |
| 抽成 | 结算合约内按参数扣除（默认 30%，可调） |

**分阶段**：M4 先中心化账本，M5 再上链。

---

## 7. 技术选型

### 7.1 Agent 底座：Claurst 以 submodule + crate 链接

- `src-tauri/claurst` 固定 commit，不修改源码。
- 直接依赖 `claurst-core` / `claurst-api` / `claurst-query` / `claurst-tools`，在 `AivpnSession` 中调用 `run_query_loop`。
- 工具实现 `Tool` trait，权限交给 Claurst 的 `PermissionManager`。
- 事件经 Tauri event 推给前端（参考 TweetPilot 的 `claurst_session.rs`）。
- 升级只改 submodule 指针 + 回归测试；能力不足优先向上游提 PR。
- 许可证 GPL-3.0；作为链接库使用，客户端整体按 GPL 处理。

**DSH 作为第二宿主**：MIT，插件化，可作为另一个入口接入同一套工具，不进入主链路。

**不选 Claude Code**：闭源、不可 fork、与 BYOK 无协同。

### 7.2 桌面端

**Tauri v2 + Rust 核心 + TS UI**。关键是提权边界：TUN 与系统代理放 Rust 侧更安全。MVP 用系统代理，无需 root。

### 7.3 代理运行时：官方 sing-box

**结论：不自建 fork，不修改代码。** App 选择、下载、校验、安装、启动官方发行版；客户端与服务端共用同一个二进制，只是配置不同。

**为什么可行**

| 需求 | 官方能力 |
|---|---|
| 运行时控制 | `experimental.clash_api`：配置热更新、流量、连接、延迟测试 |
| 按用户计量 | `experimental.v2ray_api`：按用户统计上下行 |
| 客户端/服务端 | 同一二进制，配置决定角色 |
| 多平台 | darwin/windows/linux，arm64/x86_64 均有官方构建 |
| 配置校验 | `sing-box check -c` |

**我们负责**

- 版本清单与镜像（自算 sha256，签名）
- 下载、安装、切换、回滚
- 配置生成与兼容性校验
- 进程托管、健康检查、崩溃恢复

**我们放弃**

- 无法在内核内嵌自定义计数器 → 计量改为 API 采样（±1 分钟）
- 无法修改默认值/品牌 → 通过配置模板控制
- 无法新增自定义 RPC → 只用官方 API

**进程隔离（方案 A）已确定**

| 方案 | 结论 |
|---|---|
| **A. 独立进程 + 本地控制 API** | ✅ 采用：崩溃隔离、可热切换版本、可回滚 |
| B. 进程内链接 | ❌ 不采用：官方是独立程序，且崩溃会带走 App |

**控制方式**

- 启动：`sing-box run -c <config>`
- 校验：`sing-box check -c <config>`
- 版本：`sing-box version`
- 运行时：Clash API 绑定 `127.0.0.1:<随机端口>` + 随机 `secret`（仅回环）
- 计量：节点侧开 `v2ray_api`，按用户采样

**注意**：Clash API 官方文档只描述 TCP 监听地址，不支持 Unix socket；因此控制通道用回环 TCP + Bearer secret，端口随机、仅本机可达。

**维护成本**：我们不再跟进上游代码，但要跟进**版本兼容矩阵**与安全公告；上游出现安全版本时，快速发布新的清单条目即可。

### 7.4 其他

| 领域 | 选择 | 理由 |
|---|---|---|
| 代理运行时 | 官方 sing-box | 不维护代码、协议全、API 完善 |
| 版本分发 | 签名清单 + CDN 镜像 | 可回滚、可 canary |
| 工具协议 | Claurst `Tool` trait（应用内）/ MCP（P2 外部宿主） | 少一层序列化，权限模型原生对齐 |
| 服务端 | TypeScript + Hono + Postgres | 与前端同语言 |
| 链 | Base + USDC + Foundry + viem | 低费率 |
| 钱包 | 智能账户 + Passkey | 降低门槛 |
| 打洞 | libp2p DCUtR 或自研 | 二期 |

### 7.5 许可证义务

1. **sing-box：GPLv3 + 附加条款**
   - 我们分发的是**未修改的官方二进制**，通常属于聚合作品，不触发衍生作品义务。
   - 仍需随分发附带 GPLv3 许可证文本与源码获取地址。
   - 不得使用其名称或暗示官方关联；产品命名为 Veyl，文案只做事实性说明「使用 sing-box」。
2. **Claurst：GPL-3.0** —— crate 链接与分发同样需提供源码；客户端整体按 GPL 处理。
3. **DSH：MIT** —— 与 GPL 兼容。
4. **服务端**不受 GPL 传染（非分发）。

> 这一版比 fork 方案在许可证上简单得多：没有衍生作品，没有源码修改义务，只需附带许可证与源码地址。

---

## 8. 数据模型（草案）

```
User(id, wallet_addr, created_at)
Device(id, user_id, pubkey, platform, last_seen)
Profile(id, user_id, kind, encrypted_config, config_schema, health, tags)
Node(id, owner_id, kind[cloud|residential], provider, region, ip, ipv6,
     protocol, status, reachability[public-ip|ipv6], pubkey,
     capacity_mbps, created_at)
NodeCheck(id, device_id, report_json, can_host, mode, created_at)
ProvisionGuide(id, user_id, provider, recipe_version, current_step, state)
Listing(id, seller_id, node_id, region, protocol, reachability,
        package_type[data|time], quota, duration_days, price, currency, status)
Order(id, listing_id, buyer_id, amount, payment_method[fiat|chain],
      payment_state, created_at)
Entitlement(id, order_id, buyer_id, listing_id, quota_total, quota_used,
            expires_at, voucher_json, seller_sig, status)
UsageSample(id, entitlement_id, up_bytes, down_bytes, sampled_at)
LedgerEntry(id, party_id, kind[Sale|Commission|Payout|Refund], amount,
            currency, ref_order_id, created_at)
Wallet(id, user_id, chain, address, balance_cached)
RuntimeRelease(id, upstream_version, platform, arch, artifact_url,
               sha256, size, source_url, license, config_schema,
               min_app_version, channel, changelog, published_at)
RuntimeInstall(id, device_id, runtime_release_id, state[active|standby|failed], installed_at)
ToolCallAudit(id, session_id, tool, args_digest, approved_by, result, ts)
```

- `Profile.encrypted_config` 加密存储，密钥由设备公钥加密。
- `Entitlement.voucher_json` 是卖家签名的访问凭证，节点可离线校验。
- `UsageSample` 只服务配额与展示，不参与结算。
- `LedgerEntry` 在 P3 是中心化账本，P4 对应链上事件。
- `Node.pubkey` 用于校验卖家签发的凭证。
- `RuntimeRelease` 保存官方来源与许可证，便于审计。

---

## 9. 商业模式与单位经济

### 9.1 收入结构

| 来源 | 形式 |
|---|---|
| **节点套餐销售抽成** | 套餐价格 × 费率（默认 30%，区间 10%–30%），支付时拆分 |
| 官方种子节点 | 冷启动期自营 |
| AI | 无（BYOK） |
| 客户端 | 免费开源 |

计费单位是**套餐**，不是流量：买家一次付款买一个额度包，平台在付款时拿走抽成，卖家拿到余额。没有持续结算，也没有按字节的账单。

### 9.2 抽成测算（假设值）

| 活跃节点 | 单节点月收入 | 月 GMV | 平台月收入（20%） | 平台月收入（30%） |
|---|---|---|---|---|
| 100 | $15 | $1,500 | $300 | $450 |
| 1,000 | $15 | $15,000 | $3,000 | $4,500 |
| 5,000 | $20 | $100,000 | $20,000 | $30,000 |
| 10,000 | $25 | $250,000 | $50,000 | $75,000 |

供给驱动。无中继意味着没有带宽 COGS，抽成几乎全是毛利；收入取决于上架节点数与单节点产出。

v1 只支持公网节点，供给池较小，冷启动更需要官方种子节点。

### 9.3 成本结构

| 成本 | 说明 |
|---|---|
| API 与版本分发 | 极小（CDN 流量为主） |
| RPC / 索引 | 链上读取与事件索引 |
| 链上 gas | 批量结算摊薄 |
| 审计 | 合约审计 |
| 研发 | Rust + TS（不再需要 Go 维护） |
| 客服/仲裁 | 社区化 |

**相比 fork 方案省掉的部分**：Go 内核维护、上游 rebase、安全补丁回填。

### 9.4 抽成机制

- 默认 30%，10%–30% 可调。
- 在**套餐支付时**拆分：P3 走中心化账本，P4 走合约的 `transfer`。
- 未消费额度归卖家，平台抽成不受影响。
- 建议冷启动 10%–15%，供给充足后回到 30%。
- 脱媒风险：30% 高于行业常见水平；靠凭据托管、信誉、仲裁、客户端闭环缓解。
- 退款：小额设 24 小时窗口；大额走 7 天托管。

---

## 10. 安全威胁模型

| 威胁 | 场景 | 缓解 |
|---|---|---|
| 提示注入 | 商品描述/节点 banner/changelog 藏指令 | 不可信内容隔离；高权限工具人工确认 |
| 恶意节点 | 记录用户访问目标 | 协议层加密；信誉；可选多跳 |
| 恶意客户端 | 伪造用量 | 节点侧强制配额；双方签名回执 |
| 模型越权 | 执行任意 shell | 沙箱；关闭无关工具；最小权限 |
| **发行物供应链** | 官方包或镜像被替换 | 我们的签名清单 + 自算 sha256 + 只信任 CDN |
| **恶意/降级版本** | 引导安装旧版漏洞运行时 | 签名 + 渠道策略 + 降级需确认 |
| **升级中断** | 升级后配置不兼容导致断网 | `sing-box check` + 健康检查 + 自动回滚 |
| **Claurst 供应链** | submodule 被篡改 | 固定 commit + 校验 + 依赖审计 |
| 凭据泄露 | 云 Token、节点私钥、DeepSeek Key | 系统钥匙串；日志脱敏 |
| 提权漏洞 | TUN helper 被利用 | 最小权限、独立签名、审计 |
| 向导误导 | cloud-init 粘错或令牌泄露 | 一次性令牌、脚本签名、可撤销 |
| 本机节点滥用 | 出口 IP 被用于攻击 | 默认关闭、配额、熔断、卖家协议 |

### 10.1 隐私原则

1. 控制面不记录访问目标、DNS 查询、流量内容。
2. 只保留计费元数据，默认 90 天。
3. AI 对话不经过我们（BYOK 直连）。
4. 数据面不经过我们（无中继）。
5. 诊断在本机完成，只上传聚合健康度。
6. 无 KYC、无实名；钱包地址即身份。

---

## 11. 合规与责任边界

> 本节记录产品定位与残余风险，不构成法律意见。

### 11.1 定位

- 开源协议 + 链上结算：核心团队开发客户端与协议，不运营节点、不转发流量、不托管内容。
- 全球、无 KYC、无内容审核、无地区限制。
- 抽成通过智能合约结算，不处理法币。

### 11.2 这一版降低了什么

| 风险 | 变化 |
|---|---|
| 数据面责任 | 平台不在数据路径上 |
| 带宽成本 | 归零 |
| 内容审核压力 | 无托管内容 |
| KYC/AML | 不接触法币与用户身份 |
| GPL 合规 | 只分发未修改的官方二进制，无衍生作品义务 |

### 11.3 残余风险（去中心化不等于免责）

| 风险 | 说明 | 建议 |
|---|---|---|
| 开发者责任 | 多地判例显示开源作者可能因「实质性帮助」被追责 | 就核心成员所在地做法律咨询；README 与 UI 明确免责 |
| 应用分发 | GitHub、商店、域名注册商可能因投诉下架 | 多分发渠道与镜像；自建更新通道 |
| 链上资金 | Treasury 涉及税务、AML、制裁筛查 | 明确 Treasury 归属；必要时地址筛查 |
| 市场商品 | 可能被用于违法用途 | 公开治理规则与响应流程 |
| 许可证 | 分发官方二进制需附 GPLv3 文本与源码地址 | 打包时自动附带 |
| 节点滥用 | 住宅节点 IP 关联真实网络 | 默认关闭、知情同意、配额与熔断 |

**结论**：无中继 + 无 KYC + 链上结算 + 不分发修改版，把平台直接风险降到较低水平；但不能消除核心团队与 Treasury 的责任。上线前至少就「实体注册地、Treasury 归属、分发渠道」做一次法律咨询。

### 11.4 命名决策与已知风险

> **这一节记录的是已知风险下的主动选择，不是疏忽。** 后来者若要改名，先读完这里再决定。

**产品名：Veyl**（2026-11-02 由用户拍板，替代原代号 AIVPN）。

**已知商标冲突**（2026-11-02 初步筛查，非法律意见）：

| 冲突方 | 类别 / 状态 | 说明 |
|---|---|---|
| **Veil VPN – Private Net**（App Store id6788418705） | VPN 应用，在售 | 与本产品同品类、同读音，只差一个字母；风险最高 |
| **Veil – Secure VPN Proxy**（Chrome 扩展） | VPN 代理，在售 | 同上 |
| **VEIL**（WIPO 国际注册 #1940347 / 加拿大 #2453903） | 第 9 类 + 第 42 类，2026-02-03 申请中 | 覆盖隐私计算与安全 SaaS |
| **威厉 VEYLIM**（国内，第 9 类） | 已注册（2019 申请） | 同类目近似，可能被审查员引证 |

USPTO 上「VEIL」在第 9 类曾有两个注册，均已失效（1995 年注册的 #1920777 于 2006 年撤销，另一个 2011 年放弃）。中国商标网第 9/42 类未查到「Veyl」；存在「VEYL 流风谷」在第 33/35/43 类。

**已知域名状况**（RDAP 权威库查询）：

| 域名 | 状态 |
|---|---|
| `veyl.com` | 已被 Veyl Ventures（纽约品牌公司）实际使用，不会出售 |
| `veyl.io` | 已注册，处于 `client hold`（注册商侧暂停） |
| `veyl.net` / `veyl.xyz` / `veyl.app` / `veyl.dev` / `veyl.network` | 均已注册 |

**结论：不依赖自定义域名。** 宣传页用 GitHub Pages（`https://aiwithblockchain.github.io/veyl/`），下载用 GitHub Releases。项目不持有 `veyl.com`，因此 bundle identifier 定为 `io.github.aiwithblockchain.veyl` 这类反向域名形式，而不是 `com.veyl.*`。

**风险缓解**：

1. **发布前做一次正式商标检索**（预算 $50–100，Trademarkia / TMengine / 代理律师），把上面这份初步筛查升级成可用作决策的依据。
2. **在公开发布前保留一次改名窗口**。当前无真实用户、无已发布版本，改名的成本只有代码与文档；一旦有了用户与安装包，改名就要处理数据迁移和签名重做。

对外文案避免与 "Veil" 混淆的表述（例如不要写 "Veil VPN" 或 "Veil"），并在 README 与站点上明确这是独立项目。

**已复核的技术命名事实**（2026-11-02）：

- `github.com/veyl` 被用户 Vadim 占用（GitHub 用户与组织共用命名空间），组织下不可用；项目使用 `aiwithblockchain/veyl`。
- npm `veyl` 与 crates.io `veyl` 均未被占用。

---

## 12. 开发计划（四阶段 + 收尾）

每个阶段结束时都必须是一个**可用的产品**，而不是半成品。

| 阶段 | 周期 | 目标 | 交付 |
|---|---|---|---|
| **P1 能用** | 5–6 周 | 聊天就能连上我们提供的免费节点 | 对话框、AI、下载 sing-box、生成客户端配置、节点目录服务、系统代理 |
| **P2 可测** | 4–5 周 | 看得到用量，并能把自己有公网 IP 的机器变成节点 | 流量统计、本机自检与一键准备、服务端部署 |
| **P3 可卖** | 5–6 周 | 传统支付闭环，市场能买卖 | 账号、套餐、法币支付、订单、退款、卖家提现 |
| **P4 去中心化** | 6–8 周 | 链上支付 + 打洞 + 非公网节点 | 钱包、USDC、合约拆分、签名凭证、信令与打洞 |
| **P5 收尾** | 1–2 周 | Windows 签名与分发 | 证书、签名流水线、MSI 产物、发布验证 |

### P1 能用

详细文档：`docs/phase-1-requirements.md`、`docs/phase-1-technical-design.md`。

- 桌面壳：Tauri + TS 对话框，流式输出、工具调用卡片、审批卡。
- AI：BYOK 接入 DeepSeek，通过 Claurst `Tool` 驱动。
- 运行时：下载并校验官方 sing-box，生成客户端配置，启停与状态查询。
- 节点目录服务：服务端提供可用节点列表（官方种子节点）。
- 系统代理：一键设置/恢复（macOS、Windows）。
- 验收：新用户装好应用、填 Key、说一句「连到日本」，能连上并打开网页。

### P2 可测

- 流量统计：实时速率、会话累计、按配置的历史曲线。
- 本机节点：`node.checkLocal`（公网 IPv4/IPv6 判定）、`node.prepareLocal`、服务端配置生成、注册到目录。
- 自建节点只供本人使用，暂不上市场。
- 验收：10 台公网机器稳定运行 7 天；用户能看到自己的用量。

### P3 可卖

- 账号与订单；预付费套餐（流量包 / 时长包）。
- 法币支付（第三方支付通道），**支付时拆分抽成**。
- 市场上架、检索、购买、退款窗口、卖家提现。
- 凭证签发与节点离线校验。
- macOS 公证在对外发布前完成；**Windows 代码签名与分发是最终收尾任务（P5）**，不阻塞 P3。
- 验收：20 笔真实交易，账目可对账，退款可执行。

### P4 去中心化

- 钱包登录（智能账户 + Passkey）、USDC 支付、托管与拆分合约。
- 签名凭证与链上节点注册表。
- 打洞：信令服务 + UDP 打洞，支持非公网 IP 成为节点。
- 验收：链上套餐销售跑通；打洞成功率达标后开放非公网节点。

### P5 收尾：Windows 签名与分发

- 证书路线：优先 Azure Trusted Signing；资格不满足则 OV + 云 HSM；若满足条件可先试 SignPath Foundation。
- 签名顺序：签 `veyl.exe` → 打包 MSI → 签 MSI → `signtool verify /pa /v`。
- 只有签名产物对外公开发布；未签名包仅用于内测。
- 验收：干净 Windows 10/11 安装时显示发布者名称；签名验证通过；SmartScreen 提示显著减少。

### 阶段依赖

```
P1 ──► P2 ──► P3 ──► P4 ──► P5
 │      │      │      │      └─ Windows 签名与分发（收尾）
 │      │      │      └─ 依赖 P3 的订单与凭证模型
 │      │      └─ 依赖 P2 的节点与用量数据
 │      └─ 依赖 P1 的运行时与工具层
 └─ 不依赖支付，先验证核心体验
```

**P1 是最重要的验证点**：如果「聊天开 VPN」这件事用户不买账，后面的市场与链上都没有意义。

---

## 13. 开放问题

1. 发行物：直连 GitHub 还是全量镜像？镜像的合规与成本。
2. 上游是否提供官方签名/校验和？没有的话我们自算 sha256 是否足够。
3. 版本渠道：只 stable，还是开放 beta？
4. AI 升级默认权限：补丁自动、大版本确认，还是全部确认？
5. 节点侧自更新的 canary 与回滚策略。
6. 计量精度：只用于配额与展示；若 V2Ray Stats API 不可靠，是否默认用时长包？
7. 抽成调整机制与冷启动降档。
8. 应用分发渠道与服务端开源范围。
9. P1 的免费种子节点开放到什么规模？如何防止被白嫖与滥用？

---

## 14. 术语

| 术语 | 含义 |
|---|---|
| sing-box | 通用代理平台，本项目的运行时，使用官方发行版 |
| Clash API | sing-box 的 `experimental.clash_api`，用于配置热更新与流量查询 |
| V2Ray Stats API | sing-box 的 `experimental.v2ray_api`，按用户统计流量 |
| Runtime Manager | 客户端内负责下载、校验、安装、切换、回滚运行时的模块 |
| submodule | git 子模块，用固定 commit 引入外部仓库且不修改 |
| cloud-init / User Data | 云主机首启自动执行的脚本 |
| CGNAT | 运营商级 NAT，用户无独立公网 IPv4 |
| 打洞 | 双方交换地址并同时发包，在 NAT 上开孔直连（二期） |
| MCP | Model Context Protocol |
| Claurst | Rust 编写的开源多模型编码 Agent，GPL-3.0 |
| DSH | DeepSeek Harness，MIT |
| BYOK | Bring Your Own Key |
| 脱媒 | 买卖双方绕开平台私下交易 |

---

## 附录 A：参考资料

- sing-box 仓库与许可证：<https://github.com/SagerNet/sing-box>
- sing-box Clash API 文档：<https://sing-box.sagernet.org/configuration/experimental/clash-api/>
- Claurst 仓库：<https://github.com/Kuberwastaken/claurst>
- DeepSeek Harness：<https://www.deepseek.com/en/harness/>
- DeepSeek 开放平台：<https://platform.deepseek.com/>
- MCP 规范：<https://modelcontextprotocol.io>

## 附录 B：下一步

1. 评审第 2.1 节与第 13 节。
2. 编写 `docs/architecture.md`（已按本版更新）。
3. 编写 `docs/tools-spec.md`（工具的入参/出参/错误码/权限）。
4. 按 `docs/phase-1-requirements.md` 与 `docs/phase-1-technical-design.md` 启动 P1。
5. 设计签名版本清单与发布流水线（镜像、校验、canary、回滚）。
