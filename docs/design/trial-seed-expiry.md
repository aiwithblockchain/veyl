# 试用节点过期后停止节点更新

> 日期：2026-11-27
> 状态：设计定稿，未实现
> 上游：`docs/contracts/commands.md` §1.6 / §7.19 / §8.1–8.2、
> `docs/contracts/tools.md` §4.20–4.21、`docs/design/seed-refresh.md`
> 涉及：`src-tauri/src/seed.rs`、`src-tauri/src/trial.rs`、`src-tauri/src/lib.rs`、
> `src-tauri/src/tools/services.rs`、`src-tauri/src/tools/net.rs`、
> `src/components/Settings.tsx`、`src/App.tsx`
>
> **这份文档解决什么**：7 天试用到期后，到期事务只删一次种子节点并写排除表；
> 但所有「更新试用节点」的入口都不看试用状态。排除表的 key 是
> `name + server + port + method`（`src-tauri/src/seed.rs:601`），不含密码，端口一换 key 就变，
> 过期用户点一次「检查更新」就能把种子节点加回来，等于无限续期。
>
> 产品负责人已拍板：**过期后停掉所有更新入口**；只在设置页隐藏按钮不够，后端必须硬拦。
> 同时决定**删除隐藏的窗口拖放与 `import_seed_file`**，让种子刷新成为 seed 节点唯一的网络更新入口。
> 本文只定设计与契约，不写实现。

---

## 1. 结论

| # | 决定 |
|---|---|
| 1 | 唯一判定真源是 `trial_status.state === "expired"`；后端在 `seed::refresh` 与六条 seed 写入路径内硬拦，前端隐藏按钮只是体验层。 |
| 2 | 只拦 `nodes.source = "seed"` 的种子链路。窗口拖放与 `import_seed_file` 一并删除（§4.2）；`config_create(source="seed")`、`config_create({nodeIds})`、`node_attach(source="seed")`、`node_attach({nodeIds})`、`config_update({nodeIds})` 都按候选来源接同一闸门（§4 第 11–15 行）。**过期后无法新增 seed 节点行，也无法把未绑定的 seed 节点绑回任何配置；已绑定的 seed 节点允许保留 / 编辑**；`manual` / `owned` / `url` 与 URL 导入、手动节点、托管节点不碰。 |
| 3 | 过期后设置页该行：标题 `更新试用节点`，值 `试用节点已过期`，右侧 `检查更新` 按钮**不渲染**（不是禁用）。 |
| 4 | 后端返回稳定错误：`PRECONDITION_FAILED` + `details.reason = "trial_expired"`，`retryable = false`。不新增错误码。 |
| 5 | 已有缓存与库里的节点保留（包括删除手动导入通道之前已导入的 seed 节点），只停止刷新；不删本地种子缓存。 |
| 6 | 判定读不出来（数据库异常）时**放行**并记 warn：闸门是防续期，不是安全边界，不能因为读状态失败让正常用户更新不了。 |

---

## 2. 判定口径

### 2.1 `expired` 的定义

直接用 `crate::trial::status`（`src-tauri/src/trial.rs:40`）：

- `ended_at` 非空，或 `now >= started_at + 7d` → `Phase::Expired`；
- `available`（从未开始）与 `active` → 允许刷新。

`trial_status` 的 `state = "expired"` 就是 `Phase::Expired` 的序列化值（`trial.rs:83`），
不另造判据。

**到期时刻早于清理事务也要拦。** `status` 按时间推导过期，不依赖 `expire_if_needed`
是否已经跑过。应用刚启动、清理事务还没提交的几秒里，刷新同样必须被挡；
清理随后会把节点删掉。

### 2.2 读取失败按未过期处理

`trial::status` 返回 `Err` 时：

- 记 `log::warn!`，按「未过期」继续；
- 不做兜底写入、不发事件。

理由：状态读不出来通常是数据库暂时不可用，此时种子同步本身也会失败；
拦刷新既救不了数据库，又会把正常用户挡在外面。

### 2.3 与到期清理的关系

两者互不替代：

| 机制 | 作用 |
|---|---|
| `trial::expire_if_needed`（`trial.rs:136`） | 到期瞬间删一次种子节点关联、写排除表、修 `current_node_id`、写 `ended_at` |
| `seed::refresh` 闸门（本文） | 到期后刷新不再把种子加回来；六条 seed 写入路径共用同一闸门（§3.5） |

排除表仍保留：它是「用户主动移除某个种子节点」的长期机制，也是闸门失效时的第二道防线。
但**不能只靠排除表**——key 不含密码、端口变化即可绕过（见 §7.2）。

---

## 3. 后端硬闸门

### 3.1 位置

`seed::refresh`（`src-tauri/src/seed.rs:227`）实际调用 `refresh_with`（`seed.rs:240`）。
所有入口最终都走这里，闸门放在这一层，**三个判定点**：

1. **入口**：`refresh_with` 拿到 `REFRESH_LOCK` 之后、读缓存与发请求之前。
   - 已过期 → 直接返回 `TrialExpired`，不联网、不读 `secrets.enc`、不写库。
2. **拿到响应后**：放在 `needs_refetch` 处理完之后、`if response.status == 304` 之前。
   - `refresh_with` 在 304 且本地内容丢失时会不带 ETag 再 fetch 一次（`seed.rs:296`–`308`），
     所以检查必须在这次重拉之后，否则会漏掉重拉期间发生的到期。
   - 304 分支也会更新 `checked_at`，因此检查放在 304 / 200 分支之前。
   - 过期 → 返回 `TrialExpired`，**不写新密文、不推进 hash、不合并节点、不 touch 缓存**。
3. **写事务内最终判定**：`sync_seed_nodes` 在**函数最前面、`existing.is_empty()` 早退之前**取得连接守卫并调用
   `ensure_seed_trial_active`；**判定与写入区间只用这一把守卫**。`tx.commit()` 之后按现状先
   `drop(conn)` 再发事件（`seed.rs:682`–`689`；`emit_config_updated` 内部会再 `store.conn()`，
   `seed.rs:703` / `:712`，持有连接会死锁）。早退分支也在判定之后。
   `merge_seed_nodes` 的写事务（刷新成功后的并入）同样复查。
   - `Store` 是单连接 + `Mutex`（`store/db.rs:59`），拿到连接后到期事务无法插入；
     事务内读到的 `trial_state` 到提交前保持有效，即使 WAL 下也没有第二个写者。
   - 到期清理跑在另一条线程（`lib.rs:324` 的定时任务），入口与响应后的检查之间仍可能插入一次
     到期提交；最终判定放进写事务，竞态窗口收窄到同一事务内。
   - **hash 未变 / 304 的心跳路径也要判定**：`apply_fetch` 在 `seed_cache::touch`
     （`seed.rs:437`–`444`）之前调用同一 helper；拒绝则不 touch、不续命 `checked_at`。
     这样「Unchanged 也 countdown」与「不 touch 缓存」没有微窗口。
   - `apply_fetch` 在事务外先写 `secrets.enc`（`set_secret`，`seed.rs:452`）；若 sync 返回
     `TrialExpired`，**删除刚写的 `secret:<hash>`** 再返回，旧密文与缓存元数据不动。
     若 hash 与旧缓存相同且内容原本缺失，删除后回到「内容缺失」状态，界面按无缓存处理。
   - `sync_seed_nodes` 的错误要能区分 `TrialExpired`（专用错误枚举或哨兵），由 `apply_fetch`
     映射成 `RefreshOutcome::TrialExpired`，**不能**退化成 `Offline / local_write`；
     `merge_seed_nodes` 在事务内发现到期时返回 `PRECONDITION_FAILED / trial_expired`。

前两处在 `refresh_with` 内，测试用假 HTTP 的入口也能覆盖；第三处在写事务里，是最终判定。

### 3.2 返回类型

`RefreshOutcome` 增一个变体（内部类型，不属于对外契约）：

```rust
pub enum RefreshOutcome {
    Updated { .. },
    Unchanged { .. },
    Offline { .. },
    /// 试用已到期：没有联网，也没有改动任何缓存。
    TrialExpired,
}
```

不携带节点数/原因：对外文案由命令层固定，AI 与界面都不从它推导别的事实。

### 3.3 副作用

`TrialExpired` 分支：

- 不发 `default-profile-updated`；
- 不发 `node-list-changed`；
- 不改 `seed_cache.checked_at` / `fetched_at`；
- 不删旧密文（但删掉本次 `apply_fetch` 刚写入的新密文）；
- 不调用 `merge_seed_into_global_quietly`。

**刷新成功后的 merge 拒绝不吞掉**：`default_profile_refresh` 在 `Updated` / `Unchanged` 后调用
`merge_seed_into_global`；若它返回 `trial_expired`（按 `ServiceError` 的 code + reason 识别），
整个命令映射成 `PRECONDITION_FAILED / trial_expired`，不返回成功结果。其他 merge 失败仍只记日志，
不影响刷新本身。（`merge_seed_into_global_quietly` 需要改成能返回该错误的调用，不能继续静默。）

### 3.4 锁与竞态

- 入口检查放在 `REFRESH_LOCK` 之后：同一时刻只有一个刷新在跑，状态读取与「是否还要继续」
  不会和第二个刷新交错。检查本身只是一次 SQLite 读，不增加可感知延迟。
- **连接守卫必须在任何 `.await` 之前释放**：`store.conn()` 返回的守卫持有 store 锁，
  跨 await 持有会与到期事务、状态读取互相等死。按 `refresh_with` 现有的
  `let current = { let conn = store.conn(); ... };` 写法，把判定放进独立作用域。
- 已过期时 `TrialExpired` 与 `Unchanged` 一样是很快返回，不会占住网络时间。
- 与到期事务并发：SQLite 单连接串行化。入口与响应后的检查仍可能被另一条线程的到期提交
  插在中间，所以**最终判定放在写事务内**；窗口收窄到同一事务，事务开始后到期提交无法再插入。
  无论谁先提交，结果都是「节点最终不在池里」。

### 3.5 共享判定、候选来源与写入原子性

种子有六类写入：刷新（`seed::refresh`）、`config_create(source="seed")`、
`config_create({nodeIds})`、`node_attach(source="seed")`、`node_attach({nodeIds})`、
`config_update({nodeIds})`。它们必须共用**同一个判定**，不能各写一份：

- 在 `trial.rs` 抽内部 helper：`ensure_seed_trial_active(conn) -> Result<(), SeedTrialExpired>`。
  它只做一件事：`trial::status` 为 `Expired` 时返回 `SeedTrialExpired`；`available` / `active` 放行；
  读状态失败按 §2.2 记 warn 并放行。
- **按候选节点来源判，且只拦新增的 seed 节点**：候选是 `seed` 时，与**当前已绑定集合**求差；
  差集非空才拒绝。已绑定的 seed 节点允许保留 / 编辑（否则「只改名但显式带上现有 seed id」
  会被整条拒绝，违背「已有 seed 节点仍可用」）。
  - `node_attach({nodeIds})`：已绑定集合 = 全局配置当前 `config_nodes`；
  - `config_update({nodeIds})`：已绑定集合 = `current_node_ids`（`services.rs:6636`）；
  - `config_create({nodeIds})`：新配置没有已绑定集合，候选 seed id 全视为新增。
- 调用点：
  - `seed::refresh` 的三个判定点（§3.1）；
  - `config_create(source="seed")`：`config_exists` 之后、`seed_unavailable` 检查与创建/物化之前；
  - `config_create({nodeIds})`：`replace_nodes` 之前逐个 id 查来源（候选全部视为新增）；
  - `node_attach(source="seed")`：`source` 校验之后、`seed_parsed_nodes` 与任何 upsert / 绑定之前；
  - `node_attach({nodeIds})`：`missing_nodes` 校验之后、`attach_nodes` 之前逐个 id 查来源；
  - `config_update({nodeIds})`：在写任何 patch（名称 / DNS / 分流）与 `replace_nodes` 之前逐个 id 查来源；
    拒绝时整个命令不落任何改动，也不得 `remove_seed_exclusion`。
- **写入原子性：把 seed 物化/绑定改成单事务。** 现有 `add_parsed_nodes` 每节点各取一次 conn
  （`services.rs:4816`–`4837`），`node_attach` 的 upsert 与 `attach_nodes` 也是两次取守卫
  （`:7316` / `:7352`–`7356`）；这做不到「判定 + 写入」原子。本批要求：
  - `add_parsed_nodes` 增加接受 `&Connection` / `&Transaction` 的变体；
  - `node_attach` 的 seed 分支（upsert + attach）在一个事务里完成；
  - `config_create → materialize_seed_nodes` 与 `config_create({nodeIds}) → replace_nodes`
    在一个事务 / 同一连接守卫内完成；
  - `config_update` 在同一连接守卫内先查来源与试用状态，再 `replace_nodes` 与清排除。
  这样「判定 + 写入」对到期事务原子，不留毫秒级窗口。
- 映射：`seed::refresh` 把 `SeedTrialExpired` 映射成 `RefreshOutcome::TrialExpired`；
  服务层映射成 `PRECONDITION_FAILED`、`details.reason = "trial_expired"`、`retryable = false`。

**错误优先级（写死）**：

| 入口 | 判定顺序 |
|---|---|
| `config_create(source="seed")` | 参数校验 → `CONFLICT / config_exists`（已有全局配置）→ 试用判定 → `seed_unavailable`（缓存为空）。**过期 + 已有配置 = `CONFLICT`；过期 + 无配置 + 无缓存 = `trial_expired`。** 这要求把 `config_exists` 检查移到 `seed_unavailable` 之前，与契约 §3.2 的规则顺序一致。 |
| `config_create({nodeIds})` | 参数校验 → `CONFLICT / config_exists` → 候选来源（全部视为新增）+ 试用判定 → 建配置与 `replace_nodes`。 |
| `node_attach(source="seed")` | 参数校验（两个都没给 → `source_required`；两个都给 → `source_and_node_ids_conflict`）→ 试用判定 → `seed_unavailable` 缓存检查。 |
| `node_attach({nodeIds})` | 参数校验 → `missing_nodes`（`NOT_FOUND`）→ 候选来源（未绑定 seed 差集）+ 试用判定 → 绑定。 |
| `config_update({nodeIds})` | 参数校验 → `missing_nodes`（`NOT_FOUND`）→ 候选来源（未绑定 seed 差集）+ 试用判定 → 写 patch、替换与清排除。拒绝时整个命令不落任何改动。 |

`available` / `active` 必须照常放行：试用开始流程依赖 `App.tsx` 的
`attachNodes({ source: "seed" })`，托管节点静默入池依赖 `node_attach({ nodeIds })`，
两者都不能误伤。

---

## 4. 入口逐项处理

| # | 入口 | 位置 | 处理 |
|---|---|---|---|
| 1 | 启动后台刷新循环 | `src-tauri/src/lib.rs:350` | 结构不变。每轮调用 `seed::refresh`，过期时得到 `TrialExpired`，只记一行 info，然后继续睡 6 小时。**不永久退出循环**：本地重置试用（删 `trial_state` 行，仅开发用）后无需重启即可恢复。过期期间不联网。 |
| 2 | 种子节点连接失败后的强制刷新 | `src-tauri/src/tools/services.rs:10318` | 保留现有 spawn；`seed::refresh` 返回 `TrialExpired`，日志记录后结束。不额外加第二处判断，避免两个真源。 |
| 3 | 设置页按钮 / Tauri 命令 | `src-tauri/src/agent/commands.rs:2158` → `services.rs:7937` | 命令层仍固定 `force = true`；`default_profile_refresh` 把 `TrialExpired` 映射成 `PRECONDITION_FAILED / trial_expired`。**不得**返回 `Ok` + `source = "cache"`，否则界面会显示成「离线沿用缓存」。 |
| 4 | AI 工具 `CatalogRefresh` | `src-tauri/src/tools/net.rs:221` | 不另写检查，走同一个服务层；错误信封得到 `error_code = "PRECONDITION_FAILED"`、消息为「试用节点已过期，不再更新。换用自己的节点，或新建一台服务器。」。工具描述补一句到期后不再更新。 |
| 5 | 设置页 UI | `src/components/Settings.tsx:427`（`SeedRefreshRow`）、`:2396`（调用点） | 由 App 传入 trial 状态；过期时值文案固定、按钮不渲染、不显示状态行（§6）。 |
| 6 | trial 状态来源 | `src/App.tsx:620`、`:1296`–`:1316` | 不改读取逻辑。`trial-expired` 事件已在 `App.tsx:1132` 立即把 `trial` 置为 `expired` 并 `trialNonce + 1` 重读；App 把同一个 `trial` 对象传给 `Settings`。 |
| 7 | 只读状态 `default_profile_status` / `DefaultProfileStatus` | `services.rs:7933`、`tools/net.rs:245` | **不拦**：不联网、不写库，过期后仍可读缓存元数据。AI 侧已有 `trial_sentence` 会说明到期；本设计不新增字段。 |
| 8 | 窗口拖放 / `import_seed_file` | `App.tsx:1049`、`commands.rs:2169`、`seed.rs:744` | **删除，不是「不拦」**：拖文件不再有任何行为；命令、桥接、`merge_file_nodes` 与相关测试一并移除（§4.2）。 |
| 9 | 配置创建 / 节点绑定的 `seed_unavailable` 重试 | `src/config/useVpnSession.ts:516`、`:591` | 重试里的 `defaultProfileRefresh` 被闸门拒绝时，`errorText` 按 `trial_expired` 显示「试用节点已过期」，不退化成网络失败句；功能上仍由服务层闸门兜底。 |
| 10 | 试用流程的 fetch 步骤 | `src/App.tsx:2751`–`2760` | 同上；`defaultProfileRefresh` 返回 `trial_expired` 时显示「试用节点已过期」，不用通用「没拉到预置配置」句。 |
| 11 | `config_create(source="seed")` | `services.rs:6418` | 顺序：参数校验 → `CONFLICT / config_exists`（已有全局配置）→ 试用判定 → `seed_unavailable`。过期 + 无配置 → `PRECONDITION_FAILED / trial_expired`，不建配置、不物化；过期 + 已有配置 → `CONFLICT / config_exists`。物化与判定在同一事务。`available` / `active` 照常。 |
| 12 | `node_attach(source="seed")` | `services.rs:7208` | `source` 校验后、`seed_parsed_nodes` 之前判定；过期 → `trial_expired`，不写节点行、不绑定。upsert + attach 在同一事务。`available` / `active` 照常（试用开始流程依赖）。 |
| 13 | `node_attach({nodeIds})` | `services.rs:7326`–`7356` | `missing_nodes` 后、`attach_nodes` 前逐个 id 查 `source`；候选 `seed` 与**当前已绑定集合**求差，差集非空且过期 → `trial_expired`，不绑定；已绑定的 seed 与 `manual` / `owned` / `url` 照常（托管节点静默入池依赖此路径）。upsert/绑定同一事务。 |
| 14 | `config_update({nodeIds})` | `services.rs:6721`–`6738` | 在写任何 patch（名称 / DNS / 分流）与 `replace_nodes` 之前，按候选 `seed` 与 `current_node_ids`（`:6636`）的差集判定；差集非空且过期 → `trial_expired`，**整个命令不落改动、不替换关联、不 `remove_seed_exclusion`**；已绑定的 seed 与 `manual` / `owned` / `url` 照常。检查与写入在同一连接守卫内。 |
| 15 | `config_create({nodeIds})` | `services.rs:6542`–`6545` | 新配置没有已绑定集合，候选 `seed` 全视为新增；在 `replace_nodes` 之前判定，过期 → `trial_expired`，不建配置、不绑定；`manual` / `owned` / `url` 照常。与 §3.2 的 `config_exists` 顺序一致。 |

前端在 `src/i18n/errorText.ts` 的 `ERROR_REASON_TEXT` 补 `trial_expired → settings.seed.expired`；
这是第 9、10 两个重试点的文案来源，也是 `commands.md` §1.6 词表在 UI 侧的落点。

### 4.1 过期后的可见后果（有意为之）

- 启动后不再自动拉种子；新装/重装且已过期的用户不会重新获得试用节点。
- 种子缓存与密文仍在本地，`default_profile_status` 仍能报出旧节点数；
  它不代表可刷新，也不代表节点仍在池里（`trial_status.seed_node_count = 0`）。
- 删除手动导入通道之前已经加进池里的 seed 节点、URL/手动节点、托管节点照常可用。

### 4.2 删除窗口拖放与 `import_seed_file`

#### 4.2.1 删除范围

**前端**

| 位置 | 删除内容 |
|---|---|
| `src/App.tsx:3` | `getCurrentWebview` import |
| `src/App.tsx:16` | 从 `./agent/bridge` 的多名 import 里去掉 `isTauri`，**不要整行删**（同一行其余名字仍在用） |
| `src/App.tsx:67`、`:731`、`:1021`–`1046` | `describeImportError` import；`importingRef` 声明；`importPath` 回调 |
| `src/App.tsx:1049`–`1077` | 窗口级 `onDragDropEvent` 监听 |
| `src/agent/bridge.ts:80`、`:1335` | `ImportSeedResult` 与 `importSeedFile` 方法声明 |
| `src/agent/tauriBridge.ts:30`、`:2258`–`2259` | import 与实现 |
| `src/agent/mockAgent.ts:17`、`:2063` | import 与实现 |
| `src/components/Settings.tsx:2931` | `describeImportError`（删掉拖放后唯一调用方消失） |
| `src/i18n/zh.ts:582/583/587`、`src/i18n/en.ts:604/606/610` | `app.importJsonOnly` / `app.imported` / `app.dropOneFile` |

`describeImportError` 独占的 `settings.import.*` 键（`notJson` / `tooLarge` / `unreadable` /
`invalidJson` / `allSkipped` / `noSupported` / `methodUnsupported(With)` / `secretStore` /
`failed`）随之无引用。删除前先 grep 确认没有别处引用；`NodeImportDialog` 共用
`settings.import.` 前缀，不要整组删。

`appNotice` 与 `settings.import.*` 的其余键仍被别处使用，保留；`isTauri` 从 `bridge` 的导出
仍被别处使用，但 `App.tsx:16` 的这份 import 必须删除——`tsconfig.json:15` 是
`noUnusedLocals: true`，漏删会直接让 typecheck 失败。

**后端**

| 位置 | 删除内容 |
|---|---|
| `src-tauri/src/lib.rs:478`、`:585` | 两处 `invoke_handler` 里的 `import_seed_file` 注册 |
| `src-tauri/src/agent/commands.rs:2169`–`2178` | `import_seed_file` 命令 |
| `src-tauri/src/agent/commands.rs:1833` | 注释里「与 `import_seed_file` 一致」的引用，改为只提 URL 拉取 |
| `src-tauri/src/tools/services.rs:284`、`:613` | trait 声明与默认实现 |
| `src-tauri/src/tools/services.rs:7999`–`8069` | 实现及导入后的 `merge_seed_nodes(&[])` 调用（`merge_seed_nodes` 本身保留，刷新还在用） |
| `src-tauri/src/tools/services.rs:14851`–`14897` | `a_dropped_seed_file_merges_its_nodes_into_the_global_config` 测试 |
| `src-tauri/src/seed.rs:744`–`786` | `merge_file_nodes` |
| `src-tauri/src/tools/boundary_tests.rs:360`、`:2078` | 两个 mock 实现 |

**`parse_seed` 保留**：`load_nodes`（`seed.rs:221`）、`refresh_with`（`:334`）与
`apply_fetch`（`:424`）仍在用。只删 `merge_file_nodes`，不动解析与校验。

#### 4.2.2 为什么删

1. **没有界面入口。** 删掉窗口拖放后，`importSeedFile` 的调用方为零；契约 #24 本来就标着
   「目标状态：UI 不再使用」。
2. **没有用户认知。** 它是隐藏手势，菜单、设置页、文档里都没有入口；普通用户不知道它存在。
3. **临时保留的理由已经消失。** 当初不删只是因为拖放没迁到 `node_import_file`；
   现在拖放整体退役，不必再为它保留一条命令。
4. **它会绕过试用闸门。** `merge_file_nodes` 不查试用状态、也不查排除表，写入的仍是
   `source = "seed"`。留着它就是留一条「过期后还能把试用节点加回来」的暗路；
   删掉后 `seed::refresh` 成为 seed 节点唯一的**网络更新**入口，这条暗路关闭。
   缓存物化的两个入口也接同一闸门，见 §4 第 11、12 行与 §7.2 第 5 条。

#### 4.2.3 替代路径

用户要加自己的节点，走**设置 › 连接 ›「添加节点」**（`NodeImportDialog`），三条通道：

| 通道 | 命令 | 落库来源 |
|---|---|---|
| 粘贴文本 / `ss://` 列表 | `node_import_text` | `source = "manual"` |
| 订阅地址 | `node_import_url` | `source = "url"` |
| 本地文件 | `node_import_file` → 同一个文本解析 | `source = "manual"` |

三条都是**用户自己的节点**，不触发种子刷新、不写 `source = "seed"`、不受试用到期影响。
界面上不再出现「导入种子文件」的说法。

#### 4.2.4 代价与后果

- **少了一条运维兜底。** `docs/config-execution.md` §9 本来就是「不随包、只从种子 URL 拉」
  （:174），拖放只是「拉不到时通过其它渠道把种子给他」的兜底之一（:202）。
  删除后如果 `/v1/seed` 拉不到且本地无缓存，用户只能走「添加节点」用自己的节点；
  URL 拉取与手动添加仍在，§9 不是整节失效。
- **拖任何文件到窗口都不再有反应**，也不弹提示（拍板如此）。
- **删除前已经导入的 seed 节点留在库里。** 命令删了不会清数据；到期用户若在删除前
  导入过，这些节点会继续可用。是否补一次清理见 §11。

---

## 5. 错误码与前端映射

### 5.1 后端

按 `commands.md` §1.6：只使用通用码，场景靠 `details.reason` 区分，不新增错误码。

| 字段 | 值 |
|---|---|
| `code` | `PRECONDITION_FAILED` |
| `message` | `试用节点已过期，不再更新。换用自己的节点，或新建一台服务器。`（只给 AI 工具信封；界面不读） |
| `retryable` | `false` |
| `details.reason` | `trial_expired`（UI 通道可见；AI 工具通道见下） |

**两个通道看到的字段不同（现状）**：

- **UI 通道**（Tauri 命令 → `error_value`）保留 `details`，界面能读到 `details.reason`。
- **AI 工具通道**：`net.rs:15` 的 `tool_error` 只按 `Display` 文本拆 `CODE: message`，
  **会丢掉 `details`**，所以模型只看到 `error_code = "PRECONDITION_FAILED"` 与上面那句 `message`。
  这对本场景够用：模型需要知道的是「不能再更新」，而不是内部 reason。
  若希望工具信封也带 `details.reason`，实现时把 `net.rs` 的 `tool_error` 改成
  `downcast_ref::<ServiceError>()`（`tools/configs.rs:13` 已是这个写法），属于可选改进，不阻塞本设计。

**改名约束**：`trial_expired` 一经发布不改名。它与界面屏幕 id `trial_expired`
（`src/agent/ui_context.rs:21`）同名但不在同一命名空间，不冲突。

**为什么不用单独的错误码**：

- §1.6 明确「不新增错误码」；现有 `AI_NOT_CONFIGURED` / `BUSY` 是历史例外，不再扩大。
- `PRECONDITION_FAILED` 语义就是「前置条件不满足」，与「试用已结束」一致。
- 若未来需要独立码，必须先改 §1.6 与 `runtime.md` §6.1，不在本轮。

### 5.2 前端

| 来源 | 映射 |
|---|---|
| `trial.state === "expired"`（正常路径） | 值文案 `试用节点已过期`；不渲染按钮；不渲染状态行 |
| 刷新返回 `PRECONDITION_FAILED` + `details.reason = "trial_expired"`（状态过期或事件未到） | 进入本地 `expired` 态：同样显示值文案并隐藏按钮，**不显示**「拿不到试用节点」这类网络失败文案 |
| 其他错误 | 维持现有 `failed` 态与文案 |
| `trial` 为 `null`（未加载 / 旧后端） | 按未过期处理，照常显示摘要与按钮（fail-open） |

### 5.3 seed 写入入口的展示

这些入口都走 Host 命令 → `error_value`，UI 通道能拿到 `details.reason = "trial_expired"`；
对用户显示统一用 `settings.seed.expired`（「试用节点已过期」），不显示网络失败句。

| 入口 | 界面 / AI 侧 |
|---|---|
| `config_create(source="seed")` | **没有用户可见入口**：UI 路径已退休（§3.2 只允许懒创建），AI 工具 `ConfigCreate` 早在 `tools.md` 3.18.0 已删除。错误只在直接 invoke 与测试里可见；**不需要改 `tools.md` 的工具条目**。 |
| `config_create({nodeIds})` | 同上，无 UI / AI 工具入口；候选 seed 全视为新增，过期即拒绝。 |
| `node_attach(source="seed")` | **仅 UI 命令**，没有 AI 工具。试用开始流程（`App.tsx` 的 `attachNodes({ source: "seed" })`）在 `available` / `active` 下照常；过期后该流程没有入口。若陈旧界面在过期后调用，`useVpnSession` 经 `errorText` 映射 `trial_expired`，显示「试用节点已过期」。 |
| `node_attach({nodeIds})` | **仅 UI 命令**，没有 AI 工具。托管节点静默入池用 `owned` 节点走这里，过期后必须照常；只有**未绑定的** `seed` id 才拒绝。界面不新增提示，失败仍走既有的静默重试。 |
| `config_update({nodeIds})` | **UI 与 AI 工具 `ConfigUpdate` 都会调用**。只拦候选里**未绑定的** `seed` id；已绑定的 seed 允许随改名 / 改 DNS 一起提交。UI 通道用 `details.reason` 显示「试用节点已过期」；AI 工具信封（`tools/configs.rs:13` 保留 details）拿到 `PRECONDITION_FAILED / trial_expired`。**`tools.md` 的 `ConfigUpdate` 只补错误列表文字，不新增/删除工具，工具数不变。** |

因此 `tools.md` 的改动只有：`CatalogRefresh` / `DefaultProfileStatus` 两处文字，加
`ConfigUpdate` 的错误列表；不为 `config_create` / `node_attach` 新增或修改工具条目（它们没有
AI 工具）。`commands.md` 需要补前置条件（§9）。

---

## 6. 界面

### 6.1 状态来源与传递

`Settings` 目前拿不到 trial 状态。改动：

```ts
interface Props {
  // ...
  /** 试用状态；null = 尚未读到或旧后端，按未过期处理。 */
  trial?: TrialStatusData | null;
}
```

`App.tsx:3404` 的 `<Settings … />` 增加 `trial={trial}`。
不再新增命令、事件或前端轮询；`trial-expired` 已有的事件链路足够。

### 6.2 过期态

`SeedRefreshRow` 内：

```ts
const expired = trial?.state === "expired" || phase.kind === "expired";
```

过期时只渲染：

```
更新试用节点
试用节点已过期
```

- 标题：`settings.seed.rowLabel`。
- 值：`settings.seed.expired`，放在原来的 `settings-row__value` 位置；
  不加 mono 数字、不加「共 N 个节点」「从未检查」。
- 右侧 `settings-row__aside`：整个不渲染（不是 `disabled`）。
- 状态行 `seed-refresh__status`、下架提示、复制诊断按钮：都不出现。
- 不加颜色：过期是「信息」，不是错误；不用 `--red` / `--amber`。
- 按钮消失后行高不变：主列仍由标题 + 值撑起。

### 6.3 未知态

`trial === null` 或 `trial.state` 是 `available` / `active`：与今天完全一致。
若启动时 `trial_status` 尚未返回，设置页可能短暂显示按钮；点下去会被后端拒绝并转入过期态，
可以接受，不做骨架屏或加载态。

### 6.4 文案表

**这一行内不再出现「免费节点」四个字。** 只改该行渲染到的 4 个既有 key（它们没有别的调用方），另新增 1 个。

**适用范围**：设置页这一行以本设计为准，叫「试用节点」。`docs/design/servers-trial-hint.md`
里「统一叫 `免费节点`」的规则只约束「我的服务器」页那一行只读说明，不适用于设置页这一行；
两份文档不再各自自称全局统一口径。

| key | 中文 | 英文 |
|---|---|---|
| `settings.seed.rowLabel` | `更新试用节点` | `Update trial nodes` |
| `settings.seed.expired`（新增） | `试用节点已过期` | `Trial nodes expired` |
| `settings.seed.noNodes` | `还没有试用节点` | `No trial nodes yet` |
| `settings.seed.noNodesNever` | `还没有试用节点 · 从未检查过` | `No trial nodes yet · never checked` |
| `settings.seed.failed` | `拿不到试用节点，请检查网络。` | `Couldn't get trial nodes. Check your network.` |

其余 `settings.seed.*`（相对时间、离线、已更新等）不动：
它们不含「免费节点」，或只在该行里给结果反馈。

### 6.5 可访问性

- 按钮消失后没有可聚焦控件，不需要额外 `aria`。
- 值文案是静态文本，不需要 `role="status"`；状态行本来就不渲染。
- 键盘用户不会聚焦到一个已不存在的按钮。

---

## 7. 不拦的路径与已知缺口

### 7.1 明确不拦

| 路径 | 入口 | 理由 |
|---|---|---|
| URL 导入 | `node_import_url`（`source = "url"`） | 不是试用节点更新链路 |
| 粘贴文本导入 | `node_import_text`（`source = "url"` / `"manual"`） | 同上 |
| 文件导入 | `node_import_file` → `node_import_text`（`source = "manual"`） | 用户自己的节点，不是种子 JSON |
| 手动端口密钥节点 | `node_create` / `node_update`（`source = "manual"`） | 用户自己的节点 |
| 托管节点 | `my_server_credentials`（`source = "owned"`） | 付费资产 |
| 连接到已存在的种子节点 | `vpn_connect` / `node_switch` / 探测 | 只拦「更新」，不拦「使用」；删除手动导入通道前已在池里的 seed 节点仍可连 |
| 读状态 | `default_profile_status` / `trial_status` / 诊断 | 只读 |

**窗口拖放与 `import_seed_file` 不在这张表里：它们已被删除，不是「不拦」**，见 §4.2。

### 7.2 已知边界与缺口（按拍板接受，登记备查）

1. **排除表 key 不含密码**（`seed.rs:601`）：`name + server + port + method` 四个字段任一变化都会产生新 key。
   到期事务只能排除「当时存在的节点」。这在本文闸门上线后不再构成续期路径，
   但仍是「试用期内用户移除节点后被端口轮换复活」的既有缺口，不在本轮修。
2. **后台循环仍每 6 小时醒一次**：只做一次数据库读就返回，无网络。保留是为了本地重置试用后能自动恢复。
3. **AI / 诊断文案仍叫「免费节点」**：`tools/net.rs` 的 `trial_sentence`、
   `services.rs:2573` 的 `seed_checks`、试用卡 `trial.*` 等未改名。
   本轮只改设置页这一行，是否全局统一见 §11。
4. **升级前手动导入的 seed 节点不会被清理**：删除命令不会删数据；已经通过拖放
   `import_seed_file` 加进池里的 `source = "seed"` 节点继续存在。若用户当时已到期，
   `ended_at` 已写，`expire_if_needed` 不会二次执行。是否补一次清理见 §11。
5. **缓存物化与绑回旁路（本批已封堵）**：五条路径都接 `ensure_seed_trial_active`（§3.5）：
   `config_create(source="seed")`、`config_create({nodeIds})`、`node_attach(source="seed")`、
   `node_attach({nodeIds})`、`config_update({nodeIds})`。过期返回
   `PRECONDITION_FAILED / trial_expired`，不建配置、不 upsert 节点行、不绑定、不替换关联、
   不撤销排除；`available` / `active` 放行。
   - 到期清理只删 `config_nodes` 关联、保留节点行（`trial.rs:169`–`184`），所以只拦
     `source="seed"` 不够：`node_attach({nodeIds:[seedId]})`（`services.rs:7326`–`7356`，
     `attach_nodes` 直接 INSERT）与 `config_update({nodeIds})`（`services.rs:6721` →
     `replace_nodes`，`configs.rs:804`–`838`，且 `:6734` 会撤销排除）都能把旧 seed 节点绑回。
   - **只拦新增的 seed 节点**：候选 `seed` 与当前已绑定集合求差，差集非空才拒。已绑定的 seed
     节点允许保留 / 编辑（只改名但显式带上现有 seed id 不应被拒）；`manual` / `owned` / `url` 照常。
   - 代码事实：`node_attach(source="seed")` 会先 `add_parsed_nodes(None, ...)` upsert 节点行/密码，
     再把候选 `attach_nodes` 到全局配置（`services.rs:7352`–`7354`），**能绑定**，不是
     「只重写行、不绑定」。
   - **结论：过期后无法新增 seed 节点行，也无法把未绑定的 seed 节点绑回任何配置；
     已绑定的 seed 节点仍可保留 / 编辑 / 连接。** 旧 seed 节点不删，见第 4 条。

---

## 8. 测试口径

### 8.1 Rust 单测

`src-tauri/src/seed.rs`（测试模块内可直接构造 `Store` 与 backdate `trial_state`）：

| # | 场景 | 期望 |
|---|---|---|
| 1 | 未开始试用（`available`） | `refresh_with` 照常发请求、应用内容 |
| 2 | 试用中（`active`，`started_at` 在 7 天内） | 同上 |
| 3 | `started_at` 距今 8 天、`ended_at` 为空 | 返回 `TrialExpired`；假 HTTP 闭包调用次数为 0；`checked_at` 不变 |
| 4 | `started_at` 在今天、`ended_at` 非空 | 同上 |
| 5 | 入口放行后、响应回来前才过期 | 在假 fetch 闭包里把 `started_at` 改到 8 天前，再返回 200；断言 `TrialExpired`，且不写新密文、不推进 hash、节点集不变 |
| 5b | 同上但返回 304 | 断言 `TrialExpired`，`checked_at` 不变 |
| 5c | 直接调 `sync_seed_nodes`（`trial_state` 已过期） | 事务内判定返回 `TrialExpired`；不写节点行、不绑定、不删旧节点 |
| 6 | 过期后删掉 `trial_state` 行（重置） | 下一次 `refresh_with` 恢复拉取 |
| 7 | 现有全部 seed 测试 | 无 `trial_state` 行 → `available`，行为不变 |

`src-tauri/src/tools/services.rs`（沿用 `harness()`）：

| # | 场景 | 期望 |
|---|---|---|
| 9 | 过期后调 `default_profile_refresh(true)` | `Err`；`code = "PRECONDITION_FAILED"`、`details.reason = "trial_expired"`、`retryable = false`；不返回 `Ok` |
| 10 | 过期后调 `default_profile_status()` | 仍返回缓存形状，不报错 |
| 11 | 到期清理后调刷新 | 返回同一个错误；错误文案不出现网络失败措辞 |
| 12 | 过期、无全局配置时调 `config_create(source="seed")` | `Err`；同一 code / reason / retryable；不建配置、不物化节点行 |
| 13 | 过期后调 `node_attach(source="seed")` | `Err`；同一 code / reason / retryable；不 upsert 节点行、不绑定 |
| 14 | `active` 下调 `config_create(source="seed")` | 成功：建配置并物化绑定（防误伤） |
| 15 | `active` 下调 `node_attach(source="seed")` | 成功：节点入池并绑定（试用开始流程回归） |
| 16 | 过期后调 `node_attach({nodeIds:[manual/owned]})` | **成功**：照常绑定；不能误伤自定义节点与托管节点静默入池 |
| 17 | 过期后调 `config_update({nodeIds:[manual]})` | **成功**：照常替换关联 |
| 18 | 过期后 `node_attach()` 两个参数都不给 | `INVALID_ARGUMENT / source_required`（参数校验先于试用判定） |
| 19 | 过期后调 `node_attach({nodeIds:[未绑定的 seedId]})` | `Err`；`PRECONDITION_FAILED / trial_expired`；不绑定 |
| 20 | 过期后调 `config_update({nodeIds:[未绑定的 seedId]})` | `Err`；同一错误；整个命令不落改动：节点集、名称 / DNS 均不变，不 `remove_seed_exclusion` |
| 21 | 过期、已有全局配置时调 `config_create(source="seed")` | `CONFLICT / config_exists`（先于试用判定） |
| 22 | `active` 下调 `node_attach({nodeIds:[未绑定的 seedId]})` | **成功**：节点入池并绑定（防 over-block） |
| 23 | `active` 下调 `config_update({nodeIds:[未绑定的 seedId]})` | **成功**：照常替换关联（防 over-block） |
| 24 | 过期、无全局配置时调 `config_create({nodeIds:[seedId]})` | `Err`；`trial_expired`；不建配置、不绑定 |
| 25 | 过期、候选 seed 已绑定且只改名时调 `config_update({nodeIds:[已绑定的 seedId], name})` | **成功**：改名生效，绑定与排除不变（只拦新增，不拦保留） |
| 26 | 过期、候选 seed 已绑定时调 `node_attach({nodeIds:[已绑定的 seedId]})` | **成功**：幂等跳过，`attached_node_ids` 为空（不误伤保留） |

> 现有 `config_create` / `node_attach` 测试没有写 `trial_state` 行，本身就是 `available` 的回归；
> 新增用例只补 `expired` 与 `active` 两侧，不改旧用例的构造。

### 8.2 前端用例

`src/components/Settings.seed.test.tsx`：

> 现有前端测试没有覆盖窗口拖放或 `importSeedFile`（拖放没有测试文件），
> 删除功能时不存在要移除的用例，也不新增。
>
> 改文案时**全文件替换旧断言**，不只改新增用例：
> `:99` 的 `seedRow()` 选择器、`:142` 的「更新 Veyl 免费节点」、`:264` 的
> 「拿不到 Veyl 免费节点，请检查网络。」。

| # | 场景 | 期望 |
|---|---|---|
| 1 | `trial.state = "expired"` | 行标题 `更新试用节点`；值 `试用节点已过期`；没有 `检查更新` 按钮；没有状态行 |
| 2 | `trial.state = "active"` | 与今天一致：摘要 + 按钮 |
| 3 | `trial = null` | 按未过期处理，按钮存在 |
| 4 | 按钮已渲染但刷新被拒 `PRECONDITION_FAILED / trial_expired` | 转过期态：值文案、按钮消失；不显示「拿不到试用节点」 |
| 5 | 英文渲染 | 行内不出现 `free nodes`；标题为 `Update trial nodes`，值为 `Trial nodes expired` |
| 6 | 纯函数 `seedSummary` | 现有断言只改「还没有 Veyl 免费节点」→「还没有试用节点」 |
| 7 | `seedRow()` 辅助 | 选择器改用新标题 |

`src/App.settings.test.tsx`：

| # | 场景 | 期望 |
|---|---|---|
| 8 | App 读到 `trialStatus() = expired` 后打开设置 | `Settings` 收到 `trial`，行内无按钮 |
| 9 | `trial-expired` 事件到达时设置页已打开 | 行立即变为过期态（不靠重新打开设置） |

### 8.3 人工验收（由用户执行）

1. 把本地 `trial_state.started_at` 改到 8 天前，重启应用并等清理。
2. 设置 → 连接：该行只显示 `更新试用节点` / `试用节点已过期`，无按钮。
3. 直接调用 `default_profile_refresh`（或让 AI 调 `CatalogRefresh`）：返回 `PRECONDITION_FAILED / trial_expired`。
4. 改回 `started_at`（或删 `trial_state`）并重启：行恢复摘要与按钮，刷新正常。

---

## 9. 契约修改清单

**本轮不改契约文件。** 实现时按下表改，改动原子提交。

**版本口径**

- `commands.md`：`2.90.0` → `2.91.0`。试用闸门与删除 #24 / §8.3 合并为一次未发布的契约变更；
  两者在同一实现批次，分两次升版会出现一个只含闸门、从未发布的中间版本。
- `tools.md`：**不升版，仍是未发布的 `3.40.0`**（文件头 `:3`，变更记录 `:2449` 标明未发布）。
  `CatalogRefresh` / `DefaultProfileStatus` / `ConfigUpdate` 的文字改动并入这一版；
  `src-tauri/src/tools/envelope.rs:13` 的 `CONTRACT_VERSION` 与 `boundary_tests.rs:608`
  的版本断言保持 `3.40.0`，不改。
  **前提条件**：若 `3.40.0` 在本批提交前发版，本条失效，必须改为升 `3.41.0` 并同步
  `envelope.rs` 常量与 `boundary_tests.rs` 断言。
- **删除命令不新增 Rust 常量**：`tests/contracts/check-contracts.mjs` 的 #6（命令四方对齐：
  `commands.md` 总表 ↔ `#[tauri::command]` ↔ `generate_handler!` ↔ 前端 `call()`）
  会在实现时验证四处同步删除。
- 命令表删除 #24 后**不重排后续行号**：其它文档按 `#69` 这类编号引用，重排会制造无关 diff；
  在 §16 变更记录里写明 #24 已删除。
- 删除 `import_seed_file` 是破坏性变更，但消费者只有本应用 UI，且 UI 在同一批次删除，
  没有外部兼容窗口。

| 文件 | 位置 | 改什么 |
|---|---|---|
| `docs/contracts/commands.md` | 文件头 | 版本 `2.90.0` → `2.91.0` |
| `docs/contracts/commands.md` | §1.6 词表 | 新增一行：`试用节点 \| PRECONDITION_FAILED \| trial_expired \| —` |
| `docs/contracts/commands.md` | §2 命令表第 23 行 | `default_profile_refresh` 备注追加「2.91.0 起试用到期返回 `PRECONDITION_FAILED / trial_expired`」 |
| `docs/contracts/commands.md` | §2 命令表第 2、3、95 行 | `config_create` / `config_update` / `node_attach` 备注追加「2.91.0 起候选含**未绑定的** `source="seed"` 且试用到期返回 `PRECONDITION_FAILED / trial_expired`」 |
| `docs/contracts/commands.md` | §2 命令表第 24 行 | 删除 `import_seed_file` 行；后续行号不重排 |
| `docs/contracts/commands.md` | §3.2 `config_create` | 规则增：`source="seed"` 或 `nodeIds` 候选含 seed 且 `trial_status.state = "expired"` → `PRECONDITION_FAILED / details.reason = "trial_expired"`、`retryable = false`；判定顺序写死为 **参数校验 → `CONFLICT / config_exists` → 试用判定 → `seed_unavailable`**；过期 + 无配置 → `trial_expired`，过期 + 已有配置 → `CONFLICT`。`nodeIds` 候选全部视为新增（新配置没有已绑定集合）；不建配置、不物化/不绑定；`available` / `active` 照常 |
| `docs/contracts/commands.md` | §4.0 `node_attach` | 规则增两条：① `source="seed"` 且过期 → `trial_expired`，在 `source` 校验后、`seed_parsed_nodes` / upsert / 绑定之前判定；② `nodeIds` 分支在 `missing_nodes` 后、`attach_nodes` 前按**候选节点来源与当前已绑定集合的差集**判定，差集含 seed 且过期 → `trial_expired`，不绑定；已绑定的 seed 与 `manual` / `owned` / `url` 照常。同时纠正首段「只做绑定、不解析」的旧描述：`source="seed"` 会从缓存 upsert 节点行/密码再绑定 |
| `docs/contracts/commands.md` | §3.3 `config_update` | 规则增：`nodeIds` 在写任何 patch（名称 / DNS / 分流）与 `replace_nodes` 之前，按**候选 seed 与 `current_node_ids` 的差集**判定；差集非空且过期 → `PRECONDITION_FAILED / trial_expired`，**整个命令不落改动、不替换关联、不 `remove_seed_exclusion`**；已绑定的 seed 与 `manual` / `owned` / `url` 照常 |
| `docs/contracts/commands.md` | §3.3 错误行 | 新增 `PRECONDITION_FAILED`，列出 `trial_expired`；顺带补上既有的 `route_targets_empty`（`services.rs:6657`） |
| `docs/contracts/commands.md` | §4.0 错误行 | `PRECONDITION_FAILED` 增 `trial_expired`（与 `seed_unavailable` 并列） |
| `docs/contracts/commands.md` | §4.1.2（约 749–776） | 删除整个「窗口拖放不走本命令」引用块与「为什么窗口拖放不迁移」整段，含两条入口分工；边界表删掉「不接受窗口拖放事件」那一行；`:778` 的大小上限对比改为只提 URL 拉取 |
| `docs/contracts/commands.md` | §7.19 | 增一条：`state = "expired"` 同时是种子刷新与六条 seed 写入路径的闸门唯一依据；Host 在 `seed::refresh`、`config_create` / `node_attach` 的 seed 分支、`config_create({nodeIds})`、`node_attach({nodeIds})`、`config_update({nodeIds})` 硬拦，与清理事务是否提交无关；界面隐藏按钮不构成拦截 |
| `docs/contracts/commands.md` | §8.1 | 增一句：过期后仍可读状态，它不表示可以刷新，`node_count` 是缓存数不是池内数 |
| `docs/contracts/commands.md` | §8.2 | 增「试用到期后停止更新」段：不联网、不读写缓存、不合并节点；返回 `PRECONDITION_FAILED / trial_expired`，`retryable = false`；`force = true` 不能绕过；已有缓存保留但不再刷新 |
| `docs/contracts/commands.md` | §8.3 | 整节删除；`SeedImportResult` 类型随之删除 |
| `docs/contracts/commands.md` | §12.1 第 8 行 | 决策表里的「保留」改为「已删除（2.91.0）」，或删除该行 |
| `docs/contracts/commands.md` | §15 契约版本矩阵（`:3298`） | 矩阵里的 `2.90.0` 与描述同步到 `2.91.0`，并把试用闸门、`config_create` / `node_attach` / `config_update` 的 `trial_expired` 前置条件、删除 #24 / §8.3 写进该行 |
| `docs/contracts/commands.md` | §16 | 新增 2.91.0 变更记录，同时写两条：试用闸门、删除 #24 与 §8.3；注明上游为本文。**2.16.12 / 2.16.14 / 2.0 等历史条目不改写** |
| `docs/contracts/tools.md` | §4.20 `CatalogRefresh` | 错误列表增 `PRECONDITION_FAILED`（服务层 `details.reason = trial_expired`；工具信封当前只透出 `code` + `message`）；`content` 固定句；描述补「试用到期后不再更新」。版本仍 `3.40.0` |
| `docs/contracts/tools.md` | §4.21 `DefaultProfileStatus` | 增一句：过期后仍可读；它不触发刷新 |
| `docs/contracts/tools.md` | §4.25 `ConfigUpdate` | 错误列表增 `PRECONDITION_FAILED`（`details.reason = trial_expired`，`node_ids` 含**未绑定的** seed 且试用到期时）；正文补一句：`node_ids` 新增 seed 节点时受同一试用闸门约束，已绑定的 seed 可随改名 / 改 DNS 提交。工具数与权限不变 |
| `docs/contracts/tools.md` | §8 变更记录（`:2449` 起） | 在未发布的 `3.40.0` 记录里追加本批三条：`CatalogRefresh` 到期停更、`DefaultProfileStatus` 到期仍可读、`ConfigUpdate` 的 `node_ids` 含 seed 时受闸门约束；不新增版本小节 |
| `docs/contracts/tools.md` | §7.2（`:2443`） | 开放项里的 `import_seed_file` 保留建议改为「已删除（2.91.0）」或移除 |
| `src-tauri/src/tools/envelope.rs` / `boundary_tests.rs` | `:13` / `:608` | **不改**：`3.40.0` 未发布，版本常量与断言保持 `3.40.0` |
| `docs/contracts/events.md` | `:625`、`:1369` | **只改两处引用，事件语义与载荷不变**：`:625` 的触发条件去掉「或 `import_seed_file` 合并」；`:1369` 的「完整语义见 `commands.md` §8.3」改为「该命令已删除」 |
| `docs/contracts/runtime.md` | §6.1 | **不改**：复用通用码 |
| `docs/design/seed-refresh.md` | 文首 | 实现时补一句「刷新入口受试用闸门约束，见 `trial-seed-expiry.md`」 |
| `docs/design/settings-ia.md` | §2 表格第 4 条、§4.1 末条、§4.2、§5.3、§5.4、§8 B 批次 | 把「拖放继续调 `import_seed_file`」「未删除，可恢复」改成「已随 2.91.0 退役」；`node_import_file` 三条通道保留。§1/§2 里描述旧问题的历史段落不改写 |
| `docs/design/simplified-config-create.md` | `:791` | 「窗口拖放（`import_seed_file`）：无关，不动」改为「窗口拖放与 `import_seed_file` 已删除」 |
| `docs/capabilities.md` | B4 行 | 当前状态改为「窗口拖放已删除；加节点走 `node_import_text` / `node_import_url` / `node_import_file`」 |
| `docs/data-model.md` | `seed_cache` 行（`:526`） | 从「写它的命令」里删掉 `import_seed_file`（它本来也不写 `seed_cache`） |
| `docs/shadowsocks.md` | §5.2 整节 + `:18` + `:296` 改写；补 `:146`、`:152`、`:156–157`、`:166–167`、`:177` | 标注窗口拖放与 `import_seed_file` 已退役；历史叙述不改写 |
| `docs/acceptance-p1-report.md` | — | **不改写**：历史验收报告，保留当时状态 |
| `docs/review-checklist.md` | 旧名 grep 模式 | 可选：从 `import_seed_file` 的旧名清单里移除，避免此后永远报旧名 |

---

## 10. 实现顺序（下一轮）

1. `trial.rs`：抽 `ensure_seed_trial_active(conn)`；`seed.rs` 接三个判定点；补单测 1–7（含 5b/5c）。
2. `services.rs`：`default_profile_refresh` 映射错误（含 merge 拒绝不再吞）；六条 seed 写入路径接入
   同一 helper（候选 seed 与已绑定集合求差，只拦新增）；按 §3.5 把 `add_parsed_nodes` 改成可接收
   `&Connection`/`&Transaction` 的单事务写入；`config_create` 的 `config_exists` 判定顺序按契约前移；
   补单测 9–26。
3. `lib.rs`：显式处理 `TrialExpired` 日志（可选，catchall 已能编译）。
4. 删除窗口拖放与 `import_seed_file`：前端（App / bridge / tauriBridge / mock / i18n，
   含 `App.tsx:16` 的 `isTauri` import）、后端（两处注册、命令、trait、实现、测试、
   `merge_file_nodes`、boundary mock）；顺手清掉失去唯一调用方的 `describeImportError`。`parse_seed` 不动。
5. `tools/net.rs`、`tools/description.rs` 与 `tools/configs.rs`：`CatalogRefresh` 描述中英各补一句；
   `ConfigUpdate` 的错误列表与正文补 `trial_expired`；`claurst_session` 描述测试加中文/英文断言。
6. `Settings.tsx` + `App.tsx`：传 `trial`、过期态渲染、错误映射；改 i18n 4 个 key + 新增 1 个；
   `errorText.ts` 的 `ERROR_REASON_TEXT` 增 `trial_expired → settings.seed.expired`。
7. 前端用例 1–9；同时替换 `Settings.seed.test.tsx` 的三处旧断言。
8. 最后统一改契约与文档（§9）；`tools.md` 不升版（前提见 §9），`envelope` / `boundary` 版本不改。

---

## 11. 未决问题（交 PM）

1. **全局命名**：设置页这一行按本设计叫「试用节点」；`docs/design/servers-trial-hint.md:76`
   的「统一叫 `免费节点`」只约束「我的服务器」页那一行只读说明，两份文档不再互相覆盖。
   其余界面（试用卡 `trial.*`、诊断项 `services.rs:2573` `seed_checks`、AI 工具描述
   `tools/net.rs` / `description.rs`）仍叫「免费节点」；是否另开一批全局统一，
   并同步修改 `servers-trial-hint.md` 与 `veyl-ui` skill 的固定用词，需要 PM 决定。
2. **升级前手动导入的 seed 节点**：删除命令不会清数据，已经通过拖放导入的
   `source = "seed"` 节点会留在池里；已到期用户的 `ended_at` 已写，不会再清理。
   是否补一次数据清理，还是接受这些存量节点继续可用？默认接受、不清理。
3. **后台循环空转**：默认保留 6 小时循环，过期时只读一次数据库。若希望彻底停掉，
   需要接受本地重置试用后必须重启应用才恢复刷新。
4. **错误码**：默认 `PRECONDITION_FAILED / trial_expired`。若产品要求独立码
   `TRIAL_EXPIRED`，需要先破 `commands.md` §1.6 的「不新增错误码」约定。
