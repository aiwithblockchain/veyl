# claurst 流式解码把多字节汉字切坏：回复里偶发出现 `�`

> 核实日期：2026-11-12
> 核实方式：读子模块 `src-tauri/claurst`（`v0.2.1`，commit `e4228cc`）源码 + 真机回复与 `chat_messages` 取证
> 结论：**问题真实存在，属上游子模块缺陷；用户已决定不修改上游代码，本问题遗留。**

---

## 1. 现象

AI 回复里的中文偶发变成 `�`，例如「配置建好了，在左侧���看到」。

- **不是渲染问题**：数据库 `chat_messages.content` 里存的就是坏文本，重新打开会话、重新渲染都一样坏。
- 出现位置不固定：同一句话可能这次坏、下次好；模型、提示词、温度都不相关，只看网络分块边界。
- DeepSeek 走 openai 协议路径时必现（概率取决于分块），其它走 `SseByteDecoder` 的路径不受影响。

## 2. 根因

上游 `Kuberwastaken/claurst` `v0.2.1` 的
`src-rust/crates/api/src/providers/openai.rs:868`：

```rust
let text = String::from_utf8_lossy(&chunk);
```

它对**每个网络 chunk 单独**做 `from_utf8_lossy`，再按 `\n` 切行、拼 leftover。
一个汉字在 UTF-8 里是 3 字节，被切在两个 chunk 之间时，前半截和后半截各自都是非法序列，
`from_utf8_lossy` 分别替换成 U+FFFD（`�`）——两个替换符连起来，原文再也拼不回去。

同一个 crate 里的 `SseByteDecoder`（`src-rust/crates/api/src/stream_parser.rs:37`）是**正确写法**：
按字节缓冲、凑够一个完整 UTF-8 序列再解码；`openai_compat` 路径走它，因此不受影响。
`openai.rs` 这条流式分支没有用它。

## 3. 为什么现在不修

用户决定：**不修改 claurst 子模块的代码**，本地补丁已回滚，子模块保持干净（`v0.2.1` 原样）。

这样做的好处是升级子模块时不会产生本地分叉；代价是这个问题继续存在，直到上游修复或我们换路径。

## 4. 影响范围

- 只影响**回复文本的显示与存档**（`chat_messages.content`），不影响连接、配置创建、节点导入等任何写操作逻辑。
- 已经写进库的坏文本**不会自动修复**；重试同一次问答会生成新消息，但旧消息保持原样。
- 不影响工具调用参数：JSON 参数走另一条解析，未经过这段 lossy 解码。

## 5. 后续可选方案（不在本批做）

| # | 方案 | 说明 |
|---|---|---|
| 1 | 等上游修复后升级子模块 | 最干净；需要盯上游 issue / release |
| 2 | 改为走 `openai_compat` 的 provider 路径 | 该路径用 `SseByteDecoder`，但会改 provider 映射，需要评估兼容性 |
| 3 | 向上游提 PR | 把 `openai.rs` 的 chunk 解码换成按字节缓冲（参照 `SseByteDecoder`），对上游是通用修复 |

三条都**不在本批**执行；任何一条落地后，本记录随之关闭。

## 6. 取证与判定

复现或遇到时，先确认是这个问题、而不是新的缺陷：

```bash
sqlite3 -readonly "$HOME/.veyl/veyl.db" "select id, role, substr(content,1,120) from chat_messages where content like '%�%' order by created_at desc limit 5;"
```

- 查得到行 → 属于本问题，按已知问题记录，**不算新缺陷**。
- 查不到行（界面有 `�`、库里没有）→ 不是本问题，按渲染/前端问题另记。
- 同时确认子模块版本未被本地改动：`git -C src-tauri/claurst describe --tags` 应为 `v0.2.1`。
