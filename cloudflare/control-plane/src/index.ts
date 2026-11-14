import { handleAuth } from "./auth";
import { handleOrders } from "./orders";
import { handleServers } from "./servers";

export interface Env {
  ENVIRONMENT: string;
  VULTR_API_KEY?: string;
  DO_API_TOKEN?: string;
  DB?: D1Database;
  TOKEN_SIGNING_JWK?: string;
  CREDENTIAL_ENC_KEY?: string;
  ENROLL_BASE_URL?: string;
}

const SERVICE = "veyl-control-plane";const VERSION = "0.0.0";
const USER_AGENT = "veyl-control-plane/0.0.0";
const DO_API = "https://api.digitalocean.com/v2";

/** M1 卖三档套餐，价格从 /v2/sizes 实时取，不写死。中间一档是默认推荐。 */
const PLAN_SLUGS = ["s-1vcpu-512mb-10gb", "s-1vcpu-1gb", "s-1vcpu-2gb"];
const CATALOG_TTL_SECONDS = 300;

/** 地区 slug 前缀 → 大洲。未收录的地区不返回，避免猜错。 */
const CONTINENTS: Record<string, string> = {
  nyc: "north_america",
  sfo: "north_america",
  tor: "north_america",
  atl: "north_america",
  ric: "north_america",
  mkc: "north_america",
  mem: "north_america",
  ams: "europe",
  fra: "europe",
  lon: "europe",
  sgp: "asia",
  blr: "asia",
  syd: "oceania",
};

/** 地区中文名：界面直接用 `name`，前端不内置地区表。未收录的回退英文原名。 */
const REGION_NAMES_ZH: Record<string, string> = {
  nyc1: "纽约 1",
  nyc2: "纽约 2",
  nyc3: "纽约 3",
  sgp1: "新加坡 1",
  lon1: "伦敦 1",
  ams3: "阿姆斯特丹 3",
  fra1: "法兰克福 1",
  tor1: "多伦多 1",
  sfo2: "旧金山 2",
  sfo3: "旧金山 3",
  blr1: "班加罗尔 1",
  syd1: "悉尼 1",
  atl1: "亚特兰大 1",
  ric1: "里士满 1",
  mkc1: "堪萨斯城 1",
  mem1: "孟菲斯 1",
};

function continentOf(slug: string): string | null {
  const prefix = slug.replace(/[0-9]+$/, "");
  return CONTINENTS[prefix] ?? null;
}

type DoResult = { ok: boolean; status: number; data?: unknown; error?: string };

async function doGet(path: string, token: string): Promise<DoResult> {
  try {
    const res = await fetch(`${DO_API}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
      },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    return { ok: true, status: res.status, data: JSON.parse(text) };
  } catch (error) {
    return { ok: false, status: 0, error: `network: ${String(error)}` };
  }
}

function vultrHeaders(key?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 只返回账户的只读摘要，不含邮箱、地址等个人信息。 */
async function vultrAccount(key: string): Promise<{
  ok: boolean;
  status: number;
  account?: { name: string; balance: string; pending_charges: string };
  error?: string;
}> {
  let res: Response;
  try {
    res = await fetch("https://api.vultr.com/v2/account", {
      headers: vultrHeaders(key),
    });
  } catch (error) {
    return { ok: false, status: 0, error: `network: ${String(error)}` };
  }

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: text.slice(0, 300) };
  }

  try {
    const data = JSON.parse(text) as {
      account?: {
        name?: string;
        balance?: string | number;
        pending_charges?: string | number;
      };
    };
    const account = data.account ?? {};
    return {
      ok: true,
      status: res.status,
      account: {
        name: String(account.name ?? ""),
        balance: String(account.balance ?? ""),
        pending_charges: String(account.pending_charges ?? ""),
      },
    };
  } catch {
    return { ok: false, status: res.status, error: "invalid json" };
  }
}

/** 缓存副本的新鲜度：用响应体里的 `updated_at` 判断，不依赖边缘节点的 Age 头。 */
async function catalogAgeMs(response: Response): Promise<number | null> {
  try {
    const body = (await response.clone().json()) as { updated_at?: string };
    const builtAt = Date.parse(body.updated_at ?? "");
    if (!Number.isFinite(builtAt)) return null;
    return Date.now() - builtAt;
  } catch {
    return null;
  }
}

export interface CatalogData {
  currency: string;
  updated_at: string;
  regions: Array<{ id: string; name: string; continent: string }>;
  plans: Array<{ id: string; label: string; hourly_usd: number; monthly_usd: number }>;
}

/** 目录的唯一取数入口：目录接口与下单校验共用，避免两处各取一次。 */
export async function fetchCatalogData(token: string): Promise<CatalogData | null> {
  const [regionResult, sizeResult] = await Promise.all([
    doGet("/regions?per_page=200", token),
    doGet("/sizes?per_page=200", token),
  ]);

  if (!regionResult.ok || !sizeResult.ok) {
    return null;
  }

  const rawRegions =
    (regionResult.data as {
      regions?: Array<{ slug: string; name: string; available: boolean }>;
    })?.regions ?? [];
  const rawSizes =
    (sizeResult.data as {
      sizes?: Array<{
        slug: string;
        memory: number;
        vcpus: number;
        price_hourly: number;
        price_monthly: number;
      }>;
    })?.sizes ?? [];

  // 只接受能直接给用户看的地区与套餐：字段完整、价格有限且非负。
  // 有任何一条不合格就整体 503，避免把坏数据缓存 5 分钟。
  const regions = rawRegions
    .filter((r) => r.available && r.slug.trim() !== "" && r.name.trim() !== "")
    .map((r) => ({
      id: r.slug,
      name: REGION_NAMES_ZH[r.slug] ?? r.name,
      continent: continentOf(r.slug),
    }))
    .filter((r) => r.continent !== null);

  const validPrice = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;

  const plans = PLAN_SLUGS.flatMap((slug) => {
    const size = rawSizes.find((s) => s.slug === slug);
    if (!size || !validPrice(size.price_hourly) || !validPrice(size.price_monthly)) return [];
    const memory = size.memory >= 1024 ? `${Math.round(size.memory / 1024)} GB` : `${size.memory} MB`;
    return [
      {
        id: size.slug,
        label: `${size.vcpus} 核 · ${memory}`,
        hourly_usd: size.price_hourly,
        monthly_usd: size.price_monthly,
      },
    ];
  });

  if (plans.length === 0 || regions.length === 0) {
    return null;
  }

  return {
    currency: "USD",
    updated_at: new Date().toISOString(),
    regions: regions as CatalogData["regions"],
    plans,
  };
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/" || url.pathname === "/health") {
    return json({
      ok: true,
      service: SERVICE,
      env: env.ENVIRONMENT ?? "unknown",
      version: VERSION,
      now: new Date().toISOString(),
    });
  }

  // 设备令牌：静默注册与刷新（§19.2）。目录之后实现，未配置 D1 时返回 503。
  const authResponse = await handleAuth(request, env);
  if (authResponse) return authResponse;

  // 订单：下单与假支付（§19.5）。实例开通在建机链路里跟进。
  const orderResponse = await handleOrders(request, env);
  if (orderResponse) return orderResponse;

  // 服务器：enrollment 回传（无需账户令牌）、列表、详情、销毁、凭据。
  const serverResponse = await handleServers(request, env);
  if (serverResponse) return serverResponse;

  // 公开只读目录：不校验登录，缓存 5 分钟（设计：my-servers.md §3.2）。
  if (url.pathname === "/v1/catalog") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }
    const token = env.DO_API_TOKEN;
    if (!token) return json({ ok: false, error: "catalog_unavailable", retryable: true }, 503);

    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request("https://catalog.veyl.internal/v1");
    let stale: Response | null = null;

    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const age = await catalogAgeMs(hit);
        if (age !== null && age < CATALOG_TTL_SECONDS * 1000) return hit;
        stale = hit;
      }
    }

    const data = await fetchCatalogData(token);
    const response = data
      ? json(data)
      : json({ ok: false, error: "catalog_unavailable", retryable: true }, 503);
    if (data && cache) {
      const toCache = new Response(response.clone().body, response);
      toCache.headers.set("cache-control", "public, max-age=86400");
      await cache.put(cacheKey, toCache);
    }
    // 上游抖动时宁可给旧目录，也不要让用户看到「读不到可选地区」。
    // 旧副本整体反序列化后返回，避免把内部标记暴露成字段。
    if (!data && stale) {
      const fallback = new Response(stale.body, stale);
      fallback.headers.set("x-catalog-stale", "true");
      return fallback;
    }
    return response;
  }

  // 仅 dev：确认 Cloudflare secret 里的 Vultr key 可用。生产环境不存在这个路由。
  if (url.pathname === "/v1/debug/vultr") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    if (!env.VULTR_API_KEY) return json({ ok: false, error: "missing_secret" }, 500);
    const result = await vultrAccount(env.VULTR_API_KEY);
    return json(result, result.ok ? 200 : 502);
  }

  // 仅 dev：DigitalOcean API 是否接受 Cloudflare Worker 出口（不带 key，401 即代表可达）。
  if (url.pathname === "/v1/debug/do") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    try {
      const res = await fetch("https://api.digitalocean.com/v2/regions", {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      });
      const text = await res.text();
      return json({
        ok: res.ok,
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: text.slice(0, 160),
      });
    } catch (error) {
      return json({ ok: false, status: 0, error: `network: ${String(error)}` }, 502);
    }
  }

  // 仅 dev：用完整浏览器请求头访问 Vultr 公共接口，验证是否只是 WAF 的机器人评分问题。
  if (url.pathname === "/v1/debug/vultr-browser") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    try {
      const res = await fetch("https://api.vultr.com/v2/regions?per_page=1", {
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.vultr.com/",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Sec-Fetch-Site": "same-site",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
          "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
        },
      });
      const text = await res.text();
      return json(
        {
          ok: res.ok,
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body: text.slice(0, 200),
        },
        res.ok ? 200 : 502,
      );
    } catch (error) {
      return json({ ok: false, status: 0, error: `network: ${String(error)}` }, 502);
    }
  }

  // 仅 dev：对比不同 User-Agent 访问 Vultr 公共接口的结果，判断 WAF 是否按 UA 拦截。
  if (url.pathname === "/v1/debug/vultr-ua") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    const uas: Record<string, string> = {
      default: USER_AGENT,
      chrome:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      curl: "curl/8.7.1",
    };
    const results: Record<string, unknown> = {};
    await Promise.all(
      Object.entries(uas).map(async ([name, ua]) => {
        try {
          const res = await fetch("https://api.vultr.com/v2/regions?per_page=1", {
            headers: { Accept: "application/json", "User-Agent": ua },
          });
          const text = await res.text();
          results[name] = { status: res.status, body: text.slice(0, 80) };
        } catch (error) {
          results[name] = { error: String(error) };
        }
      }),
    );
    return json({ ok: true, results });
  }

  // 仅 dev：一次探测多个上游，定位是哪一层挡了请求；同时给出 IPv4 出口。
  if (url.pathname === "/v1/debug/probes") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    const targets = [
      "https://api.vultr.com/v2/regions?per_page=1",
      "https://www.vultr.com",
      "https://docs.vultr.com",
      "https://ipv4.icanhazip.com",
    ];
    const results: Record<string, unknown> = {};
    await Promise.all(
      targets.map(async (target) => {
        try {
          const res = await fetch(target, {
            headers: { Accept: "text/html,application/json", "User-Agent": USER_AGENT },
          });
          const text = await res.text();
          results[target] = {
            status: res.status,
            server: res.headers.get("server"),
            body: text.slice(0, 120).replace(/\s+/g, " "),
          };
        } catch (error) {
          results[target] = { error: String(error) };
        }
      }),
    );
    return json({ ok: true, results });
  }

  // 仅 dev：确认 Worker 能正常发起对外 HTTPS 子请求，并显示出口 IP。
  if (url.pathname === "/v1/debug/egress") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    try {
      const res = await fetch("https://api.ipify.org?format=json", {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      });
      const text = await res.text();
      return json({ ok: res.ok, status: res.status, body: text.slice(0, 200) });
    } catch (error) {
      return json({ ok: false, status: 0, error: `network: ${String(error)}` }, 502);
    }
  }

  // 仅 dev：Worker 出口能否访问 Vultr 公共接口（不涉及 key），用于区分「出口被挡」与「key/白名单问题」。
  if (url.pathname === "/v1/debug/vultr-public") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    try {
      const res = await fetch("https://api.vultr.com/v2/regions?per_page=1", {
        headers: vultrHeaders(),
      });
      const text = await res.text();
      return json(
        {
          ok: res.ok,
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body: text.slice(0, 200),
        },
        res.ok ? 200 : 502,
      );
    } catch (error) {
      return json({ ok: false, status: 0, error: `network: ${String(error)}` }, 502);
    }
  }

  // 仅 dev：验证 DO_API_TOKEN 的 region/size/image 读权限，并给出向导所需的目录。
  if (url.pathname === "/v1/debug/do-catalog") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    if (!env.DO_API_TOKEN) return json({ ok: false, error: "missing_secret" }, 500);

    const [regions, sizes, images] = await Promise.all([
      doGet("/regions?per_page=200", env.DO_API_TOKEN),
      doGet("/sizes?per_page=200", env.DO_API_TOKEN),
      doGet("/images?type=distribution&per_page=200", env.DO_API_TOKEN),
    ]);

    const regionList =
      (regions.data as { regions?: Array<{ slug: string; name: string; available: boolean }> })
        ?.regions ?? [];
    const sizeList =
      (sizes.data as {
        sizes?: Array<{
          slug: string;
          memory: number;
          vcpus: number;
          price_monthly: number;
          regions: string[];
        }>;
      })?.sizes ?? [];
    const imageList =
      (images.data as {
        images?: Array<{ slug: string | null; id: number; name: string }>;
      })?.images ?? [];

    const available = regionList.filter((r) => r.available).map((r) => r.slug);
    const ubuntu = imageList.find((i) => i.slug === "ubuntu-24-04-x64");

    return json(
      {
        ok: regions.ok && sizes.ok && images.ok,
        endpoints: {
          regions: { status: regions.status, ok: regions.ok, error: regions.error },
          sizes: { status: sizes.status, ok: sizes.ok, error: sizes.error },
          images: { status: images.status, ok: images.ok, error: images.error },
        },
        regions: { count: available.length, slugs: available },
        sizes: {
          count: sizeList.length,
          cheapest: sizeList
            .slice()
            .sort((a, b) => a.price_monthly - b.price_monthly)
            .slice(0, 5)
            .map((s) => ({
              slug: s.slug,
              vcpus: s.vcpus,
              memory_mb: s.memory,
              usd_per_month: s.price_monthly,
            })),
        },
        ubuntu_24_04: ubuntu
          ? { id: ubuntu.id, slug: ubuntu.slug, name: ubuntu.name }
          : null,
      },
      regions.ok && sizes.ok && images.ok ? 200 : 502,
    );
  }

  // 仅 dev：逐个探测 token 的读权限边界（能读 / 被拒），确认最小权限刚好够用。
  if (url.pathname === "/v1/debug/do-scopes") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    if (!env.DO_API_TOKEN) return json({ ok: false, error: "missing_secret" }, 500);

    const probes: Array<[string, string]> = [
      ["regions", "/regions?per_page=1"],
      ["sizes", "/sizes?per_page=1"],
      ["images", "/images?per_page=1"],
      ["droplets", "/droplets?per_page=1"],
      ["firewalls", "/firewalls?per_page=1"],
      ["account", "/account"],
      ["billing_balance", "/customers/my/balance"],
    ];

    const results: Record<string, { status: number; verdict: string; error?: string }> = {};
    await Promise.all(
      probes.map(async ([name, path]) => {
        const r = await doGet(path, env.DO_API_TOKEN!);
        results[name] = {
          status: r.status,
          verdict: r.ok ? "allowed" : r.status === 403 ? "denied" : "error",
          error: r.error,
        };
      }),
    );

    return json({ ok: true, results });
  }

  return json({ ok: false, error: "not_found" }, 404);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
};
