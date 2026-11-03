# 文档索引

> 最后整理：2026-11-03
> **先看这里，再看具体文档。** 标「存档」的不要照着实现。

---

## 现行文档（以此为准）

| 文档 | 讲什么 | 什么时候读 |
|---|---|---|
| `implementation-plan.md` | 分几批做、谁做、里程碑 | **开工前必读** |
| `user-segments.md` | 四类用户怎么定义、怎么判定 | 任何涉及「面向谁」的判断 |
| `user-flows.md` | 首次启动、提问、配置确认、DNS 策略 | 做流程 |
| `configs-and-nav.md` | activity bar、左栏配置列表、配置模型 | 做导航与数据模型 |
| `center-panel.md` | 中间区域三段骨架与块词汇表 | 做中间区域 |
| `config-execution.md` | 确认之后怎么执行、节点从哪来 | 做连接与节点导入 |
| `capabilities.md` | 能力清单与分类（AI 提示词的同源依据） | 做任何后台能力 |
| `issue-management.md` | 问题管理模块 | 做诊断与失败处理 |
| `tun-mode.md` | TUN 配置差异、特权助手、内网排除 | 做二级用户路径 |
| `upgrade.md` | APP 与资源的升级 | 做发布 |
| `provider-integration.md` | 第三方服务商接入（后期） | 接服务商时 |
| `contracts/*.md` | 命令 / 事件 / 运行时 / 工具 / 分类契约 | 改接口时 |
| `issues/tweetpilot-resource-version-gap.md` | 外部项目的参考问题单 | 做资源版本管理时 |
| `review-checklist.md` | 每批的验收门禁与专项检查 | 提交前自检、交叉 review |

## 存档文档（不要照着实现）

| 文档 | 为什么存档 |
|---|---|
| `ui-redesign-spec.md` | 核心假设反了：它认为中间是对话、连接在右栏。现行是中间控制台、右栏对话 |
| `phase-1-5-requirements.md` §9 | 右栏状态面板已作废，主按钮与节点切换已挪到中间。其余章节仍有效 |
| `phase-1-requirements.md` | 早期界面布局已取代；后端需求条目仍有参考价值 |
| `phase-1-technical-design.md` | 同上；进程边界与运行时设计仍有效 |
| `acceptance-p1*.md` / `smoke-p1-macos.md` | P1 阶段的验收记录，历史材料 |

## 已改名

| 旧 | 新 |
|---|---|
| `docs/panels.md` | `docs/configs-and-nav.md` |

---

## 三条容易踩的旧说法

1. **「中间是对话，右栏是状态面板」** —— 反了。中间是控制台，右栏是对话。
2. **「连接按钮在右栏」** —— 已在中间顶部。
3. **「客户端消费 bootstrap.json」** —— 客户端消费的是 `veyl_seed.json`（只含节点），`bootstrap.json` 只是我们的上游来源。
