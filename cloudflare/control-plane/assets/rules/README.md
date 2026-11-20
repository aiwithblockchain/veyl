# 国内分流规则集（sing-box `.srs` + Clash `.mrs`）

`GET /rules/<name>` 原样下发这四个文件，公开只读：

- `.srs`（sing-box binary rule-set）：profile 的 `route.rule_set` 引用；
- `.mrs`（mihomo MRS）：Clash profile 的 `rule-providers` 引用。

见 `src/rules.ts`、`src/mobile.ts`。

## 文件与校验值

| 文件 | 大小 | sha256 |
| --- | --- | --- |
| `geosite-cn.srs` | 57,792 B | `cd66decb391db5895049ac2dba21d6c493f013092f36e47918ee1d3d672c3fe2` |
| `geoip-cn.srs` | 34,259 B | `29ed29ad2fee7a60dc1a94d73d6812a277e02aff46822689c8368be9caf45ed8` |
| `geosite-cn.mrs` | 532,882 B | `0b8c7c4d9773471991dd65737fdb16f3bf1baf2512c8b764d4c235318f01b7c6` |
| `geoip-cn.mrs` | 37,527 B | `895fd8e055ce9b26c297571c5244c2a314a1e2184122bd3b83276be75e0befb1` |

## 来源与版本

| 文件 | 上游仓库 | 拉取的分支头 | 下载地址 |
| --- | --- | --- | --- |
| `geosite-cn.srs` | `SagerNet/sing-geosite` | `rule-set` @ `d5d8660`（2026-11-19T06:41:55Z） | `https://cdn.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-cn.srs` |
| `geoip-cn.srs` | `SagerNet/sing-geoip` | `rule-set` @ `66c864f`（2026-11-12T16:38:37Z） | `https://cdn.jsdelivr.net/gh/SagerNet/sing-geoip@rule-set/geoip-cn.srs` |
| `geosite-cn.mrs` | `MetaCubeX/meta-rules-dat` | `meta` @ `0d0d829` | `https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/cn.mrs` |
| `geoip-cn.mrs` | `MetaCubeX/meta-rules-dat` | `meta` @ `0d0d829` | `https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geoip/cn.mrs` |

2026-11-20 下载，PM 已用随包 sing-box 1.14.4 `sing-box check` 验证 `.srs` 可用。只接受 `.srs`：
`sing-geosite` 的 `.db` 会被内核拒绝（`invalid sing-box rule-set file`）。`.mrs` 是 zstd 帧（magic `28 b5 2f fd`）。

## 许可证

**SagerNet 两个仓库：GPL-3.0**，Copyright (C) 2022 nekohasekai `<contact-sagernet@sekai.icu>`。
许可证全文：`https://github.com/SagerNet/sing-geosite/blob/main/LICENSE`、
`https://github.com/SagerNet/sing-geoip/blob/main/LICENSE`。

**MetaCubeX/meta-rules-dat：仓库 `master` 分支的 `LICENSE` 为 GPL-3.0**；但 `meta` 分支是纯数据，
README 未逐项说明数据来源的许可，数据合成自 Loyalsoldier/v2ray-rules-dat、blackmatrix7/ios_rule_script、
MaxMind GeoLite2 等上游。**各项上游条款未逐条确认，正式商用前需法务确认。**

本仓库把编译后的规则数据纳入仓库，并通过 HTTP 向客户端**再分发**。因此这里保留上述来源、版本与版权声明。
规则数据是独立的数据文件，不进入代码编译产物；若将来不愿承担再分发义务，改为部署时从上游拉取或放 R2/KV。

## 同步策略

- 只在**控制面发版时**更新：从上游分支重新下载，更新上面的表格（大小 / sha256 / 分支头），
  随 Worker 一起部署。Worker 不做定时拉取，也不在运行时依赖上游。
- 客户端侧：sing-box `update_interval: "7d"`；Clash `rule-providers.interval: 86400`；
  路径固定 + `cache-control: public, max-age=86400`，内容随部署切换，最长一天后被中间缓存刷新。
- 更新后跑 `npm test`：测试按文件实际字节数（57,792 / 34,259 / 532,882 / 37,527）与路由字节一致性断言，
  改文件必须同步改表。

## Clash 端的取舍（2026-11-20 裁决）

- **不用 `GEOIP`**：mihomo 的 geodata 默认从 GitHub 拉、CMFA 不带内置库；加载失败只记日志、规则落空 →
  全部流量照旧走代理且界面无异常（比不分流更糟）。
- 用我们自己托管的 `.mrs`：`rule-providers` → `cn-domain`（`behavior: domain`）、`cn-ip`（`behavior: ipcidr`），
  都带 `format: mrs`、`interval: 86400`，URL 指向 profile 同一 origin。
- 规则顺序固定：`RULE-SET,cn-domain,DIRECT` → `RULE-SET,cn-ip,DIRECT` → `DOMAIN-SUFFIX,cn,DIRECT` →
  `MATCH,Veyl`。**末尾的 `.cn` 不能删**：provider 初始化失败时 mihomo 只记日志、规则落空，
  它是最后的兜底，保证「至少不比只做 `.cn` 时更差」。
- **Clash 不配 `dns`**：`DOMAIN-SUFFIX` / `RULE-SET` 的域名匹配发生在解析之前，DNS 走境外也照样直连；
  加 dns 块只会覆盖用户在 CMFA 里自己设的 DNS，并多出「policy 写错整块失效」的故障面。
  （sing-box 侧必须配，因为 `geoip-cn` 要匹配解析后的 IP。）
- 待真机确认：CMFA 当前版本对 `format: mrs` 的支持（失败只会静默落空，见上面的 `.cn` 兜底）。
