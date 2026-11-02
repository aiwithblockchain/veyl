# Shadowsocks 支持（N-03）

> 版本：v1.0
> 日期：2026-11-02
> 契约：1.0.9
> 状态：待实施（Bob）

---

## 0. 结论

| 项 | 结论 |
|---|---|
| 协议 | `NodeProtocol` 增加 `shadowsocks`，wire 值为 `"shadowsocks"` |
| method | P1 **只支持 `aes-256-gcm`**，其余返回 `UNSUPPORTED`，**不静默降级** |
| 凭据 | `password` 与 uuid 同级，属凭据：列表接口不返回、不进 SQLite 明文、不进日志、不进模型上下文 |
| 导入通道 | **不用启动时读环境变量的方案**，改用开发专用的 selftest 子命令（§5） |
| UI | P1 不改。profile 列表的协议标签可选 |

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

### 5.2 我反对 PM 提的 `VEYL_SEED_NODES` 环境变量方案

原提议是「Host 启动时读取环境变量指定的文件，把节点导入为 profile」。

问题：

- 这段代码会**编进发布版本**。发布版里存在一条「设置某个环境变量就能注入任意节点」的路径，哪怕本意只是测试夹具，它仍然是产品里的一个额外入口。
- 启动时读文件 + 写凭据，是一个有副作用、无提示、不可见的动作。用户改了个环境变量，应用行为就变了。
- 校验它有没有生效，只能靠「重启看结果」，调试成本高。

### 5.3 采用：`veyl-runtime-selftest import-seeds`

`veyl-runtime-selftest` 已经是**开发专用二进制**（`[[bin]]` 独立构建，不进安装包）。把导入放进去：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest -- \
  import-seeds --file <种子文件路径> --data-dir "<应用数据目录>"
```

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

### 5.3.4 输出摘要

```
import-seeds: 读取 <file>
  导入 2 个，跳过 3 个
  ✓ Tokyo-01 (203.0.113.5:8388, aes-256-gcm, pw_fp=3f9a2c1e)
  ✓ Osaka-01 (203.0.113.9:8388, aes-256-gcm, pw_fp=8b1d4f07)
  – direct: 不是 shadowsocks
  – block: 不是 shadowsocks
  – hk-01: unsupported method: chacha20-ietf-poly1305
```

**永不打印 password**，只打印 server / port / method。

`pw_fp` = `sha256(profile_id ‖ password)` 前 8 位十六进制。单向不可逆，且按节点加盐 —— 同一密码在不同节点得到不同指纹，既不能跨节点比对，也挡住弱密码的枚举。用途是让「密码有没有泄漏到日志」变成一条可执行的检查：

```bash
grep -rn "3f9a2c1e" build/logs/ ~/Library/Application\ Support/Veyl/logs/
```

搜到即泄漏，搜不到即有证据说明没泄漏。没有这一步，「不进日志」只能写成「我觉得没有」。

### 5.3.5 行为细节

1. 读文件 → 解析 JSON
2. 按 §5.3.2 筛选与映射
3. 每个节点：写 `profiles` 一行（`config_json` 不含密码）+ 写 `secrets.enc` 的 `node:<profile_id>`
4. 打印摘要（§5.3.4）
5. 幂等：同 id 已存在则更新（名称、地址、method、密码），不新增行

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

### 5.6 产品化的本地导入

不在本轮。P2 走 UI 文件选择，届时可以直接复用 `node:<profile_id>` 这套存储约定。

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
