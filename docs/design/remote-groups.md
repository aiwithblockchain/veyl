# 远端节点组（node groups）

> 日期：2026-11-13
> 状态：已拍板（2026-11-14），可进入契约与实现；不改 `src/`
> 关联：`docs/design/my-servers.md`（§17 凭据代管）、`docs/data-model.md`、`docs/contracts/commands.md`、`events.md`、`tools.md`、`docs/configs-and-nav.md`

---

## 0. 结论先行

| # | 问题 | 结论 |
|---|---|---|
| 1 | 用户要不要 SSH / 节点凭据 | **不要。** 节点凭据由 cloud-init 生成、enrollment 回传控制面、客户端验签取用；界面没有 SSH、没有密码展示，用户不登录服务器（细节见 `my-servers.md` §17） |
| 2 | 实体关系 | **节点 ∈ 远端组 ∈ 配置**：一个配置绑定**恰好一个**组；一个组可被多个配置绑定；一个节点可属于多个组；组不嵌套 |
| 3 | 组的选择策略 | **M1 只做手动选节点**；自动最低延迟留字段、不给 UI、不实现 |
| 4 | 免费组 | 系统组，成员 = 种子节点，**只读**（不能改名 / 改成员 / 删除），只能被配置绑定；展示在自定义组之前。名称固定为 **`Veyl 免费节点`** |
| 5 | 配置换组 | **方案 A：配置内切换组**，不新建配置。已连接时只登记、不重连，下次连接生效（与切换配置同一套规则）；`config_launching` 期间拒绝 |
| 6 | 契约版本 | `commands.md` **3.0.0**、`events.md` **2.13.0**、`tools.md` **4.0.0**、`data-model.md` **6**（owner 见 §6） |
| 7 | 界面入口 | **组升格为一级 destination**：activity bar 第二项从 `服务器` 改为 `节点组`；左栏组列表（`免费` 段 → `我的组` 段），中间组详情；`我的服务器` 降为「添加节点」来源，并在组列表底部固定一行 `我的服务器`（安装中时带台数） |

一句话：**组是远端节点的集合，配置是客户端的一套方案；用户在配置里选组，就像现在选节点。**

> 2026-11-14 产品已拍板：IA 采用「节点组 destination」方案（`remote-groups-ui.md` §1.2）；免费组名固定为 `Veyl 免费节点`；激活不重连；控制面凭据风险按 `my-servers.md` §17.7 的「接受的残余风险」处理；服务器销毁后保留节点记录并标「服务器已销毁」。

---

## 1. 前提：凭据由控制面代管，用户不登录服务器

已核实：Vultr API 只给 `main_ip`（+ internal/v6），代理端口、加密方式、节点密码都是 cloud-init 生成后回传，Vultr 不知道也不需要。因此本设计与 `my-servers.md` §17 共同确立：

- 用户**没有**服务器登录通道；界面不出现 SSH、用户名、密码、公钥；
- 节点凭据只在「控制面 → 客户端」之间流转：cloud-init 生成 → enrollment（token 绑定 `server_id`、原子单次消费、限次重试）→ 控制面 KMS 加密 → 客户端取用并验签 → 写 `secrets.enc`（`node:<id>`）→ 内存丢弃；
- 节点坏了、装失败了、被改坏了，恢复路径只有**销毁重建**，不远程修；
- 平台侧不保留常驻运维 SSH 密钥；break-glass 走云厂商控制台并留审计（取舍见 `my-servers.md` §17.5）。

对组模型的影响：**节点对用户是「可用 / 不可用」的黑盒**。组只管理「哪些节点属于我」，不管理登录、不管理服务器运维。

---

## 2. 三个实体

```
                     ┌──────────────┐
   seed 刷新 ───────▶│  免费组（系统）│──┐
                     └──────────────┘  │      ┌────────┐
                                       ├─────▶│  node  │◀── owned（我的服务器）
                     ┌──────────────┐  │      └────────┘◀── url / manual（导入）
   用户创建 ────────▶│  自定义组     │──┘           ▲
                     └──────────────┘              │
                            ▲                      │ current_node_id
                            │ group_id             │（必须是组内成员）
                     ┌──────────────┐              │
                     │    config    │──────────────┘
                     └──────────────┘
```

| 实体 | 拥有什么 | 不拥有什么 |
|---|---|---|
| **node** | 地址、端口、method、凭据引用、来源（`seed` / `owned` / `url` / `manual`） | 不属于任何配置；不记录连接状态 |
| **组** | 名字、类型（免费 / 自定义）、成员与顺序、未来的选择策略 | 不拥有连接方式、分流、DNS、端口；不是「全局激活」对象 |
| **config** | 名字、连接方式、分流、DNS、内网排除、布局、当前节点、`group_id` | 不直接拥有节点集；节点集来自组 |

**一个节点可以同时属于多个组**（例如一台 Vultr 服务器既在「我的节点」又在「东京备用」）。组成员关系不是所有权，删组不删节点。

**组不嵌套。** 「组里再放组」会让「当前节点属于谁」变成一次递归解析，收益小、解释成本高。

---

## 3. 组的类型与规则

### 3.1 免费组（系统组）

- 固定一个：**`Veyl 免费节点`**，`kind = free`、`is_system = 1`，id 固定（客户端内置常量，不靠名字查）；组名保留，自定义组不得同名。
- 成员 = 当前种子里的节点。**种子刷新时就物化，按 `source_key` 幂等 upsert，单事务完成**（不做「打开 / 绑定」双触发，避免半物化）。种子缓存为空时绑定免费组 → `PRECONDITION_FAILED / seed_unavailable`，不是「空组」。
- **刷新失败或拉取结果为空时保留旧成员**（沿用现有「失败保留旧缓存」），不把已绑定组清空；只有成功且种子确实为空时才清空，此时绑定它的配置进入「组内没有可用节点」，连接按钮禁用并说明原因（§4.2）。
- **用户只能选中它，不能改它**：不能改名、不能加/删成员、不能删除。想只用其中几个节点 → 建一个自定义组，把需要的节点加进去。
- 由此**退役 `seed_node_exclusions`**：既然免费组不可改，就不再有「用户移除过的种子节点」这条路径（`data-model.md` 6 删除该表）。这是有意的简化，不是遗漏。
- 免费组永远排在组列表第一位，不可拖动排序。

### 3.2 自定义组

- 用户创建、改名、删除；成员可增删、可排序。
- 默认有一个 **`我的节点`** 组：第一次出现用户节点（Vultr 自建、链接/订阅导入、手动创建）时自动建立，所有用户节点自动加入。它和别的自定义组没有区别，**可以改名、移空、删除**。
- 可以包含任意来源的节点（免费种子节点、owned、url、manual）。节点在池里，就可以被加进任意自定义组。
- **允许存在未分组节点**：`我的节点` 被删或移空后，其节点回到池里的「未分组」；节点组 destination 左栏有 `未分组` 段（不是真组，不可绑定），可以把节点加进任意自定义组。**配置不能绑定空组**，所以未分组节点不能直接用于连接。
- **种子节点被加进自定义组后，不随种子删节点一起消失**：刷新发现某节点已不在种子里时，只把它从免费组摘除；只要它还在任一自定义组，`nodes` 行与自定义组成员都保留（用户明确留过它）。只有不属于任何自定义组时才删除 `nodes` 行。这样刷新永远不会悄悄清空自定义组。
- **删除组不删节点**：节点回到池里（`我的节点` 还在就留在那里，否则进 `未分组`）。若组正被配置绑定 → 拒绝删除，返回 `details.reason = "group_in_use"` 与占用它的 `config_ids`；用户先换绑再删。

### 3.3 选择策略：M1 只有手动

- 每个组有 `selection` 字段，M1 唯一合法值 `manual`：当前节点由用户在配置底部的节点下拉里选。
- `auto_latency`（自动最低延迟）**不实现、不给 UI、不写枚举白名单**。原因：
  1. 它与「连接中不悄悄换出口」直接冲突——自动换节点等于静默换网络，需要先定义「换之前是否提示、失败如何回退」；
  2. 需要探测历史、滞回与冷却，否则会在两个延迟接近的节点之间抖动；
  3. 换节点涉及 `selector` 热切换与运行时快照，先把手动路径做稳。
- 字段先留着，是为了将来加策略时不用再改表；应用层拒绝 `manual` 以外的值。

### 3.4 展示顺序

固定为：**免费组（系统组）→ 自定义组（按创建时间升序）**。组内节点按 `position` 排，用户看到的顺序就是这个顺序，不按延迟或名字重排。

---

## 4. 组与配置：配置内切换（方案 A）

### 4.1 三个方案

| 维度 | A. 配置内切换组 | B. 绑定死，换组新建配置 | C. 配置只绑「组类型」 |
|---|---|---|---|
| **用户心智** | 「这套配置用哪个节点组」＝现在「用哪个节点」的上一层，一致 | 每换一次服务器就多一套左栏配置；配置名与网络方案脱节 | 「组类型」不是用户概念；用户不知道当前到底用哪个组 |
| **连接连续性** | 切组只改绑定，不自动重连；下次连接生效，和切配置同一套规则 | 无问题，但用户要重新连接、重新选一套 | 组内容可变 → 同一配置两次连接可能走不同节点，无法解释 |
| **数据模型** | `configs.group_id` 一个外键；成员在组里；`current_node_id` 仍按配置 | 同 A，但多一层产品约束（创建后不可改） | 配置不存具体组，运行时解析；缓存、事件、排障都变复杂 |
| **契约复杂度** | 新增一个 `config_set_group`；`config-changed` 多一种 change | 不需要新命令 | 需要「组类型 → 实际组」的解析规则 + 失效处理，复杂度最高 |

### 4.2 结论：A

**配置可以换组，换组不新建配置。** 边界写死：

1. **组管节点集，配置管网络方案。** 换组只换「从哪些节点里选」，不改连接方式、分流、DNS、端口、布局。
2. **换组不是立即重连。** 未连接时：切完即生效，下次连接用新组。已连接时：只改绑定与 `current_node_id`，**不发任何运行时命令**；界面给一句轻提示「已切到 X 组，当前仍连着 Y」，下次连接生效——与 `config-switch.md` 的规则逐字同构。**连接启动在途（`config_launching`）时拒绝换组**，理由与 `node_switch` 相同：隧道已捕获旧节点，绑定分叉会连错。
3. **换组后 `current_node_id` = 新组第一个节点。** 新组为空 → 拒绝绑定（`PRECONDITION_FAILED / group_empty`）。
4. **组内容变化不影响正在进行的连接。** 用户从组里移除正在用的节点：DB 把 `current_node_id` 改成组内第一个剩余节点；若运行时正连着旧节点，连接不断，界面提示「当前连接：<旧节点>」，下次切换/重连生效。组空了且仍被配置绑定 → 拒绝用户移除最后一个节点。
5. **免费组与自定义组在「绑定」上没有区别**，区别只在能不能改成员。
6. **`current_node_id` 允许为 `null`。** 用户操作不能让绑定的组变空，但种子刷新可以：免费组里正在用的节点被刷新掉时，`current_node_id = null`，配置保留 `group_id`，连接按钮禁用并显示「组里还没有可用节点」；重新加入节点后自动落到第一个。
7. **服务器销毁后保留节点记录，不自动移出组、不改 `current_node_id`。** 节点标「服务器已销毁」；绑定的配置和组里的位置都保持原样。用户点连接时给明确错误「这台服务器已销毁，换一个节点或重新购买」，**不静默改用别的节点**（产品 2026-11-14 拍板）。用户可以在组详情里手动移除它；移除时若它是某配置的当前节点，按第 4 条回落到组内第一个剩余节点。
8. **hero 的「当前连接」取运行时快照，不取 `current_node_id`。** 运行时快照里的节点是隧道实际使用的节点；`current_node_id` 是「下次连接用哪个」。两者可以不同，这正是「已切到 X 组，当前仍连着 Y」能成立的原因。
9. **`config_launching` 期间禁止任何会改 `current_node_id` 的操作**（换组、移除成员），返回 `PRECONDITION_FAILED / config_launching`；连接启动完成或失败后恢复。

### 4.3 字段归属

| 属于配置（客户端） | 属于组（远端集合） | 属于节点 |
|---|---|---|
| 名称、连接方式、分流、DNS、内网排除、布局、`current_node_id` | 名称、类型、成员与顺序、选择策略（M1 手动） | 地址、端口、method、凭据引用、来源 |

设置页里「这套配置怎么连」不动；「用哪些节点」由组决定。**两者不混在一个表单里。**

---

## 5. 数据模型（`data-model.md` → 6）

### 5.1 新表

```sql
CREATE TABLE node_groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,           -- trim 后非空、≤ 40
    kind        TEXT NOT NULL CHECK (kind IN ('free', 'custom')),
    is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
    -- M1 只接受 manual；应用层白名单，不加 CHECK 枚举（与 nodes.method 同理）
    selection   TEXT NOT NULL DEFAULT 'manual',
    sort_order  INTEGER NOT NULL DEFAULT 0,     -- 仅自定义组之间使用
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE node_group_members (
    group_id TEXT NOT NULL REFERENCES node_groups (id) ON DELETE CASCADE,
    node_id  TEXT NOT NULL REFERENCES nodes (id)       ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, node_id)
);

CREATE INDEX idx_group_members_group ON node_group_members (group_id, position);
CREATE INDEX idx_group_members_node  ON node_group_members (node_id);
```

- 免费组：一行，`kind = 'free'`、`is_system = 1`、id 固定；应用层拒绝对它的写操作。
- 主键 `(group_id, node_id)` 保证同一节点在组里只有一条。
- 删节点 → 成员关系级联；若它是某配置的 `current_node_id`，外键置 `NULL`（与今天一致）。

### 5.2 `configs` 变更

```sql
ALTER TABLE configs ADD COLUMN group_id TEXT REFERENCES node_groups (id) ON DELETE SET NULL;
```

- 新写入路径要求 `group_id NOT NULL`；建库后由应用层校验。SQLite 加列无法直接加 NOT NULL，故用「应用层必填 + 外键」表达。
- 删组时若仍有配置绑定 → 命令层拒绝，不依赖 `SET NULL` 兜底；`SET NULL` 只防脏数据。
- `current_node_id` 的约束改为「必须是 `group_id` 对应组的成员」，应用层保证（数据库仍无法跨表表达）。

**`nodes` 增加销毁标记**（服务器销毁后节点保留，需要能区分可用与已销毁）：

```sql
ALTER TABLE nodes ADD COLUMN destroyed_at INTEGER;  -- NULL = 可用
```

- 服务器销毁时写时间戳；节点仍留在组里、`current_node_id` 不变。
- 连接校验：`destroyed_at IS NOT NULL` → `PRECONDITION_FAILED / node_destroyed`，文案「这台服务器已销毁，换一个节点或重新购买」。
- 用户手动移除节点 → 删行（原有级联照常）。

### 5.3 `config_nodes` 退役

`config_nodes` 的职责被 `node_group_members` 完全取代，且两处同时存在会产生「配置的节点集到底是哪一份」的二义性。**删除 `config_nodes` 表**，节点集只由组决定。

代价：两套配置不能再各挂一份独立的节点集——要不同就建两个组。这是有意的：组就是「可复用的节点集」，配置不再各存一份。

### 5.4 建库策略：重建 schema，不做历史迁移

现行存储机制是「`user_version` 与当前版本不符就清空所有表、重建 schema」（`data-model.md` §0、`store/migrations.rs`：`MIGRATIONS` 只有一份，`has_current_schema` 还写死检查 `config_nodes` / `seed_node_exclusions`）。**在这个机制下，设计一份「启动时一次性迁移」根本不会被执行**——加 002 迁移文件也仍会走 `reset_schema`。

产品当前没有真实用户，按既定策略办：

1. `data-model.md` 升到 **6**，`MIGRATIONS` 换成包含 `node_groups` / `node_group_members`、`configs.group_id`、`my_servers` 的新 schema；`has_current_schema` 的表名清单同步替换（去掉 `config_nodes` / `seed_node_exclusions`）。
2. 首次启动（或版本不符重建后）：只建系统免费组一行，**不物化成员**；种子刷新时再按 §3.1 物化。
3. 不建 `我的节点`，直到第一个用户节点出现（owned / url / manual）——避免空库里多一个空组。
4. 旧库里的配置与节点**按项目惯例清空**（与 `profiles` → `configs` 的处理一致），不做数据搬运。

代价：升级会丢本地配置与节点。因为还没有真实用户，这是更省的选择；如果将来有真实用户，再单独设计迁移并加验收，不把迁移逻辑混进这次。

### 5.5 约束汇总

| 表 | 约束 | 原因 |
|---|---|---|
| `node_groups` | `name UNIQUE`；系统组名保留 | 不重名；用户建同名 → `CONFLICT / name_taken`；用免费组名 → `INVALID_ARGUMENT / system_group_name_reserved` |
| `node_groups` | 系统免费组唯一（应用层） | 固定 id，重复即启动失败 |
| `node_group_members` | PK `(group_id, node_id)` | 组内不重复 |
| `configs` | `group_id` 应用层必填；删组前必须无绑定 | 不留悬空配置 |
| `configs` | `current_node_id ∈ group_id 的成员`，**允许为 `NULL`** | 组内没有可用节点时连接按钮禁用，不让用户点了没反应 |

---

## 6. 契约

> **版本策略（同批发布，推荐）**：`commands.md` **3.0.0**、`events.md` **2.13.0**、`tools.md` **4.0.0**、`data-model.md` **6**。
>
> - `events` 只是增量（新增 `node-group-changed`、`config-changed` 多一个 change 值，`node-list-changed` 不变），不需要大版本；2.13.0 同时容纳「我的服务器」的两个事件。
> - `data-model` 6 **由本设计当 owner**：节点 / 组 / 配置部分以本文为准；「我的服务器」在同一版里只贡献 `my_servers` 表与 `nodes.source = 'owned'`，不另起版本号。
> - `commands` 3.0.0 是破坏性的（`config_create/update` 换参、`config_nodes` 退役、`ConfigSummary` 加组字段）；`tools` 4.0.0 跟随同一批 schema。
> - **若产品决定先单独发「我的服务器」**：那份按 `2.22.0 / 2.13.0 / 3.12.0 / 6` 发；本设计顺延为 `commands` 3.0.0 / `events` 2.14.0 / `tools` 4.0.0 / `data-model` 7。

### 6.1 `commands.md` → 3.0.0

3.0.0 是**破坏性**的：`config_create` / `config_update` 的节点参数被 `groupId` 取代，`ConfigSummary` 增加组字段。

新增（UI 通道；AI 只读，见 §6.3）：

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `node_group_list` | `{}` | `{ groups: NodeGroupSummary[], free_group_id: string, ungrouped_count: number }` | 免费组在前，自定义组按创建时间 |
| `node_ungrouped_list` | `{}` | `{ nodes: NodeSummary[] }` | 未分组节点；仅 UI 通道，供设置页 `未分组` 段使用 |
| `node_group_detail` | `{ groupId }` | `NodeGroupDetail` | 含成员节点 |
| `node_group_create` | `{ name }` | `NodeGroupSummary` | 只能建自定义组；重名 → `CONFLICT / name_taken`；用系统组名 → `INVALID_ARGUMENT / system_group_name_reserved` |
| `node_group_rename` | `{ groupId, name }` | `NodeGroupSummary` | 系统组 → `FORBIDDEN / system_group`；重名 / 系统组名同上 |
| `node_group_delete` | `{ groupId }` | `{ deleted: true }` | 有配置绑定 → `CONFLICT / group_in_use`（附 `config_ids`）；系统组 → `FORBIDDEN` |
| `node_group_add_nodes` | `{ groupId, nodeIds[] }` | `NodeGroupDetail` | 系统组 → `FORBIDDEN`；已在组内的忽略 |
| `node_group_remove_nodes` | `{ groupId, nodeIds[] }` | `NodeGroupDetail` | 系统组 → `FORBIDDEN`；**连接启动在途（有绑定配置处于 `config_launching`）→ `PRECONDITION_FAILED / config_launching`**（与 `node_switch` 同一守卫）；会移除某绑定配置的当前节点时，先改 `current_node_id` 为剩余第一个；组将为空且仍被绑定 → `PRECONDITION_FAILED / group_would_be_empty` |
| `node_group_reorder` | `{ groupId, nodeIds[] }` | `NodeGroupDetail` | 必须恰好包含全部成员 |
| `config_set_group` | `{ configId, groupId }` | `ConfigDetail` | 空组 → `PRECONDITION_FAILED / group_empty`；**连接启动在途 → `PRECONDITION_FAILED / config_launching`**；已连接不发起运行时命令 |

类型：

```ts
type NodeGroupKind = "free" | "custom";

type NodeGroupSummary = {
  group_id: string;
  name: string;
  kind: NodeGroupKind;
  is_system: boolean;
  selection: "manual";          // M1 唯一取值
  node_count: number;
  used_by_config_count: number;
  created_at: number;
  updated_at: number;
};

type NodeGroupDetail = NodeGroupSummary & {
  nodes: NodeSummary[];         // 按 position
};
```

**既有命令的改动**：

| 命令 | 改动 |
|---|---|
| `config_create` | `source` / `nodeIds` **删除**，新增必填 `groupId`（免费组或自定义组）。种子来源就是免费组的 id |
| `config_update` | `nodeIds` **删除**；组绑定只走 `config_set_group`，一个命令一件事 |
| `config_list` / `config_detail` | `ConfigSummary` 新增 `group_id: string`、`group_name: string`；`node_count` 改读组内成员数 |
| `node_import_url` / `node_import_text` / `node_import_file` / `node_create` | `configId?` 改为 `groupId?`：给了就加入该组（系统组 → `FORBIDDEN`），没给就留在池里并确保在 `我的节点` 组。**AI 路径永远不传 `groupId`**（见 §6.3） |
| `node_switch` | 不变，但校验改为「节点属于该配置的组」且 `destroyed_at IS NULL`；已销毁 → `PRECONDITION_FAILED / node_destroyed` |
| `NodeSummary` | 新增 `destroyed: boolean`（读 `destroyed_at IS NOT NULL`）；`node-list-changed` 在服务器销毁 / 重建时照常发，UI 据此更新「服务器已销毁」标签 |

错误码沿用现有信封；新增 `details.reason`：`system_group`、`system_group_name_reserved`、`name_taken`、`group_in_use`、`group_empty`、`group_would_be_empty`、`group_not_found`、`config_launching`、`seed_unavailable`、`free_group_consent_required`、`node_destroyed`。

### 6.2 `events.md` → 2.13.0

- 新增 `node-group-changed`：

```ts
type NodeGroupChangedData = {
  change: "created" | "renamed" | "deleted" | "members_changed" | "reordered";
  group: NodeGroupSummary | null;   // deleted 时为 null
  affected_config_ids: string[];    // 绑定该组、且 node_count / current_node_id 可能变化的配置
};
```

- **成员变化的扇出**：`node_group_add_nodes` / `node_group_remove_nodes` / 种子刷新 / 服务器销毁除了发 `node-group-changed`，还要对 `affected_config_ids` 逐个发 `config-changed`（`change = "updated"`，载荷为新 `ConfigSummary`）。左栏节点数与底部节点卡都读 `ConfigSummary`，不扇出会长期显示旧数字。
- `config-changed` 的 `change` 增加 `"group_changed"`；载荷仍为 `ConfigSummary`，其中已有 `group_id` / `group_name`。
- `node-list-changed` 语义不变：节点物化、删除、凭据更新仍发它；组成员变化不重复发它。
- 不新增「组激活」事件：组没有被激活这回事，激活的是配置。

### 6.3 `tools.md` → 4.0.0

- 新增只读工具 **`NodeGroups`**：

  | 参数 | 返回 |
  |---|---|
  | `{ groupId? }` | 无 `groupId`：`{ groups: NodeGroupSummary[], free_group_id, ungrouped_count }`；有：`NodeGroupDetail` |

  用途：AI 回答「我有哪些节点组 / 这组里有什么」，以及在建议换组前确认组存在。**不返回节点密码、`password_ref`、KMS 标识或任何账户字段。**
- `ConfigCreate` / `ConfigUpdate` 工具参数同步改为 `groupId`，删除 `source` / `nodeIds`；`ConfigList` / `ConfigDetail` 输出增加组字段（随 commands 3.0.0 类型）。
- **免费节点同意门禁必须跟着搬家（硬规则）**：现在 `ConfigCreate(source: "seed")` 承担「用户必须逐字选过 `Veyl 免费节点（仅供试用）`」的门禁（`agent/questions.rs`、`tools/configs.rs`、`resources/prompts/zh/first-run.md`）。删掉 `source` 后，门禁改为 **`groupId == 免费组` 时同样要求本轮对话里用户明确选过该选项**，否则 `PRECONDITION_FAILED / free_group_consent_required`；`ConfigUpdate` 把组切到免费组时同样适用。不能因为换了个字段就让模型绕过。
- **AI 的导入路径不接触组**：`NodeImportUrl` / `NodeImportText` / `ConfigCreate` 里模型都不传 `groupId`；导入的节点只进池并自动进 `我的节点`。用户要把它们放进别的组，由界面操作。
- **不提供任何组写工具**（创建、改名、增删成员、删除、换组都不给模型）。理由与 `MyServers` 一致：这些动作改的是用户的远端资产边界，必须由用户在界面上点。将来若要开放，走确认卡，风险等级 `Execute`。
- `MyServers` 工具保持只读；其返回的 `MyServer` 增加 `group_ids: string[]`（这台服务器对应的节点在哪些组里），只读展示。

### 6.4 版本为什么要动大版本

`config_create` 从「传节点 id 数组」变成「传一个组 id」，`ConfigSummary` 增加组字段，`config_nodes` 表删除——这是数据模型层的替换，不是加字段。继续用 2.x 会让「2.22.0 的配置创建」和「3.0.0 的」在同一份契约里共存，前端必须写两套。按 `commands.md` 2.0.0 的先例，直接破。

---

## 7. 界面

### 7.1 一级入口：`节点组` destination

产品 2026-11-14 拍板：activity bar 第二项从 `服务器` 改为 **`节点组`**；组升为一级对象，`我的服务器` 不再占一个 destination。

| 区域 | 内容 |
|---|---|
| activity bar | `客户端` / `节点组` 两个图标，常驻 |
| 左栏 | 组列表：`免费` 段 → `我的组` 段；底部固定一行 `我的服务器`（安装中时 `我的服务器 · 安装中 N 台`）；最底 `设置` |
| 中间 | 选中组的详情：组头（名称、`当前节点组` 徽标、N 个节点）、节点列表、`测试全部`、`添加节点`、`设为当前节点组` |
| 右栏 | AI 对话，不变 |

```
┌────┬───────────────────────┬──────────────────────────────────────┐
│ ●  │ 节点组            ＋  │ Veyl 免费节点        [当前节点组]     │
│ ○  │                       │ 由 Veyl 维护，不能修改 · 12 个节点   │
│    │ 免费                  │                                      │
│    │ Veyl 免费节点         │ 节点                                 │
│    │ 12 个节点             │ ┌──────────────────────────────────┐ │
│    │ ─────────────         │ │ 东京 01  1.2.3.4:20343   32 ms   │ │
│    │ 我的组                │ │ 大阪 02  5.6.7.8:20343   58 ms   │ │
│    │ 上海 1 号             │ └──────────────────────────────────┘ │
│    │ 3 个节点              │                                      │
│    │                       │ [ 测试全部 ]      [ 添加节点 ]        │
│    │ 我的服务器 · 安装中 1 台│                                      │
│    │ 设置                  │                                      │
└────┴───────────────────────┴──────────────────────────────────────┘
```

**组列表**

- 段标题是分类名，不是组名：`免费` 段永远存在；`我的组` 段为空时写 `还没有自己的组` + ghost `新建组`。
- 标题右侧 `＋` 新建自定义组；免费组不能新建、不能改名、不能删。
- 行与配置行同构：名称 15/500，第二行 `N 个节点`，被激活时追加 ` · 当前节点组`；选中（正在看）仍是卡底 + 2px 钴蓝 + 名称 600。**「当前节点组」是文字，不是第二种选中态**。
- 免费组行只有 `查看`；自定义组悬停出现 `重命名` / `删除`；删组被配置绑定时先提示换绑，不提供「连同配置一起删」。
- `未分组` 段仅在有未分组节点时出现（`我的节点` 被删或移空后）；它不是组、不能绑定，只提供「加入节点组」。

**组详情**

- 头部：组名 17/600 + `当前节点组` 徽标（只读，文字 + 1px 描边）。
- 节点行：名称、地址:端口、method、延迟/上次探测；行内提供 `移除`（自定义组）或只读（免费组）。
- `测试全部` 复用现有 `node_probe_all`。
- **`设为当前节点组`**：只对「当前 active 配置」生效，按钮旁写一行小字 `会绑定到配置「<名字>」`，避免跨页副作用说不清。点击后按 §4.2：未连接立即生效；已连接只登记、不重连，toast「已切到 X 组，当前仍连着 Y」；`config_launching` 期间禁用并说明。
- `添加节点` 打开来源面板：`从我的服务器添加` / `粘贴链接或订阅` / `手动填写` / `用已有的节点`（池非空时）。

**底部固定行：我的服务器**

- 常驻在组列表底部、`设置` 上方，不随组列表滚动。
- 文案：没有在装时 `我的服务器`；有安装中的服务器时 `我的服务器 · 安装中 N 台`（N = `creating` / `booting` / `installing` / `verifying` 的数量）。
- 点击进入**中间区的服务器子视图**（§7.2），不是切换 destination；左栏仍是组列表，这一行保持高亮。

> 设置 › 连接里只保留一个 `管理节点组` 深链，点了跳到 `节点组` destination；设置页不再复制一套组管理界面。主路径永远是 activity bar。

### 7.2 我的服务器：中间区子视图

`我的服务器` 不再是一级入口，而是「添加节点」会经过的二级页，挂在节点组 destination 的中间区：

- 从组列表底部 `我的服务器` 或组详情的 `添加节点 → 从我的服务器添加` 进入。
- 中间先显示**服务器列表**（名称 · 地区 · 状态点），点一行进入**那台的详情**；`Esc` 回上一级，再点一次已激活的 `节点组` 图标回组根。**没有 `←` 返回按钮。**
- 左栏仍是组列表；点任意组即离开子视图，回到该组详情。
- 从某个组的 `添加节点` 进来时，服务器就绪后新建节点**自动加入那个组**，并回到该组详情；从底部行直接进来时，加入 `我的节点`（不存在则先建）。
- 服务器列表 / 详情 / 新建向导 / 四段进度的版式见 `my-servers.md` §7.2–§7.4；状态门控见 §7.4。**子视图里没有配置列表，也没有连接状态**。
- 安装中的服务器在子视图里显示完整四段进度；组列表底部那行只显示 `安装中 N 台` 的计数，两者由同一个 `my-server-changed` 驱动。

### 7.3 配置里换组：底部节点卡

控制台底部节点卡首行改为**组选择器 + 配置名**：

```
节点组  Veyl 免费节点 ▾     配置 · 家里
东京01 ▾   1.2.3.4:20343
[ 切换到此节点 ]  [ 测试连通 ]
```

- 组选择器列出：免费组、自定义组、末项 `管理节点组…`（切到 `节点组` destination，不跳设置）。
- 换组未连接：立即换；已连接：轻提示「已切到 X 组，当前仍连着 Y」，不断开、不重连。
- 节点下拉只显示当前组的节点。
- `当前连接：X` 的语义扩展到组：连接的是另一个组时，hero 第二行显示 `当前连接：<组名> · <节点名>`。**这两个值取运行时快照，不取 `current_node_id`**（§4.2 第 8 条）。

### 7.4 新建配置第 2 问

原来问「`Veyl 免费节点` / `其它节点`」，现在问「用哪个节点组」：

| 选项 | 行为 |
|---|---|
| `Veyl 免费节点` | 绑定免费组 |
| 选一个自定义组（含 `我的节点`） | 绑定该组 |
| `管理节点组…` | 切到 `节点组` destination，回来后继续 |
| `买一台服务器` / `其它节点` | 进 `节点组 → 添加节点 → 从我的服务器`；服务器就绪后节点自动进发起流程的组，回来时该组可选 |

**没有「不选组」的路径**：配置必须绑一个非空组，和今天「配置必须有节点」是同一条规则。

### 7.5 文案

- 用「节点组」，不用「远端组」「资源池」「集群」。
- 免费组标 `免费`，不写「官方」「系统」。
- 组内节点数写 `12 个节点`；不要写「成员」。
- 换组提示与换配置同构：「已切到 X 组，当前仍连着 Y」。

---

## 8. M1 不做什么

| 不做 | 原因 |
|---|---|
| 自动测速选优（`auto_latency`） | 见 §3.3；先把手动路径做稳 |
| 跨供应商 / 跨地区的自动故障转移 | 需要探测、门限与回退策略；失败时静默换出口违反现有原则 |
| 组嵌套 | 解析与解释成本高，收益低 |
| 组共享 / 导出 / 订阅组 | 没有需求；订阅导入仍产出节点，不产出组 |
| 组级分流规则、组级 DNS | 这些属于配置；组只回答「有哪些节点」 |
| 组级凭据 / 轮换 | 凭据在节点上，组只是引用 |
| 「全局激活某个组」 | 激活的是配置；组没有独立的激活态 |
| AI 写组（增删改、换绑） | 改远端资产边界必须由用户点；只给只读 `NodeGroups` |
| `未分组` 段 | `我的节点` 被删或移空后节点会变成未分组；设置页提供 `未分组` 段用于重新安置；配置不能绑定空组 |

---

## 9. 验收（编号 G1–G10）

| # | 用例 | 关键断言 |
|---|---|---|
| G1 | 免费组只读 | 免费组排第一、标 `免费`；没有重命名/删除/添加成员；尝试命令写 → `FORBIDDEN / system_group`；种子刷新时就物化/更新成员（按 `source_key` 幂等）；刷新失败或结果为空时保留旧成员；种子缓存为空时绑定 → `PRECONDITION_FAILED / seed_unavailable` |
| G2 | 自定义组生命周期 | 创建 → 改名 → 加节点 → 移除 → 删除；重名 → `name_taken`，用系统组名 → `system_group_name_reserved`；删组不删节点（未分组可见）；被配置绑定时删除 → `CONFLICT / group_in_use` 并列出配置 |
| G3 | 配置换组（未连接） | 换组立即生效；节点下拉只剩新组成员；`current_node_id` = 新组第一个；不发运行时命令；`config_launching` 期间 → `PRECONDITION_FAILED / config_launching` |
| G4 | 配置换组（已连接） | 换组只改绑定；连接不断、计时器不归零；toast「已切到 X 组，当前仍连着 Y」；hero 的当前节点来自运行时快照；下次断开重连走新组 |
| G5 | 组内移除当前节点 | `current_node_id` 改为剩余第一个；正在连接不中断；界面提示当前仍连着旧节点；移除最后一个且仍被绑定 → 拒绝；`config_launching` 期间同样拒绝 |
| G6 | 建库策略 | 升级后按 `user_version` 直接重建 schema：旧配置/节点被清空；新库有免费组、没有 `config_nodes` / `seed_node_exclusions`；首次用户节点出现时自动建 `我的节点`；不执行任何历史数据迁移 |
| G7 | 空组 | 用户绑定空组 → `PRECONDITION_FAILED / group_empty`；系统行为（种子清空 / 销毁）导致已绑定组为空时，`current_node_id = null`、连接按钮禁用并说明；新建流程无法跳过选组 |
| G8 | AI 只读与门禁 | `NodeGroups` 可列出组与成员；模型调用任何组写操作不存在；节点密码 / `password_ref` / KMS 标识不出现在工具结果；`ConfigCreate` 绑免费组但本轮用户没选过 `Veyl 免费节点（仅供试用）` → `PRECONDITION_FAILED / free_group_consent_required`；AI 导入不传 `groupId`，节点自动进 `我的节点` |
| G9 | 销毁服务器 | 节点记录保留并标「服务器已销毁」；**不自动移出组、不改 `current_node_id`**；连接时给明确错误，不悄悄换节点；用户手动移除后，若它是当前节点则回落到组内第一个 |
| G10 | 组列表底部 | 组列表底部固定一行 `我的服务器`；有 `creating` / `booting` / `installing` / `verifying` 的服务器时显示 `安装中 N 台`，随 `my-server-changed` 实时增减；点击进入中间区服务器子视图，左栏仍是组列表 |

---

## 10. 待核

1. 种子刷新即物化后，节点池规模与刷新耗时 / 上限（种子当前规模、未来增长）——影响刷新时延与节点列表长度。
2. 订阅导入的节点是否应自动按订阅名建组（M1 统一进 `我的节点`，M2 再考虑）。
3. `NodeSummary.source` 是否增加 `'free'` 与 `'owned'` 的展示映射（数据层已有 `seed` / `owned`，界面不显示来源词）。
4. 多组共享同一节点时，健康检查 / 探测结果是否按节点缓存（当前按节点，不按组）。

---

## 11. 文档影响

| 文档 | 改什么 |
|---|---|
| `docs/design/my-servers.md` | §17 整节改为「凭据由控制面管理，用户无 SSH」；§6.3/§6.4 去掉 SSH 用户、22 端口、SSH 凭据；§6.5 补安装时限与「销毁保留节点记录」；§7 详情去掉 SSH；§7.1 改为节点组 destination + 我的服务器子视图；§7.1.1 / §7.6 的 `config_create(node_ids)` 改为组模型；§9 去掉 SSH 密钥与日志项；§10 删除 `my_server_ssh_credentials`、标注 `data-model 6` owner；N1/N7 与 N13 同步 |
| `docs/data-model.md` | 6（本设计 owner）：新增 `node_groups` / `node_group_members`；`configs.group_id`；`nodes.destroyed_at`；删除 `config_nodes`、`seed_node_exclusions`；重建 schema、不写历史迁移 |
| `docs/contracts/commands.md` | 3.0.0：9 个组命令（含 `node_ungrouped_list`）+ `config_set_group`；`config_create/update` 参数替换；`ConfigSummary` 增组字段 |
| `docs/contracts/events.md` | 2.13.0：`node-group-changed`（含 `affected_config_ids`）+ 逐配置扇出 `config-changed`；`config-changed.change += group_changed` |
| `docs/contracts/tools.md` | 4.0.0：`NodeGroups` 只读；`ConfigCreate/Update/List/Detail` 参数与输出同步 |
| `docs/configs-and-nav.md` | §2/§3：配置不再直接挂节点集，节点集来自组；新建第 2 问改为选组 |
| `docs/design/simplified-config-create.md` | 第 2 问的选项与文案 |
| `docs/design/remote-groups-ui.md` | 并行 UI 稿：产品 2026-11-14 已采用其「节点组 destination」信息架构，本文 §7 与其一致；底部 `我的服务器` 行的台数文案以本文为准 |
| `docs/testing/e2e-acceptance.md` | 新增 G1–G10；退役与新模型冲突的节点集用例 |
| `.claude/skills/veyl-ui/SKILL.md` | activity bar 第二项改 `节点组`；左栏组列表 + 底部 `我的服务器` 行；服务器为中间子视图；控制台底部组选择器；删掉 SSH 相关入口 |