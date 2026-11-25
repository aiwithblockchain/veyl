# 编辑自定义节点（手动可改全项，订阅只改名）

> 日期：2026-11-25
> 状态：**已定，待实现**。
> 触发：自定义节点只有「添加」和「移除」，加错一个参数只能删掉重加；改了服务器密码也没地方同步。
> 相关：`docs/design/node-remove.md`（同一入口的移除）、`docs/design/node-list-grouping.md`（分组后的行结构）、`docs/design/node-import-ui.md`（手动填写表单与校验口径）。

---

## 0. 结论

新增一条 Host 命令 `node_update`，在节点行 `⋯` 里加「编辑节点」：

| 节点来源 | 名称 | 地址 / 端口 / 加密方式 / 密码 |
|---|---|---|
| `manual`（手动填写、粘贴 `ss://`） | 可改 | 可改 |
| `url`（订阅导入） | 可改 | **只读**，界面上灰显并说明「来自订阅」 |
| `owned` / `seed` | 不受理 | 不受理 |

订阅节点的连接参数不改，是因为它们由订阅内容决定：去重键是 `sha256(name \x1f server \x1f port \x1f method)`（`nodes.rs:130`），改掉任意一项，订阅刷新时算出来的键就对不上，于是**同一条订阅会多长出第二个节点**，用户会看到「改过的」和「订阅原本的」并存。刷新遇到重复是整条跳过、不覆盖（`tools/services.rs:4298`），所以不存在「被改回去」，只有「变成两条」。名称可改是因为改名时保留原 `source_key`，键仍然对得上。

---

## 1. 现状

| 事实 | 证据 |
|---|---|
| 存储层已有整体写入节点的能力 | `src-tauri/src/store/configs.rs:592` `upsert_node`（按 id upsert 全部字段） |
| 存在的改名能力只服务托管节点 | `configs.rs:691` `rename_node`，唯一调用方是控制面同步服务器改名（`control_plane/servers.rs:722`） |
| 界面没有任何编辑入口 | `src/components/ConnectionStage.tsx` 的 `⋯` 菜单只有「移除节点」 |
| 密码只进加密存储、不回读 | UI 拿到的 `NodeSummary` 没有密码字段；`secrets::get_secret` 只有 Host 内部在用 |
| 测速结果是内存态，不在库里 | `tools/probe_batch.rs` 的注册表；`node_probe_snapshot` 读它 |

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
}
```

执行顺序：

1. 读节点（`get_node`）；不存在 → `NOT_FOUND / node_not_found`。
2. `source` 不是 `url` / `manual` → `PRECONDITION_FAILED / node_not_editable`（`details.source`）。
3. `source = "url"` 且带了任一连接参数 → `PRECONDITION_FAILED / subscription_params_readonly`。名称照常可改。
4. 校验与 `node_create` 同一套：名称 ≤64 字、地址 ≤253 字节且不含空白与斜杠、端口 1–65535、`method` 必须在 `nodes.rs:19` 的 `SUPPORTED_METHODS` 里；失败按 `INVALID_ARGUMENT`，`details.reason` 与新建一致（`invalid_argument` / `unsupported_method`）。
5. 读运行时快照：`runtime.node_id == nodeId` 时先停运行时（顺序照 `node_forget`：运行时 → 存储 → 事件），记下 `was_current = true`。
6. 一个事务里：`upsert_node` 用**原 id**、**原 source_key** 覆盖 `name / server / port / method / updated_at`；`password` 非空时先写 `secrets.enc` 再提交（先写凭据再写行，与导入一致）。`created_at` 不动。
7. 清掉这个节点的测速结果（内存注册表按 `node_id` 移除；它就是当前节点时，运行时快照里的 `node_latency_ms` 一并置空——旧延迟属于旧地址）。
8. 发 `node-list-changed(reason = "node_updated")`；`paramsChanged` 时再发 `config-changed(change = "updated")`。

**id 与去重键不变**：`config_nodes` 绑定、当前节点指向、选择器缓存都按 `node_id` 引用；`source_key` 保持创建时的值，这样用户改过参数后再导入一次原链接仍按「已有相同节点」跳过，不会长出第二行。代价是：改了地址之后，导入**新地址**的链接不会被认为重复——这是预期（它确实是一条不同的节点）。

**密码**：返回里不含密码；`password` 省略或空串表示保持原密码，`details` 不说明是否改过。

**错误码**：`NOT_FOUND` / `PRECONDITION_FAILED`（`node_not_editable`、`subscription_params_readonly`）/ `INVALID_ARGUMENT`（与新建同口径）/ `SECRET_STORE` / `INTERNAL`（存储失败）。

---

## 3. 界面

- 入口：节点行 `⋯ → 编辑节点`，放在「移除节点」上方，中间一条分隔。托管与免费节点不出现这一项（与移除一致）。
- 表单：复用添加节点弹层的「手动填写」段，进入编辑态时预填名称、地址、端口、加密方式；密码留空，占位文案「不修改就留空」。
- 订阅节点：地址、端口、加密方式、密码四栏只读并附一句「这些来自订阅，订阅里改了再重新导入」。名称可改。
- 保存：主按钮「保存」；提交中禁用整张表单与「取消」。成功后关闭弹层，行内名称即时更新，提示一行「已保存」。
- `wasCurrent = true`：关闭弹层后在节点卡顶部给一行「已断开，重新连接后使用新设置」，不自动重连（改完的参数可能连不上，自动连会把用户带进失败态）。
- 失败：错误贴着对应字段（与添加节点同一套映射）；`subscription_params_readonly` 落到参数区，`node_not_editable` 落到弹层顶部一行。

---

## 4. 契约

- `commands.md` 新增一条命令，升小版本（当前 2.69.0 → 2.70.0），命令表与变更记录各一行；§12/§13 的「无 AI 工具」列表加上这一条。
- `events.md` 的 `NodeListChangedReason` 新增 `"node_updated"`，事件契约升版（当前 2.24.0 → 2.25.0）：`runtime/manager.rs` 的 `EVENT_CONTRACT_VERSION`、`src/agent/protocol.ts` 与 `mockAgent.ts` 的常量、events.md 的头部与枚举同步。
- `tools.md`：**不新增 AI 工具**。改节点参数会改变用户的连接选择，和移除一样属于界面动作。

---

## 5. 验收

1. 改手动节点的名称：行内名字变了，地址与密码不变，重启后仍是新名字。
2. 改手动节点的地址/端口/加密/密码：保存后该节点的测速结果变回「未测」，用新参数能连上。
3. 改当前正在使用的节点：先断开，再保存，提示里出现「已断开，重新连接后使用新设置」；不自动重连。
4. 订阅节点：连接参数四栏只读并有说明；只改名称能保存。
5. 托管与免费节点：`⋯` 里没有「编辑节点」；绕过界面直调命令返回 `PRECONDITION_FAILED / node_not_editable`。
6. 校验：空名称、带协议地址、端口越界、白名单外的加密方式都贴着字段报错，不发命令；密码留空不覆盖原密码。
7. 改过名称后再导入一次原订阅/原链接：不出现第二行（仍按相同节点跳过）。
8. 中英文各过一遍；界面与提示里不出现 node_id、source_key、secret 这类词。

---

## 6. 不做

- 不做批量编辑。
- 不做「订阅节点重建」（改订阅参数只能去服务商改完重新导入）。
- 不给 AI 工具入口。
- 不做编辑历史/撤销；改坏了可以再改回来。
