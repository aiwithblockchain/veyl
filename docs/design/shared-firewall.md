# 共享防火墙方案：一条防火墙带全部节点

> 日期：2026-11-21
> 状态：**方案待评审**。只出设计，不改代码。
> 上游：`my-servers.md` §19.6（建机与防火墙）、DO 官方文档（`firewalls/details/limits`、`reference/api/reference/firewalls`）
> 结论一句话：**不再为每台服务器创建防火墙；按环境建一条，用 tag 绑定，端口规则用固定区间。销毁不再删防火墙，孤儿问题从根上消失。**

---

## 1. 现状与问题

- 建机时按服务器端口创建一条独立防火墙：`servers.ts` enroll 里 `createFirewall({ port, providerId })`，规则是 TCP/UDP 单个端口 + ICMP。
- 销毁时删掉这条防火墙；删除失败只打 warn，行已标 `destroyed`，之后没有重试入口。
- 结果：DO 上会积累「0 台机器」的空防火墙（今天后台就有 7 条），而且每台机器的规则其实只差一个端口号。
- 本轮已经修过销毁路径（保留 `firewall_id` 等下次重试、按确定性名字反查），但那是**给旧模型打补丁**；模型本身就不该是这样。

## 2. DO 的硬约束（官方文档，2026-11-21 核对）

| 约束 | 出处 | 影响 |
|---|---|---|
| 每台防火墙最多直接挂 **10 台 Droplet**；超过要改用 tag | `products/networking/firewalls/details/limits` | 不能把「所有节点」直接写进 `droplet_ids` |
| 每台防火墙最多 5 个 tag | 同上 | 用 `veyl:env:<env>` 一个就够 |
| 每台防火墙最多 **50 条**入站+出站规则 | 同上 | 不能「每个端口一条规则」地无限增长 |
| 端口字段支持单端口、区间（`"8000-9000"`）或 `"0"`（全开） | `reference/api/reference/firewalls` | 可以用一条规则覆盖一个端口带 |
| 入站/出站规则支持 sources / destinations | 同上 | 出站保持全放行 |

**我们的 Droplet 建机时已经带 tag**（`provision.ts`）：`veyl:srv:<id>`、`veyl:acct:<account>`、`veyl:env:<env>`。所以「把节点加进防火墙」不需要额外 API 调用。

## 3. 方案

### 3.1 一条全局防火墙（固定名称）

**账户级硬约束：账户里只有一条我们自己的防火墙**，跟节点数无关，也不会随建机增长。临时 SSH 规则由人工往这条里加，代码不管、也不动它。

- 名称（全局常量，唯一且固定）：`veyl-shared-node-firewall`
- tag（全局常量）：`veyl:node`——所有环境的 Droplet 建机时都带这个 tag
- 规则（固定，永不变化）：
  - 入站 TCP `30000-30999`（SS 专用端口带）
  - 入站 UDP `30000-30999`
  - 入站 TCP `32100`（agent 控制端口，**固定且必须在带外**）
  - 入站 ICMP `0`
  - 出站 TCP / UDP / ICMP 全放行
- **查找方式：只按 name 完全相等**。命中就用，不看 tag、不看规则内容（人工加的 SSH 规则不参与判断）；没命中就用上面的名称、tag 和规则创建。
- 环境概念与防火墙无关：dev 与 production 共用这一条，规则本来就一样。
- 建机流程：**不创建防火墙**；Droplet 带 `veyl:node` 创建即受规则保护，没有「先建机器后挂防火墙」的裸奔窗口。
- 销毁流程：**不删除防火墙**；删除 Droplet 后自动脱离，防火墙留给下一台。

### 3.2 端口带

- `pickPort`（`orders.ts`）改成只在 `30000-30999` 内分配，保持「账户内唯一」的既有语义。
- 1000 个端口对一个账户足够（端口只要求账户内唯一，不同 IP 可以重号）。
- 端口带是固定值，写进控制面配置；改带意味着改规则，属于一次性迁移。
- **带内只允许 SS 监听**。机器无 root 密码、无 SSH，人也进不去；真正能起进程的只有 agent，所以这条由 agent 的代码保证：它只绑定控制端口（`32100`）与 sing-box 的 SS 端口，不开放任何其它监听。控制端口固定在带外，避免和 SS 混在同一段扫描面里，也便于单独针对它做鉴权和限流。

### 3.3 与 agent 轮换的关系

agent 更换连接密码时，新端口只要落在 `30000-30999` 内，防火墙**已经放行**——轮换不需要任何 DO API 调用。这是把「固定区间」而不是「预置若干个端口」写进规则的主要理由。

### 3.4 建机顺序与失败语义

1. **先确保共享防火墙存在，再创建 Droplet**。防火墙 ensure 失败 → 订单直接失败，**绝不创建一台没有防火墙的机器**。
2. ensure 是幂等的：按 name 查，命中就用，没有就建一条。不比对规则、不做并发收敛——账户内只有这一条，万一并发建出两条也不影响节点，手动删掉多余的即可。
3. Droplet 创建时带 `veyl:node`（也保留原有的 `veyl:srv:` / `veyl:acct:` / `veyl:env:`），防火墙按 tag 自动覆盖。若 DO 的覆盖有秒级延迟，这个窗口里 Droplet 上还没有任何服务（sing-box 尚未安装），实际暴露为零；但延迟行为要按 §8 的确认结果记录在案。

## 4. 收益与代价

**收益**

- 每台机器不再产生一条防火墙；DO 后台永远只有两条（dev + production）。
- 销毁路径不再有关联外部资源，不存在「机器删了、规则留着」。
- 轮换端口不需要改防火墙。
- 建机少一次 API 调用（现在是 droplet → firewall 两次，失败要回滚）。

**代价**

- **可发现性变大，不是暴露面变大**。带内没有监听时主机回 RST，扫描器只能确认「端口关着」，拿不到任何服务；真正多出来的信息是「扫 1000 个端口几秒钟就能定位到这个 IP 上的 SS 端口」。而 SS 端口本来就能被扫到，区别只是扫描量。
- 带内的所有端口对所有节点放行，扫到 30001 这类没人监听的端口也是 RST——除了暴露「这台机器在跑」之外没有别的后果。
- 发现端口不等于能用：SS 是 AEAD，密码错不响应、不报错；16 位十六进制密码是 2^64，网络暴力破解不可行。

**为什么可控**：机器没有 root 密码、没有 SSH，人进不去；能起进程的只有 agent，而 agent 的代码只绑定控制端口与 SS 端口。所以带内不会「哪天多出一个别的服务」，除非 agent 自己写错——这是代码约束，不是运维纪律。

**取舍**：band 大小对防扫描几乎没有影响（100 个端口也是秒扫），只影响「账户内端口复用空间」和将来误放服务的面积。1000 个够用；按 `30000-30999` 定，后续要收窄只需改配置与一次迁移。

## 5. 迁移

**不做迁移。** 存量节点直接销毁，测试从零开始建新机；所有新机器一律走共享防火墙模型，不需要临时规则、不需要兼容旧端口。

## 6. 代码改动清单（实施时）

| 文件 | 改动 |
|---|---|
| `cloudflare/control-plane/src/providers/digitalocean.ts` | 新增全局常量（名称 `veyl-shared-node-firewall`、tag `veyl:node`）与 `ensureSharedFirewall(token)`：单次列表、按 name 命中即返回、没有则按固定规则创建 |
| `cloudflare/control-plane/src/servers.ts` | enroll 里去掉 `createFirewall` 与防火墙 id 落库；销毁不涉及防火墙 |
| `cloudflare/control-plane/src/orders.ts` | `pickPort` 限制在端口带内 |
| `cloudflare/control-plane/scripts/prune-firewalls.mjs` | 迁移完成后可删除（变为一次性工具） |
| 契约文档 | `my-servers.md` §19.6 改写 |

## 7. 验收

1. 新建一台服务器：DO 上不出现新的防火墙；该 Droplet 的 Firewalls 标签页显示 `veyl-shared-node-firewall`。
2. 从公网连该节点端口：通；连端口带之外的端口：不通。
3. 销毁该服务器：防火墙仍在，Droplet 消失，`veyl-shared-node-firewall` 的 Droplets 列表为空。
4. 连续建 3 台：始终只有一条环境防火墙。

## 8. 待确认（DO 侧）

1. 用 tag 绑定的防火墙，对「创建时就带该 tag」的 Droplet 是否**立即生效**，有无延迟窗口？——**实测可用（2026-11-21）**：新机器建好后出现在该防火墙的 Tagged Droplets 里、节点端口可连；秒级延迟未单独测量（那段时间里机器正在装 sing-box，无可连服务）。
2. **已确认（2026-11-21）：tag 绑定不受 10 台限制。** 10 台上限只约束按 ID 写进 `droplet_ids` 的 Droplet；tag 关联的 Droplet 数量官方明确「没有上限」，单条防火墙仍最多 5 个 tag。
   - DO《How to Create Firewalls》：「There are limits on the number of Droplets and tags that can be added to a firewall, but there are no limits to the number of Droplets that can be associated with a tag. Using tags allows you to exceed the individual Droplet limit for firewalls.」<https://docs.digitalocean.com/products/networking/firewalls/how-to/create/>
   - DO《Firewalls Limits》：「You can have a maximum of 10 Droplets per firewall and 5 tags per firewall.」并给出做法：「If you have more than 10 Droplets that need the same firewall, tag the Droplets, then add that tag to the firewall.」<https://docs.digitalocean.com/products/networking/firewalls/details/limits/>
   - API 参考：`droplet_ids` 为「An array containing the IDs of the Droplets assigned to the firewall.」，`tags` 为「An array containing the names of the Tags assigned to the firewall.」，tag 代表「a group of Droplets」。<https://docs.digitalocean.com/reference/api/reference/firewalls/>
   - Terraform provider 文档旁证：`droplet_ids`「The list of the IDs of the Droplets assigned to the Firewall (max. 10).」，并建议「If you want to assign more droplets to the Firewall, add Tags to them and use the `tags` argument below.」<https://registry.terraform.io/providers/digitalocean/digitalocean/latest/docs/resources/firewall>
   - 同页其它限制：每防火墙最多 5 个 tag、50 条入站+出站规则（deny 也计入）、每条规则 Sources/Destinations 最多 1,000 个条目；未给出每账户防火墙数量上限。我们的用法（每环境 1 个 tag、7 条规则、地址仅 `0.0.0.0/0` 与 `::/0`）远低于这些上限。
   - 证据强度：官方产品文档明确，非社区推测；但「超过 10 台」的实际行为尚未实测，节点数首次到 11 台时在部署验收里回读一次即可。
3. 单条入站规则的端口区间有无大小限制，`30000-30999` 是否被接受？——**已确认**：线上建防火墙时用的就是这个区间，创建成功、节点可用。
4. 删除 Droplet 后，防火墙的 `droplet_ids` 是否自动清空？——**改 tag 模型后不适用**：机器不在 `droplet_ids` 里，删掉后自然从 Tagged Droplets 消失。
