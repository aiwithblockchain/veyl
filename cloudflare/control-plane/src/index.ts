import { handleAuth } from "./auth";
import { handleEmailAuth } from "./auth_email";
import { monthlyUsdFromDaily, planDailyPriceCents } from "./lib/config";
import { runBilling } from "./billing";
import { handleOrders } from "./orders";
import { handleTopups } from "./topups";
import { handleServers } from "./servers";
import { handleMobile } from "./mobile";
import { handleIssues, siteBase } from "./issues";
import { handleRules } from "./rules";
import { handleSeed } from "./seed";
import { handleStripeWebhook } from "./webhooks/stripe";
import { retrieveCheckoutSession } from "./payments/stripe";

export interface Env {
  ENVIRONMENT: string;
  DO_API_TOKEN?: string;
  DB?: D1Database;
  TOKEN_SIGNING_JWK?: string;
  CREDENTIAL_ENC_KEY?: string;
  CREDENTIAL_KEY_ID?: string;
  /** 手机导出令牌的 AES-256-GCM 密钥（base64 32 字节），与 CREDENTIAL_ENC_KEY 分开。 */
  MOBILE_TOKEN_ENC_KEY?: string;
  ENROLL_BASE_URL?: string;
  /** 节点 agent：cloud-init 下载 / 校验用的构建信息。 */
  AGENT_VERSION?: string;
  AGENT_SHA256?: string;
  AGENT_DOWNLOAD_URL?: string;
  /** 期望状态下发给 agent 的 sing-box 版本与下载信息。 */
  SING_BOX_VERSION?: string;
  SING_BOX_SHA256?: string;
  SING_BOX_DOWNLOAD_URL?: string;
  /** 节点 MCP 一次性令牌的独立签名密钥与 key_id。 */
  AGENT_TOKEN_SIGNING_JWK?: string;
  AGENT_TOKEN_KEY_ID?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** 日价表（USD 分/天）：{"s-1vcpu-1gb":"30"}；唯一售价真源，月价由它派生。 */
  PLAN_DAILY_PRICE_CENTS?: string;
  /** 可充值面额（美分）的 JSON 数组；唯一真源。 */
  TOPUP_DENOMINATIONS_CENTS?: string;
  APP_PAYMENT_RETURN_URL?: string;
  /** 官网站点地址：问题墙帖子链接与允许的跨域来源。 */
  PUBLIC_SITE_URL?: string;
  /** 问题墙提交开关：normal | closed（close 只影响提交，公开读取不受影响）。 */
  ISSUE_SUBMIT_MODE?: string;
}

const SERVICE = "veyl-control-plane";const VERSION = "0.0.0";
export const USER_AGENT = "veyl-control-plane/0.0.0";
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
export const PLAN_SLUGS = ["s-1vcpu-512mb-10gb", "s-1vcpu-1gb", "s-1vcpu-2gb"];
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

export async function doGet(path: string, token: string): Promise<DoResult> {
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

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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

  // 支付回跳页：只做展示，不写库；入账以 webhook 为准。异步方式回跳时可能仍在处理中，
  // 所以查一次 Stripe session 再决定文案，不能仅凭 session_id 宣称完成。
  if (url.pathname === "/payment/return") {
    const canceled = url.searchParams.get("canceled") === "1";
    const sessionId = url.searchParams.get("session_id") ?? "";
    let state: "paid" | "processing" | "canceled" | "unknown";
    if (canceled) {
      // cancel_url 优先：两个参数同时出现也不能说成功。
      state = "canceled";
    } else if (!sessionId) {
      state = "unknown";
    } else {
      const session = await retrieveCheckoutSession(env, sessionId);
      if (!session.ok) {
        // 查不到就如实说查不到，不猜成功。
        state = "unknown";
      } else if (session.status === "complete" && session.paymentStatus === "paid") {
        state = "paid";
      } else if (session.status === "complete") {
        // 微信 / 支付宝等异步方式：授权完成但资金尚未结算。
        state = "processing";
      } else {
        state = "unknown";
      }
    }
    const copy = {
      paid: {
        title: "Payment complete",
        body: "Return to the Veyl app to view your service credits. You can close this page.",
      },
      processing: {
        title: "Payment processing",
        body: "WeChat Pay or Alipay can take a few minutes to settle. Your credits update automatically once it does; you can close this page.",
      },
      canceled: {
        title: "Payment not completed",
        body: "Return to the Veyl app to start the top-up again. You can close this page.",
      },
      unknown: {
        title: "Payment flow ended",
        body: "Return to the Veyl app to see the result. You can close this page.",
      },
    };
    const text = copy[state];
    const lang = "en";
    const check =
      state === "paid"
        ? `<div class="badge"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#1B7A4E" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`
        : state === "processing"
          ? `<div class="badge badge--pending"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="#9A6B12" stroke-width="1.8"/><path d="M12 8v4.5l3 1.8" stroke="#9A6B12" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`
          : "";
    const html = `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${text.title} · Veyl</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#FAFAF8;color:#14161C;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:420px;background:#FFFFFF;border:1px solid rgba(20,22,28,.10);border-radius:16px;padding:40px 32px 32px;text-align:center;box-shadow:0 1px 2px rgba(20,22,28,.04),0 12px 32px rgba(20,22,28,.06)}
.brand{margin:0 0 28px;font-size:15px;font-weight:600;letter-spacing:.06em;color:#14161C}
.badge{width:56px;height:56px;margin:0 auto 20px;border-radius:50%;background:rgba(27,122,78,.10);display:flex;align-items:center;justify-content:center}
.badge--pending{background:rgba(154,107,18,.10)}
h1{margin:0 0 10px;font-size:20px;font-weight:600;letter-spacing:-.01em}
p{margin:0;font-size:14px;line-height:1.7;color:#5B5850}
.footer{margin-top:28px;padding-top:20px;border-top:1px solid rgba(20,22,28,.10)}
a{font-size:13px;color:#5B5850;text-decoration:none}
a:hover{color:#14161C;text-decoration:underline}
</style>
</head><body><main><div class="card">
<p class="brand">Veyl</p>
${check}
<h1>${text.title}</h1>
<p>${text.body}</p>
<div class="footer"><a href="${siteBase(env)}">Learn about Veyl &rarr;</a></div>
</div></main></body></html>`;
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // 状态会从处理中变成完成，不能让浏览器缓存旧结果。
        "cache-control": "no-store",
      },
    });
  }

  // 国内分流规则集：公开只读，随 Worker 打包；sing-box profile 的 rule_set 从这里拉。
  const rulesResponse = handleRules(request);
  if (rulesResponse) return rulesResponse;

  // 免费节点种子：匿名只读，随 Worker 部署（seed-publishing.md §4）。
  const seedResponse = await handleSeed(request);
  if (seedResponse) return seedResponse;

  // 设备令牌：静默注册与刷新（§19.2）。目录之后实现，未配置 D1 时返回 503。
  const authResponse = await handleAuth(request, env);
  if (authResponse) return authResponse;

  // 邮箱登录：发码 / 校验 / 登出（login-and-payment.md §2）。
  const emailAuthResponse = await handleEmailAuth(request, env);
  if (emailAuthResponse) return emailAuthResponse;

  // Stripe 回调：公开端点，只认签名（stripe-migration.md §4）。
  const webhookResponse = await handleStripeWebhook(request, env, ctx);
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

  // 问题墙：用户上报（账户令牌）与公开读取（无鉴权）。
  const issueResponse = await handleIssues(request, env);
  if (issueResponse) return issueResponse;

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
