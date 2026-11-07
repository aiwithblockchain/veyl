# 数据模型

> 版本：`4`（对应契约 `commands.md` 2.13.0 / `runtime.md` 2.4.0）
> 日期：2026-11-03
> 范围：配置、节点、问题、布局，以及它们与 `secrets.enc`、种子缓存的关系
> 依据：`docs/configs-and-nav.md` §3、§8，`docs/config-execution.md` §6–§10，`docs/issue-management.md` §3、`docs/center-panel.md` §3
> 状态：待 PM 审核（批 0）

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| 旧 `profiles` 表怎么办 | **直接删除，重建**。不迁移、不兼容、不留只读视图 |
| 数据库文件怎么办 | **整体重建**。`user_version` 代际不一致时清空所有表再建新 schema；对话历史一并丢弃 |
| 密码存哪 | **只在 `secrets.enc`**。SQLite 里只存键名 `node:<node_id>` |
| 时间戳 | **全部 Unix 毫秒整数**（`INTEGER`） |
| 节点与配置的关系 | **多对多**。一个节点可被多套配置引用（`config_nodes`） |
| DNS 与内网排除 | **JSON 列**，不建子表（理由见 §3.1） |
| 问题的身份 | `config_id + kind + target` 三元组唯一；同类问题只加计数，不新建行 |

**为什么不做迁移**：产品还没有用户，旧数据没有价值；兼容层会带来一整套临时分支与双写，而它们最终都要删（`docs/implementation-plan.md` §1）。这是刻意选择，不是遗漏。

---

## 1. 通用约定

| 项 | 规则 | 理由 |
|---|---|---|
| 数据库文件 | `<app_data_dir>/veyl.db` | 与现有实现一致 |
| 连接参数 | `PRAGMA journal_mode = WAL`、`PRAGMA foreign_keys = ON` | 外键约束是本模型正确性的一部分，不是可选项 |
| schema 代际 | `PRAGMA user_version` = 迁移脚本序号 | 现有 `migrations.rs` 已按此判断是否需要重建 |
| 主键 | `TEXT`，前缀 `cfg_` / `nod_` / `iss_` | 可读、可日志、跨表不会混用 |
| 时间 | `INTEGER`，Unix **毫秒** | 与 `commands.md` §1.5 一致；秒/毫秒混用会静默出错 |
| 布尔 | `INTEGER` + `CHECK (x IN (0,1))` | SQLite 没有原生 boolean |
| 字符串大小写 | 名称比较用 **trim 后逐字节**比较 | 中文没有大小写；英文配置名「Home」与「home」视为不同是用户能理解的 |
| JSON 列 | 存**规范化后的 JSON 文本**，读取时反序列化为强类型 | 不存 `NULL` 表示「空」，存 `'[]'` / `'{}'`；`NULL` 只表示「这一列还没有值」 |
| 外键删除行为 | 见每张表；原则：**子数据随父数据走，共享数据不动** | 删配置不该删节点池 |

**时间戳的唯一来源**：`store::db::now_ms()`。任何模块不得自己 `SystemTime::now()` 后算毫秒，否则测试里无法注入时间。

---

## 2. 存储边界

| 内容 | 存哪 | 为什么 |
|---|---|---|
| 配置、节点（不含密码）、关系、布局、问题、种子元数据 | SQLite | 需要查询、排序、约束 |
| 节点密码 | `secrets.enc` 的 `node:<node_id>` | 明文密码永不落盘 |
| AI 服务商 Key | `secrets.enc` 的 `provider:<provider_id>` | 同上 |
| 种子原文（含全部节点密码） | `secrets.enc` 的 `seed:<content_sha256>` | 种子整包加密缓存，SQLite 只留哈希与元数据 |
| 预置资源（提示词、规则集） | **文件**，随包预置 | 产品资产，跟 APP 版本走，不进数据库 |
| 渲染出的 sing-box 配置 | **临时文件** | 每次连接生成、断开即删；不进库 |

三个存储之间**没有分布式事务**。跨存储写入一律采用「先写不可回滚的一侧，失败时补偿删除」的顺序，见 §5.3。

---

## 3. 表定义

以下 DDL 是 `src-tauri/src/store/migrations/001_init.sql` 的目标形态。**实现以本文件为准**；与当前未提交代码的差异集中列在 §8。

### 3.1 `configs` — 一套配置

```sql
CREATE TABLE configs (
    id                TEXT PRIMARY KEY,
    -- 用户起的名字。trim 后非空、≤ 40 字符；不允许重名。
    name              TEXT NOT NULL UNIQUE,
    -- system_proxy：只给代理地址（系统代理 + mixed 入站）
    -- tun：          接管全部流量（批 5）
    connection_mode   TEXT NOT NULL CHECK (connection_mode IN ('system_proxy', 'tun')),
    -- direct：本地直连 / proxy_all：全部走 VPN / proxy_selected：指定服务走 VPN（批 3）
    routing_mode      TEXT NOT NULL CHECK (routing_mode IN ('direct', 'proxy_all', 'proxy_selected')),
    -- ⚠️ 废弃：仅保留旧数据 / 回滚；连接不再读它。本地代理端口来自 settings.proxy_port。
    -- tun 模式恒为 NULL——接管全部不需要代理端口。
    listen_port       INTEGER CHECK (listen_port BETWEEN 1 AND 65535),
    -- DNS 候选：{"mode":"auto"|"custom","local":[...],"remote":[...]}
    -- remote 是「经代理查询」的境外候选。
    dns_json          TEXT NOT NULL DEFAULT '{"mode":"auto","local":[],"remote":[]}',
    -- TUN 内网排除网段（用户补充的部分）。固定网段表在生成器里，不进库。
    tun_excludes_json TEXT NOT NULL DEFAULT '[]',
    -- 「指定服务走 VPN」的分类 id 数组；其它模式为空数组。
    route_targets_json TEXT NOT NULL DEFAULT '[]',
    -- 分流目标 / 自定义规则每次变更 +1；与运行时快照的 applied_route_revision 比较。
    route_revision    INTEGER NOT NULL DEFAULT 0,
    -- 当前节点。节点被删时由外键置 NULL，不阻止删除。
    current_node_id   TEXT REFERENCES nodes (id) ON DELETE SET NULL,
    is_active         INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    last_used_at      INTEGER
);

-- 同一时刻只允许一套激活配置。数据库层兜底，不依赖应用逻辑。
CREATE UNIQUE INDEX idx_configs_one_active ON configs (is_active) WHERE is_active = 1;
CREATE INDEX idx_configs_last_used ON configs (last_used_at DESC);
```

| 列 | 规则 |
|---|---|
| `listen_port` | **已废弃**：仅旧数据与回滚使用，连接不再读。本地代理端口只有一个来源——`settings.proxy_port`（默认 7890）。`tun` 行必须 `NULL` |
| `dns_json` | 空数组 = 「按国家自动选」，**不预填常量**。常量会被当成用户的选择，从此不跟随国家变化 |
| `tun_excludes_json` | 只存**用户补充**的网段；`10.0.0.0/8` 等固定排除表写死在生成器，避免每行配置重复一份 |
| `route_targets_json` | 分类 id 数组，仅 `routing_mode = 'proxy_selected'` 使用；空数组表示还没选目标 |
| `route_revision` | 单调递增；改 `targets` 或增删自定义规则时 +1。不是版本历史，只是「当前连接是否已应用」的比较基准 |
| `current_node_id` | 必须是该配置节点集里的成员（应用层保证；数据库无法表达「在同一配置的 config_nodes 里」） |
| `is_active` | 部分唯一索引保证至多一个 |

**为什么 DNS 与内网排除用 JSON 列而不是子表**

PM 裁定（OPEN-06）用 JSON，理由与本模型一致：

1. 它们是**一套配置的一组值**，整体读写、整体校验、整体替换，**没有独立生命周期**——不存在「这条 DNS 候选属于哪个配置」之外的问题，也不会单独创建/删除其中一条。
2. **从不跨配置查询**。没有「哪些配置排除了 10.0.0.0/8」这种需求；建子表只会多两次 join。
3. 数量固定且小（DNS ≤ 3 + 2，网段 ≤ 32），子表的扩展性收益为零。
4. 生成 sing-box 配置时就是一次性读取整组，不存在增量合并。

**什么时候应该改回子表**：一旦出现「按网段反查配置」「单条规则单独启停」「规则共享」这类需求。到那时再迁移，成本远低于现在提前拆表。

### 3.2 `nodes` — 节点

```sql
CREATE TABLE nodes (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    server       TEXT NOT NULL,
    port         INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    method       TEXT NOT NULL,
    -- secrets.enc 里的键，固定为 'node:' || id。明文密码永不落库。
    password_ref TEXT NOT NULL,
    -- 来源只影响去重与刷新策略，不影响使用
    source       TEXT NOT NULL CHECK (source IN ('seed', 'url', 'manual')),
    -- 去重键：sha256(name \x1f server \x1f port \x1f method) 的十六进制。
    -- seed 刷新按它 upsert；URL 导入按它判重。手动创建的节点也计算，便于将来合并。
    source_key   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

-- 同一来源内不允许重复节点；不同来源可以有同名同地址的两条（用户可能故意分开）。
CREATE UNIQUE INDEX idx_nodes_source_key ON nodes (source, source_key);
CREATE INDEX idx_nodes_server ON nodes (server, port);
```

- **密码不在本表**。`password_ref` 是冗余列（等于 `'node:' || id`），但显式存下来是为了让「凭据在外部」这件事在 schema 里看得见，而不是靠命名约定。
- `method` **不加 CHECK 枚举**：Shadowsocks 方法列表会随 sing-box 版本增长，白名单是应用层常量（`nodes::SUPPORTED_METHODS`）。把白名单写进 CHECK，每次扩列表都要重建表。
- `server` 允许域名与 IP；手动模式**允许私网地址**（用户可能连自己的内网服务器）。私网限制只加在 `node_import_url` 的抓取侧（SSRF），不加在数据层。

### 3.3 `config_nodes` — 配置与节点的多对多

```sql
CREATE TABLE config_nodes (
    config_id TEXT NOT NULL REFERENCES configs (id) ON DELETE CASCADE,
    node_id   TEXT NOT NULL REFERENCES nodes (id)   ON DELETE CASCADE,
    position  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (config_id, node_id)
);

CREATE INDEX idx_config_nodes_config ON config_nodes (config_id, position);
CREATE INDEX idx_config_nodes_node   ON config_nodes (node_id);
```

- `position` 决定中间底部节点下拉的顺序；**用户看到的就是这个顺序**，不由名字或创建时间重排。
- 主键 `(config_id, node_id)` 保证同一节点不会在一套配置里出现两次。
- 删配置 → 关系级联删除，**节点保留**（节点是共享池）。
- 删节点 → 关系级联删除；若它是某配置的 `current_node_id`，外键置 `NULL`。

### 3.4 `layout` — 中间区域编排布局

```sql
CREATE TABLE layout (
    config_id    TEXT PRIMARY KEY REFERENCES configs (id) ON DELETE CASCADE,
    revision     INTEGER NOT NULL DEFAULT 1,
    layout_json  TEXT NOT NULL,
    updated_at   INTEGER NOT NULL
);
```

```json
{ "version": 1, "blocks": [ { "type": "empty_hint" }, { "type": "reachability", "props": { "targets": ["ChatGPT"] } } ] }
```

| 列 | 规则 |
|---|---|
| `revision` | 每配置单调递增。UI 收到 `revision <= 当前` 的 `layout-updated` 时丢弃 |
| `layout_json` | 只存**整份通过校验**的布局。块未知、重复、props 非法或含不安全字符时，**整份丢弃**：不写库、不发事件、保留旧布局、记日志。**不逐块过滤** |

- 一套配置一份布局。切配置时布局随 `config_detail` 返回，不额外查询。
- **`revision` 同时随 `config_detail` 返回**（`ConfigDetail.layout_revision`）：UI 用它丢弃同配置内的迟到事件（`revision <= 当前` 即忽略）。只靠事件的 `config_id` 只能挡住跨配置的迟到，挡不住同一配置内「先发后到」，那时中间区会闪回上一版。`config_detail.layout` 为 `null` 时 `layout_revision` 也为 `null`。
- **不逐块过滤非法块**（PM 裁定，2026-11-06）：逐块过滤会让中间区呈现一个模型没打算要的构成——比如把 `issue_card` 滤掉，用户就少了自救入口，而且没有任何提示。所以校验是原子的：整份合法才写，否则不覆盖旧布局。
- **「空布局」与「没有布局」是两件事**（PM 裁定）：
  - `layout` 有行且 `blocks = []` → AI 明确选择「中间什么都不放」。合法，保留。
  - `layout` 没有行 → 还没编排过，UI 按本地规则渲染（固定骨架之外不插块）。
  - 因此 `config_detail.layout` 为 `null` 时才表示「还没编排」，不要用空数组表达同一件事。
- **本地规则插入的 `issue_card` 不写这张表**：故障卡是叠加渲染，不是布局的一部分。这样 AI 编排不会被故障覆盖，故障消失后布局也自动恢复原样。
- 没有 AI 的用户（`docs/center-panel.md` §5）不会产生行；缺行是正常状态。

### 3.5 `issues` — 问题记录

```sql
CREATE TABLE issues (
    id             TEXT PRIMARY KEY,
    -- 合并键：coalesce(config_id,'') \x1f kind \x1f target。同类问题只有一行。
    -- 单独成列是因为 SQLite 的 UNIQUE 把多个 NULL 视为互不相同，
    -- 而全局问题（如 helper_missing）的 config_id 就是 NULL。
    merge_key      TEXT NOT NULL UNIQUE,
    -- 配置被删时，挂在它上面的问题一并删除：配置都没了，诊断没有意义。
    -- 全局问题（config_id IS NULL）不受影响。
    config_id      TEXT REFERENCES configs (id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,          -- dns_fail / no_route / auth_failed / tun_denied / ...
    target         TEXT NOT NULL DEFAULT '', -- 目标域名 / 节点 id / 空串
    -- PM 裁定（OPEN-05）：严重度统一 P0 / P1 / P2
    severity       TEXT NOT NULL CHECK (severity IN ('P0', 'P1', 'P2')),
    -- PM 裁定：状态统一 open / handed_off / resolved / ignored
    status         TEXT NOT NULL CHECK (status IN ('open', 'handed_off', 'resolved', 'ignored')),
    mode           TEXT NOT NULL CHECK (mode IN ('system_proxy', 'tun')),
    -- Host 按 kind 从固定文案表取，不接受外部传入
    title          TEXT NOT NULL,
    occurrences    INTEGER NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
    first_seen_at  INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL,
    -- 采集时就生成并保存的结构化诊断包（已脱敏）
    evidence_json  TEXT NOT NULL,
    session_id     TEXT REFERENCES chat_sessions (id) ON DELETE SET NULL,
    last_handoff_at INTEGER,
    resolved_at    INTEGER
);

CREATE INDEX idx_issues_status ON issues (status, severity, last_seen_at DESC);
CREATE INDEX idx_issues_config ON issues (config_id, status);
```

**合并规则（J1，唯一的写入口）**

```
命中 merge_key 的已有行：
  occurrences += 1
  last_seen_at = now
  title / evidence / mode 用最新一次覆盖
  severity 取两者中更严重的（P0 > P1 > P2）
  status = 'open'（原为 resolved / ignored 时即为「重开」）
未命中：插入新行，status = 'open'
```

- **一次问题只有一行**。用户看到的「这个问题第 3 次出现了」就是 `occurrences`。
- `status` 的流转只能是：`open → handed_off → (resolved | open)`、`open → ignored → open`。没有 `deleted`——不提供删除接口。
- `resolved_at` 只在置 `resolved` 时写；重开时清空。
- `mode` 记录问题发生时的连接方式，不是当前配置的方式——配置可能已经被改过。
- `evidence_json` 在采集时生成（`docs/issue-management.md` §5），不是转交时现采。

**为什么 `merge_key` 单独成列**：`UNIQUE(config_id, kind, target)` 在 `config_id IS NULL` 时不会合并——SQLite 认为每个 NULL 都不同。把 NULL 归一化成空串放进 `merge_key`，全局问题也能正确合并。

**为什么 `config_id` 是 CASCADE 而不是 SET NULL**：`SET NULL` 会让配置删除后它的问题变成「全局问题」，继续出现在问题列表里并可能插卡；而它描述的对象已经不存在，用户点了也修不了。删配置是用户明确的动作，其诊断记录随之消失是可接受的。全局性问题（helper 未安装等）本来就不带 `config_id`，不受影响。

### 3.6 `seed_cache` — 种子元数据

```sql
CREATE TABLE seed_cache (
    id                INTEGER PRIMARY KEY CHECK (id = 1),  -- 单行
    content_sha256    TEXT NOT NULL,     -- 变化判定的唯一依据
    etag              TEXT,              -- 条件请求用，可为空
    source_version    TEXT,              -- 文件里的 version，仅展示
    source_updated_at TEXT,              -- 文件里的 updated_at，仅展示
    node_count        INTEGER NOT NULL,
    fetched_at        INTEGER NOT NULL,  -- 上次成功拉取
    checked_at        INTEGER NOT NULL   -- 上次检查（含 304 / 失败）
);
```

- 种子原文**不进本表**：含全部节点密码，整包加密存 `secrets.enc` 的 `seed:<content_sha256>`。
- 种子里的节点**不会自动进入 `nodes`**。只有当用户创建 `source = "seed"` 的配置时，才解密种子并把节点物化进节点池（`source = 'seed'`），避免从未使用的种子在节点列表里出现。
- 刷新时按 `source_key` upsert；新种子里不存在的 seed 节点被删除，其在配置里的关系随之级联。

### 3.7 `seed_node_exclusions` — 用户移除过的种子节点

```sql
CREATE TABLE seed_node_exclusions (
    source_key  TEXT PRIMARY KEY,
    name        TEXT,
    excluded_at INTEGER NOT NULL
);
```

- **按 `source_key` 全局生效，不按配置。** 用户在任意一套配置里移除某个种子节点，就记一条；种子刷新 / 首次物化时跳过它。
- `source_key` 与 `nodes.source_key` 同构：`sha256(name \x1f server \x1f port \x1f method)`。同一节点在 `nodes` 里可能因来源不同有多行，但排除只影响**种子物化**这一条路径；URL 导入与手动创建不受影响。
- 不写 `ON DELETE`：`nodes` 里没有对应行也能存；它记的是「用户不想要」，不是「这条节点存在」。
- `name` 只用于将来设置页展示，可为空。
- 没有「恢复」接口：排除是用户明确的动作，本期不做撤销；将来要恢复就加一个显式命令，而不是在下一次刷新时悄悄放回来。

### 3.8 `config_rules` — 用户自定义分流规则

自定义规则有**独立生命周期**（逐条增删、排序、单独撤销），与 DNS/内网排除不同，因此建子表而不是 JSON。

```sql
CREATE TABLE config_rules (
    id          TEXT PRIMARY KEY,               -- rul_<16 hex>
    config_id   TEXT NOT NULL REFERENCES configs (id) ON DELETE CASCADE,
    action      TEXT NOT NULL CHECK (action IN ('proxy', 'direct')),
    match_type  TEXT NOT NULL CHECK (match_type IN
                  ('domain', 'domain_suffix', 'domain_keyword', 'ip_cidr', 'category')),
    value       TEXT NOT NULL,
    note        TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_config_rules_unique
    ON config_rules (config_id, action, match_type, value);
CREATE INDEX idx_config_rules_order ON config_rules (config_id, position);
```

| 列 | 规则 |
|---|---|
| `match_type = 'category'` | `value` 存**分类 id**（如 `openai`），不存 `.srs` tag。规则集 tag 由 `categories.json` 解析，分类目录升级后不影响已存的规则 |
| `position` | 生成 `route.rules` 的顺序；删除不重排，留空不影响顺序 |
| 重复 | 同一 `(config_id, action, match_type, value)` 不允许两条 |
| 删除 | 随配置级联；不随种子/规则数据更新变化 |

### 3.9 `rules_state` — 规则数据状态（单行）

```sql
CREATE TABLE rules_state (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    active_version    TEXT NOT NULL,       -- 目录名，如 "2026-11-03.1"
    manifest_sha256   TEXT NOT NULL,
    bundled_version   TEXT NOT NULL,       -- 随包基线
    geosite_tag       TEXT,
    geoip_tag         TEXT,
    item_count        INTEGER NOT NULL,
    total_bytes       INTEGER NOT NULL,
    applied_at        INTEGER NOT NULL,
    checked_at        INTEGER,
    pending_update    INTEGER NOT NULL DEFAULT 0 CHECK (pending_update IN (0, 1))
);
```

- 规则文件本身在磁盘（`app_data/rules/<version>/`），**不进库**。
- `pending_update = 1`：未连接时排队的更新，下次连接成功后执行。
- `bundled_version` 用于区分「随包基线」与「联网更新过的版本」。

### 3.10 保留的基础设施表

这些表与「配置」格式无关，2.0 原样保留，不在本批改动范围：

| 表 | 作用 |
|---|---|
| `settings` | `key`/`value`。已知键：`llm_active_provider`、`proxy_port`（本地代理端口，十进制字符串；缺失/损坏时读回 `7890`，读不写库）。旧 `onboarding_completed` 随引导页删除，无写入方 |
| `runtime_versions` | 已安装的 sing-box 版本与状态 |
| `proxy_backup` | 系统代理备份，E3 重置网络的依据；单行 |
| `catalog_cache` | 远端目录缓存（AI 工具仍可读；`catalog_list_nodes` 命令已删除） |
| `chat_sessions` / `chat_messages` | AI 会话与消息 |
| `tool_calls` | 工具调用审计。**没有外键**——`chat_delete` 必须显式删，见 `commands.md` §9.3 |

---

## 4. 索引与约束汇总

| 表 | 约束 / 索引 | 保证什么 |
|---|---|---|
| `configs` | `name UNIQUE` | 不允许重名 |
| `configs` | 部分唯一 `(is_active) WHERE is_active = 1` | 至多一套激活配置 |
| `configs` | `(last_used_at DESC)` | 左栏排序 |
| `nodes` | 唯一 `(source, source_key)` | 同来源不重复导入 |
| `nodes` | `(server, port)` | 连通性探测与排障查询 |
| `config_nodes` | PK `(config_id, node_id)` | 一套配置里节点不重复 |
| `config_nodes` | `(config_id, position)` / `(node_id)` | 下拉排序 / 反查引用 |
| `layout` | PK `config_id` | 一套配置一份布局 |
| `issues` | `merge_key UNIQUE` | 同类问题合并 |
| `issues` | `(status, severity, last_seen_at DESC)` | 问题列表与插卡选择 |
| `issues` | `(config_id, status)` | 按配置筛选 |
| `config_rules` | 唯一 `(config_id, action, match_type, value)` | 不允许重复规则 |
| `config_rules` | `(config_id, position)` | 规则顺序 |
| `seed_node_exclusions` | PK `source_key` | 同一节点只排除一次 |

**外键必须真正生效**：`PRAGMA foreign_keys = ON` 在每个连接上设置。SQLite 的默认值是 OFF，漏设时所有级联删除都会静默失效——表现为「删了配置，config_nodes 还在」。

---

## 5. 与 `secrets.enc` 的关系

### 5.1 键空间

| 键 | 值 | 写入方 | 删除时机 |
|---|---|---|---|
| `node:<node_id>` | 节点密码（明文，仅在加密文件内） | `node_create` / `node_import_url` / 种子物化 | 节点行删除后 |
| `provider:<provider_id>` | AI 服务商 API Key | `llm_provider_save` / `deepseek_save_key` | provider 删除后 |
| `seed:<content_sha256>` | 种子原文 JSON | 种子刷新 | 新哈希写入成功后删旧键 |

**只有这三类键。** 不允许把配置、日志、诊断包写进 `secrets.enc`——它是密钥容器，不是第二个数据库。

### 5.2 不变量

1. **SQLite 里永远不出现密码明文**。`nodes` 表没有密码列；错误信息、日志、事件载荷同样不含。
2. **`password_ref` 与 `node_id` 同生同灭**。`password_ref` 不指向不存在的键（写入顺序见 §5.3）。
3. **种子节点与手动节点没有区别**：物化后都是 `nodes` 行 + `node:<id>`，生成配置时走同一条取密码路径。

### 5.3 跨存储写入协议

没有跨存储事务，因此固定顺序 + 补偿：

| 操作 | 顺序 | 失败处理 |
|---|---|---|
| 创建节点 | ① 写 `secrets.enc` → ② 事务写 `nodes` + `config_nodes` | ② 失败 → 删除 ① 写的键；删除失败只记日志（孤儿密钥无害，见 §5.4） |
| 删除节点 | ① 事务删 `nodes`（关系与 `current_node_id` 级联）→ ② 删 `secrets.enc` 的键 | ② 失败只记日志；下次启动清扫 |
| 种子刷新 | ① 写新 `seed:<hash>` → ② 事务改 `seed_cache`、upsert/删除 seed 节点 → ③ 删旧 `seed:<hash>` | 任一步失败保留旧缓存与旧键；不产生半新半旧 |
| 删配置 | 单事务删 `configs`（关系、布局、问题、`secrets` 不涉及） | 节点与密码不动 |

**永远先写不可回滚的一侧**：多一个孤儿密钥是可清理的；多一行指向不存在密钥的节点是用户会踩到的坏状态。

### 5.4 孤儿密钥清扫

应用启动时（非关键路径）做一次：

- 枚举 `secrets.enc` 里 `node:` 前缀的键，凡是不在 `nodes.id` 中的删除。
- 枚举 `seed:` 前缀，凡是不等于当前 `seed_cache.content_sha256` 的删除。
- 失败只记日志，不阻塞启动。

> 若 `secrets` 模块无法枚举键，则跳过清扫。孤儿密钥不暴露给任何人，只是占用磁盘；**不能为了清扫而阻塞或回滚启动**。

---

## 6. 旧 `profiles` 表如何处理

**结论：直接删除，不做任何迁移。**

| 对象 | 处置 |
|---|---|
| `profiles` 表及其索引 | 删除 |
| `default_profile` 表 | 删除 |
| `store/profiles.rs` | 删除 |
| `store/default_profile.rs` | 删除 |
| `default_profile.rs`（解析 `bootstrap.json` 的那套） | 删除；只保留 HTTPS 抓取能力（迁到 `public_http`） |
| `seed_import.rs` | 删除，由 `nodes.rs` + `seed.rs` 取代 |
| 迁移脚本 `002` / `003` / `004` | 删除；只留一份 `001_init.sql` |
| 数据库里的历史对话 | **一并丢弃** |

**重建方式**（与 `src-tauri/src/store/migrations.rs` 现状一致）：

```
读 user_version
  ├─ 等于当前迁移数，且 6 张新表都在 → 直接用
  └─ 否则 → 删除所有用户表 → user_version = 0 → 执行 001_init.sql
```

- 判断「是否已是新 schema」用**表名清单**（`configs` / `nodes` / `config_nodes` / `issues` / `layout` / `seed_cache`），不是只看版本号——版本号在开发期会被反复重置，表存在与否更可靠。
- **不写 `ALTER TABLE` 迁移**。旧库没有任何东西值得保留；写一份迁移脚本的测试成本高于重建。
- 用户不会看到「正在迁移数据」的界面。第一次启动就是空库，走空态。

---

## 7. 与契约的对应

| 表 | 读它的命令 | 写它的命令 | 事件 |
|---|---|---|---|
| `configs` | `config_list` / `config_detail` / `runtime_status` | `config_create` / `config_update` / `config_delete` / `config_activate` / `node_switch`（改 `current_node_id`） | `config-changed` / `node-switched` |
| `nodes` | `config_detail` / `node_probe` | `node_import_url` / `node_create` / 种子物化 | `node-list-changed` |
| `config_nodes` | `config_detail` | `config_update`（整体替换）/ 导入时追加 | `config-changed` / `node-list-changed` |
| `layout` | `config_detail` | AI 编排（批 4，Host 内部） | `layout-updated` |
| `issues` | `issue_list` / `issue_get` | Host 内部（J1）、`issue_handoff` / `issue_resolve` / `issue_ignore` | `issue-changed` |
| `seed_cache` | `default_profile_status` | `default_profile_refresh` / `import_seed_file` | `default-profile-updated` |
| `config_rules` | `rule_custom_list` | `rule_custom_add` / `rule_custom_delete` | `routing-changed` |
| `rules_state` | `rules_status` | `rules_update` / 启动解压 | `rules-changed` |
| `seed_node_exclusions` | 无直接命令（设置页将来展示） | Host 内部：用户从配置移除种子节点时写入 | 无 |

**没有任何命令直接写 `issues` 的采集字段。** `occurrences` / `first_seen_at` / `evidence_json` 只由 Host 内部登记器写；命令层只能改 `status` 与 `session_id`。

### 7.1 列名与契约字段的映射

列名是数据库内部命名，契约字段是对外命名。二者刻意不完全相同（SQL 里 `type` / `status` 是容易踩坑的词，而 UI 侧 `state` 更清楚），但必须一一对应，不得出现第三个叫法：

| 表.列 | 契约字段（`commands.md`） |
|---|---|
| `issues.kind` | `IssueSummary.type` |
| `issues.status` | `IssueSummary.state` |
| `issues.occurrences` | `IssueSummary.count` |
| `issues.first_seen_at` | `IssueSummary.first_seen` |
| `issues.last_seen_at` | `IssueSummary.last_seen` |
| `issues.evidence_json` | `IssueDetail.evidence` |
| `configs.id` | `ConfigSummary.config_id` |
| `configs.connection_mode` | `ConfigSummary.connect_mode` |
| `configs.routing_mode` | `ConfigSummary.routing_mode` |
| `configs.tun_excludes_json` | `ConfigDetail.tun_excludes` |
| `configs.dns_json` | `ConfigDetail.dns` |
| `configs.route_targets_json` | `RouteState.targets` |
| `configs.route_revision` | `RouteState.route_revision` |
| `nodes.id` | `NodeSummary.node_id` |
| `layout.layout_json` | `ConfigDetail.layout` |
| `layout.revision` | `ConfigDetail.layout_revision` |

---

## 8. 与当前未提交实现的差异（必须改）

仓库里已有一版进行中的新 schema（`001_init.sql` + `store/configs.rs` 等）。多数命名已按本文件对齐；下列差异是**必须修正**的，否则契约与库对不上：

| # | 现状 | 应为 | 原因 |
|---|---|---|---|
| 1 | `issues.severity IN ('info','warning','error')` | `('P0','P1','P2')` | PM 裁定 OPEN-05；中间插卡规则按 P0/P1 选，`info/warning/error` 无法表达「阻断」 |
| 2 | `issues.status IN ('open','resolved','dismissed')` | `('open','handed_off','resolved','ignored')` | 缺 `handed_off`（J3 转交中）与 `ignored`（J4）；`dismissed` 是另一套词汇 |
| 3 | `issues` 无 `target` / `merge_key` / `mode` / `session_id` / `last_handoff_at` | 按 §3.5 补齐 | 没有 `merge_key` 无法合并同类问题；没有 `session_id` 无法复用转交会话 |
| 4 | `issues` 用 `kind` / `occurrences` / `detail_json` | 保留 `kind` / `occurrences`，`detail_json` 改名 `evidence_json` | 与 `issue-management.md` §3、§5 的「证据 / 诊断包」一致 |
| 5 | `configs` 缺 `dns_json` / `tun_excludes_json` | 按 §3.1 补齐 | PM 裁定 OPEN-06；三级确认页要展示 DNS 策略，TUN 要存用户补充网段 |
| 6 | `nodes` 缺 `source_key` | 按 §3.2 补齐并加唯一索引 | 没有它，种子刷新与 URL 导入无法幂等 upsert，每次刷新都会重复插入节点 |
| 7 | `configs.listen_port INTEGER NOT NULL DEFAULT 0`（0 = 自动） | `INTEGER NULL`（NULL = 自动） | 0 同时也是合法的「任意端口」绑定值，哨兵值迟早被误读；契约里 `listen_port` 是 `number \| null` |
| 8 | `layout` 无 `revision` | 补 `revision INTEGER NOT NULL DEFAULT 1` | `layout-updated` 靠 revision 丢弃迟到事件 |
| 9 | `seed_cache.source_updated_at` / 无 `source_version` | 增加 `source_version TEXT` | `version` 只展示、`content_sha256` 判变化；两者都要能读到 |
| 10 | `configs` 的 `connection_mode` 注释写「system_proxy / tun」 | 保持不变 | 已与本文件一致 |

**批 3 待实现（尚未进代码，实现时按此加）：**

| # | 对象 | 内容 |
|---|---|---|
| 11 | `configs` | 增加 `route_targets_json TEXT NOT NULL DEFAULT '[]'` 与 `route_revision INTEGER NOT NULL DEFAULT 0` |
| 12 | `config_rules` | 新表（§3.8），含唯一索引与顺序索引 |
| 13 | `rules_state` | 新表（§3.9），单行；`pending_update` 支持排队 |
| 14 | `RuntimeSnapshot` | 增加 `applied_route_revision`（`runtime.md`），建连时从 `configs.route_revision` 读入 |
| 15 | `seed_node_exclusions` | 新表（§3.7）；种子物化时按 `source_key` 跳过，配置无关 |

> 差异 1–4 是**产品语义**问题，不是命名偏好：按现状实现，J3 转交后状态无处可写、P0/P1 插卡规则无法实现。差异 5–9 是**契约形状**问题。

---

## 9. 明确不做的

| 不做 | 原因 |
|---|---|
| 数据迁移 / 兼容视图 | 产品无用户；兼容层最终都要删 |
| 软删除（`deleted_at`） | 删配置就是删；问题记录不提供删除。软删除会让每个查询都多一个 `WHERE`，且容易漏 |
| 配置版本历史 / 回滚 | 没有需求；用户要回退就重配一套 |
| 节点使用统计 | 目前没有「哪个节点用了多少次」的产品需求；需要时另表，不塞进 `nodes` |
| ~~自定义分流规则表~~ | **已做**（批 3）：规则逐条增删、有独立生命周期，故建 `config_rules` 子表；DNS/内网排除仍用 JSON 列 |
| 敏感字段的列级加密 | 密码根本不在库里；对非敏感列做加密只增加复杂度 |

---

## 10. 待确认

| # | 议题 | 决议 | 状态 |
|---|---|---|---|
| 1 | `issues.config_id` 用 CASCADE 还是 SET NULL | **CASCADE**：配置删了，关于它的历史问题没有意义；全局问题本来就不带 `config_id` | **已定**（PM，2026-11-03） |
| 2 | `listen_port` 用 NULL 还是 0 表示自动 | **NULL**：0 是合法的绑定值，不能当哨兵 | **已定**（PM，2026-11-03） |
| 3 | `layout` 是否允许空布局（`blocks: []`） | **允许**；空布局 = AI 明确选择，无行 = 还没编排，两者必须区分 | **已定**（PM，2026-11-03） |
| 4 | `nodes.source_key` 对 manual 是否也计算 | **计算**，便于将来跨来源合并；当前唯一索引按 `(source, source_key)`，不影响手动节点重复创建 | 待确认 |

---

## 11. 变更记录

### 4（2026-11-06，本地代理端口设置）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `settings` 新增键 `proxy_port`：十进制字符串；缺失或损坏时读回 `7890`，读不写库 | 键新增 |
| 2 | `configs.listen_port` 标注废弃：仅保留旧数据与回滚，连接不再读取；端口来源改为全局设置 | 废弃 |

### 3（2026-11-04，批 3 修订）

| # | 变更 | 类型 |
|---|---|---|
| 1 | 新增 `seed_node_exclusions`：按 `source_key` 全局记住用户移除过的种子节点，刷新时跳过 | 表新增 |
| 2 | 明确与 `nodes.source_key` 的关系：只影响种子物化，不影响 URL/手动节点 | 说明 |

### 2（2026-11-03，批 3 · 分流与 DNS）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `configs` 增加 `route_targets_json` / `route_revision` | 列新增 |
| 2 | 新增 `config_rules`（自定义分流规则，独立生命周期 → 子表） | 表新增 |
| 3 | 新增 `rules_state`（规则数据版本、基线、排队状态） | 表新增 |
| 4 | 契约字段 `route_mode` 统一为 `routing_mode`（与列名、AI 工具同名） | 命名 |

### 1（2026-11-03，批 0）

首次定稿：6 张核心表、索引、`secrets.enc` 关系、旧 `profiles` 重建策略。
