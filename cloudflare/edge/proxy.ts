// 边缘入口（docs/design/my-servers.md §2.3）：GoDaddy 的 CNAME 只能指向 *.pages.dev，
// 而 Workers Custom Domain 要求 zone 在 Cloudflare，所以域名由 Pages 承接，请求经
// service binding 转给控制面 Worker——不过公网，也不依赖 workers.dev。

interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

export interface EdgeEnv {
  CONTROL_PLANE?: FetcherLike;
}

export async function forward(request: Request, env: EdgeEnv): Promise<Response> {
  if (!env.CONTROL_PLANE) {
    return new Response(JSON.stringify({ ok: false, error: "edge_not_configured" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return env.CONTROL_PLANE.fetch(request);
}

export function onRequest(context: { request: Request; env: EdgeEnv }): Promise<Response> {
  return forward(context.request, context.env);
}
