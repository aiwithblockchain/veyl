// dev 入口：先给开发诊断路由一次机会，其余请求原样交给生产入口。
// `wrangler.jsonc` 的 `env.dev.main` 指向本文件；顶层 `main` 仍是 src/index.ts。
// 生产包因此不包含 dev-routes 的任何代码。

import worker, { type Env } from "./index";
import { handleDevRoutes } from "./dev-routes";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const devResponse = await handleDevRoutes(request, env);
    if (devResponse) return devResponse;
    return worker.fetch(request, env, ctx);
  },
  scheduled: worker.scheduled,
};
