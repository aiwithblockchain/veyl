import { handleAuth } from "./auth";
import { handleEmailAuth } from "./auth_email";
import { buildCloudInit } from "./cloud_init";
import { monthlyUsdFromDaily, planDailyPriceCents } from "./lib/config";
import { runBilling } from "./billing";
import { handleOrders } from "./orders";
import { handleTopups, startTopupSession } from "./topups";
import { balanceCents } from "./wallet";
import { handleServers } from "./servers";
import { handleMobile } from "./mobile";
import { handleSeed } from "./seed";
import { handleDodoWebhook } from "./webhooks/dodo";

export interface Env {
  ENVIRONMENT: string;
  VULTR_API_KEY?: string;
  DO_API_TOKEN?: string;
  DB?: D1Database;
  TOKEN_SIGNING_JWK?: string;
  CREDENTIAL_ENC_KEY?: string;
  CREDENTIAL_KEY_ID?: string;
  /** 手机导出令牌的 AES-256-GCM 密钥（base64 32 字节），与 CREDENTIAL_ENC_KEY 分开。 */
  MOBILE_TOKEN_ENC_KEY?: string;
  ENROLL_BASE_URL?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  DODO_API_KEY?: string;
  DODO_WEBHOOK_SECRET?: string;
  /** 日价表（USD 分/天）：{"s-1vcpu-1gb":"30"}；唯一售价真源，月价由它派生。 */
  PLAN_DAILY_PRICE_CENTS?: string;
  /** 套餐 → Dodo 产品 ID：{"s-1vcpu-1gb":"pdt_…"}，test / live 各一套。 */
  DODO_PRODUCT_IDS?: string;
  /** 充值面额（美分）→ 一次性产品 ID。 */
  DODO_TOPUP_PRODUCT_IDS?: string;
  APP_PAYMENT_RETURN_URL?: string;
}

const SERVICE = "veyl-control-plane";const VERSION = "0.0.0";
const USER_AGENT = "veyl-control-plane/0.0.0";
const DO_API = "https://api.digitalocean.com/v2";
/** 回源超时必须短于目录租约（15 秒），否则租约过期前请求还在挂。 */
const DO_TIMEOUT_MS = 10_000;

/** 目录缓存的 D1 行：`v1` 是目录本身，`v1:refresh` 是回源租约。 */
const CATALOG_ROW_KEY = "v1";
const CATALOG_LEASE_KEY = "v1:refresh";
/** `?fresh=1` 的防抖：10 秒内重复打开向导不再回源。 */
const CATALOG_FRESH_DEBOUNCE_MS = 10_000;
/** 回源租约：拿到租约的请求负责回源，其它并发请求不会重复打 DO。 */
const CATALOG_REFRESH_LEASE_MS = 15_000;

interface CatalogCacheRow {
  payload: string;
  updated_at: number;
}

function catalogCacheResponse(payload: string): Response {
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readCatalogRow(db: D1Database): Promise<CatalogCacheRow | null> {
  return db
    .prepare("SELECT payload, updated_at FROM catalog_cache WHERE key = ?")
    .bind(CATALOG_ROW_KEY)
    .first<CatalogCacheRow>();
}

/**
 * 回源一次并写回 D1。失败返回 null——调用方一律 503，**绝不拿旧数据冒充最新**；
 * 旧行留在库里等下次回源成功后覆盖。只有拿到租约的请求才会打 DO，其余并发请求
 * 不会变成第二、第三次回源。
 */
async function refreshCatalog(
  env: Env,
  db: D1Database,
  token: string,
  row: CatalogCacheRow | null,
): Promise<string | null> {
  const now = Date.now();
  const lease = await db
    .prepare(
      "INSERT INTO catalog_cache (key, payload, updated_at) VALUES (?, '', ?) " +
        "ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at " +
        "WHERE catalog_cache.updated_at <= ?",
    )
    .bind(CATALOG_LEASE_KEY, now, now - CATALOG_REFRESH_LEASE_MS)
    .run();
  if (Number((lease as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
    console.warn("[catalog] refresh_skipped reason=another_request_in_flight");
    return null;
  }

  const data = await fetchCatalogData(token);
  // 目录里展示的必须是售价：成本价只留在控制面内部，不下发。
  const priced = data ? applySalePrices(data, env) : null;
  if (!priced) {
    console.error("[catalog] refresh_failed stage=digitalocean");
    // 失败立刻释放租约：DO 恢复后下一个 fresh 能马上重试，而不是干等 15 秒。
    // 15 秒只留给「进程崩了没机会释放」的情况。
    await db
      .prepare("DELETE FROM catalog_cache WHERE key = ?")
      .bind(CATALOG_LEASE_KEY)
      .run()
      .catch(() => {});
    await db
      .prepare(
        "INSERT INTO audit_log (at, account_id, action, detail) VALUES (?, NULL, 'catalog.refresh_failed', ?)",
      )
      .bind(now, JSON.stringify({ stage: "digitalocean" }))
      .run()
      // 审计写不进去不能把 503 变成 500：回源失败本身就是结果。
      .catch(() => {});
    return null;
  }

  const payload = JSON.stringify(priced);
  if (row) {
    // 条件更新：只有读到的版本还没被别人覆盖时才写，旧结果盖不掉新结果。
    const written = await db
      .prepare(
        "UPDATE catalog_cache SET payload = ?, updated_at = ? WHERE key = ? AND updated_at = ?",
      )
      .bind(payload, now, CATALOG_ROW_KEY, Number(row.updated_at))
      .run();
    if (Number((written as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
      // 写回被更新的版本超越了：本次仍把新数据返回给调用方，但要留痕，别静默丢掉。
      console.warn("[catalog] write_skipped reason=stale_version");
      await db
        .prepare(
          "INSERT INTO audit_log (at, account_id, action, detail) VALUES (?, NULL, 'catalog.write_skipped', ?)",
        )
        .bind(now, JSON.stringify({ expected_updated_at: Number(row.updated_at) }))
        .run()
        .catch(() => {});
    }
  } else {
    await db
      .prepare(
        "INSERT INTO catalog_cache (key, payload, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
      )
      .bind(CATALOG_ROW_KEY, payload, now)
      .run();
  }
  return payload;
}

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
      // 回源耗时必须短于 15 秒租约：超时按失败处理，租约会立刻释放。
      signal: AbortSignal.timeout(DO_TIMEOUT_MS),
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

export interface CatalogData {
  currency: string;
  updated_at: string;
  regions: Array<{ id: string; name: string; continent: string }>;
  plans: Array<{
    id: string;
    label: string;
    hourly_usd: number;
    monthly_usd: number;
    /** 售价（USD 分/天），applySalePrices 填；下单与展示都以它为准。 */
    daily_price_cents?: number;
    /** 每月公网出口额度（GiB）；来自 /sizes 的 transfer(TB) × 1000，取不到为 0。 */
    transfer_gib: number;
    /** 这个规格真实可用的地区 id（`/sizes` 的 `regions`，已对齐 `regions[]`）。 */
    regions: string[];
  }>;
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
        /** TB、float、只计公网出口；DO 计费文档把 1 TB 档写作 1,000 GiB。 */
        transfer?: number;
        /** 这个规格真实可用的地区 slug 列表；DO 按地区给，不是全地区通用。 */
        regions?: unknown;
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

  // /sizes 的 transfer 是 TB 的浮点数；乘 1000（不是 1024）折算成 GiB。
  // 缺失 / 非有限 / ≤0 一律记 0（界面按「未知」整行不显示），不写死档位。
  const transferGib = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.round(value * 1000)
      : 0;

  const plans = PLAN_SLUGS.flatMap((slug) => {
    const size = rawSizes.find((s) => s.slug === slug);
    if (!size || !validPrice(size.price_hourly) || !validPrice(size.price_monthly)) return [];
    // `/sizes` 的 `regions` 是这个规格真实可用的地区：缺字段或不是数组就整条丢弃——
    // 空数组不是「到处都能开」，不许拿它猜。只保留目录里真实下发的地区 id。
    if (!Array.isArray(size.regions)) return [];
    const knownRegions = new Set(regions.map((region) => region.id));
    const planRegions = Array.from(
      new Set(
        size.regions.filter(
          (id): id is string => typeof id === "string" && knownRegions.has(id),
        ),
      ),
    );
    const memory = size.memory >= 1024 ? `${Math.round(size.memory / 1024)} GB` : `${size.memory} MB`;
    return [
      {
        id: size.slug,
        label: `${size.vcpus} 核 · ${memory}`,
        hourly_usd: size.price_hourly,
        monthly_usd: size.price_monthly,
        transfer_gib: transferGib(size.transfer),
        regions: planRegions,
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

export async function route(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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

  // 支付回跳页：Dodo 支付完成后跳回来，这里只给一句「回到应用」，不做任何写操作。
  if (url.pathname === "/payment/return") {
    const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Veyl</title>
<style>body{margin:0;background:#FAFAF9;color:#1B1B1A;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:17px;font-weight:600;margin:0 0 12px}p{font-size:14px;line-height:1.65;color:#5C5C58;margin:0}</style>
</head><body><main>
<h1>支付已完成</h1>
<p>回到 Veyl 应用即可看到余额变化。这个页面可以直接关闭。</p>
</main></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // 免费节点种子：匿名只读，随 Worker 部署（seed-publishing.md §4）。
  const seedResponse = await handleSeed(request);
  if (seedResponse) return seedResponse;

  // 设备令牌：静默注册与刷新（§19.2）。目录之后实现，未配置 D1 时返回 503。
  const authResponse = await handleAuth(request, env);
  if (authResponse) return authResponse;

  // 邮箱登录：发码 / 校验 / 登出（login-and-payment.md §2）。
  const emailAuthResponse = await handleEmailAuth(request, env);
  if (emailAuthResponse) return emailAuthResponse;

  // Dodo 回调：公开端点，只认签名（login-and-payment.md §4.5）。
  const webhookResponse = await handleDodoWebhook(request, env, ctx);
  if (webhookResponse) return webhookResponse;

  // 钱包与充值（login-and-payment.md §4.2–§4.3）。
  const topupResponse = await handleTopups(request, env);
  if (topupResponse) return topupResponse;

  // 订单：下单与假支付（§19.5）。实例开通在建机链路里跟进。
  const orderResponse = await handleOrders(request, env);
  if (orderResponse) return orderResponse;

  // 服务器：enrollment 回传（无需账户令牌）、列表、详情、销毁、凭据。
  const serverResponse = await handleServers(request, env);
  if (serverResponse) return serverResponse;

  // 手机端导出：账户级令牌（Bearer）与远程配置（Basic）。
  const mobileResponse = await handleMobile(request, env);
  if (mobileResponse) return mobileResponse;

  // 公开只读目录：不校验登录。目录与年龄判断都存在 D1 里，所有边缘共享同一份数据；
  // `?fresh=1`：打开新建向导时绕过年龄判断直接回源（10 秒内重复打开不重复回源）。
  // 回源失败一律 503，**不回退旧数据**——过期的可用性会把用户引到建不成的组合上。
  if (url.pathname === "/v1/catalog") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }
    const token = env.DO_API_TOKEN;
    if (!token) return json({ ok: false, error: "catalog_unavailable", retryable: true }, 503);

    const fresh = url.searchParams.get("fresh") === "1";
    const db = env.DB;
    if (!db) {
      // 没有 D1（本地/测试环境）：直接回源，不做缓存。
      const data = await fetchCatalogData(token);
      const priced = data ? applySalePrices(data, env) : null;
      return priced
        ? catalogCacheResponse(JSON.stringify(priced))
        : json({ ok: false, error: "catalog_unavailable", retryable: true }, 503);
    }

    const row = await readCatalogRow(db);
    const age = row ? Date.now() - Number(row.updated_at) : Number.POSITIVE_INFINITY;
    const freshEnough = fresh
      ? age < CATALOG_FRESH_DEBOUNCE_MS
      : age < CATALOG_TTL_SECONDS * 1000;
    if (row && freshEnough) return catalogCacheResponse(row.payload);

    const payload = await refreshCatalog(env, db, token, row);
    if (payload) return catalogCacheResponse(payload);
    // 没抢到租约时，别人可能刚好刷新完：读一次新行，只有确实变新了才返回。
    const latest = await readCatalogRow(db);
    if (latest && (!row || Number(latest.updated_at) > Number(row.updated_at))) {
      return catalogCacheResponse(latest.payload);
    }
    return json({ ok: false, error: "catalog_unavailable", retryable: true }, 503);
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

  // 仅 dev：按 provider_id 查一台 droplet 的真实状态与 IP（排查卡在 booting 的机器）。
  if (url.pathname === "/v1/debug/droplet") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    if (!env.DO_API_TOKEN) return json({ ok: false, error: "missing_secret" }, 500);
    const id = url.searchParams.get("id");
    if (!id) return json({ ok: false, error: "missing_id" }, 400);
    const res = await fetch(
      `https://api.digitalocean.com/v2/droplets/${encodeURIComponent(id)}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${env.DO_API_TOKEN}`,
          "User-Agent": USER_AGENT,
        },
      },
    );
    const text = await res.text();
    if (!res.ok) return json({ ok: false, status: res.status, body: text.slice(0, 200) }, 502);
    const body = JSON.parse(text) as {
      droplet?: {
        status?: string;
        created_at?: string;
        networks?: { v4?: Array<{ ip_address: string; type: string }> };
      };
    };
    return json({
      ok: true,
      status: body.droplet?.status ?? null,
      created_at: body.droplet?.created_at ?? null,
      ips: (body.droplet?.networks?.v4 ?? []).map((n) => ({ ip: n.ip_address, type: n.type })),
    });
  }

  // 仅 dev：给已有服务器的防火墙补一条入站 ICMP（诊断用）。新建机器已经默认带。
  if (url.pathname === "/v1/debug/firewall-icmp") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    if (!env.DO_API_TOKEN) return json({ ok: false, error: "missing_secret" }, 500);
    if (!env.DB) return json({ ok: false, error: "missing_db" }, 500);
    const id = url.searchParams.get("id");
    if (!id) return json({ ok: false, error: "missing_id" }, 400);

    const row = await env
      .DB.prepare("SELECT firewall_id FROM servers WHERE id = ?")
      .bind(id)
      .first<{ firewall_id: string | null }>();
    if (!row) return json({ ok: false, error: "not_found" }, 404);
    const firewallId = row.firewall_id;
    if (!firewallId) return json({ ok: false, error: "no_firewall" }, 422);

    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${env.DO_API_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    const endpoint = `https://api.digitalocean.com/v2/firewalls/${encodeURIComponent(firewallId)}`;

    const current = await fetch(endpoint, { headers });
    const currentText = await current.text();
    if (!current.ok) {
      return json(
        { ok: false, error: "upstream", status: current.status, body: currentText.slice(0, 200) },
        502,
      );
    }
    const firewall = (
      JSON.parse(currentText) as {
        firewall?: {
          name?: string;
          inbound_rules?: unknown[];
          outbound_rules?: unknown[];
          droplet_ids?: unknown[];
          tags?: unknown[];
        };
      }
    ).firewall;
    const inboundRules = firewall?.inbound_rules ?? [];
    // 只认「面向全网的 icmp」：来源不是全网的规则满足不了 ping 诊断，仍要追加。
    const publicIcmp = (rule: unknown) => {
      const entry = rule as { protocol?: string; sources?: { addresses?: unknown } };
      if (entry.protocol !== "icmp") return false;
      const addresses = Array.isArray(entry.sources?.addresses) ? entry.sources.addresses : [];
      return addresses.includes("0.0.0.0/0") && addresses.includes("::/0");
    };
    if (inboundRules.some(publicIcmp)) {
      return json({ ok: true, changed: false, inbound_rules: inboundRules });
    }

    const icmp = {
      protocol: "icmp",
      ports: "0",
      sources: { addresses: ["0.0.0.0/0", "::/0"] },
    };
    const nextInbound = [...inboundRules, icmp];
    // DO 的 PUT 是全量替换：出站、droplet_ids 与 tags 必须原样带上，
    // 不能赌「省略 = 保持不变」——真被清空，正在跑的机器会瞬间失去防火墙。
    const updated = await fetch(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: firewall?.name,
        inbound_rules: nextInbound,
        outbound_rules: firewall?.outbound_rules ?? [],
        droplet_ids: firewall?.droplet_ids ?? [],
        tags: firewall?.tags ?? [],
      }),
    });
    const updatedText = await updated.text();
    if (!updated.ok) {
      return json(
        { ok: false, error: "upstream", status: updated.status, body: updatedText.slice(0, 200) },
        502,
      );
    }
    return json({ ok: true, changed: true, inbound_rules: nextInbound });
  }

  // 仅 dev：输出当前版本的 cloud-init 脚本，供手动建机调试（lab=1 时不关 SSH、不回传）。
  if (url.pathname === "/v1/debug/cloud-init") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    const port = Number(url.searchParams.get("port") ?? "0");
    const enroll = url.searchParams.get("enroll") ?? "";
    if (!port || !enroll) return json({ ok: false, error: "missing_params" }, 400);
    let script = buildCloudInit({ port, enrollUrl: enroll });
    if (url.searchParams.get("lab") === "1") {
      script = script
        .replace(/^systemctl (stop|disable) ssh.*$/gm, "# (lab) 保留 SSH")
        .replace("report() {", "report() { return 0; # lab：不回传");
    }
    return new Response(script, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
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
          price_hourly: number;
          price_monthly: number;
          transfer?: number;
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
        // 每个在售套餐的真实可用地区：联调/验收直接看这里，不看推断。
        plans: PLAN_SLUGS.map((slug) => {
          const size = sizeList.find((s) => s.slug === slug);
          return size
            ? {
                slug,
                regions: size.regions ?? null,
                memory: size.memory,
                vcpus: size.vcpus,
                price_hourly: size.price_hourly,
                price_monthly: size.price_monthly,
                transfer: size.transfer ?? null,
              }
            : null;
        }),
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

  // 仅 dev：清库前把在跑的实验机销毁，避免留下无人计费的实例。
  if (url.pathname === "/v1/debug/destroy") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    if (!env.DB || !env.DO_API_TOKEN) return json({ ok: false, error: "not_configured" }, 503);
    const serverId = url.searchParams.get("server") ?? "";
    const row = await env.DB.prepare("SELECT id, provider_id FROM servers WHERE id = ?")
      .bind(serverId)
      .first<{ id: string; provider_id: string | null }>();
    if (!row) return json({ ok: false, error: "server_missing" }, 404);
    if (!row.provider_id) return json({ ok: true, deleted: false, reason: "no_provider_id" });
    const { deleteDroplet } = await import("./providers/digitalocean");
    const result = await deleteDroplet(env.DO_API_TOKEN, row.provider_id);
    await env.DB.prepare("UPDATE servers SET state = 'destroyed', destroyed_at = ?, updated_at = ? WHERE id = ?")
      .bind(Date.now(), Date.now(), row.id)
      .run();
    return json({ ok: result.ok, provider_id: row.provider_id, reason: result.ok ? undefined : result.reason });
  }

  // 仅 dev：没有界面时手动造一个邮箱账户，配合下面的充值调试入口联调支付。
  if (url.pathname === "/v1/debug/account") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    if (!env.DB) return json({ ok: false, error: "db_unavailable" }, 503);
    const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) return json({ ok: false, error: "email_required" }, 400);
    const existing = await env.DB.prepare("SELECT id, email, balance_cents FROM accounts WHERE email = ?")
      .bind(email)
      .first<{ id: string; email: string; balance_cents: number }>();
    if (existing) return json({ ok: true, created: false, ...existing });
    const accountId = `acct_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await env.DB.prepare("INSERT INTO accounts (id, kind, email, status, created_at, balance_cents) VALUES (?, 'email', ?, 'active', ?, 0)")
      .bind(accountId, email, Date.now())
      .run();
    return json({ ok: true, created: true, id: accountId, email, balance_cents: 0 });
  }

  // 仅 dev：没有界面时手动开一笔充值 / 查余额，用真实收银台联调。
  if (url.pathname === "/v1/debug/topup" || url.pathname === "/v1/debug/wallet") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    if (!env.DB) return json({ ok: false, error: "db_unavailable" }, 503);
    const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
    if (!email) return json({ ok: false, error: "email_required" }, 400);
    const account = await env.DB.prepare("SELECT id, email FROM accounts WHERE email = ?")
      .bind(email)
      .first<{ id: string; email: string }>();
    if (!account) return json({ ok: false, error: "account_missing" }, 404);

    if (url.pathname === "/v1/debug/wallet") {
      return json({ ok: true, account_id: account.id, balance_cents: await balanceCents(env, account.id) });
    }
    const cents = Number(url.searchParams.get("cents"));
    if (!Number.isInteger(cents)) return json({ ok: false, error: "cents_required" }, 400);
    // 默认走真实 Dodo test 收银台；加 ?fake=1 直接入账，用于没有收银台时的快速联调。
    const mode = url.searchParams.get("fake") === "1" ? "fake" : "dodo";
    const started = await startTopupSession(env, { accountId: account.id, email: account.email, cents, mode });
    return json(started);
  }

  // 仅 dev：手动跑一次每日任务（续费/补建/对账），不必等 Cron。
  if (url.pathname === "/v1/debug/billing") {
    if (env.ENVIRONMENT !== "dev") return json({ ok: false, error: "not_found" }, 404);
    if (!env.DB) return json({ ok: false, error: "db_unavailable" }, 503);
    return json({ ok: true, report: await runBilling(env) });
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

/** 目录里展示的必须是售价：没配日价的套餐不出现，成本价对内不下发。 */
export function applySalePrices(data: CatalogData, env: Env): CatalogData {
  const plans = data.plans.flatMap((plan) => {
    const dailyCents = planDailyPriceCents(env, plan.id);
    if (dailyCents === null) return [];
    const monthly = monthlyUsdFromDaily(dailyCents);
    return [
      {
        ...plan,
        daily_price_cents: dailyCents,
        monthly_usd: monthly,
        // 时价不再是售价口径；保留字段给旧客户端，按售价折算，避免暴露成本。
        hourly_usd: Math.round((monthly / 730) * 10000) / 10000,
      },
    ];
  });
  return { ...data, plans };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const path = new URL(request.url).pathname;
    const logAccess = (status: number) => {
      // 每条请求一行结构化日志：排障时先看状态码与耗时，再进业务日志。
      const entry = {
        level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        kind: "request",
        method: request.method,
        path,
        status,
        ms: Date.now() - startedAt,
        env: env.ENVIRONMENT ?? "unknown",
      };
      if (status >= 500) console.error(JSON.stringify(entry));
      else console.log(JSON.stringify(entry));
    };
    // 任何未处理的异常都要回 JSON 信封：Host 只认信封，拿到 HTML 500 只能报“格式不正确”。
    return route(request, env, ctx)
      .then((response) => {
        logAccess(response.status);
        return response;
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.error(`[control-plane] unhandled ${request.method} ${path} ${detail}`);
        logAccess(500);
        return json(
          {
            code: "INTERNAL",
            message: "服务器服务内部错误",
            retryable: false,
            details: { reason: "internal" },
            request_id: "",
          },
        500,
      );
    });
  },
  /** 每天：续期扣费、补建「已付没机器」、对账、账本归档（login-and-payment.md §4.6）。 */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runBilling(env)
        .then((report) => {
          console.log(`[billing] done ${JSON.stringify(report)}`);
        })
        .catch((error: unknown) => {
          // 任何一处瞬时失败都不能让整轮静默消失：至少留一条可检索的日志。
          console.error(`[control-plane] billing_failed ${error instanceof Error ? error.message : String(error)}`);
        }),
    );
  },
};
