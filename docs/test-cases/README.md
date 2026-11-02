# P1 测试用例索引

> 配套文档：`docs/test-plan.md`
> 需求来源：`docs/phase-1-requirements.md`
> 最后更新：2026-11-02

---

## 文件

| 文件 | 内容 | 用例数 |
|---|---|---|
| [01-main-flow.md](01-main-flow.md) | 首次启动 → 配 Key → 连接 → 断开 | 8 |
| [02-exception.md](02-exception.md) | 7 类异常路径 + 安装审批 + 附加失败路径 | 33 |
| [03-runtime-config.md](03-runtime-config.md) | 运行时管理、安装校验、配置生成 | 30 |
| [04-ui-agent.md](04-ui-agent.md) | 外壳、对话、工具卡、事件契约、设置、诊断、体验指标 | 32 |
| [05-proxy-catalog.md](05-proxy-catalog.md) | 系统代理（macOS/Windows）、节点目录客户端 | 27 |
| [06-security.md](06-security.md) | 密钥、暴露面、提示注入、完整性、崩溃隔离 | 21 |
| [07-distribution.md](07-distribution.md) | 安装包、签名、公证、发布清单 | 19 |
| [99-p2-backlog.md](99-p2-backlog.md) | 明确留到后续阶段的项 | — |
| **合计** | | **170** |

---

## 编号与优先级

- 格式 `TC-<模块>-<三位序号>`；层标注 `U`（单元）/ `I`（集成）/ `E`（E2E）/ `M`（手工）/ `D`（发布脚本）。
- **P0** 主流程与安全底线，不过不发布；**P1** P1 范围必须通过；**P2** 留到后续阶段。

## 按层统计

| 层 | 大致数量 | 谁执行 |
|---|---|---|
| U 单元 | 约 40 | `cargo test` / 前端单测 / 契约检查脚本，Alice / Bob 编写 |
| I 集成 | 约 78 | `cargo test --test integration` + `tests/` mock 服务 |
| E E2E | 约 27 | tauri-driver |
| M 手工 | 约 20 | Clerk，W5 集中执行 |
| D 发布脚本 | 约 8 | Clerk |

---

## 追溯矩阵（FR → 用例）

| FR | 用例 |
|---|---|
| FR-1.1 | TC-SHELL-001 |
| FR-1.2 | TC-MAIN-001、TC-SHELL-002 |
| FR-1.3 | TC-SHELL-003 |
| FR-1.4 | TC-MAIN-008、TC-EXC-016、TC-PXY-013 |
| FR-1.5 | TC-MAIN-004、TC-SHELL-004 |
| FR-2.1 | TC-CHAT-001 |
| FR-2.2 | TC-CHAT-002、TC-CHAT-007 |
| FR-2.3 | TC-CHAT-003 |
| FR-2.4 | TC-CHAT-004、TC-EXC-030、TC-EXC-031、TC-EXC-032、TC-EXC-033 |
| FR-2.5 | TC-SHELL-005 |
| FR-2.6 | TC-CHAT-005、TC-CHAT-006、TC-CHAT-009、TC-EXC-029 |
| FR-2.7 | TC-MAIN-002、TC-MAIN-007、TC-EXC-001、TC-EXC-002 |
| FR-3.1 | TC-RT-001、TC-RT-002、TC-RT-003 |
| FR-3.2 | TC-RT-004、TC-EXC-008、TC-EXC-009、TC-EXC-010 |
| FR-3.3 | TC-EXC-011、TC-EXC-012、TC-SEC-015 |
| FR-3.4 | TC-RT-005、TC-RT-006、TC-RT-007、TC-RT-008 |
| FR-3.5 | TC-RT-009、TC-RT-010 |
| FR-3.6 | TC-RT-009 |
| FR-3.7 | TC-RT-011、TC-RT-012、TC-RT-013、TC-RT-015 |
| FR-3.8 | TC-EXC-020、TC-EXC-021、TC-RT-018、TC-SEC-019 |
| FR-3.9 | TC-EXC-015、TC-EXC-022、TC-RT-014 |
| FR-3.10 | TC-MAIN-004、TC-RT-017 |
| FR-4.1 | TC-CFG-001 ~ 005、TC-CFG-008、TC-CFG-009、TC-SEC-006、TC-SEC-007 |
| FR-4.2 | TC-CFG-007、TC-RT-015 |
| FR-4.3 | TC-EXC-024、TC-EXC-025 |
| FR-4.4 | TC-MAIN-006 |
| FR-4.5 | TC-CFG-006、TC-SEC-011 |
| FR-5.1 | TC-CAT-001、TC-CAT-002 |
| FR-5.2 | TC-CAT-003 |
| FR-5.3 | TC-CAT-004、TC-CAT-010、TC-CAT-011、TC-CAT-012 |
| FR-5.4 | TC-CAT-007 |
| FR-5.5 | TC-CAT-005、TC-CAT-006、TC-EXC-026、TC-DIAG-004 |
| FR-5.6 | TC-EXC-026、TC-EXC-027 |
| FR-5.7 | TC-CAT-008 |
| FR-6.1 | TC-PXY-001、TC-PXY-002 |
| FR-6.2 | TC-PXY-003、TC-PXY-004、TC-PXY-006、TC-PXY-007 |
| FR-6.3 | TC-PXY-008 ~ 012 |
| FR-6.4 | TC-EXC-016、TC-EXC-017、TC-EXC-018、TC-PXY-013 ~ 015 |
| FR-6.5 | TC-EXC-028、TC-EXC-013 |
| FR-7.1 | TC-MAIN-003 |
| FR-7.2 | TC-MAIN-004 |
| FR-7.3 | TC-EXC-005 |
| FR-7.4 | 错误分类枚举表、TC-EXC-004、TC-EXC-007、TC-EXC-013 |
| FR-7.5 | TC-MAIN-005、TC-MAIN-006、TC-EXC-004 |
| FR-8.1 | TC-MAIN-002、TC-SET-001、TC-EXC-001、TC-EXC-003、TC-SEC-005 |
| FR-8.2 | TC-SET-002、TC-SET-003 |
| FR-8.3 | TC-SET-004 |
| FR-8.4 | TC-SET-005、TC-EXC-018 |
| FR-8.5 | TC-SET-006、TC-SET-007 |
| FR-9.1 | TC-DIAG-001、TC-DIAG-004 |
| FR-9.2 | TC-DIAG-002 |
| FR-9.3 | TC-DIAG-003、TC-SEC-001 ~ 005 |
| 9.1 验收 | TC-MAIN-001 ~ 005 |
| 9.2 验收 | TC-EXC-001 ~ 023 |
| 9.3 验收 | TC-SEC-001 ~ 009 |
| 9.4 验收 | TC-DIST-001 ~ 017 |
| 9.5 验收 | TC-PERF-001 ~ 004 |
| `docs/contracts/events.md` | TC-CHAT-010 ~ 012 |
| `docs/contracts/runtime.md` §11 | TC-SEC-020、TC-SEC-021 |
| `docs/contracts/tools.md` / `catalog.md` | TC-CAT-004、TC-CAT-011、TC-CAT-012 |

---

## 覆盖缺口（需要 PM / 开发决策）

以下 FR 目前只有部分覆盖或无法在 P1 验证，已单独列出而不是用用例数量掩盖：

| 缺口 | 现状 | 建议 |
|---|---|---|
| FR-3.9「启动超时 10 秒」 | 有用例（TC-RT-014、TC-EXC-022），但**没有可靠的构造办法**让 sing-box 既不退出也不监听端口 | 需要 Bob 提供一个可替换的假可执行文件入口（测试构建） |
| FR-6.2「断开后浏览器恢复直连」 | 只能手工（TC-PXY-007） | 接受，写入手工矩阵 |
| FR-7.2「出口 IP 与地区」 | 依赖真实出口 IP 服务；mock 环境下只能验字段存在与格式 | 需要 Bob 把 IP 查询地址做成可配置，并在测试环境指向 mock |
| 9.5「首次连接成功率 ≥ 90%」 | 需要真实用户样本 | W5 dogfood 统计，测试只提供采集口径 |
| 9.2「应用被强杀」 | macOS 可脚本化；Windows 需要任务管理器或 `taskkill /F` | 手工执行，记录证据 |
| Hysteria2 连通性 | P1 只在配置生成层验证，无本地 Hysteria2 服务端 | 若 Bob 需要真实验证，需补一个本地 Hysteria2 节点（TLS 自签即可） |

---

## 当前契约偏差（`node tests/contracts/check-contracts.mjs` 实测，2026-11-02）

检查脚本已跑过，报出两处**实现与已冻结契约不一致**。这两条不是用例写得不对，是实现要改：

| # | 偏差 | 契约要求 | 归属 |
|---|---|---|---|
| 1 | `src/agent/protocol.ts` 仍是 `ai-message-chunk` / `ai-thinking-chunk` / `ai-tool-call-start` / `ai-tool-call-end`，且缺 `runtime-state-changed`、`runtime-health-changed`、`job-progress`、`approval-requested` 四个应用事件 | `docs/contracts/events.md`：前四个去 `ai-` 前缀；应用事件必须同时订阅 | Alice |
| 2 | `RuntimeStatus` 仍有 `pub clash_addr: Option<String>` 且 derive `Serialize` | `docs/contracts/runtime.md` §11：`clash_addr` 从 UI 快照中移除 | Bob |

`protocol.ts` 的注释自己写着「等契约文档到位后整体替换」——契约已于 2026-11-02 冻结，现在差的是这一步替换。替换后 TC-CHAT-010 会转绿。

这两条**不需要放宽检查**。检查脚本是防线，不是指标：它现在失败，说明它有效。
