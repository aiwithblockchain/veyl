# 免费节点种子：TS 源文件、Worker 直出、GitHub Pages 兜底

> 日期：2026-11-17
> 状态：设计定稿，未实现
> 上游：`docs/config-execution.md` §9–§10（种子语义）、`docs/design/ai-first-product.md` §第一次进入主界面
> 涉及：`cloudflare/control-plane/src/seed.ts`、`cloudflare/control-plane/src/index.ts`、`src-tauri/src/seed.rs`、`src-tauri/src/public_http.rs`

## 0. 一句话

种子就是 control-plane Worker 里的一个 TS 模块：**改文件 → 部署 Worker → 客户端下次拉取拿到新数据**。没有数据库、没有对象存储、没有上传步骤、没有签名体系。

### 0.1 速查

| 项 | 值 |
|---|---|
| TS 常量 | `cloudflare/control-plane/src/seed.ts` 的 `SEED`（`version` / `updated_at` / `nodes`） |
| 路由 | `GET https://veyl.dessage.xyz/v1/seed`（Worker 直出 JSON，匿名只读） |
| 部署命令 | `bash scripts/seed/publish.sh`（内部执行 `cd cloudflare/control-plane && npx wrangler deploy`） |
| 客户端 URL | `DEFAULT_SEED_URL = "https://veyl.dessage.xyz/v1/seed"`（`src-tauri/src/seed.rs`） |
| 兜底 | `https://meshnetprotocol.github.io/veyl_seed.json`，主源失败时才用；发布时默认同步，可显式跳过 |
| 不需要 | KV / R2 / D1、额外上传、签名、密钥轮换、独立 Worker、新域名 |

---

## 1. 结论

| 问题 | 结论 |
|---|---|
| 源文件 | `cloudflare/control-plane/src/seed.ts`，导出 `version` / `updated_at` / `nodes`；**仓库里这一份是唯一真源** |
| 主源 | 现有 control-plane Worker 新增只读路由 **`GET /v1/seed`**，序列化该模块返回，带 ETag 与 `Cache-Control` |
| 域名 | 复用 control-plane 已有域名 `https://veyl.dessage.xyz`，**不新开域名、不新开 Worker** |
| 兜底 | `https://meshnetprotocol.github.io/veyl_seed.json`（发布脚本默认生成并推送，失败即报错） |
| 签名 | **不做**。免费节点只是测试试用资源，不引入密钥体系与轮换流程 |
| 存储 | 不用 KV / R2 / D1。数据随 Worker 一起打包部署 |
| 一条命令 | `bash scripts/seed/publish.sh`（校验 → 类型检查 → 测试 → `wrangler deploy` → 核对线上哈希 → 默认同步兜底） |
| 更新判据 | 客户端仍按**内容哈希**判断，`version` / `updated_at` 只给人看 |

---

## 2. 现状（代码事实，2026-11-17）

- 客户端地址：`src-tauri/src/seed.rs:21`，当前为 GitHub Pages。
- 更新判据：**内容哈希**（`content_sha256`）；`version` 不参与判断；带 `If-None-Match` 发条件请求，304 直接结束（`seed.rs:252-300`）。
- 轮询：启动 5 分钟后、之后每 6 小时；连接失败且当前用的是种子节点时强制刷一次（`config-execution.md` §10）。
- 落盘：整包加密进 `secrets.enc`，键 `seed:<content_sha256>`；SQLite 只存哈希 / etag / 节点数 / 时间戳。
- HTTP：`public_http::get` **不跟随重定向**（`Policy::none`），上限 1 MiB，要求 200；发布地址必须直出。
- 诊断：`config.seed_stale` = 缓存 `checked_at` 超过 6 小时（或没有缓存），见 `tools/services.rs:6034-6045`。
- control-plane 现有公开路由都在 `/v1/*`（`/v1/catalog` 同样匿名只读），部署命令 `npm run deploy`。

---

## 3. 源文件：`cloudflare/control-plane/src/seed.ts`

```ts
export type SeedNode = {
  name: string;
  server: string;
  port: number;
  method: string;   // 必须在客户端 SUPPORTED_METHODS 里
  password: string;
};

export const SEED: { version: number; updated_at: string; nodes: SeedNode[] } = {
  version: 8,
  updated_at: "2026-11-17T09:30:00Z",
  nodes: [
    { name: "东京 01", server: "203.0.113.10", port: 8388, method: "aes-256-gcm", password: "…" },
  ],
};
```

规则：

- **唯一真源**：客户端不读仓库，只读 §4 的 URL；仓库里的这份只用于 review 与回滚。
- `version` 与 `updated_at` **在 PR 里手改并一起提交**（`version` +1、`updated_at` = 本次 UTC）。脚本**不修改源码**：它只校验 `version` 比线上大、`updated_at` 能解析且**距现在不超过 24 小时**（不用「必须是今天」——PR 可能前一天写、跨 UTC 零点发布或过夜 review），不满足就中止。这样「部署的字节 = HEAD 的字节」，`git revert` 能回到真正发布过的版本。
- `method` 必须与客户端 `nodes::SUPPORTED_METHODS` 一致；`server` 不允许带 scheme / 空白 / 斜杠；`port` 1–65535；`password` 非空。
- **校验放在发布前**：`src/seed.test.ts` 用与 Rust 侧同一组规则逐台断言，`publish.sh` 里跑 `npm test`，一台不合法就不部署。
- **两边同一份规则**：仓库放 `seed/fixtures/seed.golden.json`（若干合法 / 非法样本），TS 测试与 Rust 的 `seed.rs` 测试都读它（Rust 用 `include_str!`），任一侧改了校验规则而另一侧没跟上，测试就会红——防止两套校验慢慢漂移。
- 不出现分流、DNS、配置名等字段——种子只给节点。

---

## 4. 主源：`GET /v1/seed`

加在 `cloudflare/control-plane/src/index.ts` 的路由链里，与 `/v1/catalog` 同级（**匿名只读**，无鉴权、无 CORS 需求）。

```http
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
cache-control: public, max-age=300, must-revalidate
etag: "sha256-<hex>"
```

- **正文**：`JSON.stringify` 固定字段顺序（`version` → `updated_at` → `nodes`，节点内 `name` → `server` → `port` → `method` → `password`），保证同一份数据每次序列化字节一致——否则哈希每次都变，客户端会以为有新版本。
- **ETag = 正文的 sha256**，首次请求时用 `crypto.subtle.digest` 算一次缓存在模块作用域（isolate 存活期间复用）。
- **条件请求**：`If-None-Match` 与当前 ETag 相同 → `304`、空 body、保留 ETag 与 `Cache-Control`。
- 不返回任何其他节点字段，不返回上游元数据。
- 路径冲突检查：现有路由只有 `/v1/catalog`、`/v1/debug/*`、`/v1/*` 业务前缀与 `/payment/return`，`/v1/seed` 不冲突。**最终路径用 `/v1/seed`**——沿用 `/v1` 的既有约定，比 `/seed.json` 少一个「静态文件」的误解（它不是文件，是 Worker 直出）。

> **可达性**：`cloudflare/edge/proxy.ts` 把 `veyl.dessage.xyz` 的所有路径经 service binding 转给 control-plane Worker，不按路径挑选，所以 `/v1/seed` 与 `/v1/catalog` 走同一条链路。
>
> **挂载位置与方法**：`route()` 是线性 if 链（`index.ts:267` 起），没有 `/v1/*` 统一拦截，鉴权与 webhook 处理器只认各自精确路径。新路由放在 `/v1/catalog`（`index.ts:318`）旁边、最终 404（`index.ts:719`）之前。**只接受 GET / HEAD**：HEAD 返回空 body 但带同样的 `ETag` 与 `Cache-Control`；其它方法 405。它会和其它路由一样进结构化访问日志，属正常。

### 4.1 缓存：Worker 响应默认不进 CDN

- Cloudflare **不会**默认缓存 Worker 返回的响应，所以每次拉取都会执行一次 Worker——421 字节的量级，成本可忽略，而且永远拿到最新数据。
- `max-age=300` 主要约束中间代理与客户端自身；客户端的轮询是 6 小时，不受影响。
- 将来若真需要 CDN 缓存，加一条 Cache Rule（Cache Everything）即可；**现在不加**，避免「发布后 5 分钟才生效」这种额外解释。
- 顺带说明（若以后改回静态托管才需要）：Cloudflare CDN **默认不缓存 JSON**，到那时必须配 Cache Rule。

---

## 5. 双源与失败处理

客户端的取数顺序固定：

1. 先请求主源 `https://veyl.dessage.xyz/v1/seed`；
2. 主源失败（连接错误 / 超时 / 非 2xx / 正文不是合法 JSON / 没有可用节点）→ 同一次刷新内再请求兜底 `https://meshnetprotocol.github.io/veyl_seed.json`；
3. 两源都失败 → `Offline`，**保留已有缓存**，界面按既有三段式提示；不因为是主源失败就清空。

约束：

- **两源用同一份内容哈希判定更新**：换源不影响 `content_sha256` 的比较，内容相同就 `Unchanged`，不重写缓存、不触发 `config-changed`。
- **ETag 按来源隔离**：`seed_cache` 记 `etag` 与 `etag_source`（实现已加该列），`If-None-Match` 只发给产出这个 ETag 的源；兜底源首次使用时不带 ETag、全量取（421 字节，且只在主源失败时才用）。正确性仍靠内容哈希，304 只是省流量。
- 主源连续失败只在**日志**里记录（含次数与最近错误），不上报、不弹窗——离线是正常场景。
- 两个源都必须通过客户端既有的解析与节点校验；兜底源不会因为「是兜底」而放宽。
- `config.seed_stale` 判据不变：只看本地 `checked_at` 是否超过 6 小时，与哪个源成功无关。

---

## 6. 发布：一条命令

```bash
bash scripts/seed/publish.sh
```

脚本做这些事（任一失败即停）：

1. 仓库检查：`git status --porcelain` **非空就中止**（确需带脏树时显式 `--allow-dirty`）；**当前分支必须是 `main`**；打印 `git rev-parse HEAD`，方便事后对照「哪次提交发的」。注意它只能保证「部署的字节 = 提交的字节」，挡不住「已提交但未部署的其它改动被一起发出去」——发布清单里加一句人工确认线上版本。
2. `cd cloudflare/control-plane` → `npm run typecheck`。
3. `npm test -- seed`：逐台校验节点字段与加密方式（与 Rust 侧共用同一份 golden fixture，见 §3）。
4. 先请求线上 `/v1/seed` 记下 `version`，再校验本地 `version` **严格大于**线上版本、`updated_at` 可解析且**距现在 ≤ 24 小时**、**不得晚于当前时间（允许 5 分钟时钟偏差）**；不满足则中止（防止「改了节点忘了改版本」和「复制旧文件」）。
   - 线上不可达时（恰恰可能是要去修它的时候）：脚本失败并提示用 `--allow-version-unknown` 继续；该开关跳过版本比对，但输出里必须标「⚠ 未能核对线上版本」，方便事后追溯。
5. `npx wrangler deploy`：把 `seed.ts` 随 Worker 一起发布。
6. 请求线上 `https://veyl.dessage.xyz/v1/seed`，算正文 sha256，与本地模块序列化后的哈希对比；不一致 → 非 0 退出（部署成功但线上不是新数据，必须让人看到）。
7. **更新兜底**（见 §7）：默认执行；失败 → 非 0 退出。只有显式 `--skip-fallback` 才跳过，并打印醒目的警告。
8. 打印：主源 URL、兜底状态、节点数、`version`、正文 sha256。

### 需要人工做的部分

| 步骤 | 谁 | 频率 |
|---|---|---|
| `npx wrangler login`（或设 `CLOUDFLARE_API_TOKEN`） | 产品负责人 / 运维，本机 | 一次 |
| 改 `seed.ts`、走 PR review | 谁拿到节点谁改 | 每次换节点 |
| 跑 `publish.sh` | 产品负责人 / 运维 | 每次发布 |
| 推送兜底仓库的凭据（如需） | 运维 | 一次 |

回滚：`git revert` 那次提交，再跑一次 `publish.sh`。不要「删数据」当回滚。

---

## 7. 兜底：GitHub Pages（默认同步，可显式跳过）

- 脚本从同一个 `seed.ts` 生成**同一字节**的 JSON（与 §4 的序列化规则一致），写入 `$PAGES_SEED_DIR/veyl_seed.json`，`git commit` + `push`。
- **`PAGES_SEED_DIR` 未配置 = 与兜底失败同等处理**：脚本非 0 退出，提示「先完成兜底仓库的一次性配置，或显式 `--skip-fallback`」。不写成「静默跳过」，否则新机器上第一次发布会悄悄留下一个落后的兜底。
- **默认必须更新兜底**，不是因为可用性，而是因为**风险**：密码轮换后兜底没跟上，主源故障期间首次安装的用户会拿到一组已作废的密码，表现为「装好了但一个节点都连不上」。这种失败最难排查，所以把「忘记更新兜底」变成默认不发生。
- 兜底更新失败 → 脚本非 0 退出并大声报错；此时主源已经生效，用户正常拉取不受影响，但运维必须知道兜底落后了。
- 只有明确知道本次改动不影响连接（例如只改节点显示名）时才用 `--skip-fallback`，脚本会打印警告。
- Pages 需要一次构建，天然会滞后几分钟；**已作废的密码不在此列**——轮换必须等兜底构建完成再在节点侧作废旧密码（发布清单里的一条）。
- 仓库是公开的，Pages 上的文件任何人不登录也能拿——与主源性质相同（见 §9）。

---

## 8. 客户端改动面

| 项 | 改动 |
|---|---|
| `DEFAULT_SEED_URL` | 改为 `https://veyl.dessage.xyz/v1/seed` |
| 兜底 | 新增常量 `FALLBACK_SEED_URL = https://meshnetprotocol.github.io/veyl_seed.json`；按 §5 的顺序与失败条件使用 |
| ETag | 按来源隔离：`etag` + `etag_source`，只向产出该 ETag 的源发 `If-None-Match`；哈希仍是唯一判据 |
| 哈希 / 6 小时 / 加密缓存 | **不变** |
| `config.seed_stale` | **不变**（缓存超过 6 小时） |
| 诊断文案 | 沿用既有离线文案；不新增「主源 / 兜底」这类内部概念给用户看 |

---

## 9. 敏感信息与信任边界

### 9.1 已经接受的取舍

节点密码在公开仓库与两个公开源上：**这是测试试用资源，密码本身就是分发给所有客户端的**，加密源文件或签名都不能改变「谁能读到它」。因此：

- 不做加密、不做签名、不做私钥管理（产品负责人 2026-11-17 定稿）。
- **7 天试用不是控制手段**：它是客户端本地计时，密码泄露后到期照样能连。不能拿它论证安全。
- 真正的控制是两条运行时的：**定期轮换密码**（建议每月一次，泄露时立即换）与**节点侧限流**（单 IP 连接数 / 带宽上限，在节点服务端配置，具体值由运维定）；异常用量靠节点侧监控发现。

### 9.2 完整性：不签名意味着什么（必须写明）

没有签名时，`veyl.dessage.xyz`（Worker）与 GitHub Pages 兜底**处在同一个信任边界**：能改这两个地方的人，就能把试用用户的下一次连接指向自己的机器，并让流量从那里过。这不是保密问题，是完整性问题。

- 谁能改：control-plane Worker 的部署权限持有者（Cloudflare 账号），以及 GitHub Pages 仓库的推送权限持有者。
- 影响面：改的是「下次刷新后新加入 / 替换的节点」，不影响已经建立的连接；客户端无法分辨被换上的节点是否来自我们。
- **兜底源让信任边界更弱**：GitHub Pages 仓库的推送权限比 Cloudflare 账号更容易被更多人持有。**谁能改兜底源，谁就能决定主源故障时试用用户连到哪里**——这是选兜底换可用性时一并接受的风险，不是疏忽。
- 为什么接受：这两个权限本来就能控制建机与支付链路，能拿到它们的人已经是我们自己人；为一个 7 天试用资源再引入密钥分发与轮换流程，收益低于维护成本（产品负责人裁决）。
- **触发重新评估的条件**：免费节点变成付费线路、种子开始承载非免费节点，或部署权限移交给外部协作者。

---

## 10. 明确不做

签名与密钥轮换、KV / R2 / D1 存储、独立小 Worker、灰度、多环境、CDN 缓存规则、发布审计系统。免费节点=测试试用，按最简方案。

---

## 11. 验收

| # | 场景 | 期望 |
|---|---|---|
| 1 | 改 `seed.ts` → `publish.sh` | 脚本打印的哈希与线上一致；客户端强制刷新后节点数与内容变化 |
| 2 | 不改文件、只等轮询 | 6 小时内不主动拉；超过 6 小时拉到同样内容 → `unchanged`，`checked_at` 更新 |
| 3 | `If-None-Match` 命中 | 返回 304、空 body；客户端不重写缓存 |
| 4 | 主源断（本机 hosts 指向黑洞） | 同一次刷新改走兜底；能拿到节点；日志里记录主源失败 |
| 5 | 两源都断 | 保留旧缓存、三段式提示；不丢现有节点 |
| 6 | 两源内容不同 | 以先成功的为准；哈希不同才更新，不因为「换了源」重写 |
| 7 | `seed.ts` 里混入不支持的 method | `publish.sh` 在第 2 步失败，不部署 |
| 8 | 部署成功但线上哈希不符（缓存/部署未生效） | 脚本非 0 退出并打印两侧哈希 |
| 9 | 工作区有未提交改动时跑 `publish.sh` | 第 1 步中止并列出脏文件；`--allow-dirty` 才继续 |
| 10 | 兜底目录不可写 / 推送失败 / `PAGES_SEED_DIR` 未配置 | 脚本非 0 退出并提示主源已生效；`--skip-fallback` 可显式跳过并打印警告 |
| 11 | 忘改 `version`（等于线上）就发布 | 第 4 步中止，不部署，提示递增版本号 |
| 12 | 线上不可达、需要紧急发版 | 默认失败；`--allow-version-unknown` 可继续，输出标「未能核对线上版本」 |

---

## 12. 风险

- **部署即发布**：`wrangler deploy` 会同时带上其它未完成的 Worker 改动。发布前确认工作区干净（`git status`），否则「只想改种子」会顺带发别的。这是复用主 Worker 的代价，写在这里。
- **Worker 冷启动 / 单点**：主源是单个 Worker，出故障时靠兜底。Worker 的可用性由 Cloudflare 保证，不自建监控。
- **兜底滞后**：主源故障时，首次安装的用户会落到兜底；兜底若落后于一次密码轮换，就会「装好了连不上」。§7 因此把兜底更新设为默认，并在轮换时要求先等 Pages 构建完成再作废旧密码。
- **`version` / `updated_at` 靠手写**：脚本只校验「比线上大 + 24 小时内」，写错会在发布前被拦下；忘了改会导致中止，按提示改完再跑即可。`--allow-version-unknown` 只用于线上不可达的故障修复，不核对版本时输出会留痕。
