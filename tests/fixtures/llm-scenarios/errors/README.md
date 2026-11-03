# 工具错误路径剧本

18 条失败剧本，覆盖 `docs/contracts/tools.md` 3.0.0 里常见的工具失败路径。用途：让 E2E 能稳定复现「工具失败 → Agent 给出可执行建议」这条路径，而不是靠手工制造故障。

## 怎么用

Mock LLM 按用户消息里的 `[scenario:err-<Tool>]` 选择剧本：

```bash
curl -s -X POST http://127.0.0.1:18091/v1/chat/completions \
  -H 'Authorization: Bearer sk-test-valid' -H 'content-type: application/json' \
  -d '{"model":"deepseek-chat","stream":false,"messages":[{"role":"user","content":"[scenario:err-VpnConnect]"}]}'
```

剧本本身只负责「发出这次工具调用」。**工具是否真的失败，取决于被测环境**——例如 `err-RuntimeStart` 要求运行时确实没装，`err-CatalogSearch` 需要 `?_fault=500` 或停掉目录服务。前置条件写在下表。

## 字段

| 字段 | 含义 |
|---|---|
| `expect_error_code` | 期望工具返回的错误码；`null` 表示这条预期**成功** |
| `expect_ok` | 与上面对应的布尔形式 |
| `contract_backed` | 该错误码是否在契约里写明。`false` 表示契约没定义，是测试侧假定 |

## 覆盖表

| # | 工具 | 期望 | 契约依据 | 触发条件 |
|---|---|---|---|---|
| 1 | `RuntimeStatus` | `INTERNAL` | §4.1 | 快照损坏/权限不足（需故障注入） |
| 2 | `RuntimeStart` | `RUNTIME_NOT_INSTALLED` | §4.2 | 运行时未安装 |
| 3 | `RuntimeStop` | `RUNTIME_EXITED` | §4.3 | 进程已退出后再停 |
| 4 | `RuntimeRestart` | `RUNTIME_NOT_INSTALLED` | **无** | 运行时未安装 |
| 5 | `RuntimeLogs` | `INTERNAL` | **无** | 日志文件缺失 |
| 6 | `CoreListVersions` | `INTERNAL` | **无** | 内置清单损坏 |
| 7 | `CoreInstall` | `APPROVAL_REQUIRED` | §4.7 | 未审批直接调用 |
| 8 | `CatalogSearch` | `CATALOG_UNAVAILABLE` | §4.8 | 目录服务不可达 |
| 9 | `ConfigList` | `INTERNAL` | **无** | 本地数据库损坏 |
| 10 | `NodeImportUrl` | `UPSTREAM_ERROR` | §4.10 | 订阅地址当前拉不到 |
| 11 | `VpnConnect` | `PRECONDITION_FAILED` | §4.11 | 未导入配置就连接 |
| 12 | `VpnDisconnect` | `PRECONDITION_FAILED` | **无** | 未连接时断开 |
| 13 | `DiagRun` | `INTERNAL` | **无** | 诊断内部失败 |
| 14 | `DeepseekSetupKey` | **成功**（`expect_ok`） | §4.14 | 离线仍返回步骤，契约明确不报错 |
| 15 | `DeepseekSaveKey` | `INVALID_ARGUMENT` | §4.15（schema `minLength: 20`） | Key 长度不足 |
| 16 | `JobGet` | `NOT_FOUND` | §4.16 | 查询不存在或过期的 job |
| 17 | `AskUserQuestion` | `USER_DISMISSED` | **无**（Claurst 内置） | 用户关闭提问 |
| 18 | `ConfigDelete` | `PRECONDITION_FAILED` | §4.17 | 删除正在连接的配置 |

## 需要架构师补契约的 7 处

下面这些工具的失败形态契约里没写，剧本按最合理的假定填了 `contract_backed: false`。**实现与测试必须对齐同一个值，否则这条剧本只是自说自话**：

| 工具 | 缺什么 |
|---|---|
| `RuntimeRestart` | 错误码列表（大概率与 `RuntimeStart` 相同，但没写） |
| `RuntimeLogs` | 错误码列表（日志文件缺失时返回什么） |
| `CoreListVersions` | 错误码列表（清单损坏时返回什么） |
| `ConfigList` | 错误码列表（本地库损坏时返回什么） |
| `VpnDisconnect` | 错误码列表（未连接时是否报错，还是幂等成功） |
| `DiagRun` | 错误码列表（部分检查失败算 `ok:false` 还是 `ok:true` + 明细） |
| `AskUserQuestion` | 用户忽略提问时的语义（Claurst 内置，需确认其 `ToolResult` 形状） |

> `DeepseekSetupKey` 不是缺口：契约 §4.14 明确「离线时仍可返回步骤，不报错」，所以它没有失败剧本，只有一条「成功」剧本。这是 18 条剧本里唯一的例外，不是漏写。
