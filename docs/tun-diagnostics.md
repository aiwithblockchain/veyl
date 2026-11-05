# TUN 诊断（debug 构建）

目标：用二分法定位「TUN 连上但网络不通」断在哪个区段。**只用于 debug 构建**；
release 不产生这些日志，也没有 `tun_probe` 命令。

## 1. 日志在哪

| 内容 | 路径 |
|---|---|
| App 日志 | 仓库根 `logs/`（dev）或 `~/.veyl/logs/`（release） |
| helper 分段日志 | `~/.veyl/helper-logs/helper.log` |
| sing-box 自身日志 | `~/.veyl/helper-logs/sing-box.log` |

debug 构建的 sing-box 日志级别默认是 `debug`（release 是 `warn`）。
临时改级别：`VEYL_SINGBOX_LOG=debug|info|warn|error`（只影响新生成的配置）。

## 2. helper 分段日志（`[diag]` 前缀）

按流水线顺序，一次连接各一行，带耗时：

| 行 | 关键字段 | 能判断什么 |
|---|---|---|
| `start 收到` | config_bytes、首次 | 请求是否到达 helper |
| `runtime 解析` | 来源、路径、验签、耗时 | 运行时缺失/验签失败 |
| `规则就绪` | 数量、耗时、cache_hit | 规则归档没解出来 |
| `配置写入` | path、bytes、sha256 前 12 位 | 配置是否写成、内容是否变化（不写内容） |
| `spawn` | pid、参数 | sing-box 是否起来了 |
| `接管开始` / `接管结束` | tun、路由数、关键段覆盖、缺失段、耗时 | 路由是否完整（0/1、128/1、16/4、32/3） |
| `stop` | 原因、进程状态、残留 utun 路由 | 停止是否干净 |

App 侧对应一行：`连接完成`（耗时）或 `连接失败 卡在=<阶段> … code/reason/wire_code`。
`卡在` 的取值：运行时 / 规则数据 / 特权助手 / TUN 启动 / 路由接管 / sing-box 进程。

## 3. `tun_probe`（仅 debug）

TUN **已连接**时调用，采集一次并写报告：

```
~/.veyl/diagnostics/tun-<YYYYMMDD-HHMMSS>.txt
```

命令返回一句话结论与报告路径。采集内容：

1. utun 接口是否存在、地址、路由数与关键段覆盖；
2. 当前节点服务器能否直连（TCP + 耗时）；
3. 系统 DNS 能否解析 `www.apple.com`；
4. 经隧道访问 `https://www.apple.com/` 的状态码/错误；
5. sing-box 进程是否存活、pid、建立时间。

它只读，不改路由、不改连接。

## 4. 症状 → 先看哪几行 → 下一步

| 症状 | 先看 | 下一步 |
|---|---|---|
| 连上但全站不通 | `tun_probe` 的「节点直连」与「经隧道 HTTPS」 | 节点直连失败 → 查本地网络/节点地址；直连成功但 HTTPS 失败 → 看出站拨号（sing-box debug 日志） |
| 打不开网页，但 IP 直连可以 | `tun_probe` 的「系统 DNS」 | DNS 失败 → 看 `route.rules` 的 hijack-dns 与 `dns` 段；重置后仍失败执行「强制重置网络」 |
| 连上后整机断网 | helper `接管结束` 的缺失段 | 缺 `16/4`、`32/3` 等 → 路由被旧实例删除或节点服务器未旁路，对比 `连接失败 卡在=路由接管` |
| 连接很快成功但随后掉线 | `stop 原因` 与 `残留utun路由` | 有残留 → 用「强制重置网络」；没有 → 看 sing-box 退出原因 |
| 一直「未连接」 | App `连接失败 卡在=` | 运行时/规则/helper 三档按阶段名直接定位 |
| 连接超时 | helper `start 完成 总耗时` 与各阶段 | 哪一段耗时异常就看那一段（规则解包、check、spawn） |

## 5. 隐私

诊断日志只写接口名、IP、端口、路径、字节数与哈希前缀。**不写配置内容、密码、
订阅链接或代理凭据。** 分享日志前仍建议检查一遍 `sing-box.log` 里是否有节点信息。
