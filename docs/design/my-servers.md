# 我的服务器：用云服务器一键买机、装好、当节点用

> 日期：2026-11-13（§19 增补于 2026-11-14）
> 状态：目标设计，可进入实现；**M1 建机闭环的落地设计见 §19**；真实支付与退款留到 M2（§14.2）
> 范围：`docs/` 设计稿；不含实现代码
> 前置阅读：`simplified-config-create.md` §6.3 / §6.4 / §21、`provider-integration.md`、`contracts/commands.md`、`contracts/events.md`、`contracts/tools.md`、`data-model.md`
> 依据：产品 2026-11-13 拍板（入口、代付转售、假支付先行、31 个可用地区单套餐、开源无后端约束）
> 事实边界：供应商已从 Vultr 换成 **DigitalOcean**（Vultr 的 API 网关拒绝 Cloudflare Worker 出口，实测 403；DO 从 Worker 调用返回 401 JSON，网络可达）。DO 的建机 / 目录 / 镜像 / 销毁 / 防火墙接口与可达性已于 2026-11-14 核实（§13），**可以直接落实现**；仍需 token 后核实的项单列在 §13 表后，不要凭印象写实现。

---

## 0. 一句话定位与非目标

**一句话：用户在第 2 问选「其它节点」后，进入「我的服务器」，点一下（本期为假支付），Veyl 用 DigitalOcean 建一台机器并把 sing-box 服务端装好，几分钟后这台机器就是一个可直接建配置的节点。**

非目标（明确不做）：

| 不做 | 原因 |
|---|---|
| **真实支付、对账、回调验签** | 本期只做假收银台 + 假支付实现，目的是先跑通「下单 → 建机 → 装机 → 可用 → 建配置连上」全链路；真实渠道后期补（§3.1） |
| **计费循环 / 退款 / 欠费处置的实现** | 假支付没有真实扣款；规则只写文档，真实支付上线前必须补（§5.4、§8） |
| **实例配额** | 一人多台不限制；只保留创建频率的滥用防护，且不叫配额（§5.3、§8.2） |
| 通用云主机控制台（开机 / 关机 / 改配置 / 看监控 / **登录终端**） | 用户要的是节点，不是服务器；Veyl 不提供任何登录通道（§17），也不展示服务器凭据 |
| 多家云（AWS / 阿里云 / Hetzner / DigitalOcean） | 每家 API、计费、镜像、合规都不同；首期只把一条路走通 |
| 转租 / 把实例再卖给别人 | 计费、合规与滥用责任都会失控；实例只属于下单账户 |
| 用户自带云厂商 Key（BYOK） | 一律用我们的账号；BYOK 不做，已从待决项移除 |
| 通用机场市场 / 供应商广场 | 本期用「我的服务器」**替换**静态占位页，不再展示示例机场（§11 文档影响） |
| 节点转售 / 共享 / 市场 / 分成 | M1/M2 都不做：买到的节点只给自己用。转售边界与留口见 §16 |
| 节点协议选择器 | 首期固定 Shadowsocks AEAD；协议差异对用户没有价值 |

---

## 1. 与现有设计的关系

| 现有内容 | 本期处理 |
|---|---|
| `simplified-config-create.md` §6.3 供应商广场（静态占位） | **替换**为「我的服务器」页面；卡片仍叫 `其它节点`，页面名改为“我的服务器”。**既有的粘贴 / 订阅 / 手填能力保留**，入口收进同页（§7.1.1） |
| 同文件 §6.4 返回契约 `VendorPageResult` | **沿用形状、改来源**：仍返回 `{ kind: "nodes", nodeIds }` 或 `{ kind: "cancelled" }`，只是节点来自云服务器实例 |
| 同文件 §21「下一阶段」6 项 | 本文逐项覆盖：列表与来源（§3）、选择 / 购买（§5、§7）、拿回节点（§6.5）、接 `config_create(groupId)`（§7.6）与远端组（`remote-groups.md`）、空态与失败（§7.5）、验收（§12） |
| `provider-integration.md` 的结论「自建节点可直接产出 sing-box 配置，无转换损失」 | **显式利用**：安装脚本直接写 sing-box JSON，节点凭据按现有 `nodes` 表落库，不走任何订阅格式转换 |
| 现有 `node_import_*` / `node_create` / `config_create` | 节点写入节点池并加入组；配置按远端组模型绑定 `groupId`（`remote-groups.md`），本设计不新增字段 |

---

## 2. 三层架构与信任边界

```
┌──────────────────────────────┐        HTTPS（TLS 1.2+，Bearer）
│ 客户端（开源，本地）          │  ───────────────────────────────┐
│ Tauri / React                │                                  │
│  - 本地 SQLite / secrets.enc │  ◀── 订单状态 / 节点凭据 ────────┤
│  - 不持有任何云 API Key       │                                  │
└──────────────────────────────┘                                  ▼
                                              ┌──────────────────────────────┐
                                              │ Veyl 控制面（Cloudflare 私有后端）│
                                              │ Workers / D1 / Workflows / DO     │
                                              │ - 账户 / 订单 / 计费           │
                                              │ - DigitalOcean API Key（KMS）  │
                                              │ - 编排：建机 → 装机 → 回填     │
                                              │ - 支付（假实现） / 记账占位     │
                                              └───────────┬──────────────────┘
                                                          │ DigitalOcean API（Bearer）
                                                          ▼
                                              ┌──────────────────────────────┐
                                              │ DigitalOcean（我们的主账号）   │
                                              │ 每台 Droplet 打 tag 归属用户   │
                                              └──────────────────────────────┘

支付（M1 假实现；M2 接真实渠道）──▶ 控制面
```

### 2.1 信任边界

| 边界 | 谁能看到什么 | 约束 |
|---|---|---|
| 客户端 ↔ 控制面 | 客户端只发账户令牌与订单/服务器 id；收到状态与节点凭据 | 令牌存本地加密凭据 `secrets.enc`；不把云厂商凭据下发客户端 |
| 控制面 ↔ DigitalOcean | **只有控制面持有 DigitalOcean API Token** | Token 存 KMS / Secret Manager；按最小权限（droplets / regions / sizes / images / firewalls 只读与实例写）；可轮换 |
| 控制面内部 | 能看到节点密码与 enrollment 引导材料 | 数据库字段加密；日志脱敏（§9.2）；运维访问留审计 |
| 客户端内部 | 节点密码写入 `secrets.enc`（现有 `password_ref` 路径） | 不写日志、不进 AI 上下文、不显示在界面正文 |

**HTTP 由谁发**：`my_server_*` 是 UI → Host 的 Tauri 命令；真正的 HTTPS 请求与控制面令牌都住在 **Tauri Host（Rust）**。
前端只拿命令返回的结构化状态，**不持有 access/refresh token，也绝不把令牌或节点凭据放进 AI 上下文**。
密码只在「取凭据 → 验签 → 写 `secrets.enc`」这一步经过 Host 内存，写完即丢弃。

### 2.2 客户端凭什么信任后端响应

1. **传输**：仅 HTTPS，拒绝降级；证书校验走系统信任库。证书固定（pinning）作为可选项，默认不开——固定会让证书轮换变成发版依赖。
2. **来源**：后端是 Veyl 自有服务，不是第三方；响应里带 `request_id` 与 `server_time`，客户端记录以便排查。
3. **内容完整性**：节点凭据包附带控制面签名（Ed25519，公钥内置在客户端）。客户端**验签通过才写节点**；验签失败按「响应不可信」处理，不落库。这把“TLS 被中间人替换”与“后端被入侵后乱发凭据”都挡在写库之前。
4. **结果验证**：节点写入后必须先通过一次本地校验（`sing-box check` + TCP 连通 + 可选真实连接）才标「可用」。**不把“后端说好了”当成“节点能用”**。
5. **价格的事实**：价格以目录接口为准；客户端只做“预估月费”的乘法展示，并标注“以实际账单为准”。本期没有扣费与账单。

### 2.3 控制面在中国大陆的可达性（必须回答的风险）

事实：`*.workers.dev` 在中国大陆不可用；自定义域名指向 Cloudflare 能否稳定访问**不确定**（视线路与域名状态）。这不是“待核就完了”的问题——控制面不可达会让购买与管理链路直接死，必须设计降级。

**服务端应对**

1. **只使用自定义域名**，不把 `*.workers.dev` 作为任何生产入口；域名与 API 版本一起冻结在客户端。
2. **多域名列表**：客户端内置一个有序域名列表（主 + 备），逐个探测（`GET /v1/health`，2s 超时），选第一个可用的；失败按指数退避重试（1s→2s→4s→…上限 60s），**不无限重试、不弹窗刷屏**。M1 每个环境只有一个 origin（见 `docs/design/environments.md`），多域名是上线前换自有域名时的事；届时只改常量，不改判定逻辑。
3. **备用出口**：备份域名可以指向同一 Cloudflare 服务（仅换域名，绕过域名级问题）；若域名级封锁，则需另一条非 Cloudflare 出口作为运维预案，架构不变。这条预案由运维决定，不影响客户端协议。
4. **短请求**：全部走普通 HTTPS 短连接，不使用长连接 / WebSocket；轮询间隔在客户端侧（2s→5s→10s 退避）。
5. **无控制面依赖的节点**：节点凭据在本地，**已购买的服务器与节点在控制面不可达时仍能连接、切换、使用**；只有“买 / 查 / 销毁 / 重装”需要控制面。

**客户端在连不上控制面时的表现（硬要求）**

| 场景 | 要求 |
|---|---|
| 应用启动 | 不阻塞启动，不弹模态；主界面与控制台照常工作 |
| 已买节点 | 正常连接、切换、建配置，全部走本地数据，**不因控制面不可达而失效** |
| 「我的服务器」页 | 显示本地缓存的列表 + 顶部一条提示：「暂时连不上服务器服务；已买的服务器不受影响，管理功能稍后再试。」 |
| 写操作（购买 / 销毁 / 重建） | 明确报“现在连不上，稍后再试”，**不做离线排队**——钱和销毁不能盲重放 |
| 自动重试 | 仅健康探测与只读查询；到达上限后停止，改为用户手动「重试」 |
| 文案 | 三段式：发生了什么 / 已买的服务器和节点没有受影响 / 现在做什么 |

**测试要求**：验收里必须包含“断网 / 屏蔽控制面域名”的用例，断言已买节点仍可连接、页面只降级管理功能（N12）。

### 2.4 供应商抽象：`Provider` + 第一个实现 DigitalOcean

**业务层不认识任何厂商。** 建机、目录、销毁都经过一层 provider 接口；DigitalOcean 是第一个实现，将来加第二家只新增实现，不改订单、状态机、命令与界面。

```rust
#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;                       // "digitalocean"
    fn display_name(&self) -> &'static str;             // "DigitalOcean"，仅日志 / 诊断

    async fn regions(&self) -> Result<Vec<Region>>;      // 可售地区
    async fn sizes(&self) -> Result<Vec<Size>>;          // 规格 + 时价 / 月价
    async fn images(&self) -> Result<Vec<Image>>;        // 发行版镜像（只需 Ubuntu LTS）

    async fn create(&self, req: CreateInstance) -> Result<InstanceId>;
    async fn get(&self, id: &InstanceId) -> Result<Instance>;   // 状态 + 公网 IPv4
    async fn list(&self) -> Result<Vec<Instance>>;              // 对账 / 重启后恢复
    async fn destroy(&self, id: &InstanceId) -> Result<()>;
}
```

**归一化类型（业务层只用这一套，不出现厂商字段）**

| 类型 | 字段 |
|---|---|
| `Region` | `id`、`city`、`country`、`available` |
| `Size` | `id`、`monthly_usd`、`hourly_usd`、`vcpu`、`ram_mb`、`disk_gb`、`regions` |
| `Image` | `id`、`name`、`version`、`distro` |
| `CreateInstance` | `name`、`region`、`size`、`image`、`user_data`（**明文 cloud-init**）、`tags` |
| `Instance` | `id`、`status`（`creating` / `active` / `off` / `error` / `gone`）、`ipv4`、`region`、`size`、`created_at` |

- **厂商字段只出现在 `providers/digitalocean.rs`**：例如 `droplet`、`slug`、`s-1vcpu-1gb`、`user_data` 的编码方式，都不外泄到业务层、契约或界面。
- `user_data` 在接口里是**明文**；是否 base64、字段叫什么，由具体实现负责。DO 直接收明文（§13）。
- provider 注册表 `HashMap<&'static str, Arc<dyn Provider>>`，订单落 `my_servers.provider`（服务端列，**不下发客户端**）；M1 只有一行 `digitalocean`。
- 业务不变量：同一订单只在一个 provider 上创建；`destroy` 幂等（已不存在视为成功）；`get` 返回 `gone` 时按实例消失处理（§5.3）。
- 契约不变：`my_server_*` 的类型、字段、错误码保持 provider 无关；界面只显示归一化后的地区 / 状态 / 费用。

**为什么现在就要这层**：DO 与 Vultr 的建机字段、`user_data` 编码、镜像标识、状态枚举都不同（Vultr `main_ip` / DO `networks[].ip_address`）。把这些差异收在一个文件里，比将来在订单状态机里做 `match provider` 便宜得多。

---

## 3. 控制面 API（端点清单，不含实现）

> 环境映射与基础 URL：dev/prod 由构建模式决定，规则见 `docs/design/environments.md`。本节只列路径，不含 origin。

约定：

- 基础路径 `/v1`；请求/响应 JSON；字段 `snake_case`；时间 ISO 8601 UTC。
- 鉴权：`Authorization: Bearer <access_token>`；刷新用 refresh token（§4）。例外：`/v1/auth/*` 无需令牌；`/v1/enroll/{enrollment_token}` 用实例的一次性 token（§6.4）；`/v1/catalog` 公开只读、无需令牌（§3.2）。
- 写操作必须带 `Idempotency-Key`（客户端生成 UUID），重复键返回同一结果。
- 错误体：`{ code, message, retryable, details, request_id }`，与 `runtime.md` §2.6 同构；`details.reason` 取值见 §10。
- 限流：按账户与 IP；创建类接口单独限频（§8）。

> **本表是端点总览**；M1 的请求/响应字段、状态码、幂等键语义、错误 `details.reason` 与表结构统一在 **§19.5** 给出，实现以 §19 为准。

| 方法 | 路径 | 用途 | 关键请求 | 关键响应 |
|---|---|---|---|---|
| POST | `/v1/auth/device` | 设备匿名注册 / 换令牌（**M1 唯一身份路径**，§19.2） | `device_id`, `secret_hash`, `app_version`, `platform` | `access_token`, `refresh_token`, `account_id` |
| POST | `/v1/auth/email/start` | 邮箱验证码登录 | `email` | `sent: true`（不泄露是否已注册） |
| POST | `/v1/auth/email/verify` | 校验验证码 | `email`, `code` | 令牌三元组 |
| POST | `/v1/auth/google` | Google 登录（候选，未定） | `id_token` | 令牌三元组 |
| POST | `/v1/auth/refresh` | 刷新令牌 | `refresh_token` | 新令牌 |
| GET | `/v1/catalog` | 可售地区 / 套餐 / 时价 / 月价上限（**公开，无需登录**，§3.2） | — | `regions[]`, `plans[]`, `currency`, `updated_at` |
| POST | `/v1/orders` | 下单 | `region`, `plan`, `idempotency` | `order_id`, `state`, `amount`, `expires_at` |
| GET | `/v1/orders/{order_id}` | 查订单 | — | `state`, `amount`, `paid_at`, `failure`, `server_id` |
| POST | `/v1/orders/{order_id}/checkout` | **假支付**：立即标记成功（§3.1） | `channel`（固定 `fake`） | `state = paid` |
| POST | `/v1/orders/{order_id}/cancel` | 取消订单 | — | 未支付 → `cancelled`；已支付 → 销毁实例后 `cancelled` |
| GET | `/v1/servers` | 我的服务器列表 | — | `servers[]`（§5.3） |
| GET | `/v1/servers/{server_id}` | 详情与最新状态 | — | 同上单条 + `install_log_tail_redacted` |
| POST | `/v1/servers/{server_id}/rebuild` | 安装失败后重建（**销毁旧机 + 用同地区同套餐新建**） | `confirm: true` | `new_server_id`, `state = creating` |
| POST | `/v1/servers/{server_id}/destroy` | 销毁 | `confirm: true`, `reason?` | `state = destroying` |
| POST | `/v1/servers/{server_id}/credentials` | 取节点凭据（验签包） | — | `{ payload, signature }` |
| POST | `/v1/enroll/{enrollment_token}` | **实例 → 控制面**：上报安装结果与凭据 | 见 §6.4 | `ok` |

云厂商事件由控制面内部处理，不暴露给客户端；真实支付回调属于 M2（§3.1）。

### 3.1 支付：本期只做假的（接口形状保留）

**明确非目标**：本期不接真实支付、不做对账、不做回调验签、不做退款。支付只是一个能立即成功的假实现，用来跑通后面的建机与装机链路。

```ts
interface PaymentProvider {
  createCheckout(order: { id; amount_usd; currency }): Promise<
    | { kind: "fake"; paid: true }           // 本期唯一实现
    | { kind: "redirect"; url: string }      // 预留：真实渠道
  >;
}

class FakePaymentProvider implements PaymentProvider {
  async createCheckout() { return { kind: "fake", paid: true }; }
}
```

流程（本期）：

1. `POST /orders`：金额快照写入订单（展示用，不扣款）。
2. `POST /orders/{id}/checkout`：调用 `FakePaymentProvider`，**同步**把订单写成 `paid`，立即启动编排（§5.5）。
3. 客户端只看到“下单一成功就开始建机”，没有收银台、没有渠道选择、没有回调。
4. 真实渠道接入时：换一个 `PaymentProvider` 实现 + 恢复 webhook 验签与对账；**命令、事件、页面结构不变**，客户端只多一个“等待支付”状态。

**真实支付上线前必须补齐**（不在本期）：渠道选型、回调验签与去重、对账任务、退款策略（§5.4）、发票与税务。

### 3.2 目录接口是公开的（`GET /v1/catalog`）

**产品已拍板：目录与价格不需要登录。** 未登录用户可以完整看到「有哪些地区、多少钱」，只有真正下订单时才需要设备身份与付费（§4.3）。

- 无需 `Authorization`，无需 `Idempotency-Key`；只接受 `GET`。
- 响应只含可售内容：`regions[]`（含大洲分组依据）、`plans[]`（含 `hourly_usd` / `monthly_usd`）、`currency`、`updated_at`。
- **不返回**任何与账户、成本、余额、供应商原始响应相关的字段。
- 缓存：控制面用 Cache API 缓存 300 秒（`stale-while-revalidate` 可另加）；上游（DigitalOcean）失败时优先返回缓存副本，没有缓存才返回 `503` + `retryable: true`。
- 客户端每次启动拉一次，失败给「读不到可选地区，稍后再试」+ `重试`；**不退回假数据**——价格是真实承诺。
- 目录内容随套餐与地区变化，客户端不得内置地区或价格表。

---

## 4. 用户身份与鉴权

**M1 拍板：设备令牌，不做登录 UI。** 客户端首次使用「我的服务器」时静默注册一个设备账户，所有订单与服务器挂在该账户下；控制面能识别调用方，但界面上没有登录、注册、验证码。设备令牌的密钥位置、有效期、刷新与丢失后果见 **§19.2**。

**后续身份：邮箱验证码**（本节 §4.1–§4.3 保留为接入时的设计）。邮箱登录上线后，用户登录即把当前设备账户并入邮箱账户（规则见 §19.2.5），订单与服务器不迁移、不改 tag。Google 登录不做（大陆不可用）。

### 4.1 复用 TweetPilot 的现成实现

参考工程 `/Users/wesley/ai/TweetPilot/cloudflare/license-worker` 已有一整套 Cloudflare Workers 邮箱验证码逻辑，可直接复用其**行为与常量**（存储建议照搬 KV，不要为统一而迁移）：

| 能力 | TweetPilot 现状 | 本期怎么做 |
|---|---|---|
| 发码 | `POST /v1/auth/send-code`，6 位数字，Resend 发信（`lib/email.ts`） | **直接复用**：`POST /v1/auth/email/start`，6 位码，Resend；发信模板改成 Veyl 品牌 |
| 有效期 | `VERIFY_CODE_TTL_SECONDS = 300`（5 分钟） | 沿用 300s |
| 冷却 | `VERIFY_CODE_COOLDOWN_SECONDS = 60`（同邮箱 60s 一次） | 沿用 60s |
| 失败上限 | `VERIFY_CODE_MAX_ATTEMPTS = 3`，超过即作废 | 沿用 3 次 |
| IP 限频 | `SENDCODE_IP_RATE_LIMIT = 10` 次/小时，按 `CF-Connecting-IP` | 沿用 10 次/小时 |
| 防枚举 | 发送接口不区分邮箱是否注册，统一返回成功 | 沿用 |
| 校验 | `POST /v1/auth/verify`，成功后删除验证码；新邮箱自动建账户 | 复用逻辑；账户写入 D1 `accounts` / `account_identities` |
| 令牌 | Ed25519 签名的 portal JWT（`signPortalToken` / `verifyPortalToken`），默认 30 天 | 复用签名方式；access 15 分钟 + refresh 30 天，私钥放 Worker Secret |
| 人机校验 | 代码里有 Turnstile 调用但**被注释掉** | 本期启用 Turnstile（`turnstile_token`），防脚本刷码 |

**要补的**：

- 把 KV 的验证码 / 限频记录改为 D1 表（或 KV 绑定也行——TweetPilot 用 KV，Cloudflare 上照搬更省；推荐**照搬 KV**，不要为了统一而迁移）；
- 账户表从 `license` 结构改成 Veyl 的 `accounts`（邮箱、创建时间、状态）；
- 邮件内容与发件域名改成 Veyl；
- Turnstile 站点密钥与 Secret；
- 账户封禁 / 风控字段（本期只留字段，不做后台）。

### 4.2 鉴权细节

- Access token 15 分钟，refresh token 30 天；存本地加密凭据 `secrets.enc`（Host 持有，不下发 JS）。
- 所有订单与实例都挂在 `account_id` 下；**实例与账户强绑定，不可转让**。
- 登录态失效时，客户端只允许查看本地已缓存的服务器列表，写操作要求重新登录。（M1 的对应规则见 §19.2.2：自动刷新一次，刷新失败回落 §19.2.4。）

### 4.3 门禁与统一登录弹窗（M1 无门禁，M2 邮箱登录）

**门禁位置只有一处：真正产生交易或写操作之前。** 浏览地区、套餐、价格、已有服务器的本地缓存都不需要身份。

| 用户动作 | 是否需要身份 |
|---|---|
| 打开「我的服务器」、选地区、选套餐、看费用确认 | 不需要 |
| 首次读服务器列表 / 点「确认下单」 | **需要**——Host 静默注册设备（§19.2），无弹窗、无输入 |
| 查看服务器列表 / 详情（远端数据） | 设备令牌；注册或刷新失败显示空态 + `重试`，**不出现「登录」** |
| 销毁、重建、取凭据 | 设备令牌；过期自动刷新 |

**统一登录弹窗（M2，邮箱登录接入时启用）。** 全产品所有登录入口都用同一个模态弹窗（同一套界面 + 同一套状态机 + 同一处令牌存储），不做登录页、不做页面跳转、不在不同入口各写一份：

1. 第一步只问邮箱：一个输入框 + `发送验证码`。
2. 第二步输入 6 位验证码：60 秒后可重发，5 分钟有效，连续错 3 次作废并回到第一步（沿用 §4.1 常量）。
3. 成功即关闭弹窗，**回到触发它的原处**：正在确认订单的，已经选好的地区和套餐原样保留，按钮从「登录并继续」变回「确认下单」，用户再点一次才开始下单。
4. 失败按三段式给文案；邮箱未注册与已验证过的邮箱表现完全一致（防枚举）。
5. `Esc` 关闭弹窗、点遮罩关闭；关闭不改变已选地区与套餐（这些状态属于向导，不属于弹窗）。

**弹窗期间的界面**：左栏与 activity bar 仍可见但不可操作；中间区域保持原样，不做骨架屏、不跳转。不出现「登录页」「注册」「忘记密码」。

**本期不做**：Google 登录、第三方登录、多设备登录管理、改邮箱、注销账户。

---

## 5. 状态机

### 5.1 订单状态

```
pending_payment ──假支付成功──▶ paid ──▶ provisioning ──▶ ready
      │                           │
      └─ 超时 / 取消 ─▶ cancelled  ├─ 建机 / 安装 / 健康检查失败 ─▶ failed（实例已自动销毁）
                                  └─ 用户取消 ─▶ cancelled（先销毁实例）
```

- `draft` 不落库：只有用户点了「下单」才产生订单。
- **本期没有退款状态**：假支付没有真实扣款，失败时实例自动销毁，订单只记 `failed` + `failure`。
- 真实支付上线前，必须在这里补 `refunding → refunded`（§5.4）；本期不实现。

### 5.2 实例状态（控制面）

```
creating → booting → installing → verifying → healthy → active
   │          │           │           │           │
   └──────────┴───────────┴───────────┴───────────┴──▶ error（记录阶段与原因）
                                                         │
                                                 销毁 ─▶ destroying → destroyed
```

- `creating`：调用建机 API（成功即拿到 droplet id，但还没有 IP）。
- `booting`：轮询 droplet，**只认四种状态 `new` / `active` / `off` / `archive`**；其它返回值按瞬时异常重试，连续 3 次未知即失败。`active` 后从 `networks.v4[]` 里取 `type = "public"` 的 `ip_address`；`off` / `archive` 直接失败（不救）。
- `installing`：服务端脚本执行、准备上报。
- `verifying`：控制面收到凭据后做**服务端健康检查**（端口可达、出口 IP 可用）；客户端同时做**本地健康检查**（`sing-box check` + TCP 连通 + 可选真实连接）。两边都过才进 `healthy`。
- `healthy`：节点已写入节点池、`node_id` 已就绪。
- `active`：节点已至少被一套配置引用（可选状态，仅用于展示“已在使用”）。

### 5.3 状态表：失败分支、可重试性、文案、实例处置

| 阶段 | 失败情形 | 可重试 | 用户文案（三段式） | 实例处置 |
|---|---|---|---|---|
| 下单 | 地区售罄 / 目录过期 | 是（刷新目录） | 发生了什么：这个地区暂时没货 / 没有建机器 / 现在做什么：换一个地区或稍后再试 | — |
| 建机 | DigitalOcean 429 / 5xx / 镜像不可用 | 是（服务端自动 1 次，仍是同一次订单） | 发生了什么：服务器没建起来 / 会自动重试一次，仍失败就结束这笔订单 / 现在做什么：重新下单或换地区 | 无实例 |
| 开机 | 10 分钟未就绪 | 是（销毁重建） | 发生了什么：机器开机超时 / 这台已自动销毁 / 现在做什么：点「重新建一台」或换地区 | 自动销毁 |
| 安装 | 脚本失败 / 服务未起 / 自检失败 | **是（只能销毁重建，不在原机重跑）** | 发生了什么：服务端没装好 / 这台已自动销毁 / 现在做什么：点「重新建一台」 | 自动销毁 |
| 健康检查 | 端口不通 / 出口不可用 | 是（销毁重建） | 同上 | 自动销毁 |
| 可用后 | 实例被云厂商回收 | 否（重建） | 发生了什么：这台服务器已不存在 / 配置里的节点会连不上 / 现在做什么：重新买一台或改用自己的节点 | 已不存在 |
| 销毁 | 有配置正引用该节点 | 需确认 | 发生了什么：有 N 套配置在用这台 / 现在做什么：确认销毁后这些配置会少一个节点 | 删除实例与凭据 |

**重试只有两种，且都不在原机上执行**：

1. **同一次订单内的自动重试**：只用于建机 API 的可重试错误，最多 1 次；不产生第二台实例。
2. **用户点「重新建一台」**：控制面**先销毁旧实例**，再用同地区同套餐新建一台，从 `creating` 重新计时；这是新实例、新 IP、新凭据，界面明确说“重新建一台”，不说“重试安装”。

这样与 cloud-init 方案自洽：**实例上不存在可登录的运维通道**，也就没有“在原机重跑脚本”这条路径。客户端只展示状态，**不自动重复下单**——重复下单是最容易产生双倍扣费的地方。

### 5.4 退款与欠费：本期只写规则，不实现

本期是假支付，没有真实扣款，所以：

- **不实现退款**，也没有 `refunding` / `refunded` 状态。安装失败一律**自动销毁实例**，订单记 `failed`。
- **不实现计费循环**，不累计 `accrued_usd`，不做余额、欠费、停服。页面只展示目录价格与“预估月费”，标注“以实际账单为准”。
- **欠费处置（真实支付上线后启用）**：余额不足 → 提前 24h 提醒 → 停服务并调用云厂商 API 销毁实例（关机仍可能计 IP/存储费，口径待核）。本期不实现。

**真实支付上线前必须补齐**（占位，不在本期）：

1. 退款状态机：`refunding → refunded`，以及退款失败的人工队列。
2. 退款策略：未产生实例全退、安装失败全退、主动销毁按小时结算（M2 接入真实支付时再定）。
3. 欠费与宽限期：提醒、停服、销毁的时间点与用户通知。
4. 计费累计与对账：按小时累计、渠道对账、发票。

- **滥用防护（本期保留，但不叫配额）**：同一账户短时间反复建/删（如 10 分钟内超过 2 次）进入人工审核；审核期间禁止新建。一人多台不限制。

### 5.5 编排落点：Cloudflare 具体选型

Cloudflare 没有长驻进程，编排必须拆成“短请求 + 持久工作流”。

| 部件 | 选型 | 职责 |
|---|---|---|
| HTTP API | **Workers** | 全部 `/v1/*`；无状态；每次请求从 D1 读写 |
| 账户 / 订单 / 服务器 / 凭据 | **D1** | 订单与状态机的唯一事实源；凭据加密列；`webhook_events`（M2 真实支付才用）以渠道 `event_id` 唯一去重 |
| 开通编排 | **Workflows**（每订单一个实例） | 建机 → 等开机 → 装服务端 → 验健康；步骤内重试、步骤间可等待，天然支持长流程 |
| 单实例串行化 | **Durable Object**（每 `server_id` 一个） | 状态迁移、销毁 / 重建 / 回调的**单写者**；防止并发销毁与重复建机 |
| 异步重试 | **Queues（M2）** | M1 不引入：销毁是失败分支里的一次同步调用（最多 3 次，指数退避）+ Cron 兜底；队列留给 M2 的通知与批量任务 |
| 定时任务 | **Cron Triggers** | 订单过期、卡住的工作流与销毁任务巡检、遗留 droplet 对账（§19.6.5） |
| 支付 | 本期 `FakePaymentProvider` → 订单直接 `paid`（无 webhook）；真实渠道接入后改为 webhook → Worker |

**每一步：谁触发、超时、写回哪**

| 步骤 | 触发者 | 超时 / 重试 | 状态写回 |
|---|---|---|---|
| 下单 | 客户端 `POST /orders` | 同步，5s | D1 `orders = pending_payment` |
| 支付 | 本期：`checkout` 同步置 `paid`；M2：渠道 Webhook（Worker 验签） | 本期同步 1s；M2 同步 10s + `event_id` 幂等 | D1 `orders = paid`；启动 Workflow |
| 建机 | Workflow step `create_instance` | API 30s；失败重试 1 次 | D1 `servers = creating` |
| 等待开机 | Workflow step `wait_boot` | 轮询 10s，总 10 分钟 | D1 `servers = booting` → `installing` |
| 装服务端 | Workflow 等待 D1 / DO 收到 enrollment | 总 10 分钟；无回调即失败 | D1 `servers = installing`；DO 记录最后状态 |
| 健康检查 | Workflow step + 客户端本地校验 | 服务端 2 分钟；客户端 30s | D1 `servers = verifying → healthy` |
| 失败回收 | Workflow 失败分支 → Queue `destroy` | Queue 重投 5 次（指数退避） | D1 `orders = failed`；`servers = destroying → destroyed` |
| 销毁（用户） | Worker → DO → Queue | 同步改状态；删除任务重投 5 次 | D1 `servers = destroying → destroyed` |
| 卡住巡检 | Cron 每 5 分钟 | — | 标记 `error` 并告警（见下） |

**单实例串行化**：所有状态迁移（包括 enrollment 回调、销毁、重建、Workflow 的写入）都先进入该 `server_id` 的 Durable Object；DO 内串行处理并检查当前状态是否允许该迁移。这样即使 Workflow 重试与用户点击同时到达，也不会出现“两台实例 / 两次销毁”。

**可观测性**

- 结构化日志字段：`request_id`、`order_id`、`server_id`、`account_id`（哈希）、`step`、`duration_ms`、`outcome`；不含任何凭据（§9.2）。
- Cloudflare Analytics / Logpush 看错误率与延迟；Workflow 失败与 Queue 重投超限单独计数。
- 告警条件：订单停留 `paid/provisioning` 超过 15 分钟；销毁任务重投耗尽；云厂商 API 5xx 比例超阈值。
- 所有钱相关动作写 D1 `audit_log`（只追加）。

**为什么不用纯 Queues**：安装过程有“等 10 分钟开机 / 等回调”的等待，Queue 消费者每次只有 30s CPU 与有限执行时间，拆成多次消息会让状态散落、重试边界模糊；Workflows 把等待表达成步骤，重试与超时都有明确语义。

**为什么 M1 连 Queues 都不要**：M1 的异步副作用只有「销毁一台机器」一种，数量级是每单 0–1 次。用一个 Workflow 失败分支 + 一个 Cron 巡检就能覆盖，再加一层队列只会多一套重投语义和一处要看的地方。Queue 在 M2 有真实支付通知与批量任务时再引入，不影响本设计的表与端点。

**为什么不只用 DO 的 alarm 做编排**：可行，但把「等 10 分钟开机」「等 enrollment 回调」写成一串 alarm 状态机后，重试、超时、可见性全部要自己维护；Workflows 把这三件事变成声明式步骤，Dashboard 上还能直接看到每单卡在哪一步。DO 只保留它不可替代的那件事——**同一 `server_id` 的单写者**。

---

## 6. 服务端安装方案

### 6.1 选型：cloud-init 注入（唯一自动方案）+ 云控制台（人工排障）

| 方案 | 安全性 | 幂等 / 可重复 | 失败诊断 | 密钥管理 | 结论 |
|---|---|---|---|---|---|
| **cloud-init user-data 注入** | 高：自动装机本身不依赖 SSH | 一次执行；失败即销毁重建，不在原机重跑 | 中：脚本把脱敏日志回传控制面 | 无自动化密钥；只有一次性 enrollment token | **唯一自动方案** |
| 建后 SSH 执行 | 中：需要临时密钥 | 中：网络抖动会导致半完成 | 好：可直接取日志 | 需要临时密钥生命周期 | **不做**：自动装机不走 SSH；产品也不提供登录通道（§17） |
| 云厂商控制台（人工） | 中：只有我们内部账号能用 | — | 好 | 由云账号与内部权限控制 | **仅内部排障**；控制台账号不进客户端 |
| 预烘镜像（snapshot） | 高 | 最好 | 差（镜像过期） | 无 | M2 再考虑：先跑通脚本，再决定是否烘镜像加速 |

**“重试”的语义已写死为“销毁重建”**（§5.3），所以自动恢复不依赖任何登录通道：cloud-init 失败 → 控制面销毁 → 新实例重新执行同一份脚本。

DigitalOcean 的 `POST /v2/droplets` 直接接受 `user_data`（cloud-init **明文**，不要 base64）；这是自动装机的硬前提，已满足。`user_data` 大小上限未核实，脚本保持精简。
**登录通道的定位**：自动化不依赖它，产品也不提供它。装好之后没有 SSH、没有用户密码（§17）；服务器坏了就销毁重建，不做远程修复。平台自己的 break-glass 只走云控制台（§17.5），不进产品流程。

### 6.2 机器与镜像

- 镜像：Ubuntu 24.04，slug 固定为 **`ubuntu-24-04-x64`**（`type=distribution`）；本期只用 24.04。
- 规格：默认 **`s-1vcpu-1gb`**——$6/月、1 vCPU / 1GB / 25GB；本期只有这一档套餐，地区不限制。更便宜的 `s-1vcpu-512mb-10gb`（$4/月、512MB）是否满足 sing-box 运行、覆盖哪些地区**待核（§13）**，核实前不上架。
- 建机：`POST /v2/droplets`，字段 `name` / `region` / `size` / `image` / `user_data` / `tags`（另有 `ssh_keys` / `ipv6` / `monitoring` / `vpc_uuid`，本设计不使用 SSH）；**`user_data` 直接传明文 cloud-init，不 base64**。
- 防火墙：使用 DigitalOcean Cloud Firewalls（**先建 droplet，再 `POST /v2/firewalls` 并在 `droplet_ids` 里带上它**，规则一次给全、不做事后追加，因此不需要 `firewall:update`；**只放行节点端口**）。不开放 22、数据库、控制面端口。

### 6.3 初始化脚本要做什么（伪代码级）

**基线：复用现有安装脚本**（`https://meshnetprotocol.github.io/install.sh`）。它已经完成：生成随机端口 / 密码、安装 sing-box、写 systemd 服务、开防火墙。我们**不重写**，只在它基础上做四处改造（§6.3.1）。

1. `apt-get update`，安装最小依赖（`curl`、`ca-certificates`、`jq`）。
2. 安装 sing-box：**固定版本 `1.14.4`**（与客户端随包运行时一致），安装包从**我们自己的控制面 / R2** 取并校验 sha256；不使用系统包管理器里的旧版本，也不在开机时依赖 GitHub。
   - 同时安装更新代理 `veyl-agent`（验签 + sha256；`/etc/veyl/agent.toml` + systemd timer），见 §6.6。
3. 生成凭据（沿用现有脚本的口径，两处来源不同、原因见 §19.6.1）：
   - 端口：**由控制面在建机前选定**（`10000–60000` 内随机、避开常用端口），随 cloud-init 下发；脚本只用给定值，不再自行随机。原因：防火墙必须在拿到 droplet id 后立刻带端口创建，而 `firewall:update` 不在我们的权限范围内（§19.6.2）；
   - 密码：**在服务器上生成**（`[A-Za-z0-9]{16}`），不经过 `user_data`、不在控制面明文落库，只由 enrollment 回传后加密保存；
   - 加密方式：固定 **`aes-256-gcm`**；
   - 节点名：由控制面给出（`云服务器 · <地区> · <短 id>`），脚本不自行起名。
4. 写 `/usr/local/etc/sing-box/config.json`（权限 `0600`）：仅 shadowsocks 入站（`aes-256-gcm`）+ direct 出站 + 日志 `warn`；**不启用 Clash API、不监听本机管理端口**。
5. 建系统用户 `sbg`（nologin），服务以非 root 运行；systemd 单元名为 **`sing-box`**，加 `NoNewPrivileges=yes`、`ProtectSystem=strict`、`PrivateTmp=yes`、无 capabilities。
6. 防火墙：默认拒绝入站；**节点端口同时放行 TCP 与 UDP**，不开放 22。
7. **关闭登录通道**：停止并禁用 sshd，不开放 22/tcp；不创建任何可登录用户（root 无密码、无密钥）。
8. 启动服务并自检：
   - `sing-box check -c /usr/local/etc/sing-box/config.json`
   - `systemctl is-active sing-box`
   - 本机 `ss -lnt` / `ss -lnu` 确认 TCP 与 UDP 端口在听
   - 出站探测（请求一个公网 IP 服务），确认能出去
9. 上报：用一次性 enrollment token（见 §6.4）把 `{server_id, node:{port, method: "aes-256-gcm", password}, egress_ip, singbox_version}` 回传控制面；**上报走 HTTPS，载荷只进控制面，不回显到任何日志或界面**。
10. 失败：写 `/var/log/veyl-install.log`（已脱敏），尽力上报安装失败（`failure.stage = installing`）；控制面销毁实例。

### 6.3.1 对现有安装脚本的四处改造

| # | 改造 | 原脚本 | 我们 |
|---|---|---|---|
| 1 | **版本 pin** | `1.12.17` | `1.14.4`，与客户端随包运行时同版本；升级时两端一起升（`server-agent.md` §5） |
| 2 | **凭据回传** | 把节点信息打印到 stdout / 写文件，用户自己看见 | **不回显**：带一次性 enrollment token `POST` 到控制面；stdout 与安装日志都不含密码 |
| 3 | **安装包来源** | 开机时访问 GitHub 拉取 | 由**我们自己的控制面 / R2** 提供安装包与脚本，cloud-init 内置 sha256，下载后校验；不依赖开机时访问 GitHub |
| 4 | **端口来源** | 脚本自己随机 | 用**控制面下发的端口**；范围仍是 `10000–60000`，但必须与控制面建的防火墙规则一致（§19.6.1） |

其余参数保持脚本原样：端口范围 `10000–60000`、密码 16 位字母数字、配置 `/usr/local/etc/sing-box/config.json`（0600）、服务名 `sing-box`、防火墙 TCP + UDP 同时放行。

**加密方式为什么固定 `aes-256-gcm`**：客户端与服务端都支持（sing-box 内置 AEAD），现有安装脚本已经用它；统一成一个默认值，避免两端各自漂移成两套 method，最后出现「节点导入后连不上」的排查成本。

### 6.4 凭据的生成、传递与保存

```
实例启动
  └─ cloud-init 带 enrollment_token（一次性、仅能上报、45 分钟过期）+ 控制面选定的端口
       └─ 脚本生成节点密码（不建任何登录账号）
            └─ POST /v1/enroll/{token}  （HTTPS）
                 └─ 控制面：校验 token / 端口 → 存加密的节点凭据 → 标 installing→healthy
                      └─ 客户端：GET /v1/servers/{id}/credentials → 验签 → 写 secrets.enc
```

- **凭据只在服务端生成**，客户端不参与生成；控制面用 AES-256-GCM 加密保存到服务器销毁为止，销毁即删除；不做定时清理，也不在服务器仍存在时轮换（重建会生成全新凭据）。
- enrollment token 与 `server_id` / 订单绑定、**原子单次消费**（`UPDATE … WHERE used_at IS NULL RETURNING`，并发第二个必然失败）、**45 分钟过期**（必须长于整单 25 分钟硬上限，避免“机器还活着但已经不能上报”）。
- 回传失败由 `veyl-enroll.service` 自己重试：`5s → 15s → 45s → 2m → 5m`，硬截止 20 分钟；4xx（token 无效 / 端口不符 / 服务器已被销毁）**不重试**，直接按失败处理并上报。细节见 §19.7。
- 客户端取凭据包必须验签（§2.2），验签失败不落库。
- 节点落库：`nodes.source = 'owned'`（新增枚举，见 §10.4），`password_ref` 指向 `secrets.enc`，**明文密码不落库、不写日志、不回显**。
- 没有第二种凭据：不生成 SSH 密码、不注入用户公钥、没有 `ssh:` 键（§17）。

### 6.5 回滚与重装

- **安装失败 = 销毁重建**：控制面销毁实例并结束订单（`failed`）；用户点「重新建一台」后，用同地区同套餐新建，从 `creating` 重新走一遍。**不存在“在原机重跑脚本”**——原机没有登录通道，也没有必要保留一台半成品继续计费。
- **销毁后的节点**：节点记录**保留并标「服务器已销毁」**，不自动移出组、不改 `current_node_id`；连接时给明确错误，用户可在组详情手动移除（产品 2026-11-14 拍板，`remote-groups.md` §4.2 第 7 条）。
- **重建**：新实例就绪、新凭据写入后，新节点自动加入旧节点所在的组；旧节点仍保留标已销毁，`current_node_id` **不变**。界面提示「新服务器已就绪」，给一个 `换到新节点` 的显式动作——用户点了才改当前节点，不静默切换。
- **安装时限（到点即失败，不无限等）**：等待开机 ≤ 10 分钟；安装 ≤ 10 分钟；端口监听 ≤ 60 秒；TCP 握手 3 次、每次 5 秒；服务端健康检查 ≤ 2 分钟；客户端本地检查（`sing-box check` + 连通）≤ 30 秒。任一环节超时 → `error` → 销毁实例；整单硬上限 25 分钟。没有登录通道，所以判定只靠端口、握手与健康检查，不靠远程读日志。
- **重装（M2，可选）**：本质上仍是销毁重建；若将来做了“保留 IP”的能力，再区分“重装”和“新建”。
- **卸载**：销毁实例即卸载；本地节点记录由用户删除（或在销毁时询问是否同时删除）。

### 6.6 服务器上的更新代理

云厂商 API 只能管机器、不能改机器里的软件，SSH 又已撤掉；为了在不登录服务器的前提下做 sing-box 安全更新与配置变更，cloud-init 会同时安装一个**只外连、不监听端口**的更新代理：

- M1：安装 + 每小时心跳 + 上报 `agent_version` / `singbox_version` / 健康；不执行升级。
- M1 末尾或 M2：按控制面签名指令原地升级、失败自动回滚。
- **不做远程 shell、不做任意命令、不做入站通道、不做静默升级。**

协议、安全边界与 M1/M2 切分见 `docs/design/server-agent.md`。

---

## 7. 客户端界面

> 2026-11-14 产品两次改定，最终为：activity bar 三个平级 destination —— `客户端` / `节点组` / `我的服务器`。服务器与节点组是两个并行模块（数据单向：服务器 → 节点 → 组）；本节的服务器页是**独立的 `我的服务器` destination**，左栏服务器列表、中间详情 / 新建向导。从组详情的 `添加节点 → 从我的服务器添加` 跳到这里时带目标组上下文（§7.1）。

### 7.1 入口与路由（三个平级 destination）

产品 2026-11-14 拍板：activity bar 三个平级 destination —— `客户端` / `节点组` / `我的服务器`（组模型见 `docs/design/remote-groups.md` §7）。

| destination | 左栏 | 中间 |
|---|---|---|
| `客户端`（默认） | 配置列表 | 网络控制台 |
| `节点组` | 组列表（`免费` 段 → `我的组` 段） | 选中组的详情 |
| `我的服务器` | 服务器列表 | 选中的服务器详情 / 新建向导 / 四段进度 |

| 入口 | 行为 |
|---|---|
| **主入口** | activity bar 的 `我的服务器` 图标 → 左栏服务器列表 + 中间详情（默认第一台；零台时中间是空态） |
| **上下文入口** | 组详情 → `添加节点` → `从我的服务器添加` → 切到本 destination，并记住目标组（下） |
| **节点面板入口** | 底部节点面板里 `source = 'owned'` 的节点 `管理这台服务器 →` → 切到 `我的服务器` 并定位该服务器详情 |
| **新建流程入口** | 新建配置第 2 问 `其它节点` → `节点组 → 添加节点 → 从我的服务器`；服务器就绪后节点自动进发起流程的组，回到新建流程 |

**带目标组的添加**

- 从组详情跳进来时，页头一行 `从「上海 1 号」添加节点` + `取消`；左栏服务器列表照常，中间仍是详情 / 向导。
- 每台**可用**服务器的主按钮变成 **`加入「上海 1 号」`**（替代 `用来建配置`）；点它，节点进组并**自动回到组详情**。
- 安装中的服务器装好后**自动加入目标组并自动回到组详情**，不需要再点一次。
- `取消` 丢弃上下文，留在本 destination（页头恢复 `我的服务器`，按钮恢复 `用来建配置`）。
- 没有目标组时（从 activity bar 直接进入）：不显示 `加入「X」`；装机成功后节点进 `我的节点`。

**其它已定细节**

1. **默认 destination = 客户端。** 没有本地记录、记录损坏或界面大改版后，启动一律落在控制台。
2. **记住上次停留的 destination。** `localStorage["veyl.ui.destination"]`（`client` / `groups` / `servers`）+ `veyl.ui.destinationVersion`；只记「在看哪个 destination」，不记服务器选中、不恢复向导。重开落在该 destination 的根（默认第一台 / 空态）。
3. **三个图标常驻。** 没有服务器时 `我的服务器` 图标照样在，点进去是空态。
4. **不带跨 destination 的角标。** 安装台数只在左栏服务器列表与详情里看，`节点组` 图标不加台数。
5. **切换 destination 不影响连接。** 连接状态、计时器、读数、托盘图标都不随 destination 变化；切换过程中**不发任何运行时命令**。在本页下单、销毁也不改当前连接，除非用户点 `连接 VPN`。
6. **连接状态不在节点组 / 我的服务器重复显示。** 唯一住处仍是控制台 hero（加托盘镜像）。

新建流程里的 `其它节点` 会切到 `节点组` 并保留新建流程的上下文；完成后回到 `客户端` 恢复新建流程。

### 7.1.1 既有的「贴链接 / 订阅 / 手填」去哪了

第三方机场的静态广场退役，不等于用户已有的节点能力被砍掉。**三条既有路径全部保留，入口收进同一页**：

| 既有能力 | 现在放在哪 | 说明 |
|---|---|---|
| 贴分享链接 / 订阅地址 / 自己填服务器信息 | 「我的服务器」页底部的次要入口 `我已有节点或订阅` | 打开现有的导入流程（`node_import_text` / `node_import_url` / `node_create`），成功后节点入池并自动进 `我的节点` 组，可在本次新建里选该组 |
| 节点池里已有的节点 | 同页次要入口 `用已有的节点` | 池非空时出现；选完加入本次要绑定的组（默认 `我的节点`），配置走 `config_create(groupId)`（组模型见 `docs/design/remote-groups.md`） |
| AI 对话里的同一组能力 | **不变** | AI 路径仍可直接问用户要链接 / 订阅 / 四项信息；它不经过「我的服务器」页，也不要求用户先买服务器 |
| 设置 › 连接 ›「添加节点」 | **不变** | 日常管理入口 |

**「其它节点」只保留一个门**：新建第 2 问的 `其它节点` → 「我的服务器」页；页面里同时给出“买一台”（主）与“我已有节点”（次）两条路。
这样既有的订阅/分享能力有明确住处，也不会把“买服务器”和“导入节点”做成两个并列入口让人选。

> 真正退役的只有「供应商广场」这个**静态示例列表**；不存在真实机场市场，也不做外链购买。

### 7.2 服务器 destination 的页面结构（左栏列表 + 中间详情）

```
┌────┬───────────────────────┬──────────────────────────────────┬──────────┐
│ ○  │ 我的服务器        ＋  │ 东京 1 号                ● 可用 │ 助手 420 │
│ ○  │                       │ 地区  日本 · 东京                │          │
│ ●  │ ● 东京 1 号     可用  │ 节点  已就绪                     │          │
│    │   东京 · 日本         │ 费用  $0.009/小时 · 约 $6/月      │          │
│    │ ◐ 大阪 1 号     62%   │                                  │          │
│    │   大阪 · 日本         │ [ 用来建配置 ]          [ 销毁 ]  │          │
│    │                       │                                  │          │
│    │ 设置                  │                                  │          │
└────┴───────────────────────┴──────────────────────────────────┴──────────┘
```

**左栏（服务器列表）**

- 标题行 `我的服务器` + 右侧 `＋`（新建服务器）。
- 每行两行：第一行 = 名称 + 右侧状态点（`●` 可用 / `◐` 进行中 / 失败用 `--red`）；第二行 = 地区，进行中时后接紧凑状态 `安装中 62%`。
- 选中行与配置行 / 组行同一套（`--card` 底 + 左侧 2px `--cobalt` + 名称 600）。
- 零台时左栏是空态（下）；点行只换中间详情，不推栈、不动连接。
- 底部只有「设置」。

**中间（详情 / 空态）**

- 默认选中第一台；没有选中、零台时显示空态。
- 详情内容与操作门控见 §7.4；向导见 §7.3。
- **没有 `←` 返回按钮**；`Esc` 在向导里回详情（有未提交内容先确认），在详情里不做任何事；回根 = 再点一次已激活的 `我的服务器` 图标。
- 空态（零台）：

```
      还没有自己的服务器
用云服务器买一台属于你的服务器，Veyl 会帮你装好，
建完就能当节点用。
         [ 新建服务器 ]
```

- 详情底部次要入口（文字链接）：`我已有节点或订阅` · `用已有的节点`（节点池非空时出现）。

> 本期是假支付：没有余额、没有“本月已花”、没有台数上限。价格只做只读展示。

### 7.3 新建服务器（M1：单页创建 → 假支付）

**一屏完成，没有「下一步 / 确认订单 / 返回」**（2026-11-14 产品拍板，参考云厂商创建实例的做法）。同一屏从上到下：

| 区块 | 内容 | 交互 |
|---|---|---|
| 地区 | 按大洲分组的地区按钮，默认选中第一个可用地区 | 点选即生效 |
| 服务器类型 | 三档单选卡：`1 核 · 512 MB · $4/月`、`1 核 · 1 GB · $6/月`（默认）、`1 核 · 2 GB · $12/月` | 整卡可点，`radiogroup`，↑↓ 切换 |
| 系统 | 一行事实：`Ubuntu 24.04 LTS` | **不可选**——安装脚本只支持这一个系统，不提供装不上的组合 |
| 底部 | `约 $6/月 · $0.00893/小时` + 唯一主按钮 `创建服务器` | 价格随选择实时变 |

- 价格来自目录接口（§3.2），客户端不内置价格表；没有的地区或套餐不渲染。
- 点 `创建服务器` 即下单（假支付同步成功）；**没有登录弹窗**——身份由 Host 静默注册的设备令牌提供（§19.2），用户在界面上看不到任何认证步骤。身份注册失败时按钮下方给一句「暂时连不上服务器服务」+ `重试`。
- 本期没有支付方式选择：下单后直接假支付成功，显示一句“体验流程，不会真实扣费”。
- 目录读取失败：整页一句「读不到可选地区」+ `重试`，不回退假数据。
- 下单后回到详情：左栏该行出现紧凑状态 `安装中 62%`，中间显示完整四段进度：`正在建机器 → 等待开机 → 安装服务端 → 检查是否可用`。
- 完成后左栏状态点变绿；节点自动加入目标组（带目标组进入时）或 `我的节点`（从 activity bar 直接进入时），直接可用于 `config_create(groupId)`；详情的主按钮变为 `用来建配置`，点它回到新建流程；带目标组进入时自动回到组详情。

**全程不出现命令行、SSH、root、镜像、API 等词。**

向导占据中间区域（替换详情），左栏服务器列表仍在但不可选。向导没有「返回」按钮：中途退出按 `Esc`，有未提交内容时先确认放弃，然后回到详情；完成或放弃之前不会退回客户端或组详情。

### 7.4 详情（中间）

- 详情是 `我的服务器` destination 的中间内容：点左栏一行即切换；`Esc` 在详情里不做任何事（回根 = 再点一次已激活的图标）。
- 事实行：地区、状态、节点是否就绪、费用（只读）。**不显示 IP、端口、协议、创建时间，也没有 SSH / 用户名 / 密码**（§17.3）。
- **操作按钮按状态门控**（`MyServerState`，§10.1）：

  | 状态 | `用来建配置` | `销毁` | `重新建一台` |
  |---|---|---|---|
  | `creating` / `booting` / `installing` / `verifying` | 不显示 | **显示** | 不显示 |
  | `healthy` / `active`（可用） | **显示**（唯一主按钮） | 显示 | 不显示 |
  | `error` | 不显示 | 显示 | **显示** |
  | `destroying` | 不显示 | 不显示（显示「正在销毁」） | 不显示 |
  | `gone`（已失效） | 不显示 | 不显示 | 显示 `重新购买` + `改用自己的节点` |
  | `destroyed` | 列表中不显示，详情不可达 | — | — |

- **`用来建配置` 只认「可用」**（`healthy` / `active`）：安装中、出错、销毁中一律不给——节点还没进池或已失效，给了也只会失败。
- **带目标组进入时，这个主按钮换成 `加入「X」`**（同样只认可用）：点后节点进组并自动回到组详情（§7.1）。
- **没有 `SSH 登录` 这一行**：凭据由控制面管理，用户不登录服务器，界面上也没有可显示的密码（§17）。
- **创建中也能 `销毁`**，这是用户取消卡住创建的唯一出口：同一个 danger-ghost，二次确认文案改为「取消创建并销毁这台服务器？正在进行的安装会中断。」；出错时 `销毁` 同样可用（实例尚未回收的情况），后台已自动销毁的会走 `destroying → destroyed`，不会停在 `error`。
- **已销毁的服务器不显示**：`destroyed` 从列表移除，不留墓碑行；`gone`（实例已不存在）保留在列表标 `已失效`，给 `重新购买` 与 `改用自己的节点`。
- 创建中：中间显示**完整四段进度**与百分比；服务器列表那一行只给一句紧凑状态（`安装中 62%`），不重复四段。
- 若该节点已被 N 套配置引用，提醒销毁影响。

### 7.5 空态与失败态

| 情况 | 界面 |
|---|---|
| 身份未就绪 | 列表区空态 + 一句「暂时连不上服务器服务」+ `重试`；价格仍可看。**不出现 `登录`** |
| 下单处理中 | 列表该行显示「正在开始…」，详情给一句进度；假支付通常不到 1 秒 |
| 建机失败 | 详情错误块：发生了什么 / 这笔订单已结束，没有产生服务器 / `重新下单` 或 `换地区`；列表该行状态点转红 |
| 装机失败 | 中间详情错误块：已自动销毁 + `重新建一台`；不说“重试安装” |
| 实例已不存在 | 列表行标 `已失效`；**节点保留在组里并标「服务器已销毁」**，连接时给明确错误；用户可手动移除；详情给 `重新购买` 与 `改用自己的节点` |
| 提供商不可用 | 页头提示「暂时连不上服务器服务，稍后再试」；不影响已有节点 |

所有错误按三段式：发生了什么 → 有没有产生服务器或改动 → 现在做什么。本期没有扣费，文案不要提“退款”。

### 7.6 节点如何进池、如何建配置

1. 控制面通知客户端 `my-server-changed(state = `healthy`)`。
2. Host 取凭据 → 验签 → 写 `nodes`（`source = 'owned'`）+ `secrets.enc` → 发 `node-list-changed`。
3. `my_server_get` 返回 `node_id`；客户端把节点加入 `我的节点`（或用户在组的添加流程里指定的组）；配置绑定组，调 `config_create(groupId)`，**不加新字段**。
4. 已建配置里该服务器若被销毁：**节点记录保留并标「服务器已销毁」，不自动移出组、不改 `current_node_id`**；连接时给明确错误「这台服务器已销毁，换一个节点或重新购买」，用户可手动移除（移除后按组内第一个回落）。产品 2026-11-14 拍板，见 `remote-groups.md` §4.2 第 7 条。

### 7.7 veyl-ui 约束对照

- 一屏一个主按钮：服务器列表标题的 `＋` 是图标动作、不是主按钮；有服务器时中间详情只有 `用来建配置` 是实心；零台时空态的 `新建服务器` 是唯一实心。`销毁` 一律 danger-ghost。
- 每个事实一个住处：价格只在费用确认与详情各出现一次；**四段进度完整版只在中间详情，服务器列表行只给一句紧凑状态（`安装中 62%`）**。
- 禁词：正文不出现 proxy / TUN / 分流；`TUN 模式` / `Proxy 模式` 仅在三处例外可用（新建卡片、左栏、读数）。`我的服务器` destination 全程不使用这些词。
- 字号 20/17/15/14/13/12/11，间距 4px 网格，颜色只用现有 token；状态点复用 `.led` 尺寸。
- 加载不跳版：四段进度占位固定高度；失败不弹 toast，留在详情里。
- **destination 与骨架**：切换 destination 时**左栏与中间一起换**——`客户端` 是配置列表 + 控制台三段骨架，`节点组` 是组列表 + 选中组详情，`我的服务器` 是服务器列表 + 详情 / 向导；右栏 AI 不变；三个图标常驻（`veyl-ui` §1.1 / §1.3）。切换 destination 不改连接状态、不发运行时命令。

---

## 8. 价格展示与滥用防护（不实现计费）

### 8.1 展示口径（只读）

- 价格**直接使用目录接口返回的售价**，客户端与后端都不做成本计算、不加价计算。
- 同时给时价与月估：`$0.009/小时` 与 `约 $6/月（按 730 小时）`；月估只是乘法，标注“以实际账单为准”。美元价来自 `/v2/sizes` 的 `price_hourly` / `price_monthly`，不手写。
- **加价 30% 只写进文档**：内部口径是“云厂商成本 + 30%”，由运营在配置目录售价时体现；**代码里不出现 30%**，也不拆“成本 / 服务费”。
- 不显示“已花费”“余额”“本月账单”——本期没有计费循环。

### 8.2 滥用防护（不叫配额）

一人多台**不限制**；只限制“刷”的行为：

| 项 | M1 |
|---|---|
| 同时创建 | 1 台 |
| 创建频率 | 10 分钟内最多 2 次；超过进入人工审核（本期可先拒绝并提示稍后再试） |
| 未完成订单 | 同时最多 1 个，10 分钟过期 |
| 下单前提 | 设备身份已注册（M1，无登录 UI；§19.2） |

界面不出现“配额”“上限”“达到上限”等字；触发频率限制时按三段式说明“操作太频繁，稍后再试”。

### 8.3 责任边界（真实支付前的占位）

- 云厂商按小时计费；**关机不等于停止计费**（IP / 存储通常仍计，具体口径待核 §13），所以界面只提供 `销毁`，不提供“关机省钱”。
- 销毁由控制面显式调用云厂商 API；调用失败要重试并告警，不能假装已销毁。
- 本期没有真实金额变动；接入真实支付前，必须补计费累计、退款、欠费、支付争议的流程与审计（§5.4）。

---

## 9. 安全与隐私

### 9.1 存放位置

| 秘密 | 存放 | 谁能读 |
|---|---|---|
| DigitalOcean API Token | 控制面 KMS / Secret Manager；不落代码库、不落日志 | 控制面服务进程；运维经审计临时授权 |
| 支付渠道密钥 | 同上 | 同上 |
| 节点密码 | 控制面加密列（服务器生命周期内）+ 客户端 `secrets.enc` | 控制面服务、下单用户 |
| enrollment token | 控制面 D1 **只存 `sha256`**；明文只出现在该实例的 `user_data` | 对应实例的 cloud-init |
| 客户端设备秘密 + 令牌 | **本地加密凭据 `secrets.enc`**（`device_secret` 是长期根，access 15 分钟 / refresh 30 天）；SQLite 只存 `account_id` | 客户端 Host 进程（**不下发 JS**） |
| 凭据加密密钥（AES-256-GCM） | 控制面 Worker Secret（`CREDENTIAL_ENC_KEY`），带 `key_version` 以便轮换 | 控制面服务 |
| 签名私钥（凭据包 / 令牌） | 控制面 KMS / Worker Secret（`TOKEN_SIGNING_KEY`） | 控制面服务 |

### 9.2 日志脱敏清单（必须逐项实现）

- 永不记录：云厂商 API Token、支付密钥、节点密码、enrollment token、私钥、完整邮箱（只留哈希或掩码）、客户端 access/refresh token。
- 可记录：`account_id` 哈希、`order_id`、`server_id`、地区、plan、状态迁移、错误码、耗时。
- 安装日志回传前过滤：密码、token、云厂商凭据、完整 IP 列表（可保留出口 IP）。
- 客户端日志：服务器密码与令牌打码；AI 上下文里永不出现密码。

### 9.3 开源仓库禁用清单

- 任何云厂商 Key / 支付 Key / 签名私钥 / 测试账号凭据；
- 能推出控制面内部地址与密钥的配置（后端域名可作为公开的 API 端点，但不得携带任何凭据）；
- 真实用户邮箱、IP、订单号、服务器密码；
- 测试用的云厂商 API Token（即使已失效）。

### 9.4 合规与平台风险

- **云厂商代付转售条款：按产品决定不纳入设计约束**（2026-11-13，2026-11-14 随供应商切换重新确认）。事实记录：我们用自己的主账号创建实例、通过 Cloudflare 向用户收费；云厂商服务条款对该模式的限制未做核验，风险由产品承担。本文不再把它当阻塞项，工程上只按“主账号 + 我们收钱”实现。
- 中国大陆用户支付与税务：跨境支付、发票、退款政策需产品与财务确认；收费在 Cloudflare 侧，具体渠道见 §3.1。
- 数据与隐私：邮箱、支付信息、服务器 IP 的保存期限与删除机制；隐私政策需更新。
- 内容与用途：滥用（扫描、代理黑产）会导致云厂商封号；需要有账户封禁与实例销毁流程。

---

## 10. 契约变更

版本规则：**按真正变化的那份升**，不齐升。

### 10.1 `commands.md` → 2.23.0

> `2.22.0` 已落地 `my_server_catalog`（公开目录，只读）。本批只新增其余 8 条命令。
> 版本顺序按「谁先合入谁占号」：如果节点组批的 `3.0.0` 先合入，本批顺延为 `3.1.0`，**命令集合不变**。

新增命令（均为 UI 通道；命名沿用现有 snake_case）：

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `my_server_catalog` | `{}` | `{ regions, plans, currency, updated_at }` | 可售地区 / 套餐 / 价格；来自控制面（**2.22.0 已落地**） |
| `my_server_list` | `{}` | `{ servers: MyServer[] }` | 列表 |
| `my_server_get` | `{ serverId }` | `MyServer` | 详情（含 `node_id`） |
| `my_server_create` | `{ region, plan, idempotencyKey }` | `MyServerOrder` | 下单；本期假支付 |
| `my_server_checkout` | `{ orderId }` | `MyServerOrder` | 假支付：立即 `paid` 并开始编排 |
| `my_server_cancel_order` | `{ orderId }` | `MyServerOrder` | 取消未完成订单（已建实例则先销毁） |
| `my_server_rebuild` | `{ serverId, confirm }` | `{ newServerId, state }` | 销毁旧机并用同地区同套餐新建（安装失败的恢复路径） |
| `my_server_destroy` | `{ serverId, confirm }` | `MyServer` | 销毁 |
| `my_server_credentials` | `{ serverId }` | `{ payload, signature }` | 取凭据（客户端验签后落库） |

```ts
type MyServerState =
  | "creating" | "booting" | "installing" | "verifying" | "healthy" | "active"
  | "error" | "destroying" | "destroyed" | "gone";

type MyServer = {
  server_id: string;
  name: string;
  region: string;
  plan: string;
  state: MyServerState;
  created_at: string;
  ip: string | null;
  port: number | null;
  node_id: string | null;         // 安装成功后才有
  hourly_usd: number;
  monthly_usd: number;            // 目录给出的月估，仅展示
  failure: { stage: MyServerState; code: string; message: string; retryable: boolean } | null;
};

type MyServerOrder = {
  order_id: string;
  state: "pending_payment" | "paid" | "provisioning" | "ready" | "cancelled" | "failed";
  region: string;
  plan: string;
  amount_usd: number;             // 展示用金额快照
  created_at: string;
  expires_at: string | null;
  server_id: string | null;
  failure: { code: string; message: string; retryable: boolean } | null;
};
```

### 10.2 错误码（沿用现有信封：`code` + `details.reason` + `retryable`）

| 场景 | code | details.reason | retryable | 用户文案要点 |
|---|---|---|---|---|
| 提供商不可用 | `UPSTREAM_ERROR` | `provider_unavailable` | 是（退避） | 暂时连不上服务器服务，稍后再试；没有产生服务器 |
| 创建失败 | `UPSTREAM_ERROR` | `instance_create_failed` | 是（服务端 1 次） | 服务器没建起来；这笔订单已结束 |
| 安装失败 | `UPSTREAM_ERROR` | `install_failed` | 是（只能销毁重建） | 服务端没装好；已自动销毁；可「重新建一台」 |
| 实例已不存在 | `NOT_FOUND` | `server_gone` | 否 | 这台服务器已不存在；重新购买或改用其它节点 |
| 身份失效 / 令牌无效 | `PRECONDITION_FAILED` | `auth_required` | 是（自动刷新后重试） | 稍后再试；仍失败就重新注册设备，并提示旧服务器不可见（§19.2.4） |
| 地区售罄 | `PRECONDITION_FAILED` | `region_unavailable` | 是（换地区） | 这个地区暂时没货 |
| 操作太频繁 | `PRECONDITION_FAILED` | `rate_limited` | 是（稍后） | 操作太频繁，稍后再试 |
| 幂等键内容冲突 | `PRECONDITION_FAILED` | `idempotency_conflict` | 否 | 这次操作已作废，请重来一次 |
| 同键请求处理中 | `PRECONDITION_FAILED` | `idempotency_in_flight` | 是（1s 后重试） | 正在处理，稍等 |
| enrollment 无效 / 已用 / 过期 | `PRECONDITION_FAILED` | `enrollment_invalid` | 否 | 仅写安装日志，**不展示给用户** |
| enrollment 端口与控制面不一致 | `PRECONDITION_FAILED` | `enrollment_port_mismatch` | 否 | 同上；按安装失败处理并销毁 |

`message` 为可直接展示的中文；`details` 不含任何凭据。本期没有“需要付款 / 支付失败 / 额度超限”——假支付不会失败，也没有配额。

### 10.3 `events.md` → 2.13.0

| 事件 | 载荷 | 用途 |
|---|---|---|
| `my-server-changed` | `{ server_id, state, failure?, node_id? , at }` | 列表与详情实时更新；窗口隐藏时仍更新 |
| `my-server-order-changed` | `{ order_id, state, failure?, server_id?, at }` | 下单 / 开通进度 |

### 10.4 `data-model.md` → 6

新增表 `my_servers`（控面 id 的本地镜像，用于离线展示与节点关联）：

```sql
CREATE TABLE my_servers (
    id            TEXT PRIMARY KEY,          -- 控制面 server_id
    provider      TEXT NOT NULL DEFAULT 'digitalocean',  -- 服务端列，不下发客户端
    name          TEXT NOT NULL,
    region        TEXT NOT NULL,             -- 归一化地区 id
    plan          TEXT NOT NULL,             -- 归一化规格 id（如 s-1vcpu-1gb）
    state         TEXT NOT NULL,
    node_id       TEXT REFERENCES nodes (id) ON DELETE SET NULL,
    hourly_usd    REAL NOT NULL,
    monthly_usd   REAL NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    last_synced_at INTEGER NOT NULL
);
```

`nodes.source` 的 CHECK 增加 `'owned'`（云服务器代购）。这是**破坏性 schema 变更**：按项目惯例（无真实用户）整体重建，版本从 5 升到 6。**`data-model.md` 6 的 owner 是 `docs/design/remote-groups.md`**（节点 / 组 / 配置部分以那份为准）；本文在同一版里只贡献 `my_servers` 表与 `nodes.source = 'owned'`，不另起版本号。

不新增 `configs` 字段；配置与节点的关系按 `docs/design/remote-groups.md` 执行（配置绑 `group_id`、`config_nodes` 退役），`config_create` 使用 `groupId`。

### 10.5 `tools.md` → 3.12.0（只读，不给模型建机/销毁）

- 新增 `MyServers`（`ReadOnly`）：列出我的服务器与状态，供 AI 回答“我的服务器怎么样了”。
- **不新增购买 / 销毁 / 凭据工具**。建机、销毁只能由用户点界面；模型最多建议用户去「我的服务器」操作。节点密码永不进 AI 上下文。
- 若未来要开放写工具，`MyServerCreate` / `MyServerDestroy` 必须走确认卡（`kind = "my_server_create"` / `"my_server_destroy"`），风险等级 `Execute`。

### 10.6 `runtime.md` / `routing.md`

不变。服务器是节点来源，连接与分流逻辑不感知。

---

## 11. 分期

### M1：假支付 + 16 个可用地区 + 三档套餐，端到端跑通

- 控制面（Cloudflare）：Workers + D1 + Workflows + Durable Objects + Cron（M1 不用 Queues，§5.5）；设备令牌（静默注册，§19.2）、目录（三档：`s-1vcpu-512mb-10gb` $4/月、`s-1vcpu-1gb` $6/月（默认）、`s-1vcpu-2gb` $12/月；2026-11-14 实测 `GET /v2/regions` 返回 16 个可用地区、`GET /v2/sizes` 返回 43 种套餐）、订单、**假支付**、DigitalOcean 建机、cloud-init 装机、enrollment、凭据下发、销毁。
- 客户端：入口替换、列表 / 空态 / 四段进度 / 失败、详情、销毁、`用来建配置`。
- 节点入池、加入组与 `config_create(groupId)` 打通（组模型见 `remote-groups.md`）。
- 不含：真实支付、对账、退款、计费循环、多套餐、BYOK。

**完成标志**：在假支付下，新用户走完「其它节点 → 我的服务器 → 下单（假付款）→ 自动建机装机 → 出现节点 → 建配置 → 真实连上 → 销毁」，全流程不需要真实支付渠道。
**这同时是 M1 的必过验收**：N4 必须用测试环境 / 沙箱 key 真跑一次建机与装机，不接受 mock。

### M2：多套餐 / 真实支付

- 多套餐与价格实时同步；按地区推荐（可用延迟/离用户远近）。
- 真实支付接入：渠道选型、webhook 验签、对账、退款与欠费（§5.4、§14.2）。
- 多台并行创建（提高同时创建数）；更换地区（重建）。
- 预烘镜像或快照加速装机；安装成功率与耗时看板。
- 可能的第二供应商（同一抽象）。

---

## 12. 验收条目与文档影响

### 12.1 验收（`e2e-acceptance.md`）

**替换**：E1-14（供应商广场静态预览）、E1-15（返回）、E1-16（节点已删，供应商页落地后）、E1-35（其它节点不生成配置）——这四条随静态页一起退役，改写为「我的服务器」用例。**既有的粘贴 / 订阅 / 手动导入用例（E1 其余、E2 系列）不受影响，继续保留**；新增一条“第 2 问 `其它节点` 页里仍能进入三条导入路径并带回节点”。

**新增**（建议放在第 1 章或新开第 12 章，编号待定）：

| # | 用例 | 关键断言 |
|---|---|---|
| N1 | 入口与页面 | activity bar 三个 destination：`客户端` / `节点组` / `我的服务器`；点 `我的服务器` 后左栏是服务器列表、中间是选中详情（内容区无返回按钮）；从 `节点组 → 添加节点 → 从我的服务器添加` 跳进来时页头显示 `从「X」添加节点`、可用服务器行显示 `加入「X」`；无「供应商广场」字样 |
| N2 | 设备身份 | 可看价格；点 `创建服务器` **不弹任何认证**，Host 静默注册设备后直接下单；注册失败只给一句提示 + `重试`，不出现「登录」 |
| N3 | 假支付 | 点「确认下单」立即成功，没有收银台 / 渠道选择；订单进入 `paid` 并开始建机；界面明确说“体验流程，不会真实扣费” |
| N4 | **端到端全链路（M1 必过）** | 用测试环境 / 沙箱 key 真跑一次：假支付 → 建机 → 装机 → 四段进度 → `node_id` 出现 → 节点池 +1 / 进组 → `config_create(groupId)` → 真实连上 → 销毁；全程不接真实支付渠道 |
| N5 | 安装失败 | 安装中详情**没有** `用来建配置`，`销毁` 可用；出错后 `重新建一台` 出现、`销毁` 仍可用（实例未回收时）；行内三段式；实例已自动销毁；无配置产生；文案不提退款 |
| N6 | 价格展示 | 只读显示目录返回的时价与月估；页面没有余额 / 本月已花 / 台数上限；不出现“配额”“达到上限” |
| N7 | 销毁 | 二次确认；有配置引用时提醒；**创建中 `销毁` 可用**（确认文案为取消创建）；`destroying` / `destroyed` 不显示 `用来建配置`；**服务器行从列表移除，但节点记录保留在组里并标「服务器已销毁」，`current_node_id` 不变**；连接给明确错误；手动移除后回落到组内第一个；文案说“停止计费”仅作说明 |
| N8 | 实例消失 | 模拟 `server_gone`；配置不静默改；给重新购买/改用其它节点 |
| N9 | 提供商不可用 | 页头提示；没有产生服务器；已有节点不受影响 |
| N10 | 凭据安全 | 界面与日志无密码；`secrets.enc` 有 `node:<id>`；日志 grep 不到明文 |
| N11 | 既有导入不被吞掉 | `其它节点` 页底部可进入“我已有节点或订阅”；粘贴 / 订阅 / 手动三条路都能带回节点并完成新建；全程不要求买服务器 |
| N12 | 控制面不可达 | 断网或屏蔽控制面域名：应用照常启动；已买服务器与节点仍能连接、切换、建配置；“我的服务器”页只显示缓存 + 降级提示；购买/销毁明确报错且不做离线排队 |
| N13 | 无登录通道 | 详情页没有 SSH / 用户名 / 密码 / 公钥，也不显示 IP、端口、协议；`my_server_ssh_credentials` 不存在；日志与 `chat_messages` 无节点密码；`secrets.enc` 只有 `node:<id>`，销毁后取不到 |
| N14 | 切换不改连接 | 已连接时切到服务器并停留，计时器继续、托盘不变、无 stop/start 记录；切回仍是同一份状态 |
| N15 | 左栏随 destination 切换 | 客户端下左栏是配置列表；点「节点组」后同一列变成组列表（`免费` 段 → `我的组` 段）；点「我的服务器」后同一列变成服务器列表；三者的中间各自对应；点「客户端」换回配置列表 |
| N16 | **建机闭环真的通了** | 用测试 key 实跑：droplet 到 `active` 且 `ip` 取的是 public v4；防火墙已绑定且入站只有节点的 TCP+UDP 两条；enrollment 恰好成功一次（同 token 再用 409）；凭据验签通过、客户端连上、`node_id` 出现在服务器与节点池；销毁返回 204、列表不再出现、`GET /v2/droplets/{id}` 404 |
| N17 | **失败不留计费实例** | 注入防火墙创建失败与 enrollment 超时两种故障：每次都在 60 秒内销毁 droplet，订单 `failed`，按 tag `veyl:srv=*` 查询云账号为空；客户端不产生任何节点 |
| N18 | **幂等与设备令牌** | 同一 `Idempotency-Key` 重复下单只产生一台 droplet；同 key 不同 body 返回 `idempotency_conflict`；本地秘密丢失后重启应用不会自动重新注册，而是给出「身份已丢失」提示且旧服务器不可管理；令牌与密码不出现在日志、界面、`chat_messages` 与 AI 上下文 |

### 12.2 其它文档

| 文档 | 影响 |
|---|---|
| `docs/design/simplified-config-create.md` | §6.3 / §6.4 改为「我的服务器」；§21 标记「已由 `my-servers.md` 接续」；§11 入口表里「其它节点」改为跳转 |
| `docs/configs-and-nav.md` | 无需改配置模型；节点来源多一种 `owned`，节点面板可显示「我的服务器」标签（可选） |
| `.claude/skills/veyl-ui/SKILL.md` | activity bar 三个 destination（客户端 / 节点组 / 我的服务器）、各 destination 的左栏与中间、带目标组的添加入口；**没有 SSH / 密码入口**；禁词规则不变 |
| `docs/contracts/*` | §10 所述版本与字段；检查脚本 `check-contracts.mjs` 需补新命令/事件/工具的检查项 |
| `docs/testing/e2e-acceptance.md` | §12.1 |

---

## 13. DigitalOcean 事实核实（2026-11-14）

**供应商切换原因（2026-11-14）**：Vultr 的 API 网关拒绝 Cloudflare Worker 的出口 IP，实测返回 403 HTML，控制面无法调用；DigitalOcean 从 Worker 调用返回 401 JSON（无 token 时），说明网络可达。产品据此把供应商换成 DigitalOcean，Vultr 不再作为 M1 备选。

以下由产品用官方 API 与 docs.digitalocean.com 核实，**可以直接落实现**：

| # | 事实 | 影响 |
|---|---|---|
| 1 | API 基址 `https://api.digitalocean.com/v2`；鉴权 `Authorization: Bearer <token>` | 控制面客户端 |
| 2 | 目录：`GET /v2/regions`、`GET /v2/sizes`、`GET /v2/images?type=distribution` | 地区 / 规格 / 镜像来源 |
| 3 | 镜像：Ubuntu 24.04 slug **`ubuntu-24-04-x64`**（发行版镜像，`type=distribution`） | 安装脚本基线 |
| 4 | 建机：`POST /v2/droplets`，字段 `name` / `region` / `size` / `image` / `user_data` / `ssh_keys` / `tags` / `ipv6` / `monitoring` / `vpc_uuid` | 建机请求 |
| 5 | **`user_data` 是明文 cloud-init，不是 base64**（与 Vultr 不同） | §6.1 / §6.3 的脚本注入方式 |
| 6 | 销毁：`DELETE /v2/droplets/{id}`，不可逆 | 销毁语义 |
| 7 | 防火墙：`/v2/firewalls`（Cloud Firewalls，按 Droplet 关联；规则需先建） | 只放行节点端口 |
| 8 | 从 Cloudflare Worker 调 `/v2/regions`（无 token）返回 **401 JSON**；Vultr 同条件是 403 HTML | 网络可达性结论 |

**2026-11-14 用真实 token 在 dev 控制面实测（dev-only 诊断路由）**：

- token 需要的最小 scopes：`droplet:read`、`droplet:create`、`droplet:delete`、`firewall:create`、`tag:create`、`region:read`、`size:read`、`image:read`（`firewall:read` 已在 token 上，但不依赖它）。`firewall:update` 不申请：先建 droplet，再建防火墙时把 id 写进 `droplet_ids`（见下），就不需要它。
- `GET /v2/regions` 返回 **16** 个 `available: true` 地区：`nyc1 nyc2 nyc3 sgp1 lon1 ams3 fra1 tor1 sfo2 sfo3 blr1 syd1 atl1 ric1 mkc1 mem1`。
- `GET /v2/sizes` 返回 **43** 种；最便宜 5 档：`s-1vcpu-512mb-10gb` $4、`s-1vcpu-1gb` $6、`s-1vcpu-1gb-intel` $7、`s-1vcpu-1gb-35gb-intel` $8、`s-1vcpu-2gb` $12（均为月价，USD）。
- `GET /v2/images?type=distribution` 中 `ubuntu-24-04-x64` 的 **id = `252242095`**，名称 `24.04 (LTS) x64`。
- 权限边界实测（`/v1/debug/do-scopes`）：`regions` / `sizes` / `images` / `droplets` / `firewalls` 全部 **200 allowed**；`/account` 与 `/customers/my/balance` 都是 **403 denied**——token 恰好停在最小权限，没有多余的账户或计费权限。

**2026-11-14 官方文档核实（`docs.digitalocean.com/reference/api/reference/`）**：

| 事实 | 结论 |
|---|---|
| `POST /v2/droplets` 请求字段 | 必填 `name` / `region` / `size` / `image`；可选 `user_data`、`ssh_keys`、`backups`、`ipv6`、`monitoring`、`tags`、`vpc_uuid`、`subnet_uuid`、`volumes`、`snapshot_ids`、`count`、`with_droplet_agent`。**没有 `firewalls` / `firewall_ids` 字段**——建机时不能直接挂防火墙。成功返回 **202**，body 为 `{ "droplet": { ... } }`。 |
| `user_data` | 明文文本，上限 **64 KiB**（不是 16 KB），不要求 `#!` 开头。 |
| Droplet 状态枚举 | `new` / `active` / `off` / `archive`（**没有 `suspended`**）。 |
| IP 字段 | `networks.v4[]` / `networks.v6[]`，每项含 `ip_address`、`netmask`、`gateway`、`type`（`public` / `private`）。不是 `network`。 |
| 销毁 | `DELETE /v2/droplets/{id}` → **204**，scope `droplet:delete`。 |
| 建防火墙 | `POST /v2/firewalls`，scope `firewall:create`；`inbound_rules[].ports` 是字符串（`"80"`、`"8000-9000"`、`"0"` 表示全端口），`protocol` ∈ `tcp`/`udp`/`icmp`；`droplet_ids` 字段本身需要 `droplet:read`。 |
| 给已有防火墙追加机器 | `POST /v2/firewalls/{id}/droplets` 需要 **`firewall:update`**。 |
| **挂防火墙的确定顺序** | **先建 droplet，再 `POST /v2/firewalls` 时把 droplet id 写进 `droplet_ids`** —— 只需 `firewall:create`，不必申请 `firewall:update`。 |
| 打 tag | `tags` 字段需要 **`tag:create`** scope。**M1 要申请它**：`veyl:env` / `veyl:acct` / `veyl:srv` 是对账与运维兜底的唯一线索（§19.6.5），比省一个 scope 重要。按 tag 反查用 `GET /v2/droplets?tag_name=`（`droplet:read`）。 |
| 限流 | **5000 次/小时、250 次/分钟**；响应头 `ratelimit-limit` / `ratelimit-remaining` / `ratelimit-reset`；429 按 `Retry-After` 退避。10 秒轮询 × 并行单数远低于上限（§19.6.3）。 |

**仍待核（实现对应部分前先核实）**：

| # | 事项 | 为什么 |
|---|---|---|
| 1 | `s-1vcpu-512mb-10gb`（$4/月）是否够跑 cloud-init + sing-box；不够就固定用 `s-1vcpu-1gb`（$6/月） | 默认套餐与价格展示；价格已核实，内存占用待真机 |
| 2 | 销毁后多久从 `GET /v2/droplets` 消失（返回码已知是 204） | “已销毁”能不能说 |
| 3 | 计费粒度、关机是否仍收 IP / 存储费、账单周期 | “销毁即停”的说明口径（本期只写文档） |
| 4 | 云厂商回收 / 欠费 / 滥用的通知机制（邮件 / API） | 实例消失的发现路径 |
| 5 | **我们自己的控制面在中国大陆的可达性**：自定义域名是否稳定、`*.workers.dev` 的可达性、跨境延迟、是否需要备案 / 加速 | 付款成功但连不上控制面，整条链路仍直接死 |
| 6 | DO 是否返回 / 邮件发送 root 密码 | 仅记录；本设计不使用 root 密码（节点凭据由 cloud-init 生成） |

补充：从中国大陆到各地区的实际延迟仍待实测，只影响默认地区排序，不阻塞实现。

**已决定、不再列为待核**：

- 云厂商代付转售条款：**不考虑该条款限制**，按“我们的主账号建节点、我们收钱”推进；风险见 §9.4。
- 云厂商对大陆用户的注册/支付限制：**与本案无关**——用户不自己去 DigitalOcean 注册，也不向 DO 付钱。
- 不需要 root 密码 / 不需要登录通道：节点凭据由 cloud-init 生成并回传，**不需要 SSH**（§17）。DO 即使返回或邮寄 root 密码，也不进入任何产品路径、不写日志、不展示。
- 加密方式固定 **`aes-256-gcm`**（2026-11-14 产品拍板）：现有脚本已用它，客户端与服务端都支持；密码为 16 位字母数字（§6.3），不再保留 method 待核项。

---

## 14. 已决定与待决（M2）

### 14.1 已决定（产品 2026-11-13）

| # | 决定 |
|---|---|
| 1 | **托管在 Cloudflare**：M1 = Workers + D1 + Workflows + Durable Objects + Cron；Queues 留到 M2（§5.5、§19.3）。 |
| 2 | **本期只做假支付**：假收银台 UI + `FakePaymentProvider`（checkout 立即成功），不接真实渠道、不做对账、不做回调验签、不做退款。 |
| 3 | **加价 30% 只写文档**：目录价直接展示，代码不算。 |
| 4 | **一人多台不限制**：删除余额 / 配额 / 上限；只保留创建频率的滥用防护。 |
| 5 | **不做退款**：失败一律自动销毁；真实支付上线前必须补退款策略（§5.4）。 |
| 6 | **欠费只写规则**：本期不实现计费循环；真实支付后停服务并调 API 销毁实例。 |
| 7 | **身份**：M1 用**设备令牌**，无登录 UI（§19.2）；邮箱验证码复用 TweetPilot 的 Workers 发码 / 校验 / 限流逻辑，登录上线后把设备账户并入邮箱账户（§4.1、§19.2.5）。 |
| 8 | **BYOK 删除**：一律用我们的 DigitalOcean 账号。 |
| 9 | **地区不限制**：目录通过 DigitalOcean API 拉取；默认规格暂定 `s-1vcpu-1gb`（$6/月），更便宜的 `s-1vcpu-512mb-10gb`（$4/月）覆盖地区待核（§13）。 |
| 10 | **凭据跟随服务器生命周期**：实例销毁即删除，不做定时清理。 |
| 11 | 云厂商代付转售条款不再作为约束；用主账号建节点、我们收钱。 |

### 14.2 待决（只剩真实支付）

| # | 问题 | 推荐（一句话） | 什么时候需要 |
|---|---|---|---|
| 1 | 真实支付渠道 / 接法 | **先接 Paddle 或 Stripe 中能在 Cloudflare 侧完成托管收银的一个，渠道实现藏在 `PaymentProvider` 后面；后续可加微信/支付宝。** | M2 接入真实支付前；本期不影响开发 |

接入真实支付时还要一并定：退款与欠费策略、发票与税务、回调验签与对账。这些都在 §5.4 列为“上线前必须补齐”。

---

## 15. 依据

- `veyl-ui`：§2.1 一屏一个主按钮；§2.2 每个事实一个住处；§3.1 颜色 token；§3.2 字号阶梯；§3.3 4px 网格；§6 禁词与例外。
- `ui-ux-pro-max`（本次检索）：
  - *Progressive Disclosure*（High）：长流程分四段进度，不一次性倾倒技术细节。
  - *Error Messages / Error Recovery*（High）：错误必须带下一步（重新建一台 / 换地区 / 稍后再试）。
  - *Loading Indicators*（High）：安装过程有稳定反馈与 `aria-busy`，布局不跳。
  - *Destructive Actions*（Critical）：销毁必须二次确认，说明影响（配置会少节点、计费停止）。
  - *Trust & Security*（High）：支付与凭据页面说明数据去向；不显示密码。
- `provider-integration.md`：自建节点可直接产出 sing-box 配置，无订阅转换损失。
- 产品决定（2026-11-13，供应商于 2026-11-14 改为 DigitalOcean）：入口、代付转售、默认规格 `s-1vcpu-1gb`（$6/月，覆盖地区待核）、开源无后端、托管与收费在 Cloudflare；**本期只做假支付**、加价 30% 只写文档、一人多台不限、不退款、不实现计费、无 BYOK、地区不限制；云厂商条款不作为约束。身份原定邮箱验证码，2026-11-14 改为 **M1 设备令牌**（§19.2），登录 UI 后置。

---

## 16. 非目标与为后续留的口子（转售）

> 产品方向（2026-11-13，用户原话）：「用户创建的配置可以卖给别人，但是这是下一步，现在我们先满足用户付费后创建节点的需求。」

### 16.1 非目标

- M1 / M2 **不做**节点转售、共享、市场、分成、他人付费与订阅分发。
- 用户买到的服务器与节点**只给自己用**；实例与账户 1:1，节点凭据只进买家的设备。
- 本期所有界面、接口与文案都不出现「出售 / 分享 / 市场 / 分成」。

### 16.2 唯一会让将来推倒重来的 M1 决定

**把「节点凭据」与「购买者身份」绑死。**

具体表现（都算绑死，M1 都不要做）：

- 用账户密钥派生节点密码（如 `password = HMAC(account_secret, server_id)`），换人就得换密码、重装；
- 把凭据做成一次性、设备绑定或带购买者 id 的令牌；
- 在 `nodes` 表上写 `owner_id`，让「能不能用这个节点」由节点行上的单一归属决定；
- 让客户端把「我的服务器列表里有这台」当作使用节点的前提。

将来 1:N 时，同一个实例要让**多个人的设备**同时拿到可用凭据；上面任一种写法都会迫使凭据重发、节点重建或数据迁移——这正是“推倒重来”。

### 16.3 成本为零的留白（只做这些，不加字段、不加工作量）

| # | 留白 | 现在怎么做（零成本） | 为什么足够 |
|---|---|---|---|
| 1 | 归属不落在节点上 | `nodes` **不新增 owner / account 列**；归属只存在于控制面的订单与 `my_servers`（本地镜像） | 将来加「授权表（server_id, holder_account_id）」即可，不动已有节点 |
| 2 | 凭据是「实例的属性」，不是「人的属性」 | 密码随机生成、按 `server_id` 存；不派生自账户、不绑设备、默认不过期 | 将来同一实例可以再发一份凭据给另一个人，无需重装 |
| 3 | 节点可用性不依赖「我的服务器」行 | 节点一旦写入节点池并加入组，配置绑定该组即可用；`my_servers.node_id` 只是展示关联 | 将来收到的共享节点没有本地服务器行，也能直接用 |
| 4 | 订单只记录事实，不承担授权 | 订单保留 `buyer_account_id` + `server_id`，只用于对账；权限判断另走将来新增的授权表 | 订单追加写、不改语义，迁移成本为零 |
| 5 | 不做一次性订阅链接 | `my_server_credentials` 返回一次性响应，但**不生成**带账户/设备签名的下载链接 | 将来真要分发，新增端点即可，旧路径不动 |
| 6 | 销毁权限先只给所有者 | 现在只允许买家销毁；将来转让是新增操作 | 不把“所有者”编码进实例或节点名 |

**代价为零的定义**：不新增表、不新增字段、不新增接口、不改变现有交互；只是不把身份写进凭据与节点。

### 16.4 风险提示（不展开）

转售会引入平台责任（内容、滥用、合规）与“他人付款如何退款”的路径，需在将来单独立项评估；本期不为其做任何实现准备，只保留 §16.3 的留白。

---

## 17. 服务端凭据由控制面管理（用户无 SSH）

### 17.1 结论

已核实：DigitalOcean 的 Droplet 对象提供公网 IP（字段名待真实响应确认，§13）；**端口由控制面选定并下发**，加密方式固定、节点密码由 cloud-init 生成后回传控制面，云厂商不知道也不需要知道。因此：

- **用户不登录服务器。** 界面没有 SSH、没有用户名、密码、公钥，也没有「复制登录信息」。
- 节点凭据只在「控制面 ↔ 客户端」之间流转，**不进 AI 上下文、不写日志、不回显**。
- 自动装机、建配置、连接、销毁都不依赖 SSH；节点凭据与服务器运维彻底分开。

### 17.2 凭据生命周期

```
cloud-init 启动
  └─ 写入下发端口 / 生成节点密码
       └─ POST /v1/enroll/{token}（HTTPS；一次性；45 分钟过期）
            └─ 控制面：校验 token 与端口 → AES-256-GCM 加密保存（node:<server_id>）→ 标 installing→healthy
                 └─ 客户端：GET /v1/servers/{id}/credentials → Ed25519 验签
                      └─ 写 secrets.enc（node:<node_id>）→ 内存丢弃
```

- **只在服务端生成**，客户端不参与生成。
- enrollment token **与 `server_id` 和订单绑定**；控制面只接受该 `server_id` 的回传，且**原子单次消费**——并发的第二个上报必须失败，不能两次都写成功；token 不下发给客户端，也不写进安装日志。
- **重试有上限**：回传由 `veyl-enroll.service` 重试，退避 `5s / 15s / 45s / 2m / 5m`，硬截止 **20 分钟**（§19.7.3）；控制面在 **10 分钟内**没有收到成功上报 → 订单转 `error` → 销毁实例。不存在「无限重试」或「在原机重跑」。
- **控制面不可达**：实例侧按上面的上限重试，超时即失败；控制面侧由 Workflow 超时分支负责销毁，不依赖实例再次回调。
- 控制面保存到服务器销毁为止，销毁即删除；不做定时清理，也不在服务器仍存在时轮换——重建会生成全新凭据。
- 客户端取凭据包必须验签（§2.2），验签失败不落库。
- `nodes` 表没有密码列；`password_ref` 固定为 `node:<node_id>`。明文密码不落库、不写日志、不回显。

### 17.3 界面

- 详情事实行只留：**地区 / 状态 / 节点是否就绪 / 费用（只读，§8.1）**。
  - **状态** = 生命周期：`安装中` / `可用` / `出错` / `销毁中`。
  - **节点是否就绪** = `node_id` 是否已写入节点池：`已就绪` / `未就绪`；未就绪时 `用来建配置` 不出现（§7.4）。
  - **不显示** IP、端口、协议、加密方式、用户名、创建时间——用户不需要，也没有登录通道可用。
  - **费用保留**：它是唯一的计费透明入口（§8.1），与登录无关。
- 操作只有：`用来建配置` / `销毁` / `重新建一台`（状态门控见 §7.4）。
- 没有 `SSH 登录` 折叠行，没有密码显示 / 复制，没有公钥输入。
- 文案不出现 SSH、命令行、root、镜像、API（§7.3）。

### 17.4 恢复路径

- **安装失败 / 服务端被改坏 / 节点不可用** → 健康检查失败 → 提示 → **销毁重建**（新 IP、新凭据），不修原机。判定时限见 §6.5。
- 不做远程修复、不重跑安装脚本、不重置密码；没有登录通道，也没有「修一台」这条路径。
- **销毁后节点保留**：记录标「服务器已销毁」，不自动移出组、不改 `current_node_id`；连接时给明确错误，用户可在组详情手动移除（`remote-groups.md` §4.2 第 7 条）。

### 17.5 我们自己的运维通道（取舍）

- **不保留常驻 SSH 密钥**，不在镜像里注入运维公钥，不建后门账号。这是「用户无 SSH」承诺的一部分：只关掉用户的入口、自己留一把钥匙，等于没有承诺。
- 排障优先用：enrollment 回传的脱敏安装日志 + 控制面健康检查 + 客户端日志 + DigitalOcean Droplet 状态。
- 极端情况（系统不启动、网络不通、agent 已死）走**云厂商控制台**（VNC / 串口）做 break-glass：仅限平台故障与滥用处置，逐次授权、留审计，不用于查看用户流量内容（代理流量端到端加密，平台也看不到明文）。
- **取舍**：部分故障因此无法远程取证，只能销毁重建。接受——实例是一次性节点，状态都在控制面，重建成本低。
- 对外表述要准确：**「产品没有用户登录服务器的通道；平台不保留常驻密钥。」** 不要说「我们永远无法访问任何机器」——云控制台本身是平台侧能力。

### 17.6 与既有设计的关系

| 既有设计 | 是否改变 |
|---|---|
| 安装失败 = 销毁重建 | **不变**；不依赖登录通道 |
| 节点凭据 | 只存 `node:<node_id>`；**不再有 `ssh:` 键** |
| 服务器销毁 | 删除节点凭据即可（没有 SSH 凭据要删） |
| 控制面编排 | 不调用 SSH，也不等 SSH 状态 |
| 用户把服务端改坏 | 节点可能不可用；只提示并建议 `重新建一台`，不尝试远程修复 |
| 22 端口 | **不开放**；实例内关闭 sshd（§6.3） |

### 17.7 风险与处理

| 风险 | 做 | 不做 |
|---|---|---|
| 控制面被完全拿下 | 承认这是**接受的残余风险**：KMS 与控制面同信任域，拿下控制面 = 可解密保存的全部节点凭据（进而看到代理流量）。只做降低概率与检测：最小权限、审计、凭据读取限流与留痕、客户端验签 | 不声称 KMS 能兜住；不做周期轮换（重建即新凭据）；不把节点密码下发前端 / AI |
| 节点凭据被暴力猜测 | 只监听节点端口；16 位字母数字随机密码（约 95 bit 熵），与现有安装脚本一致；防火墙只放行节点端口 | 不暴露 SSH；不做端口敲门 |
| 服务器被用于滥用（扫描 / 代理黑产） | 依赖云厂商滥用通知；按账户封禁流程处理，可销毁实例；创建频率限流（§8.2） | 不做流量内容审查；不装监控代理 |
| 平台运维越权 | break-glass 走云控制台、逐次授权、留审计；只看状态不读流量明文 | 不保留常驻密钥；不记录用户连接内容 |

**接受的残余风险（写在这里，不藏在「已缓解」里）**：控制面与 KMS 在同一信任域，控制面被完全拿下时，攻击者可以解密全部节点凭据并看到经代理的流量。加密只保护「数据库泄露但密钥未泄露」这一种情形，不保护「控制面整体失守」。本设计不为此增加节点凭据周期轮换——轮换需要实例配合，且不能阻止已发生的解密；正确的应对是控制面最小权限、审计、异常读取告警，以及出事后批量销毁重建。

**缓解措施（降低概率与影响，不改变上面的残余风险结论）**：

- **KMS 信封加密**：节点凭据用数据密钥加密，数据密钥由 KMS 主密钥封装；库泄露但主密钥未泄露时不可读。
- **最小权限**：只有凭据下发服务能解封；控制面其它 Worker、日志、分析任务都没有解密权限。
- **审计日志**：每次凭据读取记录 `account_id` 哈希、`server_id`、`request_id`、时间与来源；异常频率告警。
- **读取限流**：按账户与服务器限制凭据读取次数，重复读取不重复解密。
- **客户端验签**：客户端只接受控制面私钥签名的凭据包，验签失败不落库。
- **范围最小化**：节点只跑代理，不承载用户业务数据；控制面不保存流量内容。

这些措施都不阻止「控制面整体失守 = 全部凭据可被解密」——那一条是 M1 明确接受的残余风险。

### 17.8 契约与数据

- 保留 `my_server_credentials`（取节点凭据，客户端验签后落库）。
- **删除** `my_server_ssh_credentials` 与 `/v1/servers/{id}/ssh-credentials`。
- `secrets.enc` 只有 `node:<node_id>`；不新增 `ssh:` 键、不新增表、不新增 `nodes` 字段。
- 验收：N10（界面 / 日志 / AI 上下文无密码，`secrets.enc` 有 `node:<id>`）；N13 退役。

### 17.9 待核

- ~~创建实例后是否返回 root 密码~~：不需要，也不使用；DO 即使返回或邮件发送，也不进入任何产品路径。本条关闭。

---

## 18. 后续需求记录（待排期）

### 18.1 我的服务器测延迟

**需求（产品 2026-11-14）**：用户能测「客户端 → 自己服务器上的 sing-box」的网络延迟，用来判断这台服务器能不能用，体验与客户端现有的节点测速一致。

**约束**：

- **复用现有 `node_probe`**：服务器装好后节点已在节点池；已连接且属于当前配置时走 Clash 真实延迟，否则对 `server:port` 做 TCP 握手测延迟。不新造测速通道。
- 入口放在服务器详情（`测试延迟`），列表行显示最近一次结果（`42 ms` / `连不上` / `未测试`）。
- 节点从 `installing → healthy` 后自动测一次，用户可手动重测；结果带时间戳与 TTL。
- 文案不把「TCP 通」等同于「代理可用」；端口不通写「服务器没有响应」，延迟高只提示、不判死。
- 安装中 / 安装失败的服务器没有节点，不显示测速入口。
- 契约优先零新增（复用 `node_probe`）；确有需要再评估按 server 测的最小新增面。

**状态**：已记录，未设计、未实现。

---

## 19. M1 建机闭环

> 日期：2026-11-14
> 前置：`GET /v1/catalog` 已上线（`cloudflare/control-plane`）；本批把**下单、建机、装机、列表、销毁**接上。
> 一句话：**一条设备令牌认人，一条 Workflow 建机，一份 cloud-init 装机，任何一步失败都销毁机器。**

### 19.1 范围与完成定义

| 进本批 | 不进本批 |
|---|---|
| 设备令牌（静默注册、刷新、丢失后果） | 邮箱登录 UI、验证码发信、账户合并（§19.2.5 只写规则） |
| 控制面：D1 五张表 + 幂等键 + Workflow + 每 server 一个 DO + Cron 巡检 | Queues、真实支付、对账、退款、计费循环 |
| DigitalOcean 建 droplet + 建防火墙 + 状态轮询 | 多供应商、换地区重建、预烘镜像 |
| cloud-init 装机、enrollment 单次回传与重试 | 用户自定义镜像、SSH、任何登录通道 |
| 凭据签名下发、客户端验签落库、销毁即删除 | 凭据轮换、凭据导出 |
| 列表 / 详情 / 销毁 / 重建命令与事件 | 自动把新节点加入某个组（**单独标为下一批**，见 §19.11） |

**完成定义**：一台真机在 25 分钟内跑完 `creating → healthy`，客户端拿到验签通过的凭据并**真实连上**；用户点销毁后 60 秒内云账号里查不到这台 droplet，列表也不再出现。判据见 §19.10。

### 19.2 身份：设备令牌（M1 无登录 UI）

#### 19.2.1 首次注册

1. **Host 生成长期秘密** `device_secret`：32 字节 CSPRNG → base64url（43 字符）。它只存在于本机 `secrets.enc`，**从不发给前端 JS、从不写 SQLite、从不进日志与 AI 上下文**。
2. `device_id`：随机 16 字节 → `dev_<base64url>`。
3. 第一次需要身份时（打开「我的服务器」destination 读列表、或点「确认下单」）静默请求：

```http
POST /v1/auth/device
{ "device_id": "dev_...", "secret_hash": "b64u(sha256(device_secret))",
  "platform": "macos", "app_version": "0.9.0" }
```

```json
{ "account_id": "acct_...", "device_id": "dev_...",
  "access_token": "eyJ...", "access_expires_at": "2026-11-14T08:15:00Z",
  "refresh_token": "b64u-32B", "refresh_expires_at": "2026-12-14T08:00:00Z" }
```

- 只发**哈希**：请求被日志截获也拿不到可用的秘密。
- 以 `device_id` 天然幂等：同 id 同哈希 → 重新签发令牌（这就是刷新令牌过期后的恢复路径）；同 id 不同哈希 → `PRECONDITION_FAILED` / `device_mismatch`，不覆盖。
- 按 `CF-Connecting-IP` 限频 10 次/小时（沿用 §4.1 的常数口径）。

#### 19.2.2 令牌与刷新

| 项 | 值 | 说明 |
|---|---|---|
| access token | Ed25519 签名 JWT，**15 分钟** | 无状态校验；claims `{sub: account_id, did: device_id, iat, exp, jti}`；私钥在 Worker Secret |
| refresh token | 32 字节不透明串，**30 天滑动** | D1 只存 `sha256`；每次刷新**轮换**并作废旧值 |
| 重放检测 | 旧 refresh token 再次使用 → **整族作废**（`refresh_family`） | 令牌被复制走是唯一能观察到的信号，宁可让用户重注册 |
| 刷新失败 | access 过期 → 自动刷新一次；刷新 401 → 回落 §19.2.4 | 并发刷新用 Host 侧单飞锁，避免互相作废 |

#### 19.2.3 存哪

**放在现有的 `secrets.enc`，不碰系统钥匙串**（2026-11-14 与既有实现对齐）：这个仓库的本地凭据存储刻意不用 Keychain / Credential Manager——macOS 每次读写都可能弹授权框，debug 每次重建还会重新问。`secrets.enc` 是 0600 的机器绑定密文文件，密钥由「机器标识 + 固定盐」经 PBKDF2 派生，换机或抹盘后解不开，语义上已经等价于「秘密丢失」。

- 条目 `device:secret` 存 `{ device_id, device_secret, account_id }`；`device:tokens` 存 `{ access, refresh, exp }`。
- 明文只在内存里出现，不写 SQLite、不进日志、不进 AI 上下文。
- SQLite 只镜像 `account_id`（用于「是不是同一台设备」的判断），不含任何可用于认证的材料。
- 文件损坏或被篡改时按 `secrets.enc` 既有规则处理（`__verify` 能解、单条解不开 → 删该条），并走 §19.2.4 的身份丢失路径。

#### 19.2.4 丢失后的后果（必须写进界面）

| 情形 | 后果 | 界面行为 |
|---|---|---|
| refresh 过期（30 天没用） | 用 `device_secret` 重新注册即续（§19.2.1） | 无感 |
| 本地秘密丢失（换机、抹盘、`secrets.enc` 损坏） | **该设备账户不可恢复**：旧服务器仍在你名下的云账号里**继续计费**，但客户端无法列出、无法销毁 | 若本地 `my_servers` 仍有记录：**不自动重新注册**，显示一条提示「这台设备的身份已丢失。已买的服务器仍在计费，这里无法管理。」+ 一个显式的 `重新注册设备` 按钮（点了才建新账户；旧记录保留为本地只读，操作按钮禁用） |
| 账户被封禁 | 全部写操作 403 `account_blocked` | 只读本地缓存 |

- **运维兜底**：每台 droplet 都打了 `veyl:srv=<server_id>` / `veyl:acct=<hash8>` tag，运维可按 tag 在云控制台直接销毁（§19.6.5 对账任务同一个入口）。M1 没有工单系统，文案只写「联系支持」。
- 这是 M1 已知的、可接受的洞：登录 UI 后置的代价。**M2 邮箱登录上线就补上自助恢复。**

#### 19.2.5 并入邮箱账户（M2，仅写规则）

- 邮箱验证通过时，请求体可带 `device_id` + `device_secret` 作为「这是同一个人」的证明；控制面校验通过后合并。
- 合并 = 把 `devices` / `orders` / `servers` 的 `account_id` 改为邮箱账户；旧账户记 `merged_into` 并停用；`audit_log` 留一条。
- **不改 droplet 上的 tag**（tag 是审计线索，不是身份）；不改 `server_id` / `node_id`，客户端无感。
- 两边都有服务器时取并集，不做去重以外的处理；`created_at` 取较早者。

### 19.3 控制面骨架（Workers + D1 + Workflows + DO）

沿用 §5.5，M1 只落四个部件，理由已写在 §5.5 末尾：

| 部件 | M1 用法 | 为什么是它 |
|---|---|---|
| **Workers** | 全部 `/v1/*`，无状态 | 请求短、可水平扩 |
| **D1** | 五张表 + 幂等键 + 审计 | 订单状态的唯一事实源；事务足够小 |
| **Workflows** | 每订单一个实例跑开通流水线 | 25 分钟里有三段「等待」，Queue 装不下、DO alarm 要自己造重试 |
| **Durable Object** | 每 `server_id` 一个（`idFromName(server_id)`） | enrollment 回调、销毁、重建、Workflow 写入并发时的**唯一写者** |
| **Cron Triggers** | 每 5 分钟对账 + 兜底销毁 | 「不能留下计费实例」的最后一道闸 |

- **不用 Queues**（M1）：唯一异步副作用是销毁，失败分支同步调用 + Cron 兜底即可。
- 模块落点（实现建议，不强制目录名）：`src/auth`（设备令牌）、`src/orders`、`src/servers`、`src/providers/digitalocean.ts`、`src/workflows/provision.ts`、`src/do/server.ts`、`src/cron/reconcile.ts`、`src/lib/{idempotency,crypto,json}.ts`。
- **dev / prod 必须用两个 DigitalOcean 项目**（各自的 token）：dev 建的机器也是真计费，但对账与 tag 归属只会碰自己环境，绝不会误杀生产。
- Worker Secrets（不写进 `wrangler.jsonc`）：`DO_API_TOKEN`、`TOKEN_SIGNING_KEY`（Ed25519 私钥）、`CREDENTIAL_ENC_KEY`（AES-256-GCM 密钥）、`ENROLL_BASE_URL`（本环境的控制面地址，写进 cloud-init）。

**DigitalOcean token 最小 scopes**：`droplet:read`、`droplet:create`、`droplet:delete`、`firewall:create`、`tag:create`、`region:read`、`size:read`、`image:read`。
**不要 `firewall:update`**——防火墙规则在建时一次给全（§19.6.2）。遗留的未绑定 firewall 不计费，M1 不清理（清理需要 `firewall:read` + `firewall:delete`，M2 再加）。

### 19.4 最小表结构（D1）

```sql
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,          -- acct_<b64u-16B>
  kind        TEXT NOT NULL,             -- 'device' | 'email'
  email       TEXT,                      -- 邮箱账户才有
  status      TEXT NOT NULL DEFAULT 'active',   -- active | blocked
  merged_into TEXT REFERENCES accounts(id),
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX accounts_email ON accounts(email) WHERE email IS NOT NULL;

CREATE TABLE devices (
  id                 TEXT PRIMARY KEY,   -- dev_<b64u-16B>
  account_id         TEXT NOT NULL REFERENCES accounts(id),
  secret_hash        TEXT NOT NULL,      -- b64u(sha256(device_secret))
  platform           TEXT NOT NULL,      -- macos | windows
  app_version        TEXT NOT NULL,
  refresh_family     TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  revoked_at         INTEGER
);

-- 刷新令牌历史：只存哈希。必须留历史，否则无法区分「被重放的旧令牌」与「随便编的令牌」，
-- §19.2.2 的「重放整族作废」就没有可靠的判定依据。
CREATE TABLE refresh_tokens (
  hash       TEXT PRIMARY KEY,           -- b64u(sha256(refresh_token))
  device_id  TEXT NOT NULL REFERENCES devices(id),
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,                    -- 已轮换出去
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX refresh_tokens_device ON refresh_tokens(device_id);

CREATE TABLE orders (
  id              TEXT PRIMARY KEY,      -- ord_<b64u-16B>
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  region          TEXT NOT NULL,
  plan            TEXT NOT NULL,
  amount_usd      REAL NOT NULL,         -- 展示快照，不扣款
  state           TEXT NOT NULL,         -- pending_payment|paid|provisioning|ready|cancelled|failed
  idempotency_key TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  paid_at         INTEGER,
  expires_at      INTEGER,               -- 未支付订单 10 分钟过期（§8.2）
  server_id       TEXT,
  failure_code    TEXT,
  failure_stage   TEXT
);
CREATE UNIQUE INDEX orders_idem ON orders(account_id, idempotency_key);

CREATE TABLE servers (
  id                     TEXT PRIMARY KEY,   -- srv_<b64u-16B>
  account_id             TEXT NOT NULL REFERENCES accounts(id),
  order_id               TEXT NOT NULL REFERENCES orders(id),
  provider               TEXT NOT NULL DEFAULT 'digitalocean',
  provider_id            TEXT,               -- droplet id（数字，按 TEXT 存）
  region                 TEXT NOT NULL,
  plan                   TEXT NOT NULL,
  state                  TEXT NOT NULL,
  node_port              INTEGER NOT NULL,   -- 建机前由控制面选定（§19.6.1）
  ip                     TEXT,
  node_id                TEXT,               -- nd_<b64u-12B>，enrollment 成功时确定
  enrollment_hash        TEXT,               -- 一次性 token 的哈希，用后置 NULL
  enrollment_used_at     INTEGER,
  enrollment_expires_at  INTEGER,
  firewall_id            TEXT,
  singbox_version        TEXT,
  agent_version          TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  destroyed_at           INTEGER
);
CREATE UNIQUE INDEX servers_enroll ON servers(enrollment_hash);

CREATE TABLE credentials (
  server_id    TEXT PRIMARY KEY REFERENCES servers(id),
  key_version  INTEGER NOT NULL,   -- 密钥轮换用；本期恒为 1
  iv           TEXT NOT NULL,
  ciphertext   TEXT NOT NULL,      -- AES-256-GCM(node password + host + port + method)
  created_at   INTEGER NOT NULL,
  destroyed_at INTEGER
);

CREATE TABLE idempotency_keys (
  account_id   TEXT NOT NULL,
  endpoint     TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,      -- sha256(规范化请求体)
  status       INTEGER NOT NULL,   -- 0 = 处理中
  response     TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, endpoint, key)
);

CREATE TABLE audit_log (              -- 只追加
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  account_id TEXT,
  server_id  TEXT,
  action     TEXT NOT NULL,          -- order.create | checkout | enroll.ok | destroy | …
  detail     TEXT NOT NULL           -- 脱敏，无凭据
);

-- 固定窗口限流：设备注册按 IP 10 次/小时（§19.2.1）。
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
```

- D1 默认不强制外键，上面写的是**意图**，实现里用应用层校验。
- **凭据列只存密文**；`audit_log` 与任何日志都不含密码、token、完整 URL 查询串。

### 19.5 端点、字段与幂等键语义

鉴权：除 `/v1/health`、`/v1/catalog`、`/v1/auth/*`、`/v1/enroll/{token}` 外都要 `Authorization: Bearer <access_token>`。

| 端点 | 请求 | 成功响应 | 幂等 |
|---|---|---|---|
| `POST /v1/auth/device` | §19.2.1 | 令牌三元组 | 由 `device_id` 天然幂等 |
| `POST /v1/auth/refresh` | `{ refresh_token }` | 新三元组（旧 refresh 立即失效） | 否；重放按族作废 |
| `GET /v1/catalog` | — | 目录（已上线） | 公开、可缓存 300s |
| `POST /v1/orders` | `{ region, plan }` | `{ order_id, state:"pending_payment", amount_usd, expires_at }` | **必须** `Idempotency-Key` |
| `GET /v1/orders/{id}` | — | 订单 | — |
| `POST /v1/orders/{id}/checkout` | `{ channel:"fake" }` | `{ state:"paid", server_id }`，同时启动 Workflow | **必须** |
| `POST /v1/orders/{id}/cancel` | — | `{ state:"cancelled" }`；已支付则先销毁 | **必须** |
| `GET /v1/servers` | — | `{ servers: MyServer[] }`（按 `created_at` 倒序） | — |
| `GET /v1/servers/{id}` | — | `MyServer`（含 `install_log_tail_redacted`，≤ 20 行） | — |
| `POST /v1/servers/{id}/rebuild` | `{ confirm:true }` | `{ new_server_id, state:"creating" }` | **必须** |
| `POST /v1/servers/{id}/destroy` | `{ confirm:true, reason? }` | **204** | **必须** |
| `POST /v1/servers/{id}/credentials` | — | `{ payload, signature, key_id }`（payload 5 分钟有效） | **不做幂等**：无副作用，重复调用只是重新签发 |
| `POST /v1/enroll/{token}` | §19.7 | `200 { ok:true, node_id }` / `200 { ok:false }` | token 自身即幂等键：**原子单次消费** |

> `destroy` 的 HTTP 响应是 **204**（无 body）；`my_server_destroy` 命令把它映射成 `state: "destroying"` 的 `MyServer` 返回，客户端不用为 204 特判。

**幂等键语义**

1. 作用域 **`account_id` + endpoint + key**；客户端每个用户动作生成一个 UUIDv4，重试复用，新动作必须新 key。
2. 首次请求先插 `status = 0`（处理中）占位；并发重复请求看到占位 → `409 PRECONDITION_FAILED` / `idempotency_in_flight` / `retryable: true`，客户端 1 秒后重试（§10.2）。
3. 完成后写入 `status` 与 `response`；之后同 key 同 `request_hash` → **原样回放**（同状态码、同响应体，含 204）。
4. 同 key 不同 `request_hash` → `idempotency_conflict`，不执行。
5. 保留 24 小时，Cron 清理。**不做**「跨账号复用 key」，不做请求排队。

### 19.6 建机与回滚

#### 19.6.1 两条参数来源不同（都是被约束逼出来的）

| 参数 | 谁生成 | 为什么 |
|---|---|---|
| **端口** | **控制面**，建机前 | 防火墙必须在拿到 droplet id 后立刻带着端口创建，而 `firewall:update` 不在权限里（§19.6.2）。端口写进 D1、写进 cloud-init、写进防火墙——三处同一个值，不可能漂移 |
| **密码** | **服务器**，装好后 | 密码不该经过 `user_data`（droplet 元数据可读、控制面会先存一份明文）。只有 enrollment 回传后才加密落库 |

端口取值：`10000–60000` 内 CSPRNG，避开 `10000`、`12345`、`20000` 这类常被扫描或占用的值；同一账户内不复用仍在用的端口（按 `servers` 表查一次，最多 3 次重试）。

#### 19.6.2 顺序：先 droplet，再 firewall，一次给全

```http
POST /v2/droplets
{ "name": "veyl-srv_7f3a", "region": "sgp1", "size": "s-1vcpu-1gb",
  "image": "ubuntu-24-04-x64", "ipv6": false, "monitoring": false,
  "tags": ["veyl", "veyl:env=prod", "veyl:acct=ab12cd34", "veyl:srv=srv_7f3a"],
  "user_data": "<cloud-init 明文，≤ 64 KiB，目标 ≤ 16 KiB>" }
```

```http
POST /v2/firewalls
{ "name": "veyl-srv_7f3a", "droplet_ids": [123456789],
  "inbound_rules": [
    { "protocol": "tcp", "ports": "20343", "sources": { "addresses": ["0.0.0.0/0"] } },
    { "protocol": "udp", "ports": "20343", "sources": { "addresses": ["0.0.0.0/0"] } } ],
  "outbound_rules": [
    { "protocol": "tcp", "ports": "all", "destinations": { "addresses": ["0.0.0.0/0"] } },
    { "protocol": "udp", "ports": "all", "destinations": { "addresses": ["0.0.0.0/0"] } } ] }
```

- **只有两条入站规则**（节点的 TCP + UDP），**不开放 22**；出站全放行（脚本要拉包、enrollment 要回传）。
- 为什么不能等 enrollment 拿到端口再建：那段时间机器是「全部端口开放」的；而且事后加规则就要 `firewall:update`。**所以端口由控制面先定。**
- 防火墙创建失败 → 立刻销毁 droplet（它此刻已存在且计费）。
- 建机响应是 202 + droplet 对象，`id` 立刻可拿但 `status = new`、IP 可能还没有；**不要在 `new` 阶段取 IP**。

#### 19.6.3 状态轮询与 IP

- 轮询 `GET /v2/droplets/{id}`，间隔 10 秒，总上限 10 分钟。
- **只认四种状态**：`new` → 继续等；`active` → 成功；`off` → 失败（不救）；`archive` → 失败（不救）。其它值按瞬时异常，连续 3 次未知即失败。
- IP：`networks.v4[]` 中 `type == "public"` 的 `ip_address`；取不到（仍为空）视为尚未就绪，继续等，不猜 `networks.v4[0]`。
- 429 / 5xx：按 `Retry-After` 退避，建机 API 整体最多重试 1 次（§5.3），仍失败即结束订单。

#### 19.6.4 失败路径：任何一步都必须销毁

```
create_droplet 失败（无 id）           → 订单 failed，无实例
create_firewall 失败                   → destroy(droplet) → 订单 failed
wait_boot 超时 / off / archive         → destroy(droplet) → 订单 failed
wait_enrollment 超时（10 分钟）        → destroy(droplet) → 订单 failed
enroll 报 failed（脚本侧）             → destroy(droplet) → 订单 failed
verify 端口不通                        → destroy(droplet) → 订单 failed
用户取消（已 paid）                    → destroy(droplet) → 订单 cancelled
```

- `DELETE /v2/droplets/{id}` → **204**；404 视为已不存在（成功）。删除是异步的，所以销毁后仍以 `provider_id` 做一次 404 复核（Cron 负责）。
- 销毁失败（5xx / 超时）：同步重试 3 次（2s / 10s / 30s），仍失败则 `servers.state = destroying` 留待 Cron，**每 5 分钟重试并告警**。
- **状态先落库再动作**：先把 `destroying` 写进 D1（并写 `destroy_requested_at`），再调 API。进程/Workflow 中途死掉，Cron 也能接着销毁。
- 订单终态只有 `failed` / `cancelled` / `ready`；**不允许 `paid` 或 `provisioning` 停留超过 25 分钟**。

#### 19.6.5 对账 Cron（每 5 分钟）

1. `orders` 停在 `paid` / `provisioning` 超过 25 分钟 → `failed` + 销毁。
2. `servers` 停在 `creating/booting/installing/verifying` 超过 30 分钟 → `error` + 销毁。
3. `servers` 停在 `destroying` 超过 10 分钟 → 再发一次 `DELETE`；超过 1 小时 → 告警。
4. **按 tag 反查**：`GET /v2/droplets?tag_name=veyl:env=<env>` 与本环境 `servers.provider_id` 求差集；有 droplet 但 D1 没有 → **孤儿，直接销毁并告警**（这是「Workflow 崩了也不留计费实例」的兜底）。
5. 清理 24 小时前的幂等键、过期订单。
6. 对账结果写 `audit_log`；单次最多处理 20 台，避免一次跑爆。

### 19.7 装机与 enrollment

#### 19.7.1 cloud-init 做什么（顺序即优先级）

```yaml
#cloud-config
write_files:
  - path: /etc/veyl/bootstrap.json     # 0600, root
    content: |
      {"server_id":"srv_...","port":20343,
       "enroll_url":"https://<control-plane>/v1/enroll/<token>",
       "singbox_url":"https://<r2>/sing-box-1.14.4-linux-amd64","singbox_sha256":"…",
       "agent_url":"https://<r2>/veyl-agent-0.1.0-linux-amd64","agent_sha256":"…"}
runcmd:
  - /usr/local/bin/veyl-bootstrap
```

1. **第一步就关登录通道**：停用并禁用 `ssh`，删除 `authorized_keys`、root 密码置空。
2. 装最小依赖（`curl`、`ca-certificates`、`jq`）。
3. 拉 sing-box `1.14.4` 与 `veyl-agent`，**校验 sha256**，不通过即失败（不重试同一份，直接上报失败）。
4. 生成密码（`[A-Za-z0-9]{16}`），写 `/usr/local/etc/sing-box/config.json`（`0600`，端口用下发的值，加密 `aes-256-gcm`），建 `sbg` 用户，起 `sing-box` 服务。
5. 自检：`sing-box check`、`systemctl is-active`、`ss -lnt/-lnu` 能看到该端口、出站探测。
6. 安装 `veyl-agent` + timer（§6.6，M1 只心跳）。
7. 由 `veyl-enroll.service` 回传（下一步）；成功即 `systemctl disable veyl-enroll`。
8. 失败：写 `/var/log/veyl-install.log`（脱敏），尽力上报 `{result:"failed"}`，退出非 0。

**`user_data` 预算**：硬上限 64 KiB（§13 待核已关闭）；本脚本目标 **≤ 16 KiB**——只内联 URL 与 sha256，**绝不内联二进制或大段脚本**。超限就是设计错误，不是调大上限。

#### 19.7.2 回传协议

```http
POST /v1/enroll/<token>
{ "server_id": "srv_...", "result": "ok",
  "node": { "port": 20343, "method": "aes-256-gcm", "password": "…" },
  "singbox_version": "1.14.4", "agent_version": "0.1.0",
  "egress_ip": "203.0.113.10", "installed_at": "2026-11-14T08:03:00Z" }
```

- token：32 字节 base64url，D1 只存 `sha256`，**45 分钟过期**，与 `server_id` 绑定；**body 里的 `server_id` 只做一致性校验，身份以 token 为准**。
- 原子消费：`UPDATE servers SET enrollment_used_at=?, enrollment_hash=NULL WHERE enrollment_hash=? AND enrollment_used_at IS NULL RETURNING *`；0 行 → `PRECONDITION_FAILED` / `enrollment_invalid`。
- **端口必须等于控制面下发的值**，否则 `enrollment_port_mismatch`，按安装失败处理（防火墙开的不是这个端口，机器不可用，也没有修的手段）。
- 成功：加密存凭据 → `verifying` → 触发校验步骤 → 返回 `{ ok:true, node_id }`。
- 失败上报（`result:"failed"`）：同样消费 token，写 `failure`，**立即销毁**，不 waiting 到超时。

#### 19.7.3 回传失败与重试

| 项 | 值 |
|---|---|
| 谁重试 | `veyl-enroll.service`（`Type=oneshot` + `Restart=on-failure`） |
| 退避 | 5s → 15s → 45s → 2m → 5m，之后每 5 分钟一次 |
| 硬截止 | `TimeoutStartSec=1200`（20 分钟）；到点退出，控制面侧 10 分钟未收到也已失败 |
| 不重试 | 4xx（`enrollment_invalid` / `enrollment_port_mismatch`）：直接按失败处理并退出 |
| 断网恢复 | 服务重启后继续重试；token 未过期就能补上 |
| 一次性 | 成功或失败上报任一 200 后，token 作废，服务自禁用 |

- 客户端看不到 enrolment 的细节，只看 `installing` / `verifying` / `error`；失败文案按 §5.3（「服务端没装好 / 这台已自动销毁 / 点「重新建一台」」）。

### 19.8 凭据下发

```json
{ "payload": "{\"server_id\":\"srv_...\",\"node_id\":\"nd_...\",\"host\":\"203.0.113.10\",\"port\":20343,\"method\":\"aes-256-gcm\",\"password\":\"…\",\"issued_at\":\"…\",\"expires_at\":\"…\"}",
  "signature": "base64(ed25519(payload 原始字节))", "key_id": "cp-2026-11" }
```

- **签名字节就是 `payload` 字符串本身**，不要先解析再重序列化（键序会变）。
- 客户端验签（公钥内置）+ 校验 `key_id` 已知、`expires_at` 未过、`server_id` / `node_id` 与请求的一致；任何一项不过 → 视为响应不可信，**不落库**、报 `UPSTREAM_ERROR`。
- 落库：`secrets.enc` 的 `node:<node_id>`；本地 `nodes` 行 `id = node_id`、`source = 'owned'`；**密码不进 SQLite 明文字段、不进日志、不进 `chat_messages`、不进 AI 上下文**。
- 凭据的「有效期」只是**响应有效期（5 分钟）**，底层密码在服务器存活期间不变；重新取一次即可（重装、迁移、本地 `secrets.enc` 损坏）。
- **销毁即销毁凭据**：DELETE 成功后把 `credentials.ciphertext` 置空、写 `destroyed_at`；客户端收到 `my-server-changed(state=destroyed)` 后删本地 `node:<node_id>`（节点记录保留并标「服务器已销毁」，§6.5）。
- `my_server_get` / 列表 / 事件**永不返回密码**；`ip` 与 `port` 只在服务器详情内部使用，界面不展示 IP/端口/协议（N13）。

### 19.9 客户端契约增量

#### 19.9.1 契约文件与版本

| 文件 | 版本 | 增量 |
|---|---|---|
| `commands.md` | **2.23.0** | 8 条：`my_server_list` / `get` / `create` / `checkout` / `cancel_order` / `rebuild` / `destroy` / `credentials`；类型 `MyServer` / `MyServerOrder`（§10.1）。`my_server_catalog` 已在 2.22.0 |
| `events.md` | **2.13.0** | `my-server-changed`、`my-server-order-changed`（§10.3） |
| `data-model.md` | **6** | `my_servers` 表 + `nodes.source = 'owned'`（§10.4，与节点组批共用一版） |
| `tools.md` | **3.12.0** | `MyServers`（只读，§10.5） |
| `runtime.md` / `routing.md` | 不变 | 服务器只是节点来源 |

> 版本顺序同 §10.1：若节点组批先合入，本批 commands 顺延 `3.1.0`、events `2.14.0`、tools `4.1.0`，**集合不变**。

#### 19.9.2 前端 / 后端各改哪几处

| 侧 | 改动 |
|---|---|
| **Rust Host** | ① 设备身份：生成 / 读写 `secrets.enc` / 注册 / 刷新（单飞 + 轮换）；② 8 个端点的 HTTP 客户端 + `Idempotency-Key` + 错误映射到现有信封（§10.2）；③ 注册 8 条命令；④ 凭据 Ed25519 验签 + 写 `secrets.enc` + 建 `nodes` 行（`source='owned'`）；⑤ 订阅事件 → 更新 `my_servers` 缓存并向 UI 发事件；⑥ 秘密丢失检测（§19.2.4） |
| **React UI** | ① `src/myservers/` 的 service 换成真实实现（保留现有接口，mock 留作测试）；② 向导：下单 → checkout → 四段进度（`my-server-changed` 驱动，事件不可用时 2s→5s→10s 轮询兜底）；③ 列表 / 详情：状态、`重新建一台`、`销毁`、`用来建配置`；④ 身份丢失提示 + 显式 `重新注册设备`；⑤ 失败态文案按 §5.3 / §10.2 |
| **控制面** | 全部新写（`/v1/auth`、`/v1/orders`、`/v1/servers`、`/v1/enroll`、`workflows/provision`、`do/server`、`cron/reconcile`），目录接口不动 |

### 19.10 验收：什么算这一步真的通了

| # | 断言（可判定） |
|---|---|
| A1 | `POST /v2/droplets` 返回 202；10 分钟内 `status = active`；`ip` 来自 `networks.v4[]` 的 `type=public`，与 enrollment 上报的 `egress_ip` 一致 |
| A2 | 防火墙已绑定该 droplet，入站**恰好两条**（节点端口 TCP + UDP），无 22；`droplet_ids` 含该 id |
| A3 | enrollment 恰好成功一次：首个请求 200；同 token 第二次 409 `enrollment_invalid`；`servers.node_id`、`credentials` 行同时出现 |
| A4 | `POST /servers/{id}/credentials` 的 payload 能用内置公钥验签；客户端写入 `secrets.enc` 后 `node_probe` 或真实连接成功（TCP 或 Clash 延迟二者其一） |
| A5 | 销毁返回 **204**；`GET /v1/servers/{id}` = `destroyed`；列表不含；`GET /v2/droplets/{id}` = 404；`GET /v2/droplets?tag_name=veyl:srv=<id>` 为空 |
| A6 | 故障注入（防火墙创建失败、enrollment 超时各一次）：60 秒内 droplet 被销毁，订单 `failed`，客户端零节点，tag 查询为空 |
| A7 | 幂等：同 key 两次 `POST /orders` 只出现一个 `order_id`、一台 droplet；同 key 改 body → `idempotency_conflict`；并发同 key → 一个 `idempotency_in_flight` |
| A8 | 令牌安全：`rg` 全部日志与 `chat_messages` 无 access/refresh token、无节点密码；前端 JS 侧拿不到令牌；撤销设备后旧 access 15 分钟内失效、refresh 立即失效 |

### 19.11 非目标

| 不做 | 说明 |
|---|---|
| 真实支付、退款、对账、发票 | 假支付 `checkout` 同步成功；真实渠道 M2（§3.1） |
| 多供应商 | `Provider` 抽象先留着（§2.4），M1 只有 DigitalOcean |
| 重建换地区 / 换套餐 | `rebuild` 固定同地区同套餐（§5.3） |
| **自动加入节点组** | **下一批**：本批只产出 `node_id` 与凭据，节点如何进组由节点组模型决定（`remote-groups.md`） |
| 邮箱登录 UI、验证码发信、账户合并 | §19.2.5 只写规则 |
| 配额 / 计费循环 / 欠费停服 | 只有创建频率的滥用防护（§8.2） |
| IPv6、备份、快照、改规格、开机 / 关机 | 不属于「节点」这件事 |

### 19.12 待核（实现前必须核实，不凭印象写）

| # | 待核 | 影响 |
|---|---|---|
| 1 | `POST /v2/firewalls` 省略 `outbound_rules` 是否等于放行全部出站 | 决定要不要显式写出站规则 |
| 2 | droplet 删除后其 firewall 是否自动解绑、是否占账户配额 | 决定 M2 是否要加 `firewall:delete` 清理 |
| 3 | Workflows 单次运行时长与步骤数上限是否覆盖 25 分钟 | 不覆盖就得改成 DO alarm 编排 |
| 4 | `GET /v2/droplets/{id}` 在 `new` 阶段 `networks.v4` 是否已含公网地址 | 影响「不猜 v4[0]」的等待逻辑 |
| 5 | Workers `connect()` 对 `10000–60000` 端口是否有禁止端口 | 若有，端口池要避开 |
| 6 | D1 单库写入速率上限（enrollment 高峰） | 决定是否要给 enrollment 加 KV 旁路 |

