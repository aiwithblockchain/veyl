# 契约：分流与 DNS（草案）

> 契约版本：`1.0.0`（定稿待并入；并入后 `commands.md` 2.1 / `events.md` 2.1 / `data-model.md` 2 / `runtime.md` 2.1）
> 状态：**定稿（待 PM 复核）**，2026-11-03。PM 复核通过前不改 `capabilities.md`，也不并入其它契约文件。
> 依据：`docs/user-flows.md` §1.4、`docs/config-execution.md` §7、`docs/capabilities.md` G/I 组、`docs/tun-mode.md` §3/§5、`docs/upgrade.md` §3、`docs/review-checklist.md` B3-01～B3-08
> 实现：`src-tauri/src/config/`（生成）、`src-tauri/src/rules/`（资源与更新）、Clash API（热切换）

---

## 0. 一句话

**规则数据随包、按需加载；三种分流模式由同一份超集配置表达；同一家族内用 selector 免重启切换；DNS 与分流由同一个 `RoutePlan` 一次生成，不写第二份分类。**

---

## 1. 名词

| 名词 | 定义 |
|---|---|
| **规则集（rule set）** | 一个 `.srs` 文件，sing-box 通过 `route.rule_set` 引用。上游只发这个格式 |
| **分类（category）** | 面向 AI 与 UI 的语义单位，如 `openai`、`google`。一个分类可对应 1–N 个规则集 |
| **规则数据（rules bundle）** | 随包/可更新的归档，含全部 `.srs`、`manifest.json`、`categories.json` |
| **分流模式（routing mode）** | `direct`（本地直连，其余走 VPN）/ `proxy_all`（全部走 VPN）/ `proxy_selected`（指定服务走 VPN） |
| **默认家族** | `direct` 与 `proxy_all` 合称「默认走 VPN 家族」；`proxy_selected` 是「默认直连家族」 |
| **RoutePlan** | 生成器内部的一次计算结果，同时产出 `route` 与 `dns` 两段。**唯一事实来源** |

---

## 2. 规则数据：怎么随包、怎么按需加载

### 2.1 随包归档

```
src-tauri/resources/rules/
  veyl-rules-<version>.tar.zst     # 2.25 MiB 级别，约 2,233 个 .srs
  LICENSE-GPL-3.0.txt
  SOURCE.txt                       # 上游仓库、tag、抓取时间
```

- **归档随安装包**，不在安装包里铺 2,233 个文件——文件数会让 macOS 签名与增量更新变慢。
- 首次启动解压到 `app_data/rules/<version>/`，写入 `rules_state`。
- 解压失败 → `RULES_NOT_READY`，**不降级成全局代理**（见 §10）。
- **APP 升级时的基线切换**：启动时若 `bundled_version` 比 `rules_state.active_version` 新（按 `<日期>.<序号>` 比较），解压新基线并切换；若用户已在线更新到更新版本，则保留用户的。

### 2.2 目录形态

```
app_data/rules/<version>/
  manifest.json
  categories.json
  geosite/<tag>.srs
  geoip/<cc>.srs
```

`manifest.json`：

```json
{
  "schema": 1,
  "version": "2026-11-03.1",
  "source": { "geosite_tag": "20261102203016", "geoip_tag": "20261012" },
  "items": [
    { "id": "geosite-cn", "kind": "geosite", "file": "geosite/cn.srs",
      "sha256": "<hex>", "bytes": 123456 }
  ]
}
```

`categories.json`（能力 I1 的数据源）：

```json
{
  "schema": 1,
  "version": "2026-11-03.1",
  "categories": [
    { "id": "openai", "name_zh": "ChatGPT / OpenAI", "name_en": "OpenAI",
      "description": "OpenAI 的网页与 API 域名", "item_count": 12,
      "rule_sets": ["geosite-openai"], "dns_classifiable": true }
  ]
}
```

### 2.3 按需加载

生成配置时**只把实际引用的规则集写进 `route.rule_set`**。sing-box 只加载被引用的文件，未引用的 2,233 个文件只占磁盘、不占内存。

一个配置最多引用：

| 来源 | 规则集 |
|---|---|
| 本地层（仅 `direct` 模式） | CN：`geosite-cn` + `geoip-cn`；其它国家：`geoip-<cc>` |
| 目标层（`proxy_selected`） | 每个目标分类的 `rule_sets` |
| 自定义规则里的分类 | 每个分类的 `rule_sets` |
| 固定 | 无（私网用 `ip_is_private`，不引规则集） |

**上限保护**：单个配置引用的规则集 > 32 个 → `PRECONDITION_FAILED / too_many_rule_sets`。正常人不会到这个量级；到了说明意图该被拆成两套配置。

### 2.4 构建期校验

构建脚本必须：

1. 解压归档，逐条比对 `manifest.items[].sha256` 与文件内容，不一致 → **构建失败**。
2. 校验 `categories.json` 里每个 `rule_sets` 都能在 manifest 里找到。
3. 把归档整体 hash 写进构建产物，APP 启动时比对（归档被替换是供应链攻击）。

理由见 `docs/upgrade.md` §5：TweetPilot 有过「忘了 bump 版本，老用户永久停在旧版」的事故，构建期校验是唯一能挡住它的地方。

### 2.5 更新

| 环节 | 做法 |
|---|---|
| 源 | **我们自己发布的归档**（GitHub Releases / Pages），不直接拉上游 2,233 个文件 |
| 触发 | 启动 5 分钟后一次；之后每 6 小时；设置页手动「更新规则数据」 |
| 前置 | **下载需要已连接**（上游与 GitHub 在部分网络下不可达）。`system_proxy` 模式经本机 mixed 端口下载；`tun` 模式由 TUN 接管，直接请求即可。**未连接时排队**，下次连接成功后自动执行 |
| 下载 | 临时目录，校验归档 `sha256` + 逐条 `manifest`，不覆盖当前版本 |
| 切换 | 解压到 `<new-version>.tmp` → 校验 → rename 为 `<new-version>` → 更新 `rules_state.active_version`（单事务） |
| 旧版本 | 保留上一版目录；新版本 `sing-box check` 通过后删除更旧的版本 |
| 生效 | **下次连接**。路由不能热重载（`user-flows.md` §1.4 实测） |
| 失败 | 静默保留当前版本；`rules_status.checked_at` 更新；不插卡 |

手动更新在未连接时 → `PRECONDITION_FAILED / not_connected`，`details.hint = "连接后才能更新规则数据"`。

---

## 3. 三种分流模式怎么落成 `route.rules` + `final`

### 3.1 出站结构（`direct` / `proxy_all` 共用）

```json
"outbounds": [
  { "type": "selector", "tag": "proxy", "outbounds": ["node-<id>", "..."], "default": "node-<当前节点>" },
  { "type": "direct", "tag": "direct" },
  { "type": "selector", "tag": "route-local", "outbounds": ["direct", "proxy"], "default": "direct" }
]
```

> `proxy_selected` 不生成 `route-local`，只生成 `proxy` 与 `direct`（见 §3.4）。

| tag | 用途 | 谁改 |
|---|---|---|
| `proxy` | 节点选择器（B2 换节点） | `node_switch` |
| `direct` | 直连 | 不变 |
| `route-local` | 「本地直连」那一层走哪；**只在 `direct` / `proxy_all` 生成** | **只在 `direct` ↔ `proxy_all` 之间热切** |

`route-local` 的 `outbounds` 里包含 `proxy`（一个 selector 引用另一个 selector）。sing-box 支持嵌套组，1.14.4 的发布记录还专门修过嵌套组的解析；生成后仍以 `sing-box check` 为准。若某个版本不支持，退化方案是 `route-local` 直接列出全部 `node-<id>` + `direct`，并在 `node_switch` 时同步它的选择——**两条路只选一条，不能同时存在**。

**不启用 `experimental.cache_file` 的 selector 记忆**：模式的唯一事实来源是 `configs.routing_mode`，重启后按配置重建；让 selector 自己记住上次选择会出现「库里的模式与运行时不符」。

### 3.2 模式 A：`direct`（本地直连，其余走 VPN）

```json
"route": {
  "rule_set": [
    { "tag": "geosite-cn", "type": "local", "format": "binary", "path": "<abs>/geosite/cn.srs" },
    { "tag": "geoip-cn",   "type": "local", "format": "binary", "path": "<abs>/geoip/cn.srs" }
  ],
  "rules": [
    { "ip_is_private": true, "action": "route", "outbound": "direct" },
    { "rule_set": ["geosite-cn", "geoip-cn"], "action": "route", "outbound": "route-local" }
  ],
  "final": "proxy"
}
```

生成时 `route-local` 的 `default` 按库里的模式填：`direct` 模式填 `direct`，`proxy_all` 填 `proxy`。运行时热切只是改这一个 selector 的当前值。

上面的 `rule_set` 是 CN 用户的形态；其它国家把两项换成单个 `geoip-<cc>`，路由骨架与 selector 完全不变（§3.7）。

### 3.3 模式 B：`proxy_all`（全部走 VPN）

规则与 A **完全相同**，只是把 selector 切到 `proxy`：

```
route-local = proxy
```

于是本地层规则命中的流量也走 `proxy`，`final` 仍是 `proxy` → 全部进隧道。

**A ↔ B 的切换 = 一次 `PUT /proxies/route-local`，不改配置文件、不重启、不断流**（B3-02）。

### 3.4 模式 C：`proxy_selected`（指定服务走 VPN，其余直连）

```json
"route": {
  "rule_set": [
    { "tag": "geosite-openai", "type": "local", "format": "binary", "path": "..." },
    { "tag": "geosite-google", "type": "local", "format": "binary", "path": "..." }
  ],
  "rules": [
    { "ip_is_private": true, "action": "route", "outbound": "direct" },
    { "rule_set": ["geosite-openai", "geosite-google"], "action": "route", "outbound": "proxy" }
  ],
  "final": "direct"
}
```

- **不加载** `geosite-cn` / `geoip-cn`：`final = direct` 已经覆盖「其余直连」。
- 目标分类为空 → 生成配置时 `PRECONDITION_FAILED / route_targets_empty`。全部直连的配置没有存在意义（用户要的就是「指定服务走 VPN」）。

### 3.5 三模式对照

| | `direct` | `proxy_all` | `proxy_selected` |
|---|---|---|---|
| 本地层规则 | 有 | 有 | 无 |
| `route-local` | `direct` | `proxy` | 不存在 |
| `final` | `proxy` | `proxy` | `direct` |
| 目标分类规则 | 无 | 无 | 有 |
| 本地层规则集 | CN：`geosite-cn`+`geoip-cn`；其它：`geoip-<cc>` | 同左 | 无 |
| 能否热切 | ↔ `proxy_all` | ↔ `direct` | **否** |

### 3.6 顺序（不可变）

```
sniff → hijack-dns → ip_is_private → 自定义规则 → 本地层/目标层 → final
```

- `sniff` 必须在最前（`tun-mode.md` §3）。
- `hijack-dns` 必须在 `ip_is_private` 与分流之前，且 sniffer 列表必须含 `dns`。
- 自定义规则在预置规则**之前**，用户覆盖优先。
- 顺序错是**静默失效**，B3-03 会用脚本断言索引严格递增。

### 3.7 所有国家都支持 `direct`，依据不同

产品负责人 2026-11-03 明确：**本国直连对所有国家都成立**，区别只在判定依据。

| 地区 | 本地层规则集 | 精度 |
|---|---|---|
| CN | `geosite-cn` + `geoip-cn` | 域名级 + IP 级 |
| 其它国家 | `geoip-<cc>`（如 `geoip-jp`） | **仅 IP 级近似** |

- 非中国用户的 `direct` 模式**照常提供服务**，不报错、不隐藏。
- **文案必须如实说明近似**：界面说「尽量让你的本地网站直连；这项判断按 IP 归属，可能有个别网站判断不准」，不承诺精确。
- **DNS 侧的限制**：其它国家没有对应的 geosite 规则集，DNS 无法按域名把「本地」分出来。此时 `dns.final` 仍是 `dns-remote`（与默认走 VPN 一致），本地站点的解析也可能经由代理 DNS——这是 IP 级近似的固有代价，写进文案与诊断说明，不假装没有。
- 地区判定来自 H1（系统区域），不联网。

---

## 4. 热切换协议

### 4.1 `route_set_mode`

| 当前 | 目标 | 已连接时 |
|---|---|---|
| `direct` | `proxy_all` | **热切**：`PUT /proxies/route-local {"name":"proxy"}` |
| `proxy_all` | `direct` | **热切**：`PUT /proxies/route-local {"name":"direct"}` |
| 任一家族 | 另一家族（涉及 `proxy_selected`） | **先确认，再断开重连**；未确认时拒绝 |

跨家族切换需要换 `final`，而 `final` 不能热重载（`user-flows.md` §1.4 实测：`PUT /configs` 返回 204 但不生效）。因此：

- 已连接 + 跨家族 + **没有 `confirmReconnect: true`** → `PRECONDITION_FAILED`，`details.reason = "will_disconnect"`，`details { applied_mode, target_mode }`。**不静默切断**。
- 带 `confirmReconnect: true` → Host 按 `runtime_stop` → 写库 → `runtime_start` 的顺序执行（与 `config_activate` 的确认语义同等对待），返回 `reconnect = "reconnected" | "reconnect_failed"`。
- 未连接 → 只写库，不需要确认。

与能力 G2 的口径一致：G2 写的是「切换分流方式（A/B）」——热切只承诺 A/B。

### 4.2 读回校验

每次热切写完后**读回两个 selector 的实际值**，据此给出 `applied_mode`，而不是假定成功：

```
(route-local, final) = (direct, proxy) → direct
(route-local, final) = (proxy,  proxy) → proxy_all
(route-local, final) 不存在 / final=direct → proxy_selected
```

- `applied_mode` 与 `applied_revision` 一律取自 **`RuntimeSnapshot`**（`applied_route_revision`），不是从库里推；断开后为 `null`。
- `proxy_selected` 没有 `route-local`，`applied_mode` 取快照里建连时记录的模式。
- 写失败或读回不一致 → `PRECONDITION_FAILED / route_switch_failed`，**库里模式不变**，并尝试把 selector 恢复到切换前的值。
- 部分失败的处理顺序：先写目标值，失败则写回旧值；两次都失败只记日志并报告 `applied_mode` 的真实值，不改库。

### 4.3 不影响已有连接

selector 只影响**新连接**；已建立的连接继续走原出口直到自然结束（B3-02 的验证方式就是持续 curl 观察 30 秒零失败）。这是 sing-box 的行为，不改。

---

## 5. 自定义规则

### 5.1 语义

用户或 AI 指定的、叠加在预置规则之上的覆盖。**不随种子/规则数据更新被覆盖**（B3-04）。

| 字段 | 取值 | 说明 |
|---|---|---|
| `action` | `proxy` / `direct` | 这条命中后走哪 |
| `match_type` | `domain` / `domain_suffix` / `domain_keyword` / `ip_cidr` / `category` | 前四种是字面匹配；`category` 引用分类目录里的一个 id |
| `value` | 字符串 | 域名 / CIDR / 关键字 / 分类 id |
| `note` | 可空 | 用户可读的来源说明（如「用户说 ChatGPT 要能开」） |

- `category` 是给 AI 用的：用户说「让 ChatGPT 走 VPN」，AI 用 I1 把服务名翻成分类，再加一条 `category` 规则，而不是自己拼 20 个域名。
- 加 `category` 规则时，生成器把该分类的 `rule_sets` 一并加进 `route.rule_set`。
- 同一 `(config_id, action, match_type, value)` 不允许重复 → `CONFLICT`。
- 自定义规则**只影响本套配置**，不影响节点池或其它配置。

### 5.2 与分层的顺序

```
自定义规则（按 position）→ 本地层/目标层 → final
```

自定义 `direct` 可以覆盖目标层的 `proxy`（用户想把某个子域从 VPN 里摘出来），这是刻意的：**用户的显式覆盖优先于我们的分类**。

### 5.3 生效时机

改自定义规则会改 `route.rules`，**不能热重载**：

- 写入成功 → `effective = "next_connect"`，`reconnect_required = true`。
- 已连接时 UI 必须提示，不静默。
- 库里保存 `route_revision`（每次变更 +1），事件携带它，UI 据此判断「当前连接是否已应用」。

---

## 6. DNS 策略

### 6.1 服务器

| 组 | 数量 | 用途 | detour |
|---|---|---|---|
| `dns-local-*` | 2–3 | 本地/直连流量解析 | `direct` |
| `dns-remote-*` | 2 | 走 VPN 的流量解析 | `proxy` |

默认候选（`dns.mode = "auto"` 时由生成器按地区填）：

| 地区 | local | remote |
|---|---|---|
| CN | `223.5.5.5`、`119.29.29.29` | `https://1.1.1.1/dns-query`、`https://dns.google/dns-query` |
| 其它 | 系统 DNS（若非回环）+ `1.1.1.1`（直连） | 同上 |

- **非中国用户的 `direct` 模式没有 geosite 规则集**，DNS 侧没有「本地」可分类，全部走 `dns.final = dns-remote`。这与 §3.7 的 IP 级近似是同一件事，不要试图用 `geoip` 拼 DNS 规则。
- `dns.mode = "custom"` 时用配置里的 `local` / `remote`，数量与格式在 `config_create` 校验。
- 自动模式**排除回环与指向本机的 DNS**：系统 DNS 是 `127.0.0.1` / `::1` / 本机 mixed 端口时（用户开着别的代理），改用 `1.1.1.1` + `8.8.8.8` 直连，避免把解析打回自己的代理形成环。
- remote 一律 DoH 经代理：明文 UDP 53 在部分网络会被劫持，DoH 经隧道才能拿到可信结果。

### 6.2 规则

DNS 规则**由同一个 `RoutePlan` 生成**，与 `route.rules` 一一对应：

| 模式 | DNS 规则 | `final` |
|---|---|---|
| `direct` / `proxy_all` | 本地层规则集 → `dns-local-1`（**仅 CN 有域名级规则**）；自定义 `direct` → `dns-local-1` | `dns-remote-1` |
| `proxy_selected` | 目标层规则集 + 自定义 `proxy` → `dns-remote-1`；自定义 `direct` → `dns-local-1` | `dns-local-1` |

**同源不变量（必须写成测试）**

1. `dns.rules` 里引用的每个 `rule_set` 必须也出现在 `route.rule_set` 里（子集关系）。
2. **`dns.rules` 只引用 `kind = "geosite"` 的规则集**。`geoip` 是纯 IP 匹配，DNS 查询阶段还没有目标 IP，写进去不会命中——它只参与 `route.rules`。
3. 「哪些域名算本地 / 哪些算目标」只由一个 `Classification` 表决定；DNS 与 route 都从它读，**不允许出现第二份分类逻辑**。
4. 用户自定义规则同时改变两侧：`domain` / `domain_suffix` / `domain_keyword` / `category` 四类进 DNS，`ip_cidr` **只进 route**（理由同上）。
5. 一条 `direct` 规则既把流量指向 `direct`，也把该域名解析指向 `dns-local`；`proxy` 相反。

### 6.3 TUN 额外要求

- 必须配 `route.default_domain_resolver`（取第一个 `dns-local` 的 tag）。配了多条 DNS 却缺它不是降级，是 **FATAL 起不来**（`tun-mode.md` §5）。
- 规则顺序：`sniff` → `hijack-dns` → `ip_is_private` → 分流。
- sniffer 必须含 `dns`，否则劫持规则不命中。
- `strategy = "prefer_ipv4"`：默认不启用 IPv6 解析优先，避免本地 IPv6 半通状态把用户卡住。此值本批固定，不做配置项。

### 6.4 DNS 与热切

DNS 规则不随 A↔B 切换变化（两者的默认都是「其余走 VPN」，DNS final 都是 remote）。这正是把 `proxy_selected` 排除出热切的原因之一：它的 DNS final 是 `dns-local`，与 A/B 相反。**换家族必然换 DNS，必须重连。**

---

## 7. 命令

以下为建议并入 `commands.md` 2.1 的条目。命名与参数遵循该文件的 camelCase 规则；能力 ID 按 `capabilities.md` G/I 组。

### 7.1 共用类型

```ts
type RoutingMode = "direct" | "proxy_all" | "proxy_selected";

type CustomRule = {
  rule_id: string;                 // rul_<16 hex>
  action: "proxy" | "direct";
  match_type: "domain" | "domain_suffix" | "domain_keyword" | "ip_cidr" | "category";
  value: string;
  note: string | null;
  position: number;
  created_at: number;              // Unix 毫秒
};

type RouteState = {
  config_id: string;
  routing_mode: RoutingMode;
  applied_mode: RoutingMode | null; // 当前连接实际生效的模式；未连接为 null
  targets: string[];               // 分类 id，仅 proxy_selected
  custom_rules: CustomRule[];
  route_revision: number;          // 每次改规则 +1
  applied_revision: number | null; // 当前连接生成时的 revision；建连时记录，断开清空
  effective: "current_connection" | "next_connection";
  reconnect_required: boolean;
  local_direct_basis: "domain_and_ip" | "ip_only"; // CN = domain_and_ip，其它 = ip_only
  detected_region: string | null;  // ISO 3166-1 alpha-2
};
```

### 7.2 `route_get { configId? }` → `RouteState`

- **G1** 查看当前分流方式。`configId` 省略用 active 配置。
- 只读，不联网，不发事件。
- `applied_mode` 从运行时 selector 读回，不是从库里推——两者可能不同（见 `applied_revision`）。

### 7.3 `route_set_mode { configId?, mode, confirmReconnect? }` → `RouteSetModeData`

```ts
type RouteSetModeData = RouteState & {
  hot_switched: boolean;
  reconnect: "not_running" | "reconnected" | "reconnect_failed" | null;
};
```

- **G2** 切换分流方式。
- 同一模式 → 幂等返回，不发事件。
- 同家族且已连接 → 热切（§4）；`effective = "current_connection"`、`reconnect_required = false`、`hot_switched = true`。
- 跨家族且已连接、未带 `confirmReconnect` → `PRECONDITION_FAILED / will_disconnect`，**不产生任何变更**。
- 跨家族且已连接、带 `confirmReconnect: true` → 断开 → 写库 → 重连；`reconnect` 给出结果。重连失败**不抛错**：切换本身已成功，`reconnect = "reconnect_failed"`，运行时快照里的 `last_error` 说明原因。
- 未连接 → 只写库；`effective = "next_connection"`、`reconnect_required = false`、`reconnect = "not_running"`。
- `mode = "proxy_selected"` 且 `targets` 为空 → `PRECONDITION_FAILED / route_targets_empty`。

### 7.4 `route_targets_set { configId, categories }` → `RouteState`

- **G4** 设置「指定服务」的分类集合，整体替换。
- 每个 id 必须在 `categories.json` 里存在 → 否则 `NOT_FOUND / category_unknown`，`details.unknown` 一次列全。
- `dns_classifiable = false` 的分类 → `UNSUPPORTED / category_not_dns_classifiable`。这类分类只有 IP 规则集，在 `proxy_selected` 下会造成「解析走本地、流量走 VPN」的错位（§6.2）。
- 只在 `proxy_selected` 下有实际作用；其它模式允许保存，切换模式时生效。
- 不热切：`effective = "next_connection"`。

### 7.5 `rule_custom_list { configId }` → `{ rules: CustomRule[] }`

- **G4** 按 `position` 升序返回。

### 7.6 `rule_custom_add { configId, action, matchType, value, note? }` → `CustomRule`

- **G4** 追加到末尾（`position = max + 1`）。
- 校验：`matchType` 与 `value` 匹配（域名语法、CIDR 合法性、分类存在且 `dns_classifiable`）；重复 → `CONFLICT`。
- 返回后发 `routing-changed`，`reconnect_required = true`。

### 7.7 `rule_custom_delete { configId, ruleId }` → `{ rule_id, deleted, already_absent }`

- **G4** 幂等；不存在 → `deleted = false`、`already_absent = true`。
- **不重排** `position`：删除留下空位不影响顺序，避免每次删除都写全表。排序始终按 `position`，新增取 `max + 1`。
- 发 `routing-changed`。

### 7.8 `category_list { query?, limit? }` → `{ categories: Category[], total }`

- **I1** 分类目录，AI 与 UI 共用。
- `query` 对中英文名与 id 做不区分大小写的子串匹配；`limit` 默认 50、上限 200。
- 只读，不联网，读当前生效版本的 `categories.json`。

```ts
type Category = {
  id: string;
  name_zh: string;
  name_en: string;
  description: string;
  item_count: number;
  rule_sets: string[];
  // 是否至少有一个 geosite 规则集。false 的分类无法参与 DNS 决策，
  // 不能用于「指定服务走 VPN」或自定义 category 规则（§6.2 同源约束）。
  dns_classifiable: boolean;
};
```

### 7.9 `rules_status` → `RulesStatus`（**G3 / I2**）

```ts
type RulesStatus = {
  active_version: string;          // 目录名
  manifest_sha256: string;
  geosite_tag: string | null;
  geoip_tag: string | null;
  geosite_age_days: number | null;
  geoip_age_days: number | null;
  stale: boolean;                  // geosite > 3 天或 geoip > 35 天
  item_count: number;
  total_bytes: number;
  checked_at: number | null;       // Unix 毫秒
  bundled_version: string;         // 随包基线版本
  pending_update: boolean;         // 有排队的更新，下次连接后自动执行
};
```

- 只读，不联网。
- `stale` 只用于设置页提示与 `update_hint`，不阻断连接。

### 7.10 `rules_update {}` → `{ queued: boolean, job_id: string | null }`

- **G3 / I2** 更新规则数据（§2.5）。
- 已连接 → 异步执行：立即返回 `queued: false` + `job_id`，进度走 `job-progress`（`kind = "rules_update"`）。
- **未连接 → 排进待办**：返回 `queued: true`、`job_id: null`，`rules_status.pending_update = true`。下一次连接成功后自动执行。**不弹「更新失败」**——没有失败，只是时候未到。
- 已有更新在跑 → `CONFLICT`，`details.job_id` 指向进行中的任务。
- 成功切换目录后发 `rules-changed`，`effective = "next_connect"`。

---

## 8. 事件

### 8.1 `routing-changed`

```ts
type RoutingChangedPayload = {
  contract_version: "2.1.0";
  config_id: string;
  routing_mode: RoutingMode;
  applied_mode: RoutingMode | null;   // 热切后为实际生效值；仅写库时保持旧值
  targets: string[];
  route_revision: number;
  applied_revision: number | null;
  change: "mode" | "targets" | "custom_rule";
  hot_switched: boolean;
  reconnect_required: boolean;
  emitted_at: string;
};
```

触发：`route_set_mode` / `route_targets_set` / `rule_custom_add` / `rule_custom_delete` 提交后。

- `hot_switched = true` 时，`applied_mode` 与 `routing_mode` 一致；
- `hot_switched = false` 时，两者可以不同，UI 据此提示「下次连接生效」。

### 8.2 `rules-changed`

```ts
type RulesChangedPayload = {
  contract_version: "2.1.0";
  active_version: string;
  previous_version: string | null;
  geosite_tag: string | null;
  geoip_tag: string | null;
  item_count: number;
  effective: "next_connect";
  emitted_at: string;
};
```

触发：`rules_update` 成功切换目录后。**不打断当前连接**；当前连接继续用旧规则，直到下次连接。

### 8.3 `job-progress` 扩展

`kind` 增加 `"rules_update"`。`stage` 取值：`downloading` / `verifying` / `extracting` / `switching` / `done`。

---

## 9. 数据模型增量

### 9.1 `configs` 新增列

```sql
ALTER TABLE configs ADD COLUMN route_targets_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE configs ADD COLUMN route_revision INTEGER NOT NULL DEFAULT 0;
```

- `route_targets_json`：分类 id 数组，仅 `proxy_selected` 使用。
- `route_revision`：`targets` 或自定义规则每次变更 +1；用于判断当前连接是否已应用。

> 这两列是「一套配置的一组值 + 一个单调计数」，仍属 `data-model.md` §3.1 用 JSON 列的同一判据；不建子表。

### 9.2 新表 `config_rules`

自定义规则有**独立生命周期**（逐条增删、排序），与 DNS/内网排除不同，因此建子表而不是 JSON：

```sql
CREATE TABLE config_rules (
    id          TEXT PRIMARY KEY,               -- rul_<16 hex>
    config_id   TEXT NOT NULL REFERENCES configs (id) ON DELETE CASCADE,
    action      TEXT NOT NULL CHECK (action IN ('proxy', 'direct')),
    match_type  TEXT NOT NULL CHECK (match_type IN
                  ('domain', 'domain_suffix', 'domain_keyword', 'ip_cidr', 'category')),
    value       TEXT NOT NULL,
    note        TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_config_rules_unique
    ON config_rules (config_id, action, match_type, value);
CREATE INDEX idx_config_rules_order ON config_rules (config_id, position);
```

### 9.3 新表 `rules_state`（单行）

```sql
CREATE TABLE rules_state (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    active_version    TEXT NOT NULL,       -- 目录名，如 "2026-11-03.1"
    manifest_sha256   TEXT NOT NULL,
    bundled_version   TEXT NOT NULL,       -- 随包基线；用于判断是否从未更新过
    geosite_tag       TEXT,
    geoip_tag         TEXT,
    item_count        INTEGER NOT NULL,
    total_bytes       INTEGER NOT NULL,
    applied_at        INTEGER NOT NULL,    -- 首次解压或切换时刻
    checked_at        INTEGER             -- 最近一次检查/更新尝试
);
```

- 规则文件本身在磁盘，**不进库**（与预置资源的一致原则，`configs-and-nav.md` §8）。
- `bundled_version` 用于设置页区分「用的是随包版还是更新过的版本」。

### 9.4 运行时快照新增字段（并入 `runtime.md` 时执行）

```ts
// RuntimeSnapshot 增加
applied_route_revision: number | null;  // 本次连接生成配置时的 configs.route_revision
```

- 建连时从配置读入并随进程保存；断开置 `null`。
- 与 `configs.route_revision` 比较：相等 → 规则已生效；不等 → 改了但当前连接还没用上，界面显示「下次连接生效」。
- 它也回答「当前这个连接用的是哪一版规则」——不需要额外的内存状态或第二份记录。
- 字段恒存在，未连接写 `null`。

### 9.5 问题类型

规则过期时登记 P2 `rule_stale`（不插中间卡，仅进问题列表）。`target` 为 `geosite` / `geoip`。

---

## 10. 错误码

| 码 | 含义 | `details.reason` |
|---|---|---|
| `PRECONDITION_FAILED` | `will_disconnect` / `route_targets_empty` / `route_switch_failed` / `too_many_rule_sets` | |
| `NOT_FOUND` | `category_unknown`（`details.unknown`）、配置不存在 | |
| `CONFLICT` | `duplicate_rule`、规则更新进行中（`details.job_id`） | |
| `RULES_NOT_READY` | 规则目录缺失/损坏，无法生成配置 | 不降级为全局代理 |
| `RULES_INTEGRITY` | 归档或单文件 sha256 不符 | 保留旧版本 |
| `UNSUPPORTED` | 运行时不支持所需 selector/规则集能力 | |

---

## 11. 与其它契约的改动清单（审核通过后执行）

| 文件 | 改动 |
|---|---|
| `commands.md` | +9 条命令（§7，`route_set_mode` 增加 `confirmReconnect`）；§11 能力映射加 G1–G4 / I1 / I2；§2 总表编号顺延 |
| `events.md` | +2 事件（`routing-changed` / `rules-changed`）；`job-progress.kind` 增加 `rules_update`；事件总数 18 → 20 |
| `data-model.md` | +2 列、+2 表（§9）；索引汇总更新 |
| `capabilities.md` | **PM 维护**：G1–G4 / I1 / I2 的「实现状态」列填上命令名 |
| `runtime.md` | `RuntimeSnapshot` 增加 `applied_route_revision`（§9.4） |
| `tools.md` | +9 个 AI 工具（与 §7 同名）；`RouteSetMode` 的热切语义写进工具描述，避免模型以为 `proxy_selected` 也能热切 |

---

## 12. PM 裁定记录

六项已于 2026-11-03 全部裁定，本文件按裁定定稿。

| # | 议题 | 决议 | 来源 |
|---|---|---|---|
| 1 | 跨家族切换必须重连 | **已定**：接受；已连接时必须 `confirmReconnect`，Host 断开重连，与 `config_activate` 同级 | PM 2026-11-03 |
| 2 | 非中国是否提供 `direct` | **已定：所有国家都提供**。CN 用 `geosite-cn` + `geoip-cn`，其它国家用 `geoip-<cc>`（IP 级近似），文案如实说明 | PM 2026-11-03（`user-flows.md` 决策表已改） |
| 3 | 自定义规则匹配词汇 | **已定**：`domain` / `domain_suffix` / `domain_keyword` / `ip_cidr` / `category` | PM 2026-11-03 |
| 4 | 规则更新必须已连接 | **已定**：未连接时排队，下次连接自动执行，不报失败 | PM 2026-11-03 |
| 5 | 规则归档由谁发布 | **已定**：我们的构建流水线打包发布，客户端不直连上游 | PM 2026-11-03 |
| 6 | 如何表达「当前连接用的是哪一版规则」 | **已定**：`RuntimeSnapshot.applied_route_revision` 与 `configs.route_revision` 比较；相等即已生效，不等即下次连接生效 | PM 2026-11-03 |

---

## 13. 验收对应

| 审查项 | 本设计的落点 |
|---|---|
| B3-01 三种模式 `check` 通过 | §3.2–§3.4 的完整骨架 |
| B3-02 免重启不断流 | §4.1（A↔B 只改 selector）、§4.3 |
| B3-03 规则顺序 | §3.6 |
| B3-04 自定义规则不被种子覆盖 | §5.1（独立表，不在种子层） |
| B3-05 DNS 完整 | §6.1–§6.3（含 `default_domain_resolver`） |
| B3-06 文案无禁用词 | 不在契约层；UI 用「哪些网站走 VPN / 直连」 |
| B3-07 按需加载 | §2.3 |
| B3-08 先 `check` 再启动 | §2.4 / `config-execution.md` §7 既有规则 |
