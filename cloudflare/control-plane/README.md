# Veyl 控制面（Cloudflare Worker）

节点供应商是 **DigitalOcean**（Vultr 已弃用：其 API 网关拒绝 Cloudflare Worker 出口）。当前已实现公开目录 `GET /v1/catalog`（地区与三档套餐，缓存 5 分钟、上游失败回退旧副本），以及 dev-only 的诊断路由；下单、建机、装机、凭据下发尚未实现。

## 环境

| 环境 | Worker 名称 | 部署命令 |
|---|---|---|
| 生产（默认） | `veyl-control-plane` | `npm run deploy` |
| 开发 | `veyl-control-plane-dev` | `npm run deploy:dev` |

两者使用各自的 `workers.dev` 域名，`vars.ENVIRONMENT` 不同，secrets 互相独立。

## 首次准备

```bash
npm install
npx wrangler login
```

## 部署

```bash
npm run deploy:dev   # 开发环境
npm run deploy       # 生产环境
```

## 验证

```bash
curl -s https://veyl-control-plane-dev.ribencong.workers.dev/v1/catalog
```

返回 `{ currency, updated_at, regions[], plans[] }`；`regions[].continent` 是 `asia` / `europe` / `north_america` 等六个值之一。

## Secrets

每个环境单独设置，不要写进仓库：

```bash
npx wrangler secret put DO_API_TOKEN --env dev
npx wrangler secret put DO_API_TOKEN
```

token 的最小 scopes：`droplet:read`、`droplet:create`、`droplet:delete`、`firewall:read`、`firewall:create`、`region:read`、`size:read`、`image:read`。**没有设置该 secret 时 `/v1/catalog` 返回 503。**

## 本地开发与测试

```bash
npm run dev        # 本地 http://localhost:8787
npm run typecheck
npm test
```

