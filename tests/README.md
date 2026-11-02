# 测试环境

测试计划与用例在 `docs/test-plan.md`、`docs/test-cases/`。本目录只放**可运行的环境**，不放用例。

## 快速开始

```bash
# 0) 契约一致性（CI 第一步，几秒出结果）
node tests/contracts/check-contracts.mjs

# 1) 起三个 mock 服务并自检
bash tests/run-mocks.sh --selftest

# 2) 起一个真实的本地 sing-box 节点（需要先下载内核）
bash tests/local-node/setup.sh --download
bash tests/local-node/setup.sh --selftest

# 3) 生成恶意/替身归档与对应 manifest（含路径穿越、假 sing-box）
python3 -I tests/fixtures/make_archives.py
```

## 目录

| 路径 | 内容 |
|---|---|
| `run-mocks.sh` | 一键启动/停止 mock 服务；`--selftest` 做健康检查 |
| `mock-catalog/server.mjs` | 节点目录服务（设备注册、节点列表、故障注入、本地文件下发） |
| `mock-llm/server.mjs` | OpenAI 兼容接口，按剧本返回 `tool_calls` |
| `echo/server.mjs` | 回显服务，验证代理链路 |
| `local-node/setup.sh` | 真实 sing-box 服务端 + 客户端（VLESS Reality），带自检 |
| `contracts/check-contracts.mjs` | 契约一致性检查：事件名、chatStore 覆盖、快照字段 |
| `fixtures/nodes.json` | 节点数据（含不可达、凭证失效、注入载荷三种异常节点） |
| `fixtures/llm-scenarios/*.json` | 剧本：用户说什么 → 依次返回什么工具调用 |
| `fixtures/manifest-*.json` | 运行时清单：正常 / 坏 sha / 坏 URL / 路径穿越 / 假内核 |
| `fixtures/make_archives.py` | 生成归档与清单（sha 自动计算，不手填） |

## 端口

| 服务 | 端口 |
|---|---|
| 目录服务 mock | 18090 |
| LLM mock | 18091 |
| 回显 | 18080 |
| 本地节点 VLESS | 18443 |
| Reality 握手目标 | 18444 |
| 被测客户端 mixed | 12080 |
| 被测客户端 Clash API | 19090 |

全部可用环境变量覆盖（`MOCK_*_PORT` / `LOCAL_NODE_*_PORT`）。

## mock 目录服务的故障注入

请求加 `?_fault=` 或请求头 `X-Mock-Fault`：

| 值 | 行为 | 对应用例 |
|---|---|---|
| `timeout` | 不返回，30 秒后断连 | TC-CAT-006、TC-EXC-026 |
| `500` | 返回 500 | TC-EXC-027 |
| `malformed` | 返回截断的 JSON | TC-RT-003 |
| `slow&ms=3000` | 延迟 N 毫秒返回 | 超时边界 |

观测接口：`GET /__stats`（各类请求计数，用于断言「没有重复注册设备」）、`GET /__health`、`GET /__reset`。

下载接口：`GET /__file?name=<asset>` 下发 `fixtures/generated/` 里的归档（含恶意归档与假内核）。

## mock LLM 的剧本机制

请求里最后一条 user 消息带 `[scenario:connect-jp]` 即选择该剧本；未带则用默认剧本（`connect-jp`）。
轮次由「请求里已有多少条 assistant 消息」决定，服务端无状态，便于并发测试。

剧本里的工具名目前按 `phase-1-technical-design.md` §5.1 的契约写成 `catalog_search` / `vpn_connect` 这样的小写形式。
**W1 需要 Alice 确认 `Tool::name()` 的实际返回值**；如果实现用 `CatalogSearch` 这类 PascalCase，改 `fixtures/llm-scenarios/*.json` 即可，代码不用动。

观测接口：`GET /__stats`（请求计数）、`GET /__reset`、**`GET /__last_request`**（最近一次请求的完整消息数组，用于断言「节点凭据没有进入模型上下文」，对应 TC-CAT-012）。

## 本地节点的已知边界

- 只覆盖 **VLESS Reality**。Hysteria2 在 P1 只验证配置生成，没有本地服务端。
- 握手目标用本地自签 TLS 服务（`openssl s_server`），已实测可用；不需要外网。
- 脚本面向 macOS / Linux。Windows 需要 Bob 另写 PowerShell 版本，或直接在 Windows 上手工跑服务端。

## 注意事项

- `local-node/out/` 每次运行都会重新生成密钥与配置，**不要提交**（已在 `tests/.gitignore` 中忽略）。
- `fixtures/generated/` 里的归档与 `manifest-*.json` 由脚本生成，**要一起提交**：manifest 里的 sha256 与归档内容绑定，单独改一边会导致用例假失败。
- 测试 Keychain 用独立 service 名 `aivpn-test`，不要用生产 service 名。
