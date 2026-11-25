# 编辑自定义节点（手动可改全项，订阅只改名）

> 日期：2026-11-25
> 状态：**已定，待实现**（评审后第 2 版）。
> 触发：自定义节点只有「添加」和「移除」，加错一个参数只能删掉重加；改了服务器密码也没地方同步。
> 相关：`docs/design/node-remove.md`（同一入口的移除）、`docs/design/node-list-grouping.md`（分组后的行结构）、`docs/design/node-import-ui.md`（手动填写表单与校验口径）。

---

## 0. 结论

新增一条 Host 命令 `node_update`，在节点行 `⋯` 里加「编辑节点」：

| 节点来源 | 名称 | 地址 / 端口 / 加密方式 / 密码 |
|---|---|---|
| `manual`（手动填写、粘贴 `ss://`） | 可改 | 可改 |
| `url`（订阅导入） | 可改 | **只读**，界面上灰显并说明原因 |
| `owned` / `seed` | 不受理 | 不受理 |

订阅节点的连接参数不改，是因为这一行是订阅内容的镜像。判重查的是库里存的 `source_key` 列（`configs.rs:653` `find_node_by_source_key`），不是按行内现有参数重算——只要本地保留原键，重导同一条订阅永远命中「重复」并整条跳过：本地改过的值既不会被订阅覆盖，也不会被它纠正，就成了一个说不清出处的节点。而服务商那边一旦改了这条，重导会算出新键、多出一条，「改过的」和「订阅原本的」并排出现。留着只读，这一行才始终等于订阅。名称可改：改名不改变镜像语义（判重只看键），订阅重导时仍按重复跳过。

**密码只写不读**：表单留空表示保持原密码。本设计不提供「清空密码」，也不支持 `method = none`：今天两条新建路径都强制密码非空（`NodeImportDialog.tsx:259`、`nodes.rs:330`），所以 `none` 节点本来就建不出来；本设计不改这个边界。

---

## 1. 现状

| 事实 | 证据 |
|---|---|
| 存储层已有整体写入节点的能力 | `src-tauri/src/store/configs.rs:592` `upsert_node`（按 id upsert 全部字段，`created_at` 不动） |
| 存在的改名能力只服务托管节点 | `configs.rs:691` `rename_node`，唯一调用方是控制面同步服务器改名（`control_plane/servers.rs:722`） |
| 界面没有任何编辑入口 | `src/components/ConnectionStage.tsx` 的 `⋯` 菜单只有「移除节点」 |
| 密码只进加密存储、不回读 | UI 拿到的 `NodeSummary` 没有密码字段 |
| 密码与节点行不在同一个库 | 密码在 `secrets.enc`（`src-tauri/src/secrets/mod.rs`），节点行在 SQLite：**两者无法放进同一个事务** |
| 已连接时改配置要重建运行时 | `tools/services.rs:8741` `rebuild_running_config`，由 `node_create` / `node_attach` 在连接中调用（`services.rs:6382`、`:6575`） |
| selector 热切只改选中项 | `node_switch` 按固定 tag `node-<id>` PUT（`services.rs:6733` 起）；节点参数变了它不会重建 outbound |
| 测速结果是内存态，没有按节点失效的接口 | `tools/probe_batch.rs` 只有整批 `cancel` 与 60 秒空闲 TTL（`IDLE_TTL`），`snapshot` 按配置返回 |

---

## 2. 命令设计

```
node_update {
  nodeId: string
  name: string
  server?: string        // 仅 manual 可传
  port?: number          // 仅 manual 可传
  method?: string        // 仅 manual 可传
  password?: string      // 仅 manual 可传；省略或空串 = 不改
} -> {
  updated: true
  wasCurrent: boolean    // 改之前运行时正在跑这个节点
  paramsChanged: boolean // 地址/端口/加密/密码任意一项变了
  rebuilt: boolean       // paramsChanged 且重建了连接中的运行时
}
```

执行顺序：

1. 读节点（`get_node`）；不存在 → `NOT_FOUND / node_not_found`。
2. `source` 不是 `url` / `manual` → `PRECONDITION_FAILED / node_not_editable`（`details.source`）。
3. `source = "url"` 且带了任一连接参数 → `PRECONDITION_FAILED / subscription_params_readonly`。名称照常可改。
4. 校验与 `node_create` 同一套：名称 trim 后非空且 ≤64 字（`configs.rs:903`）；地址沿用 `validate_server`（`configs.rs:916`：≤253 字节，禁 `://`、空白、`/`、`\`、控制字符）；端口 1–65535；`method` 先 `to_ascii_lowercase` 再查 `nodes.rs:19` 的 `SUPPORTED_METHODS`；密码非空时 ≤256 字。失败按 `INVALID_ARGUMENT`，`details.reason` 与新建一致（`invalid_argument` / `unsupported_method`）。
5. 读运行时快照（`node_id`、`config_id`），决定要不要动运行时：
   - 正在跑的正是这个节点 → `was_current = true`，先停运行时；
   - 否则若 `paramsChanged` 且这个节点绑在**正在连接的配置**里 → 记下「写库之后要重建」，此时不动运行时；
   - 不在连接中的配置里 → 不动运行时。
   - 判断依据是运行时快照的 `node_id`，不是活动配置的 `current_node_id`：真正在跑的是运行时。**已知不一致**：`node_remove` 判 `was_current` 用的是活动配置的 `current_node_id`，两者口径不同；本批不改 `node_remove`，后续统一，评审时不要当成新缺陷。
6. 写库（**跨两个存储，没有共同事务**）：
   1. `password` 非空时先写 `secrets.enc`；失败 → `SECRET_STORE`，节点行一行不动；
   2. 再在一个 SQLite 事务里 `upsert_node`，用**原 id**、**原 source_key** 覆盖 `name / server / port / method / updated_at`，`created_at` 不动；失败 → `INTERNAL / store_error`。
   窗口说明：第 1 步成功、第 2 步失败时，凭据已是新的、节点行还是旧的。命令整体报错，前端不猜测中间态；重试幂等（同样输入再写一遍即收敛）。
7. 重建运行时（仅第 5 步记下要重建时）。**不能直接复用 `rebuild_running_config`**：它会因为 `added` 为空直接返回 `skipped / no_new_nodes`（`services.rs:8742`），日志与失败文案写的是「新节点」，而且回滚时会把 `added` 当排除集传给 `connect_body`（`services.rs:8925`）——拿被编辑节点当 `added`，一旦首轮启动失败回滚，恢复出来的配置里就没有这台节点了。做法二选一，取后者：
   1. ~~直接复用~~（不可行）；
   2. 把「重建原因」与「回滚排除集」拆开：`rebuild_running_config` 的 `added` 换成 `RebuildCause { AddedNodes(&[String]), NodeEdited }`，排除集只在 `AddedNodes` 时非空；日志与失败文案按原因出「新节点」或「新设置」，`new_nodes` 只在 `AddedNodes` 时返回。编辑路径首轮与回滚都用空排除集。
   - 仍受 `mode_switches` 串行闸门约束：同配置已有切换在跑 → `CONFLICT / switch_in_progress`，本次编辑的库改动已经落库，报错只说明「这次没重建成功」，不要撤销已保存的值。
   - 重建失败：**不自动恢复旧参数**（库里已是新值），提示「新设置没能应用，连接已断开」，用户可再改或移除；返回 `rebuilt = false`。
8. 失效测速：`ProbeBatchState` 当前没有按节点失效的公开方法，需要新增（并让 `snapshot` 丢弃已失效节点）：
   - 该节点有在途批次 → 立即使其失效，批次回写的结果丢弃；
   - 空闲探针缓存 → 失效集合内不再命中；
   - 断开了运行时的话，运行时快照里的 `node_latency_ms` 随断开自然清空，不需要额外写。
9. 发 `node-list-changed(reason = "node_updated", config_id = null, changed_node_ids = [nodeId])`。
   **不发 `config-changed`**。两条证据：运行配置里 outbound 的 tag 是 `format!("node-{}", node.id)`（`src-tauri/src/config/builder.rs:285`）——用的是节点 id 而不是名字，所以改名对运行配置零影响，不需要让运行时重新生成配置；`ConfigSummary`（`commands.md` §3.0）里也既没有节点名也没有连接参数。改参数的情况由重建处理，过程本身有运行时事件。UI 收到 `node-list-changed` 就会重拉当前配置详情。

**id 与去重键不变**：`config_nodes` 绑定、当前节点指向、选择器缓存都按 `node_id` 引用；`source_key` 保持创建时的值（判重读的是这一列，不按行内参数重算），所以改过名称或参数之后再导入同一条订阅/原链接，仍按「已有相同节点」整条跳过，不会长出第二行。会出现两条的情形只有一个：订阅端自己改了这条的参数，重导算出新键，被当成新节点——这与本地是否编辑过无关。

**密码**：返回里不含密码；`password` 省略或空串表示保持原密码，`details` 不说明是否改过。

**错误码**：`NOT_FOUND` / `PRECONDITION_FAILED`（`node_not_editable`、`subscription_params_readonly`、重建路径的 `switch_in_progress`）/ `CONFLICT` / `INVALID_ARGUMENT`（与新建同口径）/ `SECRET_STORE` / `INTERNAL`（存储失败）。

---

## 3. 界面

- 入口：节点行 `⋯ → 编辑节点`，放在「移除节点」上方，中间一条分隔。托管与免费节点不出现这一项（与移除一致）。
- 复用 `NodeImportDialog` 的表单，但需要编辑态（该组件在 `open` 变化时会强制回到「链接 / 订阅」段并清空全部字段，`NodeImportDialog.tsx:124`）：
  - 新增 `editing: NodeSummary | null`；非空时隐藏「链接 / 订阅」段与文件导入，标题改「编辑节点」，主按钮改「保存」；
  - 重置只在 `editing.node_id` 变化时发生，预填名称、地址、端口、加密方式；密码栏留空、占位「不修改就留空」；
  - 成功一行「已保存」；字段错误仍按添加时的映射贴字段。
- 订阅节点：地址、端口、加密方式、密码四栏只读，附一句「这些来自订阅：本地改了不会同步回服务商，也不会被订阅纠正。要改请在服务商那边改完重新导入」。**不要**写「会被改回去」，也不要写「刷新会多出一条」——那是订阅端改了才会发生的事。
- 保存：主按钮「保存」；提交中禁用整张表单与「取消」。成功后关闭弹层，行内名称即时更新。
- `wasCurrent = true`：关闭弹层后在节点卡顶部给一行「已断开，重新连接后使用新设置」，不自动重连（新参数可能连不上）。
- `rebuilt = true`：一行「已用新设置重新连接」；连接态由运行时事件表达，不在提示里承诺。
- 失败：错误贴着对应字段（与添加节点同一套映射）；`subscription_params_readonly` 落到参数区，`node_not_editable` 落到弹层顶部一行。

---

## 4. 契约

- `commands.md`（当前 2.69.0 → 2.70.0）要改**五处**：§2 命令总表加一行、新增 §7.33、§12 能力↔命令映射、§13 与 AI 工具的对应关系（写「无 AI 工具」）、§15.5 版本矩阵那一行；再同步头部版本与变更记录。
- `events.md`（当前 2.24.0 → 2.25.0）：`NodeListChangedReason` 加 `"node_updated"`。版本号按该文件自己的规则改，但**不是全文替换**，分三类：
  - 改：34 处 payload 里的 `contract_version: "2.24.0"` 字面量；文件头部版本行；三处**当前版本引用**——§0 的「当前 `2.24.0`」（:25）、`ai-request-end` 的 `error.contract_version` 取本事件契约版本那句（:462）、与顶层 `contract_version` 对比那句（:513）。
  - 改：`routing.md` 的副本——§8 开头的「跟 `events.md`（当前 `2.24.0`）」（:538）与两个载荷字面量（:544、:567）。events.md 的变更记录已经写明「`routing.md` 两处副本随本文件」。
  - 不改：历史注记共 7 处（「2.24.0 起事件不再携带 `text`」、§3.4.1 标题里的 `(2.24.0)`、§10 的 2.24.0 变更条目等）——那是历史，不是当前版本。
- 实现侧有两处常量、两处断言要一起改：
  - `src-tauri/src/runtime/manager.rs:19` `EVENT_CONTRACT_VERSION`；
  - `src-tauri/src/claurst_session/events.rs:11` 的第二份 `CONTRACT_VERSION`；
  - 断言写死 `2.24.0` 的有两处：`claurst_session/events.rs:292`、`claurst_session/mod.rs:2200`。
- `src/agent/protocol.ts` 的 `NodeListChangedReason` 联合类型加 `"node_updated"`；`mockAgent` 用该类型、没有自有版本常量，只需实现 `nodeUpdate` 的 mock 行为（改 localStorage 里的节点、作废该节点测速、发事件）。
- `tools.md`：**不新增 AI 工具**。改节点参数会改变用户的连接选择，和移除一样属于界面动作。

---

## 5. 验收

1. 改手动节点的名称：行内名字变了，地址与密码不变，重启后仍是新名字。
2. 改手动节点的地址/端口/加密/密码：保存后用新参数能连上；该节点的测速结果变回「未测」。
3. 改当前正在使用的节点：先断开，提示里出现「已断开，重新连接后使用新设置」；不自动重连。
4. 改的是连接中配置里的**非当前**节点：连接自动重建，重建成功继续可用；重建失败按运行时错误提示，不静默变回旧参数。
5. 测速正在进行时编辑同一节点：旧批次的结果不会写回，行内最终显示「未测」。
6. 订阅节点：连接参数四栏只读并有说明（说明说的是「本地改了不会同步、也不会被订阅纠正」，不是「会被改回去」）；只改名称能保存。
7. 托管与免费节点：`⋯` 里没有「编辑节点」；绕过界面直调命令返回 `PRECONDITION_FAILED / node_not_editable`。
8. 校验：空名称、带协议地址、端口越界、白名单外的加密方式都贴着字段报错，不发命令；密码留空不覆盖原密码，密码 257 字报错。
9. 用**原订阅链接 / 原参数**再导入一次：不出现第二行（按相同 `source_key` 跳过）；用改名后的**新名字**手动新建会出现第二行——这是预期，两条确实不同。
10. 中英文各过一遍；界面与提示里不出现 node_id、source_key、secret、outbound 这类词。

---

## 6. 不做

- 不做批量编辑。
- 不支持清空密码或把加密方式改成 `none`（`none` 在今天的新建路径里也建不出来，见 §0）。
- 不做「订阅节点重建」（改订阅参数只能去服务商改完重新导入）；也不改刷新逻辑去覆盖用户修改——现在的「重复整条跳过」是对的。
- 不给 AI 工具入口。
- 不做编辑历史/撤销；改坏了可以再改一次。

---

## 7. 实现边界

- **分两批**。第一批是纯重构、行为逐字不变：`rebuild_running_config` 的 `added` 换成 `RebuildCause { AddedNodes(&[String]), NodeEdited }`，改三个调用点（`node_create`、`node_attach`、回滚路径），`AddedNodes` 仍用新增 id 当排除集、`NodeEdited` 为空；提交信息写明「纯重构、无行为变化」，跑全量 `cargo test`。第二批再叠 `node_update`、界面、契约、事件与 probe 失效。分两批的理由是可审：混在一起回归时分不清是重构错还是新功能错。
- `src-tauri/src/claurst_session/` 是本仓库自己的目录，版本常量与写死断言可以改；`claurst/` 子模块仍然只读，不碰。
- `tools/probe_batch.rs` 只加「按 `node_id` 失效」这一条最小接口，不顺手重构批次状态机。
- `events.md` 的版本号只改 34 处 payload 字面量与文件头部，历史注记不动，也不用整仓格式化或全仓替换类命令。
