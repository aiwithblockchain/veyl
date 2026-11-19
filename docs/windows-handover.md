# Windows 交接：现状、缺口与验证路径

> 日期：2026-11-19
> 面向：接手 Windows 实现的工程师
> 先读：`docs/windows-tun.md`（为什么这么设计）、`docs/windows-tun-w0-w2-handover.md`（服务/管道/认证的验证清单）、`docs/windows-tun-w3-handover.md`（TUN 竖切的验证清单）、`docs/tun-privilege-implementation-plan.md` §阶段 W
> 本文只讲**现在处于什么状态、还缺什么、怎么验证**，不重复那几份文档的步骤。

---

## 0. 一句话

**Windows 的代码写到 W3（服务 + 命名管道 + 对端认证 + TUN 竖切 + 平台配置差异），全部已进 `main`；但这套代码从未在 Windows 上运行过一条命令。** 当前最大的风险不是「还缺多少功能」，而是「第一次真机跑起来会怎样，我们不知道」。

---

## 1. 代码现状（都已提交，可查）

| 模块 | 位置 | 状态 |
|---|---|---|
| 平台门控 | `src-tauri/Cargo.toml` 的 `[[bin]]` 门控、`tun/session.rs`、`tun/backend.rs` | 完成 |
| 常驻服务 | `src-tauri/src/bin/veyl-service/` | 代码完成，未运行 |
| 命名管道 / 帧 / ACL | `tun/windows/pipe.rs`、`ipc.rs`、`acl.rs` | 代码完成，未运行 |
| 对端认证 | `tun/windows/peer.rs`（PID → 句柄 → `WinVerifyTrust`） | 代码完成，只用自签证书试过静态逻辑，未真机 |
| TUN 竖切 | `tun/windows/backend.rs`、`runtime.rs`、`process.rs`、`scm.rs` | 代码完成，未运行 |
| 平台配置差异 | `config/builder.rs`（`198.18.0.1/15`、排除段校验、`strict_route`、`gvisor`、`ipv4_only`） | 完成 |
| 代理模式 | `src-tauri/src/proxy/windows.rs`、`backup.rs`、`netcfg.rs` | 已存在，CI 有类型检查 |
| 开发脚本 | `scripts/windows/dev-install-service.ps1`、`dev-uninstall-service.ps1`、`dev-sign.ps1`、`dev-squat-pipe.ps1` | 开发用，不是安装器 |
| 运行时抓取 | `scripts/runtime/fetch-runtime.mjs` | 支持 windows x64（sing-box.exe + wintun.dll），无 arm64 |

**注意：`main` 目前领先 `origin/main` 8 个提交，CI 没跑过这批。** 下一个人接手前先推一次，让 `windows-latest` 至少把 `cargo check --all-targets` 跑一遍——那是当前唯一能廉价发现「Windows 目标编不过」的手段。

本地交叉编译**不要试**：`cargo check --target x86_64-pc-windows-msvc` 在 macOS 上会卡在 `aws-lc-sys` 的 C 依赖（缺 `windows.h`），这不是代码问题，是工具链没有 Windows SDK。要验只能靠 CI 或真机。

---

## 2. 从未验证的部分（优先级最高）

`docs/windows-tun-w3-handover.md` §6 已经列出这些，这里只强调顺序：

1. **服务安装与启动**（`dev-install-service.ps1` → `sc query`）。这是所有后续步骤的前提。
2. **管道与对端认证**：非管理员客户端能连上；未签名/他签客户端被拒；抢占管道快速失败。
3. **TUN 竖切**：服务 staging `sing-box.exe` + `wintun.dll` → 拉起 → 界面（普通用户）连上 → 出口 IP 改变 → 断开无残留。
4. **`strict_route` 与其它 VPN / 安全软件共存**：这是最容易在真机上翻车的一条，翻车了先记录现象，不要当场改设计。

---

## 3. 还没做的功能（按影响排序）

### P0 · 不做就用不起来

1. **规则集没有 staging 到 `%ProgramData%\Veyl\rules\*.srs`。**
   服务只从那里读；当前开发安装下，任何引用 `rule_set` 的配置都会返回 `rule_set_missing`。W5 安装器负责投放，但可以先用手工拷贝验证链路。

2. **`tun::collect()` 在 Windows 上返回空**（`tun/mod.rs:574`）。
   后果：界面和 AI 判不出 TUN 是否真的接管（`tun_device_up` / `tun_default_route` 恒为 `null`），分流切换回复里带 `runtime_state=tun_unknown`。要做适配器枚举（`GetAdaptersAddresses`）+ 默认路由判定。这不是体验问题，是「我们不知道连接成没成」。

3. **没有安装器（W5）。**
   现有 `scripts/windows/*.ps1` 是开发脚本，不是产品安装流程。目标是：per-user 应用安装器（NSIS `currentUser`，不弹 UAC）+ **首次需要 TUN 时才提权**安装服务；卸载要停服务、删适配器、清代理/DNS、删目录。

4. **没有签名（W6）。**
   Authenticode + 时间戳，服务、提权安装器、主程序、安装包都要签。**Windows 代码签名证书仍未确认**，这是外部依赖，只阻塞分发，不阻塞实现。

### P1 · 会让用户困惑或偶发失败

5. **首次授权体验仍是 macOS 的说法。**
   `src/components/HelperPermissionDialog.tsx`、`TunHelper.tsx`、`agent/bridge.ts` 里的文案是「系统设置 › 通用 › 登录项与扩展」。Windows 上这套流程不存在，需要换成 UAC / 服务安装的说法与动作。这是**界面必须分平台**的地方，不是纯文案。

6. **`ipv4_only` 同时作用于节点域名解析。**
   IPv6-only 节点在 TUN 模式下解析不到。遇到时记录现象，不要自行改回 `prefer_ipv4`——那会让 AAAA 绕开隧道。

7. **Wintun 适配器清理**：`stop` 走 `TerminateProcess`，不保证删除虚拟网卡；卸载器要兜底。

8. **临时端口竞态**：pick → check → spawn 之间仍有窗口（已加 spawn 前再确认，不是原子）。

9. **运行时哈希每次 `start` 重算**（约 78 MiB 读盘），慢盘上会计入 30 秒回复预算。

---

## 4. 会咬人的设计取舍（改之前先读）

- **TUN 地址必须与排除段不重叠**：Windows 用 `198.18.0.1/15`，而 macOS 用 `172.19.0.1/30` 且排除段里含 `172.16.0.0/12`。两套地址不能互换。生成阶段与服务端各有一道校验，谁改排除表都要过这两道。
- **`strict_route = true`** 是防泄漏的，代价是与其它 VPN / 安全软件冲突。降级前先有真机证据。
- **`stack = gvisor`**：纯用户态，和系统网络栈共存问题最少，但性能不如 system 栈。别为了性能随手换。
- **对端认证只看签名、不看客户端路径**；两侧读写都有超时。这条不要为了「方便调试」放宽。
- **服务不读任何用户可写路径**（staging 目录固定、文件名按 sha256 命名）。

---

## 5. 怎么验证

1. **CI（廉价、每次推送都跑）**：`.github/workflows/ci.yml` 的 `windows-latest` 会跑 `npm run typecheck`、`npm test`、`cargo test --lib`、`cargo check --all-targets`。它**不能**验证 TUN（Wintun、路由、服务装卸都要真机），但能挡住编译级回归。
2. **真机（唯一能验 TUN 的地方）**：按 W0–W2 / W3 两份 handover 的清单逐条执行，结果写回文档。
3. **日志位置**：服务日志 `%ProgramData%\Veyl\logs\service.log`；应用日志同 macOS（debug 构建在仓库 `logs/`，release 在数据目录）。
4. **常见失败**：服务未注册 → `sc query Veyl`；管道连不上 → 看 ACL 与是否单实例；`runtime_missing` → staging 目录；`rule_set_missing` → P0 第 1 条。

---

## 6. 建议顺序

1. 推 `main`，让 CI 在 `windows-latest` 跑一次，先确认「能编译」。
2. 真机走 W0–W2 清单（服务、管道、认证），把结果写回 `windows-tun-w0-w2-handover.md`。
3. 真机走 W3 清单（TUN 竖切），重点看 `strict_route` 共存与适配器残留。
4. 补 P0-2（`tun::collect()`），让界面和 AI 能判断接管真的成立。
5. 做 W5 安装器 + 规则集投放，再做 W6 签名（等证书）。
6. P1-5（分平台授权文案）可以和 W5 一起做——它们讲的是同一件事。

---

## 7. 交接时请一并转达的三件事

1. **代码作者从未在 Windows 上运行过**，所有「通过标准」都还没有实际结果；不要在报告里写「已验证」。
2. **真机验证由产品负责人执行**，开发侧只提供可复制的命令与判定标准，不远程操作。
3. **签名证书未确认**，它只阻塞分发（W6），不阻塞实现与真机验证。
