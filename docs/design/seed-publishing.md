# 免费节点种子：D1 存储、Worker 读取

> 日期：2026-11-27 ｜ 状态：设计定稿，已实现（未上线）
> 上游：`docs/config-execution.md` §9–§10
> 涉及：`cloudflare/control-plane/src/seed.ts`、`index.ts`、`migrations/`、`scripts/seed/`
>
> **本轮只做**：节点数据从 `seed.ts` 搬进 D1；`/v1/seed` 改读 D1。
> 不做 App 身份、签名、Key、限速、凭据轮换；客户端不改请求；Pages 兜底客户端退役由另一会话处理。

## 1. D1 表
迁移 `0019_seed_payload.sql`（只建表，不写数据）：

```sql
CREATE TABLE seed_payload (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,        -- ISO 8601 UTC，只展示
  body TEXT NOT NULL,              -- 客户端收到的完整 JSON 字节
  content_sha256 TEXT NOT NULL,    -- body 的 sha256（小写 hex）
  updated_by TEXT NOT NULL,
  stored_at INTEGER NOT NULL       -- Unix 毫秒
);
```

**为什么单行 JSON**：客户端按正文哈希判更新，按节点行存会在读时重新序列化，顺序/空格一变字节就变；
单行更新是一条 `INSERT … ON CONFLICT(id) DO UPDATE`，天然原子。节点字段在 `body` 内，写前校验。

## 2. 读取与 ETag
`handleSeed(request, env)`：

1. 只接受 GET/HEAD，其它 405。
2. `SELECT body, content_sha256 FROM seed_payload WHERE id = 1`。
3. 无行或 `env.DB` 未绑定 → `503 { ok:false, error:"seed_unavailable" }`。
4. 读时再算 body 的 SHA-256 与 `content_sha256` 比对；不一致 → `500 seed_corrupt`。
5. `ETag: "sha256-<content_sha256>"`；`If-None-Match` 命中 → 304 空 body，保留 ETag。
6. `Cache-Control: public, max-age=300, must-revalidate`（仍匿名只读，不需要 no-store）。
7. 正文原样返回；HEAD 同头、空 body。删除 `seedEtag()` 与模块级缓存，避免发布后 isolate 仍回旧 ETag。

## 3. 空表
返回 **503 `seed_unavailable`**，不返回 `{"nodes":[]}`：空列表会被客户端当成「合法但没有节点」，
语义含混；503 明确是「服务端暂时没有种子」，客户端按离线路径保留缓存，无缓存才报 `UPSTREAM_ERROR`；
表空通常意味着发布漏了或误删，503 能让运维立刻看到。

## 4. 数据怎么写进去
`scripts/seed/publish-d1.ts`（用 `npm run seed:publish --` 运行，等价于 `vite-node`；复用 `seed.ts` 的校验与序列化）：

1. 读本地 JSON：`{ "nodes": [ … ] }`。文件必须在仓库外或已被 `.gitignore` 忽略（`git check-ignore` 通过）。
2. 校验节点字段与方法白名单；空数组/全部非法 → 中止。
3. 读当前 version（`wrangler d1 execute <DB> --remote --json --command "SELECT version …"`），无行从 0 开始。
4. 生成 `version = 当前 + 1`、`updated_at = 当前 UTC`、固定字段顺序正文、`content_sha256`。**空表首发**可用 `--version` / `--updated-at` 覆盖（只在这时允许），用来保持正文与旧常量字节一致。
5. 写临时 SQL（`chmod 600`，退出时删除），`wrangler d1 execute <DB> --remote --file`；SQL 字符串按 SQLite 规则双写 `'`，拒绝 NUL。
6. 回读 D1，确认 version / hash / 正文一致；打印摘要（不含密码）。
7. `--dry-run` 只打印 version / updated_at / 哈希；`--dev` 操作 `veyl-control-plane-dev-4`；**远程写生产必须显式 `--prod`**（漏加不会默认打到生产），`--local` 只写本地。

**防误操作**：版本由脚本生成（`--version/--updated-at` 仅空表首发可用，表里已有行时直接报错）；`ON CONFLICT … DO UPDATE … WHERE excluded.version > seed_payload.version` 拦住版本倒退；
脚本以**回读**判定是否写入成功（本地 wrangler 的 `--file --json` 不返回 `changes`）；临时 SQL 600 权限并退出删除；失败输出只保留关键行，不带 SQL 正文或密码。

**谁有权改**：持有 D1 写权限 Cloudflare API Token 的人（PM/运维），与 Worker 部署权限同级。
本轮不建管理后台（`cloudflare/admin` 没有 D1 绑定）；以后需要非运维人员改，再加 Access 保护的发布表单。

## 5. 本地开发
- `npm run seed:publish -- --input <本地 JSON> --local` 写本地 D1；输入文件同样不入库。
- 没写过数据时本地 `/v1/seed` 返回 503；客户端按离线处理，其余功能正常。
- migration 只建表；任何节点数据都不进 migration。客户端 debug 仍可用 `VEYL_SEED_URL` 指向本地/dev。

## 6. 部署与回滚
| # | 动作 | 说明 |
|---|---|---|
| 1 | 应用迁移 `0019` 建表（空表） | `/v1/seed` 仍是旧代码 |
| 2 | 脚本把当前种子数据发布进 D1；**首发显式 `--version 2 --updated-at 2026-11-27T06:55:36Z`**（只在空表允许） | 线上行为不变；正文与旧常量逐字节一致 |
| 3 | 部署读 D1 的 Worker | 验收：正文 sha256 必须是 `06f60478f5fabdc2a4c69f7817827162d29bfa3209596e24238d3ae9f3e109fb`、304 字节，ETag 不变；旧 Worker 仍有常量 |
| 4 | 常量删除已并入第 3 步的代码提交 | 仓库不再有节点数据；上线顺序仍是 1 → 2 → 3 |

```bash
# 第 2 步（空表首发；表里已有行时脚本会拒绝这两个参数）
npm run seed:publish -- --input scripts/seed/private_seeds.json --prod --dry-run \
  --version 2 --updated-at 2026-11-27T06:55:36Z
npm run seed:publish -- --input scripts/seed/private_seeds.json --prod \
  --version 2 --updated-at 2026-11-27T06:55:36Z
# 之后每次更新：脚本自增版本，不再传 --version / --updated-at，但仍要 --prod
npm run seed:publish -- --input scripts/seed/private_seeds.json --prod
```

- `--version` / `--updated-at` 是**首发专用**：表里一旦有行，传它们直接报错退出，避免版本倒退。
- 上线前先 `curl -s https://veyl.dessage.xyz/v1/seed` 备份旧正文，用于第 3 步后逐字节对比。

- 回滚 Worker：`wrangler rollback` 回上一版（仍带常量，忽略 D1），第 1 步建的表留着不影响它。
- 回滚数据：用上一份私有 JSON 重发（版本 +1），不删行。
- 不可先改读取再建表：空表会 503。客户端不改，无需客户端发布顺序。

## 7. `seed.ts` 收尾
保留：`SeedNode` / `Seed` 类型、固定字段顺序序列化（`seedBody(seed)`，去掉默认 `SEED` 参数）、节点校验、
`handleSeed(request, env)`（改读 D1）。
删除：`SEED` 常量、`seedEtag()` 与 `cachedEtag`、`seedBody()` 的默认参数。
`index.ts` 调用改为 `handleSeed(request, env)`，路由位置不变。

## 8. 需同步的文档（只列清单）
| 文件 | 改什么 |
|---|---|
| `docs/config-execution.md` §9–§10 | 来源改 D1；仍一个 URL；删 Pages 兜底描述；轮询与失败保留缓存不变 |
| `docs/capabilities.md` | 无独立种子条目，不改；新增时按本文口径 |
| `docs/design/trial-seed-expiry.md` | 只改引用种子缓存/来源的段落：§4.1、§4.2.4、§7.2；闸门逻辑不变 |

## 9. 测试口径
Worker 单测（假 D1）：

| # | 场景 | 期望 |
|---|---|---|
| 1 | 有数据 | 200；body 与 D1 一致；ETag `"sha256-<hash>"`；缓存头保留 |
| 2 | If-None-Match 命中 | 304；空 body；保留 ETag |
| 3 | 空表 / DB 未绑定 | 503 `seed_unavailable` |
| 4 | 正文哈希不一致 | 500 `seed_corrupt` |
| 5 | HEAD | 200；空 body；同 ETag |
| 6 | 非 GET/HEAD | 405 |

脚本单测：节点校验、版本 +1、空表从 1、版本不递增中止、含单引号密码可写入并回读、日志不含密码、
仓库内未忽略路径被拒绝。

真实 curl：

```bash
curl -i https://veyl.dessage.xyz/v1/seed   # 200 + etag
etag=$(curl -sI https://veyl.dessage.xyz/v1/seed | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -i -H "if-none-match: $etag" https://veyl.dessage.xyz/v1/seed   # 304
```

dev 库清空验证 503；发布后再验证 200 与哈希一致。

## 10. 明确不做
App 身份 / 签名 / Key 分发 / 限速 / nonce / 凭据轮换 / 客户端请求改动 / Pages 兜底客户端代码。
