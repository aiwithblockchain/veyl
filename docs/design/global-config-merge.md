# 全局单配置收敛：一个配置、一个节点池

> 日期：2026-11-17
> 状态：设计定稿；§6 的实现项已落地（2026-11-19 复核），剩 C6 验收待执行。只出设计与契约影响。
> 上游：`ai-first-product.md` §全局配置与设置 / §全局配置与节点池、`docs/design/stage-quick-toggles.md`、`docs/contracts/commands.md` §3 / §4 / §7.19
> 触发：产品负责人 2026-11-17 拍板——试用不提前结束、到期硬断开、本批补完全局单配置。

## 0. 一句话

**后端只保留一行 `configs`，它就是全局配置；`config_nodes` 就是全局节点池。** 所有节点来源（种子、自建服务器、订阅、手填、文件）都往这一行里加节点，不再有新配置、不再有切配置。已有数据在启动时一次性合并成一行。

## 1. 现状与裂缝（代码事实）

| 现象 | 位置 |
|---|---|
| 试用流程用 `config_create(source="seed")` 建一套「免费节点」配置 | `src/App.tsx:1967-1972` |
| 我的服务器「连接」拿到节点后又 `config_create(nodeIds:[node])` 建第二套配置 | `src/App.tsx:590-595` |
| 后端 `config_create` 仍是「插一行新配置」，不合并 | `src-tauri/src/tools/services.rs:4055` |
| 界面没有配置切换入口，但 `hasNodes` 统计所有配置 | `src/App.tsx:661-676` |
| 同一台服务器再点「连接」会再建同名配置 → `duplicate_name` | `commands.md` §3.2 |

后果：节点池名义上全局，实际被切进多套配置；旧配置的节点在界面上消失，却仍让 `hasNodes` 为真；重复连接直接报错。

## 2. 目标模型

1. `configs` 恒为 **0 或 1 行**。0 行只在「全新安装、还没有任何节点」时存在。
2. 这一行承载所有连接参数：`connection_mode`、`routing_mode`、`dns`、`tun_excludes`、`current_node_id`。
3. `config_nodes` 是**唯一的节点池**，`position` 决定顺序与「第一个节点」的兜底。
4. 界面上没有配置列表、没有新建配置、没有切换配置；`config_list` 只用于读回这一行（0 或 1 条）。
5. 「新建节点」= 往池子里加节点，不是建配置。

## 3. 收敛方案

### 3.1 谁创建这一行

**第一条节点绑定时由 Host 懒创建**，不需要界面先调 `config_create`：

- 新 UI 命令 `node_attach`（见 §3.3）在 `configs` 为空时，用固定默认值创建全局配置：`name = "默认配置"`、`connect_mode = "system_proxy"`、`routing_mode = "direct"`（智能）、`dns = auto`、`tun_excludes = []`、`current_node_id = null`、`is_active = 1`。
- 默认值与 `ai-first-product.md` §全局配置与设置 一致；界面不需要先替用户选一次接管方式。
- `config_create` 保留在协议里，但**已有全局配置时一律拒绝**：`CONFLICT / config_exists`（替代原来的 `duplicate_name` 路径）。UI 与 AI 都不得再用它加节点。
- **懒创建对四条导入路径同样生效**（`node_import_url` / `node_import_text` / `node_import_file` / `node_create`）：省略 `configId` 时若池里还没有配置，同样先建默认行，再绑定。
- **并发兜底靠 `configs.name UNIQUE`**（`001_init.sql:24`）：建行在同一个事务里执行 `INSERT INTO configs(...) VALUES('默认配置',...) ON CONFLICT(name) DO NOTHING`，随后 `SELECT id FROM configs LIMIT 1` 取实际行。两个请求同时懒创建时，后者命中唯一约束、不报错；`is_active` 由第一行独占（`idx_configs_one_active`，`001_init.sql:47`）。**不要用「先 SELECT 再 INSERT」的两步判断**，那会在并发下撞 UNIQUE。

### 3.2 节点进入池子的路径矩阵

| 来源 | 命令 | 新语义 |
|---|---|---|
| 种子（试用） | `default_profile_refresh`（种子层）+ `node_attach { source: "seed" }` | 刷新只写 `nodes`；attach 把全部种子节点并入全局配置，已绑定的跳过。**AI 侧没有 `node_attach` 工具**（仅 UI），所以 `CatalogRefresh`（工具）在单配置下必须顺带完成同样的绑定：刷新后把新种子节点并入全局配置（幂等、不改 `current_node_id`）。否则模型只有「刷新」一条路径，节点永远进不了池子（见 §6 第 1 条） |
| 自建服务器 | `my_server_credentials`（写 `nodes(source='owned')`）+ `node_attach { nodeIds: [id] }` | 凭据命令不碰配置；attach 负责绑定。重复点「连接」是幂等的（`config_nodes` 主键去重），**不再撞 `duplicate_name`** |
| 订阅 | `node_import_url { configId? }` | 省略 `configId` 时绑定全局配置（新语义），不再有「只进池不绑定」的死状态 |
| 粘贴 / 手填 / 文件 | `node_import_text` / `node_create` / `node_import_file` | 同上：省略 `configId` = 绑定全局配置 |

统一规则：

- 追加到末尾；已绑定的节点跳过（幂等）。**`node_attach` 与导入命令一律不改 `current_node_id`**：当前为空时也保持为空，等用户点「连接」或显式切节点。
- 成功后发 `node-list-changed`（`reason = "bindings_changed"`，`config_id` = 全局配置）+ `config-changed(change = "updated")`。不新增 reason 取值。
- 传入的 `configId` 只允许等于全局配置 id，否则 `CONFLICT / not_global_config`。

**谁改「当前节点」（两条路径写死）**：

| 流程 | 动作顺序 |
|---|---|
| 试用加入种子 | `node_attach({source:"seed"})` → 界面本地预选「最快」，**不写库** → 用户点「连接」时 `node_switch` 再 `runtime_start`（既有口径，`ai-first-product.md` §选中免费节点之后） |
| 服务器页「去连接」 | 未连接时只 `my_server_credentials` → `node_attach({nodeIds:[id]})`，随后跳控制台并**预选**这台节点的节点卡（预选不写库）；**不调 `node_switch`、不调 `runtime_start`**。非 idle（已连接 / 连接中 / 断开中）一条命令都不发，只跳控制台。真正的连接只发生在控制台主按钮那一下（2026-11-19 起，`commands.md` §4.0） |
| 订阅 / 粘贴 / 手填 / 文件 | 只 attach；当前节点由用户点选或点「连接」时再定 |

`node_switch`（写库；已连接时是 Clash selector 热切换）与 `runtime_start`（同配置幂等）只由**控制台主按钮**发起。所以「已经连着免费节点、去服务器页点『去连接』」不会切过去：只跳控制台并提示先断开；连接中连 `node_attach` 都不发——它会触发 `runtime_rebuild`（stop → start 断流，`commands.md` §4.0.1）。

### 3.3 命令取舍

| 命令 | 处理 | 说明 |
|---|---|---|
| **新增 `node_attach { source?: "seed", nodeIds?: string[], configId? }`**（仅 UI） | 新增 | 只做「把已存在的节点绑进全局配置」，不联网、不读密码；`source` 与 `nodeIds` 二选一，缺省报 `INVALID_ARGUMENT / source_required`；`configs` 为空时先建默认配置（§3.1） |
| `config_create` | 保留，加拒绝 | 已存在全局配置 → `CONFLICT / config_exists`；UI 不再调用 |
| `config_list` | 保留（只读） | 返回 0 或 1 条 + `active_config_id`；UI 用它加载 `activeConfig` |
| `config_detail` | 保留 | 返回全局配置；id 不存在 → `NOT_FOUND` |
| `config_update` | 保留 | 设置页写连接参数；`nodeIds` 仍是整体替换（管理池子顺序时可用） |
| `config_set_mode` | 保留 | 只作用于全局配置；`configId` 必须等于全局 id |
| `config_activate` | UI 退休 | 目标不是全局配置 → `CONFLICT / single_config`；UI 不再调用 |
| `config_delete` | UI 退休 | 删全局配置 → `PRECONDITION_FAILED / only_config`（删了会让节点池失去载体）；UI 不再调用 |

**`node_attach` 形状（仅 UI）**

```ts
node_attach { source?: "seed"; nodeIds?: string[]; configId?: string }
  → {
      config_id: string;              // 全局配置 id（可能是本次懒创建出来的）
      created_config: boolean;        // 本次是否新建了默认配置
      attached_node_ids: string[];    // 本次真正绑上的
      skipped_node_ids: string[];     // 已在池里的
      node_count: number;             // 绑定后的池大小
      current_node_id: string | null; // 原样返回，attach 不改它
    }
```

| 错误 | reason | 触发 |
|---|---|---|
| `INVALID_ARGUMENT` | `source_required` | `source` 与 `nodeIds` 都没给 |
| `INVALID_ARGUMENT` | `source_and_node_ids_conflict` | 两个都给 |
| `INVALID_ARGUMENT` | `invalid_source` | `source` 不是 `"seed"` |
| `NOT_FOUND` | — | `nodeIds` 里有不存在的节点；`details.node_ids` 一次列全 |
| `PRECONDITION_FAILED` | `seed_unavailable` | `source = "seed"` 但池里没有种子节点；`details.hint` 同 `config_create` |
| `CONFLICT` | `not_global_config` | `configId` 不等于全局配置 id |
| `CONFLICT` | `switch_in_progress` | 同一配置上正有 `config_set_mode` 在跑；`retryable: true` |
| `INTERNAL` | — | 写库失败 |

**退休命令的返回码**

- `config_activate`：目标就是全局配置 → 幂等成功（`changed: false`）；其它 id → `CONFLICT / single_config`。
- `config_delete`：一律 `PRECONDITION_FAILED / only_config`，包括池子为空时（删了就没有承载连接参数的载体了）。

### 3.4 `hasNodes` 判定

**只认全局配置**：`vpn.activeConfig?.node_count > 0`。删掉 `vpn.configs.some((c) => c.node_count > 0)` 这一支（`App.tsx:661-676`）。收敛后只有一行，两者等价；写死「只认全局」是防止以后又冒出一条隐藏配置把界面点亮。

### 3.5 重复导入

- 同一节点（`source` + `source_key`）重复导入：`node_import_*` 按既有规则计入 `skipped(reason="duplicate")`；`node_attach` 幂等跳过。
- 服务器页重复「去连接」：`my_server_credentials` 按 `server_id` 覆盖写同一节点；`node_attach` 不重复绑定；**当前节点不变**——连接只由控制台主按钮发起，attach 从不顺带改 `current_node_id`（§3.2、`commands.md` §4.0）。
- 同一台服务器换了凭据（重建后 IP 变化）：`my_server_credentials` 覆盖 `nodes` 行，`config_nodes` 关联不变，无需再 attach。

### 3.6 迁移：已有多个配置

启动时在**一个事务**内执行一次。两种触发都算：

- `COUNT(*) > 1`：合并。
- `COUNT(*) = 1 AND is_active = 0`：只补 `is_active = 1`（唯一一行必须是激活行；`idx_configs_one_active` 允许它存在，但 `config_list.active_config_id` 会是 `null`，界面按「没有配置」处理——这是旧库的另一种残留）。

合并步骤：

1. 选保留下来的那一行：**优先 `is_active = 1`，否则 `last_used_at` 最新，再否则 `created_at` 最早**（与 `commands.md` §3.1 的解析顺序一致，不引入 `updated_at`）。连接参数以它为准，并把它置为 `is_active = 1`。
2. 其余配置的节点按目标配置现有顺序之后追加，按 `node_id` 去重；`position` 按合并后的相对顺序重写（一次性迁移允许重编号；**到期清理不重编号**，见 §3.7）。
3. **`issues` 必须按 `merge_key` 合并，不能只改 `config_id`**。`merge_key` = `coalesce(config_id,'') \x1f kind \x1f target` 且 `UNIQUE`（`001_init.sql:115`），直接改 `config_id` 会让旧键留在行上、与目标行的新键永不相等。逐条处理被删配置下的 issue：
   - 先算 `new_key = 保留行.id + \x1f + kind + \x1f + target`。
   - **已有同 `new_key` 的行** → 合并进那行：`occurrences` 相加；`first_seen_at = min`、`last_seen_at = max`；`severity` 取更高一级（P0 > P1 > P2）；`status` 取 `open`（任一为 open）否则取目标行原值；合并后为 `open` 时 `resolved_at = null`；`evidence_json` 保留目标行的（来源行的证据指向已退役配置）。然后删掉来源行。
   - **没有同键行** → 原地更新 `config_id = 保留行.id`、`merge_key = new_key`。
   - **逐条处理、边处理边落库**：处理完的行留在表里，后面同键的 issue 会走「已存在」分支合并。**不要先批量 `UPDATE config_id` 再收尾**——`UNIQUE` 在事务内立即生效，批量改会在中途撞键。
4. `layout` 挂在 `configs.id` 上（`001_init.sql:141`，`ON DELETE CASCADE`）：保留行自己的布局不动，其余配置的布局随配置一起删除。**不从别的配置搬布局**——布局是旧配置里 AI 对那套节点的编排，搬到新池子会指向不存在的块。
5. `config_nodes` 随被删配置级联清理（`001_init.sql:100`）。
6. 保留行的 `current_node_id` 若为 `null`，落到合并后第一个节点；若仍有效则不动。
7. 提交后发 `config-changed(change = "deleted")`（每删一行一条）+ `node-list-changed(reason = "bindings_changed")`，让已打开的界面重读。

**不做自动合并的选择界面**：多配置是旧模型的中间态，不是用户资产；连接参数只保留激活那套。这一条要写进发布说明。

### 3.7 到期清理：顺序不动、选中项写库回落

现有实现 `src-tauri/src/trial.rs:130-200` 已经是这个形状，本批只把它写成硬要求，不再改动语义：

1. **只删行，不重排 `position`**：`DELETE FROM config_nodes WHERE node_id IN (source='seed')`（`trial.rs:181`）。剩余节点的 `position` 原样保留，允许出现空号；渲染按 `position ASC` 排序（`store/configs.rs:398`），所以自建节点的**相对顺序与前移都不会发生**。禁止在清理后重编号（`config_update` 的整体替换会重编号，那是另一条命令，不在这里）。
2. **当前节点回落写库，不是界面层回落**：`current_node_id` 指向被删种子节点时，UPDATE 成剩余节点里 `position` 最小的那个（`trial.rs:190-197`）；没有剩余才置 `NULL`。界面收到 `trial-expired` 后**重读 `config_detail`**，不得自己算一个 fallback（`events.md` §4.24 已要求重读 `runtime_status`，这里补上配置）。
3. **硬断开**：只有 `RuntimeSnapshot.node_id` 属于被删集合才 `runtime_stop`（先提交事务、再断连，最多重试 30 秒）；**不自动切到自建节点**。
4. **自建节点不受影响**：清理只按 `nodes.source = 'seed'` 选行；`owned` 行与它们的 `config_nodes` 关联一行都不动。

## 4. UI 改动面

| 位置 | 改动 |
|---|---|
| 试用流程 · 加入节点 | `config_create(source="seed")` → `node_attach({ source: "seed" })`（`App.tsx:1967`） |
| 试用流程 · 失败清理 | **删掉 `vpn.deleteConfig(config.config_id)`**（`App.tsx:2001`）：全局配置不能删，attach 失败时池子没变，直接报错重试即可 |
| 服务器页「连接」 · 入池 | `config_create(nodeIds)` → `my_server_credentials` + `node_attach({ nodeIds })`（`App.tsx:620-622`） |
| 服务器页「连接」 · 切当前 | **服务器页不再发起连接**：未连接只入池 + 预选节点卡后跳控制台；非 idle 一条命令都不发，只跳控制台（同一台不提示，否则提示先断开）。`node_switch` / `runtime_start` 只由控制台主按钮发起（`App.tsx:601-643`，2026-11-19 起） |
| `hasNodes` | 只认 `activeConfig.node_count`（`App.tsx:661`） |
| 到期屏 | 用户已有节点时不显示 `trial_expired`（PM 已另派最小修复；本设计确认口径：`expired && !hasNodes`） |
| 节点导入入口 | 省略 `configId` 即绑定全局池；界面不再传配置 id |
| 节点卡 / 节点列表 | 同一张卡里显示两类节点，按 `source` 标注来源：`seed` → `免费节点`，`owned` → `你的服务器`；`url` / `manual` 不标（导入件不是「服务器」，也不是试用资源） |
| `useVpnSession` | `selectConfig` / `deleteConfig` 不再被 `App.tsx` 调用；保留实现只为兼容 mock 测试，标记为待清理（`docs/design/ai-first-product.md` 后续清理节） |
| 左栏 | 保持无配置切换；不新增入口 |

## 5. 契约影响

| 文件 | 版本 | 改什么 |
|---|---|---|
| `commands.md` | **2.37.0** | 新增 §4.x `node_attach`（仅 UI）；§3.2 `config_create` 增 `config_exists` 拒绝；§3.5 / §3.6 `config_activate` / `config_delete` 的退休语义与错误；§4.1 / §4.1.1 / §4.1.2 / §4.2 省略 `configId` 时绑定全局配置；**`NodeSummary.source` 补 `"owned"`**（现实现已发这个值、契约漏了，节点卡靠它分「免费节点 / 你的服务器」）；§7.19 试用清理口径从「全库」改为「全局配置」并写明「不重排 position、选中项写库回落」 |
| `tools.md` | **3.18.0** | `ConfigList` / `ConfigCreate` / `ConfigDelete` 退出 AI 工具集（`ConfigActivate` 本就无工具入口），总数 42 → 39；`NodeCreate` / `NodeImportText` 的 `configId` 语义同步；无需新增 `NodeAttach` 工具——AI 只加节点，绑定由服务层完成 |
| `data-model.md` | **9 不变** | 不加列、不加约束；§3.1 补一条不变量「`configs` 恒 0–1 行，`config_nodes` 即全局节点池」，迁移是数据操作不是 schema 迁移 |
| `events.md` | **2.17.0（当前版本，本批不变）** | 不加事件、不加字段；迁移与合成都用既有 `config-changed` / `node-list-changed(bindings_changed)`；`trial-expired` 不带新字段，UI 收到后重读 `runtime_status` + `config_detail` 拿回落后的当前节点 |

> **`ConfigList` 也退出**（PM 2026-11-17 与后端对齐后的最终口径，覆盖本节早先的保留建议）：`config_list` 命令保留给 UI 读回唯一配置，模型侧不再有列配置 / 切配置的工具；读配置与节点池统一走 `ConfigDetail`。系统提示词里凡引用 `ConfigList` 的句子要同批改掉。

## 6. 实现项与验收

**状态（2026-11-19 复核）**：第 1–5 项均已落地——`node_attach`（`services.rs:211`）、`config_create` 的 `config_exists` 拒绝（`services.rs:5508`）、`config_activate` / `config_delete` 退休返回 `only_config`（`services.rs:5758`）、种子刷新并入全局配置（`merge_seed_into_global`，`services.rs:4025`）、迁移合并（`merge_into_global`，`store/configs.rs:316`）、工具层退出（`tools/mod.rs:168`）、`CONTRACT_VERSION`（`envelope.rs:13`）。**第 6 项 C6 验收尚未执行**。

1. **后端命令**：`node_attach`（含懒创建与错误码）；`config_create` 的 `config_exists` 拒绝；`config_activate` / `config_delete` 的退休返回；`node_import_*` / `node_create` 省略 `configId` 时的懒创建 + 绑定；**`default_profile_refresh` / `CatalogRefresh` 刷新后把新种子节点并入全局配置**（与 `node_attach{source:"seed"}` 同语义，幂等、不改 `current_node_id`）——没有这一步，AI 首次配置选免费节点时无法把节点放进池子。
2. **后端迁移**（§3.6）：合并配置、按 `merge_key` 合并 issues、处理 `COUNT=1 AND is_active=0`、`layout` 随配置删除；事务内完成、幂等、在 UI 读配置之前。
3. **前端入口**：`App.tsx:1967`（attach）、`App.tsx:2001`（删掉 `deleteConfig`）、`App.tsx:590`（credentials + attach）、`App.tsx:604-616`（删掉 `selectConfig`）、`App.tsx:661`（`hasNodes`）、到期屏守卫；`useVpnSession.selectConfig/deleteConfig` 标记待清理。**2026-11-19 起服务器页不再发起连接**：「去连接」未连接时只 credentials + attach 后跳控制台并预选，非 idle 一条命令都不发（`App.tsx:601-643`；`commands.md` §4.0）。
4. **工具层**：`ConfigList` / `ConfigCreate` / `ConfigDelete` 退出（`ConfigActivate` 无工具入口）；系统提示词同步（`tools.md` §5.1、`prompt-design.md:315`）；前端 `TOOL_COPY` 映射表与 mock 剧本里的旧工具名同批删掉。
5. **实现侧版本常量同批升**：`src-tauri/src/tools/envelope.rs:13` 的 `CONTRACT_VERSION` 跟本批 `tools.md` 一起到 **3.18.0**（不是 3.17.5），断言它的 `boundary_tests.rs:542` 同步；`display.rs` 里没有版本常量（已核对），不涉及。另：`claurst_session/events.rs:11`、`runtime/manager.rs:19` 的 `2.16.2 → 2.17.0`（与 §5 `events.md` 2.17.0 一致）。这些不改，`check-contracts` 会一直挂 advisory。
6. **验收**：C6「试用 + 自建节点并存」——试用中建机、连接后节点池含两类节点；到期后种子节点消失、自建节点与当前节点保留、界面进连接舞台而不是到期屏；重复点同一台服务器的「连接」不再报错；到期时选中项回落写库。

## 7. 风险

- **连接参数只保留一套**：迁移会丢掉非激活配置的 `routing_mode` / `dns` / `tun_excludes`。多配置本来就是旧模型的中间态，但发布说明要写明。
- **issues 历史**：不重指就会随配置级联删除；迁移里先改 `config_id` 再删。
- **旧版本回滚**：迁移后再退回旧版本，旧版本会看到只有一套配置——可接受；不要写「降级即恢复多配置」。
- **AI 工具残留**：`ConfigCreate` 不退出，模型仍可能建第二套配置，把这次收敛重新打穿。工具层必须与命令层同批改。
- **issues 合并是启发式**：同键合并时取「任一 open 则 open」、severity 取高、`evidence_json` 保留目标行的。这会让一条已 resolved 的历史在另一配置仍开着时重新变为 open——语义上对（问题确实还开着），但会改变问题面板的计数，发布说明提一句。
- **并发兜底**：懒创建靠 `configs.name UNIQUE`，不是靠先查后插（§3.1）；多进程同时首次附加节点时只有一个能建行，另一个复用。

## 8. 验收

### 8.1 验收口径（产品锁定，2026-11-17，原文）

1. 试用节点和自建节点都存在同一个全局池子里，一起出现在节点卡上，凭「免费节点 / 你的服务器」来源区分，不分成两套配置。
2. 到期时只从池子里删掉试用节点，自建节点原样保留、**顺序不动**。
3. 到期时正连着试用节点 → 硬断开（不静默换网络）；当前选中的是试用节点但没连着 → 选中项回落到池里剩下的第一个（通常是自建节点）。
4. 自建节点永远不受到期影响，也不会因为买过服务器就提前结束试用。

### 8.2 四条口径怎么被满足

| 口径 | 落地 | 判定证据 |
|---|---|---|
| 1 | 单行 `configs` + 单份 `config_nodes`（§2）；节点卡按 `source` 标 `免费节点` / `owned` 标 `你的服务器`（§4）；`NodeSummary.source` 补 `"owned"`（§5） | 节点卡上两类节点同时可见、各自带来源标签；`SELECT COUNT(*) FROM configs` = 1 |
| 2 | 清理只 `DELETE` 种子关联、不重编号（§3.7 第 1 条）；渲染按 `position ASC` | 到期前后自建节点的显示顺序逐条相同；`position` 允许空号，不做连续化 |
| 3 | 是否断连只看 `RuntimeSnapshot.node_id` 是否属于被删集合；`current_node_id` 在事务内 UPDATE 到剩余 `position` 最小者，无剩余才 `NULL`（§3.7 第 2、3 条） | 到期后 `config_detail.current_node_id` 是自建节点（不是 `null`、不是界面猜的）；正连种子节点时 `trial-expired.disconnected = true`；正连自建节点时 `disconnected = false` |
| 4 | 试用只按 7 天计时；`ended_at` 只由 `expire_if_needed` 写；清理条件只认 `nodes.source = 'seed'` | 建机并连接后 `trial_status.state` 仍为 `active`、`remaining_ms` 继续减少；到期后 `owned` 节点行与其关联一条不少 |

### 8.3 验收场景

| # | 场景 | 期望 |
|---|---|---|
| 1 | 全新安装 → 试用 | `configs` 只有 1 行，节点池 2 条 |
| 2 | 试用中建机并连接 | 仍是同一行；节点池 3 条；当前节点为自建节点；免费节点仍可见可选 |
| 3 | 再点同一台服务器的「连接」 | 不报错、不新增配置；当前节点切回该服务器 |
| 4 | 试用到期且已有自建节点 | 种子节点从池中消失；自建节点与当前节点保留、顺序不变；进连接舞台，不是到期屏 |
| 5 | 到期时正连着自建节点 | 不断线；界面不切成到期屏 |
| 6 | 到期时正连着种子节点 | 硬断开；不自动连到自建节点；节点卡只剩自建节点，当前项是池里第一个 |
| 7 | 到期时选中种子节点但未连接 | 选中项写库回落到剩余第一个；界面无「已连接」残留 |
| 8 | 旧库多配置升级 | 启动后只剩 1 行，节点合并去重、相对顺序不变，`issues` 按 `merge_key` 合并后条数正确且无 UNIQUE 冲突，`layout` 只剩保留行的，`current_node_id` 有效 |
| 9 | 旧库只有 1 行但 `is_active = 0` | 启动后该行被置为激活；界面按有配置处理 |
| 10 | AI 尝试新建配置 | 被拒绝（`config_exists`），模型如实说明只有一套配置 |
