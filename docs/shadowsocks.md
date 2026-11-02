# Shadowsocks 支持（N-03）

> 版本：v1.1
> 日期：2026-11-02
> 契约：1.0.10
> 状态：已实施

---

## 0. 结论

| 项 | 结论 |
|---|---|
| 协议 | `NodeProtocol` 增加 `shadowsocks`，wire 值为 `"shadowsocks"` |
| method | P1 **只支持 `aes-256-gcm`**，其余返回 `UNSUPPORTED`，**不静默降级** |
| 凭据 | `password` 与 uuid 同级，属凭据：列表接口不返回、不进 SQLite 明文、不进日志、不进模型上下文 |
| 导入通道 | **两条入口、一套实现**：窗口级拖放 + 设置页「选择文件」按钮，都调 `import_seed_file({ path })`（§5.2） |
| UI | 设置页加一个「选择文件」按钮；窗口接受拖放。profile 列表的协议标签可选 |

---

## 1. 现状

配置生成已经支持两种协议（`config/builder.rs` 的 `ProtocolConfig`）：

```rust
pub enum ProtocolConfig {
    VlessReality { ... },
    Hysteria2 { ... },
}
```

凭据模型在 `catalog/types.rs`：

```rust
pub enum Credentials {
    VlessReality { uuid: String },
    Hysteria2 { password: String },
}
```

`profiles` 表只存**非凭据**的 `config_json`，连接时通过 `catalog.node_detail(node_id)` 重新取凭据。

这条链路对「目录服务里的节点」成立，但**种子文件导入的节点没有 node_id 可查** —— 这是本轮要解决的新问题（§5.4）。

---

## 2. 协议与凭据

### 2.1 枚举

```rust
pub enum NodeProtocol { VlessReality, Hysteria2, Shadowsocks }
```

wire 值：`"vless_reality"` | `"hysteria2"` | `"shadowsocks"`。

### 2.2 凭据

```rust
pub enum Credentials {
    VlessReality { uuid: String },
    Hysteria2 { password: String },
    Shadowsocks { password: String, method: String },
}
```

`method` 放在凭据里而不是节点公开字段里 —— 它不是秘密，但和密码是同一类配置，放一起少一次匹配。

### 2.3 节点公开字段

列表接口返回的摘要**不含** `method` / `password`；详情接口返回 `server`、`server_port`、`method`，`password` 同 uuid 一样**只在详情接口出现且只在内存流转**。

---

## 3. method 白名单

**P1 只接受 `aes-256-gcm`。**

```rust
const SUPPORTED_METHODS: &[&str] = &["aes-256-gcm"];
```

其它 method（`chacha20-ietf-poly1305`、`aes-128-gcm`、`rc4-md5`…）：

- 导入阶段拒绝：`UNSUPPORTED`，`details = { "method": "<原值>", "supported": ["aes-256-gcm"] }`
- **不降级、不猜测、不尝试**。降级会在用户不知情的情况下改变加密强度，比直接失败更糟。

为什么只支持一种：sing-box 的 shadowsocks 出站支持更多 method，但我们**没有测试覆盖**。声明支持一个没测过的加密方式，等于把「能不能连上」交给运气。

---

## 4. 配置生成

`config/builder.rs` 的 `ProtocolConfig` 加一个分支：

```rust
ProtocolConfig::Shadowsocks { server, server_port, method, password }
```

渲染为：

```json
{
  "type": "shadowsocks",
  "tag": "proxy",
  "server": "<server>",
  "server_port": 8388,
  "method": "aes-256-gcm",
  "password": "<password>"
}
```

不做 UDP over TCP、不加插件、不加 multiplex —— P1 只求「能连上」。

生成后照常走 `sing-box check`，check 失败返回 `RUNTIME_CONFIG_INVALID` 并带上 stderr。

---

## 5. 导入通道（本轮的关键决策）

### 5.1 为什么要单独定

现在只有 `ProfileImport(node_id)` 走目录服务。种子文件里的节点不在目录服务里，没有 `node_id` 可查。为了做真实连通性验证，需要一个把「本地文件 → profile + 凭据」落地的通道。

### 5.2 通道选择：两条入口，一套实现

> **2026-11-02 最终决定（当日修订一次）**。此前试过五条路，被否决的理由都记在下面 —— 它们不是「没想到」，是试过之后有意不用。
>
> 最初只定了拖放；同一天用户明确要求还要能从目录里选文件。**这不是第二条导入管线**：两条入口共用同一个前端 handler，最终都调 `import_seed_file({ path })`。

| 通道 | 结论 | 说明 |
|---|---|---|
| **窗口级拖放** | ✅ P1 | 用户把 `.json` 拖进窗口；`getCurrentWebview().onDragDropEvent()` 拿到路径 |
| **设置页「选择文件」按钮** | ✅ P1 | `@tauri-apps/plugin-dialog` 的 `open()` 返回绝对路径；用户取消返回 `null` |
| `VEYL_SEED_NODES` 环境变量 | ❌ | 发布版里留一条隐式入口；启动行为随环境变量变化 |
| `veyl-runtime-selftest import-seeds` | ⚠️ 仅 CI | 开发专用二进制，内测用户手上没有 |
| 一整个「导入 / 节点管理」页面 | ❌ | 要多做一个页面；用户拿到的只是「安装包 + 一个 JSON」 |
| 固定路径 `<data_dir>/seeds.json` 自动导入 | ❌ | `~/Library` 默认隐藏，用户手动放文件不可行；有 UI 后是第二套隐形入口，增加攻击面又没有用户价值 |

**为什么两条入口不算两条管线：**

```
拖放事件 ──────┐
               ├──► 同一个 handler ──► invoke("import_seed_file", { path })
「选择文件」按钮 ┘
```

校验、解析、落库、错误文案**只在 Host 侧实现一次**（`seed_import.rs`）。前端两条入口只负责「拿到一个路径」，拿到之后走完全相同的代码。加第二条入口的成本因此仅限于一个按钮和一个事件监听，不产生分叉。

**文件选择器只授 `open` 权限**：`capabilities/default.json` 里只出现 `dialog:allow-open`，不出现 `save` / `ask` / `confirm` / `message`。我们唯一的用途是「选一个已有文件」，多授一项就多一处可被前端代码触发的系统交互。

**取消即无操作**：`open()` 返回 `null` 时前端直接返回，不调 Host、不改任何状态、不显示提示。

自动化（CI / 测试）继续用 `veyl-runtime-selftest import-seeds`，**它与两条 UI 入口共用同一套 `seed_import` 解析**。

### 5.3 导入流程：拿到路径 → `import_seed_file`

```
用户拖放 或 点「选择文件」
  → 前端拿到绝对路径（拖放：onDragDropEvent；按钮：plugin-dialog open()）
  → 路径为 null（用户取消）→ 直接返回，不调用 Host
  → invoke("import_seed_file", { path })
  → Host 校验：扩展名 .json / 大小 ≤ 1MB / 存在且可读
  → seed_import::parse → plan → apply
  → 返回 { imported, skipped[], profiles[] }
```

**引入 `@tauri-apps/plugin-dialog`（只开 `open`）** —— Tauri 2 内置的拖放事件覆盖不了「点按钮从目录选文件」。这是用户明确要求后加的依赖，代价是一个插件与一条 capability；换来的是不熟悉拖放的用户也能导入。

关键约束：

- 这条命令 `source = "ui"`，**不经过 Agent**，密码不会进入模型上下文。
- 前端只在内存里持有路径，**不把文件内容读进 WebView** —— 内容由 Host 直接读。
- 解析逻辑复用 `src-tauri/src/seed_import.rs`，**不写第二份**。

### 5.3.1 种子文件不是节点列表，是 sing-box 配置包

实际结构（脱敏）：

```json
{
  "provider_id": "...", "name": "...", "tags": [...], "package_hash": "...",
  "config": {
    "log": {...}, "dns": {...}, "inbounds": [...],
    "outbounds": [
      { "type": "shadowsocks", "tag": "...", "server": "...",
        "server_port": 8388, "method": "aes-256-gcm", "password": "..." }
    ],
    "route": {...}
  }
}
```

**两个 shadowsocks 节点在 `config.outbounds[]` 里**，不是独立的节点数组。

### 5.3.2 适配规则

| 输入 | 处理 |
|---|---|
| `config.outbounds[]` 中 `type == "shadowsocks"` | 映射为一个 profile |
| `config.outbounds[]` 中其它 `type` | **跳过并计数**，摘要里写明原因（例：`"direct" 不是 shadowsocks`） |
| method 不在白名单 | **跳过并计数**，写明 `unsupported method: <值>` |
| `password` 缺失或为空 | **跳过并计数**，写明 `missing password` |
| `log` / `dns` / `inbounds` / `route` | **全部忽略** |
| 顶层元数据（`provider_id` / `name` / `tags` / `package_hash`） | 只用于生成 profile 名称与幂等 id |

**为什么忽略 `config` 里除 outbounds 以外的一切：**

那个包里自带 `log`、`dns`、`inbounds`、`route`，是一份能直接跑的完整配置。如果照搬，我们测的就是**别人的配置**，而我们这轮要验的恰恰是 `config/builder.rs` 生成的对不对。

导入只取「节点是什么」（server / port / method / password），配置一律由我们重新生成。

### 5.3.3 profile 的命名与幂等 id

- **名称**：`<package 顶层 name> · <outbound tag>`，缺字段时退化为 `<server>:<server_port>`。
- **id**：`seed-` + `sha256(provider_id || name || server || server_port || tag)` 的前 16 位十六进制。

用哈希而不是递增序号，是为了**同一个包导入两次得到同一个 id** —— 重跑时更新而不是复制一份。

### 5.3.4 结果展示与错误文案

导入结果**直接作为命令返回值交给 UI 展示**，不写 `settings`、不发事件 —— 用户刚点了拖拽，就在同一个交互里得到反馈。

```ts
{ imported: number, skipped: [{ name, reason }],
  profiles: [{ id, name, server, server_port, method }] }
```

| 场景 | 展示 |
|---|---|
| 全部成功 | 已导入 N 个节点（列出名称与 `server:port`） |
| 部分跳过 | 已导入 N 个节点，跳过 M 个（逐条列出原因） |
| 失败 | 按错误码给不同文案，见下表 |

| 错误码 | `details.reason` | 文案 |
|---|---|---|
| `INVALID_ARGUMENT` | `not_json_file` | 请选择 .json 文件 |
| `INVALID_ARGUMENT` | `file_too_large` | 文件过大，最大 1 MB |
| `INVALID_ARGUMENT` | `file_unreadable` | 无法读取这个文件 |
| `INVALID_ARGUMENT` | `invalid_json` | 这个文件不是有效的节点文件 |
| `INVALID_ARGUMENT` | `no_importable_nodes` | 文件里没有支持的节点（已跳过 M 个） |
| `UNSUPPORTED` | — | 不支持加密方式 `<method>`，目前只支持 aes-256-gcm |
| `SECRET_STORE` | — | 凭据保存失败，请重试 |

**任何情况下都不显示 password，也不回显文件内容。**

### 5.3.5 行为细节

1. 校验扩展名、大小、可读性（先校验再读，避免把大文件读进内存）
2. `parse`：文本 → `SeedPackage`（非法 JSON → `invalid_json`）
3. `plan`：筛 `config.outbounds[]` 中 `type == "shadowsocks"`、method 在白名单、password 非空；其余进 `skipped[]` 并附原因
4. `apply`：写 `profiles` 一行（`config_json` 不含密码）+ 写 `secrets.enc` 的 `node:<profile_id>`
5. 幂等：同 id 已存在则更新（名称、地址、method、密码），不新增行
6. 日志记导入数量、节点 id、跳过原因、`pw_fp`（**永不记 password**）

### 5.3.6 明确否掉：让 AI 把文件写到合适位置

有过一个提议：既然用户找不到 `~/Library`，不如让 AI 把文件写到正确目录。

**不做，理由是架构性的：**

凭据链路是 `文件 → 适配器 → secrets.enc → builder → sing-box 配置`，**整条链没有面向外部的出口**。给模型文件写入权，等于在这条链上开一个由「模型判断」做访问控制的出口 —— 而审批机制已经被移除，那个判断没有任何东西兜底。

对比一下现有的边界：

| 能力 | 谁触发 | 访问控制 |
|---|---|---|
| 拖拽导入 | 用户在窗口里主动拖入 | 人的动作 |
| 写文件工具 | 模型的判断 | 无（审批已移除） |

前者出错是用户点错，后者出错是模型想错 —— 而模型的错误无法被用户事前拦截。

### 5.4 连接时凭据从哪来

种子导入的 profile **没有 `node_id`**，`catalog.node_detail()` 用不了。

规则：`connect` 取凭据时按顺序尝试

1. `profile.node_id` 存在 → 走目录服务取详情（现有路径）
2. 否则 → 读 `secrets.enc` 的 `node:<profile_id>`
3. 都没有 → `PRECONDITION_FAILED`，`details.reason = "credentials_missing"`

这条规则对现有节点无影响（它们都有 `node_id`），只给种子导入的节点兜底。

#### 5.4.1 凭据存放位置**按来源区分**（写验收断言时必读）

| profile 来源 | `node_id` | `secrets.enc` 的 `node:<profile_id>` | 凭据实际来自 |
|---|---|---|---|
| 目录服务导入 | 有 | **不存在**（设计如此，不是漏存） | 目录服务的 node detail |
| 种子文件导入 | **无** | 存在 | `secrets.enc` |

**这决定了负向验证的做法不同：**

- 对**种子导入**的 profile：删掉 `node:<profile_id>` → 连接必须失败（`PRECONDITION_FAILED` / `credentials_missing`），恢复后能连上
- 对**目录导入**的 profile：`node:` 条目本来就不存在，**不能**用它做「删了应失败」的断言 —— 那会测出假失败

目录导入的 profile 要验证凭据来源，只能靠正向观察（连接成功即说明目录服务可用），或者断掉目录服务看是否报错。

> 同理，「凭据必须写进 `secrets.enc`」这条断言**只适用于种子导入**。目录导入的 profile 不该在 `secrets.enc` 里留副本 —— 留了反而是重复存储，一份泄漏面变成两份。

### 5.5 两种来源共用一个内部模型（切换数据源 ≠ 重写）

P1 的节点来自本地 seed 文件，计费上线后换成「账号令牌 + 服务端目录」。**这两条路必须汇到同一个内部模型**，否则切换时不是换数据源，是重写。

汇合点已经存在，就是 `config/builder.rs` 的 `ProtocolConfig` 加 `catalog/types.rs` 的 `Credentials`：

```
catalog 的 NodeDescriptor ──┐
                            ├──► ProtocolConfig + Credentials ──► builder ──► sing-box JSON
seed 文件的 sing-box outbound ┘
```

两条线各自是**不同的 wire 格式**（一个是目录服务 API，一个是 sing-box 配置片段），但都映射到同一组内部类型。要保证的是：

| 不变式 | 含义 |
|---|---|
| 字段集合一致 | 协议、server、port、凭据、TLS 参数，两边都能表达 |
| 白名单一致 | method 白名单在适配层统一校验，不因来源不同而放宽 |
| 凭据边界一致 | 无论从哪来，凭据只进 `secrets.enc`，`config_json` 永不含密码 |

**将来换成目录服务时要做的事，只有「删掉 seed 适配器」**，不需要动 builder、不需要动存储、不需要动 `connect` 的凭据回退逻辑（届时新 profile 都有 `node_id`，自然走目录路径）。

### 5.6 内测分发风险（用户已知情）

第一批内测用户逐个拿到 seed 文件，**文件里的密码在所有内测用户之间是共享的**。这不是缺陷，是当前分发方式决定的：

| 风险 | 说明 |
|---|---|
| **一人泄漏，全体暴露** | 所有人用的是同一个 shadowsocks 密码，任何一个用户泄露文件，其他人全部受影响 |
| **无法按用户吊销** | 服务端只有一套凭据，做不到「吊销某个用户的访问」—— 只能整体换密码，然后重新发放 |
| **无法定位泄漏源** | 密码相同，日志里看不出是谁用的 |

缓解措施（都已写进流程）：

1. **外部登记表**：用户侧自己维护一份「哪台机器/哪个人拿到哪份文件」的记录，**不放进仓库、不随应用分发**。出事时能圈定范围。
2. **不改造成多凭据**：给每个内测用户发不同 UUID 需要服务端支持，属于计费版的能力，不在 P1。
3. **明确预期**：导入页面的说明文字应写明「这份文件含共享凭据，请勿外传」。

> **计费上线时必须重新设计这块**：届时凭据随账号下发、可按用户吊销，共享密码这条风险自然消失。当前的共享是过渡状态，不是最终形态。

### 5.7 产品化的本地导入

P1 已有最小形态：窗口拖放 + 设置页「选择文件」按钮，共用 `import_seed_file`。

P2 要做的是**节点管理**（列出 / 重命名 / 删除本地导入项），不是再开第三条导入路径 —— 任何新入口都必须汇到同一个 handler。

---

## 6. 安全红线

`seeds.json` 里是**真实可用的密码**。

### 6.1 凭据允许出现在哪里（白名单，其余一律视为泄漏）

| 位置 | 允许 | 要求 |
|---|---|---|
| 用户的 `seeds.json` | ✅ | 留在用户目录，Veyl 只读不搬 |
| `<data_dir>/secrets.enc` | ✅ | `0600` |
| sing-box 的 active 配置文件 | ✅ | **必须 `0600`**，由 builder 写出，连接结束或切换后清理 |
| `profiles.config_json` | ❌ | 只存非凭据部分 |
| `veyl.db` 任何表 | ❌ | — |
| 日志（应用 / 运行时 / selftest） | ❌ | — |
| 错误信息、`args_preview`、工具返回 | ❌ | — |
| 模型上下文 | ❌ | `ProfileList` / `CatalogSearch` 不返回 `password` |
| 仓库、报告、聊天记录 | ❌ | 示例一律用占位符 |

> **不要把「密码出现在 sing-box 配置里」当成泄漏** —— 那是 sing-box 运行所必需的输入。要验的是这个文件是 `0600`、不被日志引用、且切换后清理。

### 6.2 泄漏检查的做法

用 `pw_fp` 指纹 grep，范围按 §6.1 分成两组：

```bash
FP=3f9a2c1e

# 不该出现的地方（应全部为空）
grep -rn "$FP" build/logs/ "$HOME/Library/Application Support/Veyl/logs/" 2>/dev/null
sqlite3 "$HOME/Library/Application Support/Veyl/veyl.db" \
  "SELECT id FROM profiles WHERE config_json LIKE '%$FP%';"

# 允许出现的地方（应命中，且权限必须是 0600）
ls -l "$HOME/Library/Application Support/Veyl/config/"   # active 配置
ls -l "$HOME/Library/Application Support/Veyl/secrets.enc"
```

### 6.3 其余规则

| 规则 | 说明 |
|---|---|
| 不复制进仓库 | 包括不以「示例文件」名义复制 |
| 不进日志 | selftest 摘要只打印数量、节点 id、`pw_fp`，**永不打印 password** |
| 不进报告 | Clerk 的验收报告里不出现任何真实密码，用 `<redacted>` |
| 不进模型上下文 | `ProfileList` / `CatalogSearch` 的返回不含 `password` |
| `.gitignore` | `*seeds*.json` 兜底，不替代上面各条 |
