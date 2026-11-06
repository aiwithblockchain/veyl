# 本地代理端口（用户可设置）

> 日期：2026-11-06
> 状态：设计定稿，未实现
> 上游：`docs/contracts/commands.md` §4.5（`proxy_params`）、§4.14（`RuntimeSnapshot`）、§7 命令表
> 涉及：`src-tauri/src/config/ports.rs`、`src-tauri/src/tools/services.rs`、`src-tauri/src/runtime/manager.rs`、
> `src-tauri/src/tools/probe_batch.rs`、`src/components/Settings.tsx`、`src/ui/middleArea.ts`
>
> **这份文档解决什么**：端口每次连接随机（`ports.rs:9`），用户把 `127.0.0.1:65098` 填进浏览器 / 下载器 / CLI
> 之后，重连就变一个数，配置失效且不报错。要的是**用户在设置里填一次，之后每次都用它**。

---

## 1. 现状

| 事实 | 证据 |
|---|---|
| 每次连接在 49152–65535 里随机挑 | `config/ports.rs:9 pick_free_port()` |
| 配置表里有 `listen_port`，显式设了就直接用 | `store/configs.rs:42`、`services.rs:5163-5166` |
| 但设置页没有入口，前端从不传 | `grep listenPort src/` 只有类型与测试 |
| AI 工具**能**设置它（`ConfigCreate`/`ConfigUpdate` 的 `listen_port`，1000–65535） | `tools/configs.rs:278`、`:447` |
| 显式端口**不做占用检查**，被占则 sing-box 绑定失败、连接失败 | `services.rs:5163` 只做 `match` |
| 契约已承诺「端口被占用时自动顺延，并如实回显」 | `commands.md:525` |
| 契约已承诺「端口冲突重试最多 5 次」+ `RUNTIME_PORT_UNAVAILABLE`，**代码里都没有** | `runtime.md:345`、`:457` |
| **TUN 连接也会 `build_routed_multi`，同样绑定一个 mixed 端口** | `services.rs:5354`、`builder.rs:75` |

最后一条是这次的关键发现，见 §6。

---

## 2. 结论（一页版）

| 问题 | 结论 |
|---|---|
| 形态 | **设置项**，不是内部常量。设置 → 连接 →「本地代理端口」 |
| 默认值 | **7890**（与 `veyl-ui` 一致，也是 Clash 系的共同默认） |
| 持久化 | **全局一个**，`settings` 表键 `proxy_port` |
| 候选链 | 用户设置 → 7890…7899 → 系统分配 |
| 未连接时 | 中间区显示 `127.0.0.1:<设置里的端口>`（这是用户填的，不是我们的预测） |
| 生效时机 | 保存后**下次连接**生效；已连接时行内提示「下次连接生效」 |
| 校验 | 1–65535，非整数直接拒绝；**<1024 只提示不阻止**（需要管理员权限、不建议） |
| 冲突 | **能连上 + 说清楚**：预检查发现被占 → 顺延到附近可用端口 → 明确告诉用户「你设置的 7890 被占用，本次用 7891」 |
| TUN | **不用这个端口**，TUN 的 mixed 端口继续随机（§6，这里有个坑） |
| 探针运行时 | 继续随机，且**避开**用户设置的端口 |
| 契约 | 新增 `proxy_port_get` / `proxy_port_set`（仅 UI）；`RuntimeSnapshot` 加 `port_fallback` |

---

## 3. 设置项

### 3.1 位置与形态

设置 → **连接** → 与现有行并列，新增一行（`settings-row`）：

```
本地代理端口          127.0.0.1 : [ 7890 ]
                      别的软件要填代理地址时，用的是这个端口。改一次，以后每次连接都用它。
```

- 输入框是数字，宽度固定 5 位；右侧固定显示 `127.0.0.1 :` 前缀，让用户知道这是**本机地址的端口**。
- 失焦或点「保存」时提交；不做实时保存（半截输入会写进库）。
- 保存成功后行内一行反馈「已保存，下次连接生效」；已连接时才带「下次连接生效」，未连接时写「已保存」。

### 3.2 文案（给不懂网络的人）

- 标题：**本地代理端口**。
- 说明：**「别的软件要填代理地址时，用的是这个端口。改一次，以后每次连接都用它。」**
- 小于 1024 时的提示：**「小于 1024 的端口在系统里通常需要管理员权限，不建议用。」**（提示，不阻止保存）
- 不出现：mixed port、混合端口、inbound、TUN、分流、规则集。

### 3.3 校验

| 输入 | 结果 |
|---|---|
| 空 / 非整数 | 前端直接拒绝，不发命令：「请填一个 1–65535 之间的数字」 |
| `0` / `> 65535` | 后端 `INVALID_ARGUMENT`，前端同一句 |
| `1–1023` | **接受**，行内显示管理员权限提示 |
| `1024–65535` | 接受 |
| **当前被别的程序占着** | **允许保存**，行内提示「这个端口现在被占用了，连接时会自动顺延」 |

保存时就校验，不留到连接时才发现。

**被占用不阻止保存**：占用者可能只是临时开着（下载工具、另一个代理软件），五分钟后就不占了。
为了一次临时的占用挡住用户修改自己的设置，是把系统的临时状态当成用户的错。
真正连接时按 §4 顺延并说明，用户那时能改。

### 3.4 与配置内 `listen_port` 的关系

**本轮把配置级端口摘掉**，端口只有一个来源：全局设置。

| 动作 | 处理 |
|---|---|
| `ConfigCreate` / `ConfigUpdate` 的 schema | 删掉 `listen_port`（`tools/configs.rs:278`、`:447`） |
| 解析处 | 不再接受这个字段；传了也不生效（`tools/configs.rs:372`、`:499`） |
| `configs.listen_port` 列 | **保留**，不删——旧数据的读取与回滚还要它，只是没有写入入口 |
| `validate_listen_port`（`store/configs.rs:604`） | 保留，防御旧数据里 TUN 带端口的情况 |
| `ConfigDetail.listen_port` | 保留返回，**标注废弃**，界面不再使用 |

理由：用户要的是「一个端口，改一次就不用再改」。只要这个字段还能写，AI 设过一次之后，
用户在设置里怎么改都静默不生效，而且界面上没有任何提示——正是这几个月一直在修的那类问题。
代价只是 schema 里删两行。

---

## 4. 连接时怎么用这个端口

### 4.1 选择顺序

```
候选 = [用户设置 proxy_port] ++ [7890 ..= 7899 依次] ++ [系统分配 any_free_port]
```

- 第一项是**用户指定**；从第二项开始是**降级**，会告诉用户（§4.3）。
- 去重，保持顺序（用户把端口设成 7895 时，7895 不会在列表里出现两次）。
- 第一个 `is_port_free` 成功的就用它。

为什么降级用相邻端口而不是随机：消息里要能说「7890 被占了，这次用 7891」。
一个 `49321` 会让人以为又回到随机了。

### 4.2 冲突：能连上 + 说清楚

PM 给的三条里选**第三条**，并做一处改良：

| 方案 | 判断 |
|---|---|
| 静默换端口 | **否决**：等于回到随机，正是要修的问题 |
| 连接失败，让用户去改设置 | **否决**：把「端口被占」变成用户当前无法完成的任务——他可能不知道是谁占了，也没权限关掉 |
| **预检查 → 顺延 → 明说** | **采用** |

改良点：**先用 `is_port_free` 预检查，不要先启动再失败**。二者结果相同，但预检查不产生一次
sing-box 启动 + 一句吓人的错误日志，快且干净。

竞态仍然存在（检查通过后、bind 之前被抢）：启动失败且输出命中 `address already in use`
（`config/validate.rs:62` 已有的识别）→ 顺延到下一个候选重试，**最多 3 次**，
仍失败返回 `RUNTIME_PORT_UNAVAILABLE`（`details.tried_ports`）。这个错误码目前**不存在**，
按契约 `runtime.md:457` 补上；`runtime.md:345` 的「最多 5 次」同步改成「候选 + 最多 3 次重启」。

### 4.3 用户会看到什么

代理卡在降级时多一行（`middleArea.ts` 的 `proxy_card`）：

```
127.0.0.1:7891
你设置的 7890 被别的软件占用了，这次用的是 7891。在设置里换一个端口，或先关掉占用它的软件。
```

- 正常连接时**一个字都不加**。
- 只在 `connect_mode = "system_proxy"` 且本次确实降级时出现。
- 端口号从字段读，不写死。

### 4.4 未连接时显示什么

现在是 `middleArea.ts:170` 用 `config.listen_port`，而 `config/model.ts:24` 在它为 null 时显示「自动」。
有了全局设置之后这两个都不对了：`listen_port` 不再参与，而「自动」会变成一句假话。

改成：

- 未连接时，代理卡显示 **`127.0.0.1:<设置里的端口>`**（默认 7890）。
  这是**用户自己填的值**，不是预测，说出来是诚实的——它唯一可能不成立的情况是连接时被占用，
  而那时 §4.3 会立刻纠正。
- 标签不再出现「自动」。
- 未连接时**不预判降级**，只说设置值。

因此 `proxy_port_get` 在 App 启动时读一次并放进共享状态（§8.2），设置页与控制台都用这一份。

---

## 5. 持久化

| 项 | 规则 |
|---|---|
| 位置 | `settings` 表，键 `proxy_port`，值是十进制字符串 |
| 读 | `proxy_port_get {}` → `{ port }`；从未设置过时返回默认值 7890（**不写库**，读不产生副作用） |
| 写 | `proxy_port_set { port }` → `{ port }`；事务写入 |
| 作用域 | 全局，不按配置 |
| 切换配置 | 地址不变——端口是应用级设置 |
| 清空 / 卸载 | 键不存在时回到 7890 |

为什么不按配置存：用户说的是「在 app 里面配置一次」。地址属于应用，用户把它填进的是浏览器和下载器，
那些软件不知道 Veyl 里有几套配置。按配置存，切配置就换地址，同一个问题换个形式重来。

---

## 6. TUN：这里有一个坑

PM 的假设是「TUN 模式 `mixed_port` 为 null，不受影响」。**契约与快照确实是 null，但底层不是**：

- TUN 连接走的是 `start_tun_connection` → 同样 `build_routed_multi`（`services.rs:5354`），
  而 `builder.rs:75` **无条件**生成一个 mixed inbound 监听 `mixed_port`——TUN 模式下这个端口真实存在、
  真实被 bind；
- 只是 TUN 分支自己拼的返回 JSON 里写死了 `"mixed_port": null`（`services.rs:5462`），
  所以界面与快照看不到它。

也就是说：**端口一直是有的，只是没人看见。** 如果把用户设置的端口直接塞给 TUN：

- 用户开着 Clash（7890 被占）→ 连 TUN 也会因为 mixed inbound 绑不上而失败；
- 而这正是「TUN 用户根本不会去填代理地址」的那群人，他们平白多了一个失败点。

**结论：TUN 连接不使用用户设置的端口，mixed 端口继续随机。**
`proxy_params` 对 TUN 仍然返回 `reason = "tun_mode"`、`port = null`，界面不展示地址。
用户设置只影响 `system_proxy` 模式。

顺带记录一处现状：TUN 的 mixed 端口既随机又不上报，它除了内部使用没有别的作用，本次不动。

---

## 7. 探针运行时

`tools/probe_batch.rs:485` 的临时运行时**继续随机**，并且要**避开**用户设置的端口：

```rust
pick_free_port_excluding(&[configured_port])
```

理由：探针在独立槽里跑（`node-list.md` §6.5），用户完全可能在批次进行中点「启动 VPN」。
如果探针占到 7890，真实连接就会降级到 7891，之后整个会话都在 7891 上——
等于我们自己制造了一次降级，还要显示「你设置的 7890 被占用」这句假话。

---

## 8. 契约

### 8.1 新增两条命令（仅 UI，AI 不可调用）

| # | 命令 | 入参 | 返回 |
|---|---|---|---|
| 65 | `proxy_port_get` | `{}` | `{ port: number }` |
| 66 | `proxy_port_set` | `{ port: number }` | `{ port: number }` |

- 没有通用设置读写命令可用（命令表 1–64 里没有 `settings_get` / `settings_set`；
  `settings` 表目前只被 LLM 配置与 `catalog_base_url` 内部使用）。
  **不新造一套通用设置 API**——通用写法会开一个「任意键读写」的口子，为一项设置不值得。
- `proxy_port_set` 的校验：整数、1–65535；不满足 → `INVALID_ARGUMENT`。
  小于 1024 **不拒绝**（那是界面提示的事）；**当前被占用也不拒绝**（§3.3）。
- `proxy_port_get` 返回**用户设置值**，从未设置过时返回默认 7890 —— 界面不用硬编码这个数字。
  读不写库，不产生副作用。
- `proxy_port_set` 成功后**不发事件**，由调用方（设置页）直接更新 App 层状态（§8.2）。

### 8.2 不加事件：状态放在 App 层

中间区在**未连接时**要显示 `127.0.0.1:<设置端口>`（§4.4），所以保存设置后控制台要跟着变。
**不为此新增事件**：

- 这条链路的写入方只有设置页一个——AI 工具里的 `listen_port` 本轮已经摘掉，不存在第二个写入者；
- 设置页与控制台在同一棵 React 树里，端口值提到 `App.tsx`（或一个 hook）就能同时更新两处，
  不需要跨进程；
- `events.md` 是契约，加一条要升版本、要维护兼容性，为一次本地 UI 同步付这个代价不值。

做法：`useVpnSession` 或 App 层持有 `proxyPort`，启动时 `proxy_port_get` 读一次；
设置页保存成功后更新同一份状态；控制台与设置行都从它取。

**运行时不信这份状态**——它在每次连接前自己读 `settings.proxy_port`。所以哪怕 UI 状态过期，
连出来的端口仍然是对的，错的只是界面上的一个数字，下次刷新就回来。

### 8.3 `RuntimeSnapshot` 加一个字段

```ts
// RuntimeStatus / RuntimeSnapshot
port_fallback: { requested: number; actual: number } | null;
//               你设置的          实际用的
// 正常连接、未连接、TUN 时均为 null
```

- 为什么不是布尔：界面要说「你设置的 7890 被占用」，得知道用户设置的是哪个。
- 为什么不是两个平铺字段：`actual` 在没有 `requested` 时没有意义，成对出现不容易用错。
- **`port_fallback` 不新增事件**：`runtime-state-changed` 已经带 snapshot（`events.md:381`、`:385`）。

### 8.4 其余

- `proxy_params` 形状不变；`port_source` 的 `configured` 现在唯一来自全局设置，
  `pending` 不再产生，标注废弃。
- **`events.md` 不变**：§8.2 的状态在 App 层，不跨进程。
- `tools.md` 改一处：`ConfigCreate` / `ConfigUpdate` 删掉 `listen_port` 参数（§3.4）。
  **不给 AI 一个改端口的工具**——端口是用户自己的设置。
- `veyl-ui` 技能文档若写的是 `127.0.0.1:7890`，与本次选值一致，无需改（该文件不在本仓库，实现时核对一次）。

---

## 9. 测试

| # | 场景 | 期望 |
|---|---|---|
| 1 | 全新安装，未设置过 | `proxy_port_get` 返回 7890，且不写库 |
| 2 | 设置 8080 后连接 | 监听 8080；`port_fallback = null` |
| 3 | 重连一次 | 仍是 8080（不再随机） |
| 4 | 设置 7890，被别的程序占着 | 连上用 7891；`port_fallback = {7890, 7891}`；代理卡出现那句说明 |
| 5 | 上一场景重连 | 仍然是 7891（每次预检查 7890 仍被占），说明文案重复出现 |
| 6 | 设置 7890，占用解除后重连 | 回到 7890；说明消失 |
| 7 | 设置 1–1023（如 80） | 保存成功；行内出现管理员权限提示；能连上（或按权限失败） |
| 8 | 输入 0 / 70000 / 非数字 | 拒绝保存，不发命令 / 返回 `INVALID_ARGUMENT` |
| 9 | 设置 65535 且被占 | 顺延不越界（不会到 65536），必要时直接系统分配 |
| 10 | 检查通过后 bind 前被抢 | 重试下一个候选，最多 3 次；全失败返回 `RUNTIME_PORT_UNAVAILABLE` 且带 `tried_ports` |
| 11 | 已连接时修改设置 | 保存成功，行内「下次连接生效」；当前连接端口不变 |
| 12 | TUN 连接 | 不使用设置里的端口；`port_fallback = null`；`proxy_params.reason = "tun_mode"` |
| 13 | 批量测速运行时 | 不占用设置里的端口；批次进行中点「启动 VPN」仍拿到设置端口 |
| 14 | 旧数据里残留 `listen_port = 9999`，设置为 8080 | 用 **8080**；旧值不参与任何判断（`ConfigDetail.listen_port` 仍返回 9999，但界面不读它） |
| 15 | 设置被外部清空 | 读回 7890 |
| 16 | macOS / Linux 普通用户设 80 | 连接失败时不崩溃，错误码是权限类而不是 `INTERNAL` |
| 17 | 未连接，设置为 8080 | 代理卡显示 `127.0.0.1:8080`；**不出现「自动」** |
| 18 | 已连接时把设置从 8080 改到 8081 | 当前连接仍是 8080；行内「下次连接生效」；App 层状态更新，未连接的代理卡立即显示 8081 |
| 19 | 保存一个当前被占用的端口 | **保存成功**；行内提示「现在被占用了，连接时会自动顺延」 |
| 20 | 非法值（0 / 70000 / 非数字） | 拒绝；**库里原值不变** |
| 21 | 打开设置页 | 输入框显示 `proxy_port_get` 的值（用户值，不是任何运行时值） |

---

## 10. 不做的事

- 不做「记住上次成功的端口」——候选链完全确定，记忆既没用，还会压制用户的显式修改。
- 不做随机端口兜底（除了最后一步系统分配）。
- 不抢占、不停止、不修改占用端口的进程。
- 不给 AI 改端口的工具。
- 不在未连接时把设置值说成"实际地址"（`proxy_params` 仍是 `configured`，不是 `runtime`）。
- 不改 TUN 的 mixed 端口策略。
- **不删** `configs.listen_port` 列（旧数据与回滚还要它），只删写入入口。

---

## 11. 影响文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/config/ports.rs` | `DEFAULT_PROXY_PORT = 7890`；候选链 `pick_port_with_preference`；`pick_free_port_excluding` |
| `src-tauri/src/tools/services.rs:5163-5176` | 端口来源改成「全局设置 → 7890–7899 → 系统」；预检查；冲突重试 ≤3；写 `port_fallback` |
| `src-tauri/src/tools/services.rs:5354` | **TUN 分支继续 `pick_free_port()`**，不读设置（§6） |
| `src-tauri/src/tools/probe_batch.rs:485` | 改用 `pick_free_port_excluding(&[configured])` |
| `src-tauri/src/tools/configs.rs:278`、`:447` | 从 `ConfigCreate` / `ConfigUpdate` schema 删 `listen_port` |
| `src-tauri/src/tools/configs.rs:372`、`:499` | 解析不再接受 `listen_port`（传了也不生效） |
| `src-tauri/src/runtime/manager.rs:131-158` | `RuntimeStatus` 增 `port_fallback`；plan 里带 `requested_port` |
| `src-tauri/src/agent/commands.rs`（或等价注册处） | 注册 `proxy_port_get` / `proxy_port_set` |
| `src/agent/protocol.ts` / `bridge.ts` / `tauriBridge.ts` / `mockAgent.ts` | 两条命令、`port_fallback` 字段 |
| `src/components/Settings.tsx` | 连接页新增「本地代理端口」行：输入、保存时校验、<1024 提示、被占用提示、保存反馈 |
| `src/ui/middleArea.ts:170` | 未连接时端口来源从 `config.listen_port` 改成**设置值**（§4.4）；降级时多一行说明 |
| `src/config/model.ts:24` | 去掉「自动」这个标签（§4.4） |
| `src/config/useVpnSession.ts`（或 App 层） | 持有 `proxyPort`：启动时读一次 `proxy_port_get`；设置页保存成功后更新同一份状态（§8.2） |
| `src/components/Console.tsx` | 把设置端口与 `port_fallback` 传进代理卡 |
| `docs/contracts/commands.md` | 命令表加 #65/#66；§4.14 `RuntimeSnapshot` 加 `port_fallback`；§4.5 说明 `configured` 的新来源、`pending` 废弃；§4.5「自动顺延」补具体规则；`ConfigDetail.listen_port` 标注废弃 |
| `docs/contracts/events.md` | **不变**（§8.2：状态在 App 层，不跨进程） |
| `docs/contracts/runtime.md` | §345「最多 5 次」改成候选 + 最多 3 次重启；§457 的 `RUNTIME_PORT_UNAVAILABLE` 从"已定义未实现"变成真实现 |
| `docs/contracts/tools.md` | `ConfigCreate` / `ConfigUpdate` 去掉 `listen_port` 参数 |
| `docs/data-model.md` | `settings` 表登记 `proxy_port` 键（默认为空，读时回落 7890）；`configs.listen_port` 标注"仅保留旧数据" |
