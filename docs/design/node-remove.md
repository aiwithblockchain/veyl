# 移除自定义节点（订阅 / 手动）

> 日期：2026-11-24
> 状态：**待实现**。含一条需要新增的 Host 命令与契约版本变更。
> 触发：连接页现在没有任何移除 `url` / `manual` 节点的入口，用户加错一个节点就永久留在列表里。
> 相关：`docs/design/node-list-grouping.md`（三组显示）、`docs/design/node-import-ui.md`（手动添加）。

---

## 0. 结论

新增一条 Host 命令 `node_remove { node_id }`，只允许移除 `source` 为 `url` / `manual` 的节点：

- 托管节点（`owned`）不受理——它对应一台真实机器，只能在「我的服务器」里销毁；
- 免费节点（`seed`）不受理——它由种子刷新管理，删了下次刷新又回来。

界面上在节点行加一个「⋯ → 移除节点」，二次确认。

---

## 1. 现状

| 事实 | 证据 |
|---|---|
| 存储层已有删除函数，但只删 `nodes` 行 | `src-tauri/src/store/configs.rs:669` `delete_node` |
| 配置与节点是多对多关联表 `config_nodes` | 同文件 `:366`、`:478` 的删除写法 |
| 唯一的删除入口是托管节点的停机墓碑 | `src-tauri/src/agent/commands.rs:930` `node_forget` → `forget_owned_node`，前提是有对应 server |
| 界面没有任何调用 | `bridge.nodeForget` 无组件使用 |

也就是说：**`delete_node` 单独调用会留下 `config_nodes` 的悬空行**，运行配置重建时会撞上「节点不存在」的路径。所以新命令必须在一个事务里同时清掉关联。

---

## 2. 命令设计

```
node_remove { nodeId: string } -> { removed: boolean, wasCurrent: boolean }
```

执行顺序（照 `node_forget` 的既有约定：先动运行时，再动存储，最后发事件）：

1. 读节点；不存在 → `NOT_FOUND`。
2. `source` 不是 `url` / `manual` → `PRECONDITION_FAILED / node_not_removable`（`details.source` 带上）。
3. 若它是当前配置的当前节点：先停运行时（与「销毁当前连接节点时先停运行时」同一条规则）。
4. 一个事务里：删 `config_nodes` 中该节点的所有关联行 → 删 `nodes` 行。
5. 发 `node-list-changed`。

返回值：`removed` 恒为 true（失败走错误），`wasCurrent` 供界面决定是否提示「已断开」。

**错误码**：`NOT_FOUND` / `PRECONDITION_FAILED`（`node_not_removable`）/ `INTERNAL`（存储失败）。

---

## 3. 界面

- 位置：节点行右侧，悬停或在选中态显示「⋯」，菜单里一项「移除节点」。不做行内常驻按钮——移除不是高频动作。
- 二次确认（就地确认，不弹系统框）：
  - 标题：`移除「{name}」？`
  - 正文讲两件事：**只从这台电脑的节点池移除，不会影响你的服务商或订阅**；**如果是订阅导入的，下次刷新订阅还会出现**。
  - 若 `wasCurrent`：追加「当前正在使用，会先断开连接」。
- 结果：成功一行 `已移除`；失败一行错误，不整块变错误态。
- 免费节点与托管节点：不显示这个菜单项（后端也会拒，但界面先不给入口）。

---

## 4. 契约

- `commands.md` 新增一条命令，升小版本（当前 2.66.0 → 2.67.0），变更表写一行。
- `tools.md`：**不新增 AI 工具**。AI 没有删除节点的能力是刻意的——删节点会改变用户的连接选择，属于界面动作。
- `commands.md` §12/§13 的命令 → 工具映射里这一条写「无 AI 工具」。

---

## 5. 验收

1. 移除订阅节点：行消失、`config_nodes` 无悬空行、重启应用后不再出现。
2. 移除手动节点：同上。
3. 移除当前正在使用的节点：先断开，再移除，提示「会先断开」在确认里出现过。
4. 对托管节点与免费节点：菜单项不出现；即使绕过界面直接调命令，返回 `PRECONDITION_FAILED / node_not_removable`。
5. 移除后订阅刷新：订阅节点重新出现（这是预期，文案已说明）。
6. 中英文都过一遍；确认文案里不出现「删除」以外的技术词（不说 config、pool、node_id）。

---

## 6. 不做

- 不做批量移除。
- 不做「移除并加入黑名单」（订阅刷新还会出现，见上）。
- 不给 AI 工具入口。
