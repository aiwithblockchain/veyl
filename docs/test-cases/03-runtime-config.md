# 运行时与配置用例

> 覆盖 FR-3.x（运行时管理）、FR-4.x（配置生成）
> 层：U = 单元，I = 集成（真实 sing-box 进程）
> 归属：Bob

---

## 1. 清单与下载

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-RT-001** | U | FR-3.1 | `manifest-ok.json` | 1) 解析清单；2) 按 `platform=darwin,arch=arm64` 查询 | 返回恰好 1 条匹配项，字段完整（`upstream_version` / `url` / `sha256` / `size` / `source_url` / `license`）；缺失任一字段时解析报错而不是静默忽略 | P0 |
| **TC-RT-002** | U | FR-3.1 | 清单中 platform/arch 不匹配 | 1) 查询 | 返回空集合并给出「当前平台无可用版本」，不得回退到其它平台的包 | P0 |
| **TC-RT-003** | U | FR-3.1 | 清单被截断（JSON 语法错误） | 1) 解析 | 报错并**拒绝启动安装流程**；不得使用部分解析结果 | P1 |
| **TC-RT-004** | I | FR-3.2 | `manifest-ok.json` | 1) 下载 darwin-arm64 归档；2) 校验 | 文件大小 == 清单 `size`（实测 1.14.4 arm64 为 `29186204`）；sha256 == `0d8c7f5e…a406838` | P0 |
| **TC-RT-005** | I | FR-3.4 | `manifest-traversal.json`（归档内含 `../../evil`） | 1) 解压 | 拒绝解压；`error_code=download_failed`（或专用 `unsafe_archive`）；**目标目录外无任何文件被创建**；归档被删除 | P0 |
| **TC-RT-006** | U | FR-3.4 | 归档内含绝对路径条目 `/tmp/evil` | 1) 解压 | 拒绝；错误信息指出条目名（截断后） | P0 |
| **TC-RT-007** | U | FR-3.4 | 归档内含指向外部的符号链接 | 1) 解压 | 拒绝；不创建该链接 | P0 |
| **TC-RT-008** | U | FR-3.4 | 归档为 `.zip`（Windows 通道） | 1) 解压 | 与 `.tar.gz` 走同一套安全检查；路径穿越同样被拒绝 | P1 |
| **TC-RT-009** | I | FR-3.5、FR-3.6 | 安装成功 | 1) 查看安装目录；2) 执行 `sing-box version` | 目录名含版本号；可执行文件权限正确（macOS 保留 +x）；`sing-box version` 输出 `sing-box version 1.14.4` 且退出码 0 | P0 |
| **TC-RT-010** | I | FR-3.5 | 已安装 1.14.4，再次安装同版本 | 1) 重复安装 | 幂等：不重复下载（或下载后覆盖），最终状态一致；不产生两份目录 | P1 |

---

## 2. Runtime Manager 状态机

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-RT-011** | U | FR-3.7 | — | 1) 依次驱动 `not_installed → installing → installed → starting → running → stopping → idle` | 每步迁移被允许；非法迁移（如 `idle → running`）被拒绝且状态不变 | P0 |
| **TC-RT-012** | U | FR-3.7 | 状态 `running` | 1) 直接调 `start` | 拒绝重复启动，返回「已在运行」；不产生第二个进程 | P0 |
| **TC-RT-013** | U | FR-3.8 | 状态 `failed` | 1) 调 `stop` | 幂等成功，不报错 | P1 |
| **TC-RT-014** | I | FR-3.9 | 可执行文件存在但不监听端口 | 1) `start` | 恰好 10 秒判超时；状态 `starting → failed`；进程被终止 | P0 |
| **TC-RT-015** | I | FR-3.7、FR-4.2 | 合法配置 | 1) 启动；2) 2 秒内 `GET /version` | 返回 200，body 形如 `{"meta":true,"premium":true,"version":"sing-box 1.14.4"}` | P0 |
| **TC-RT-016** | I | FR-4.1、7 安全设计 | 已启动 | 1) 不带 Authorization 请求 `/version`；2) 带错误 secret 请求 | 两次均返回 **401**；secret 非空且长度 ≥ 32 字节随机值；`external_controller` 只绑定 `127.0.0.1`（不得出现 `0.0.0.0`） | P0 |
| **TC-RT-017** | I | FR-3.10 | 运行中 | 1) `runtime_status` | 返回 `state` / `pid` / `version` / `uptime_seconds` / `health{process,clash_api,data_plane}` / `exit_ip` / `last_error`；`pid` 与真实进程一致 | P0 |
| **TC-RT-018** | I | FR-3.8 | 运行中 | 1) 杀掉进程；2) 每 100ms 采样状态 | 状态在 2 秒内离开 `running`；重启完成后 `pid` 变化；期间**不得**出现「running 且 pid 已死」的持续状态（采样 20 次，不得连续 3 次以上命中） | P0 |

---

## 3. 配置生成

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-CFG-001** | U | FR-4.1 | `seed-jp-01`（VLESS Reality） | 1) 生成配置；2) `sing-box check -c` | `check` 退出码 0；`inbounds[0].type == "mixed"` 且 `listen == "127.0.0.1"`；`route.final == "proxy"`；`experimental.clash_api.external_controller` 为 `127.0.0.1:<port>` | P0 |
| **TC-CFG-002** | U | FR-4.1 | `seed-hy2-01`（Hysteria2） | 1) 生成；2) `check` | `check` 退出码 0；出站 `type == "hysteria2"`；无 `reality` 字段 | P0 |
| **TC-CFG-003** | U | FR-4.1 | 缺失 `uuid` | 1) 生成 | **生成阶段即报错**（`config_invalid`，字段 `outbounds[0].uuid`）。实测 `sing-box check` 会放过这类配置，所以不能只靠 `check` | P0 |
| **TC-CFG-004** | U | FR-4.1 | 缺失 `reality.public_key` | 1) 生成 | 报错并指出字段路径 | P0 |
| **TC-CFG-005** | U | FR-4.1 | 端口为 0 / 70000 / 字符串 | 1) 生成 | 三种均被拒绝，错误指明字段 | P1 |
| **TC-CFG-006** | U | FR-4.5、9.3 | 任意节点 | 1) 生成配置；2) grep 全文本 | 配置中**不含** `veyl`、平台标识、遥测字段、设备 ID；节点名称不写进配置（不需要） | P0 |
| **TC-CFG-007** | I | FR-4.2 | 生成成功 | 1) 检查临时文件权限 | 临时文件未移入 `config/active.json` 之前权限为 `0600`；`active.json` 同样 `0600`；临时文件在成功后不残留 | P1 |
| **TC-CFG-008** | U | FR-4.1 | 指定 `mixed_port=12080` | 1) 生成 | 生成结果里 `listen_port == 12080`（端口可配置性） | P1 |
| **TC-CFG-009** | U | FR-4.1 | 两次生成同一节点 | 1) 比较配置 | `clash_api.secret` **每次不同**；其余字段一致 | P0 |
| **TC-CFG-010** | I | FR-4.2 | 配置中 `listen_port` 指向已占用端口 | 1) `sing-box check`；2) 启动 | `check` 通过（它不检查端口占用）；启动被识别为 `port_in_use`，日志含 `bind: address already in use` | P0 |

---

## 4. 本地集成环境自检

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-RT-019** | I | 测试环境 | `tests/local-node/setup.sh` 首次运行 | 1) 运行脚本；2) 脚本自检 | 生成 `client.json` / `server.json` 并各自 `sing-box check` 通过；启动后 `GET /version` 返回 200；通过 mixed 入站访问回显返回 `VEYL_ECHO_OK` | P0 |
| **TC-RT-020** | I | 测试环境 | 本地节点已启动 | 1) 停掉服务端；2) 通过 mixed 入站请求回显 | 返回 **502 Bad Gateway**（实测）；Host 应把它归为 `node_unreachable` | P0 |
