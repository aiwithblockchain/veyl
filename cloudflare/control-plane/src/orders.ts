// 订单（§19.5）：下单、查询、结账、取消。金额只做展示快照，真钱由 Dodo 收。
// 所有写操作都要 Idempotency-Key：同 key 同请求体原样回放，同 key 不同体拒绝。

import { authenticate, isResponse, type MaybeAuthEnv } from "./auth";
import { randomId, sha256B64u } from "./lib/crypto";
import { apiError, json } from "./lib/http";
import { paymentReturnUrl, planHourlyUsd, planPriceUsd } from "./lib/config";
import { createCheckoutSession } from "./payments/dodo";
import { fetchCatalogData, type CatalogData } from "./index";
import { provisionServer } from "./provision";

const ORDER_TTL_MS = 10 * 60 * 1000;
/** 收银台会话有效期：跳转、3DS 都要时间。 */
const CHECKOUT_TTL_MS = 30 * 60 * 1000;

export interface OrdersEnv extends MaybeAuthEnv {
  DO_API_TOKEN?: string;
  ENROLL_BASE_URL?: string;
  ENVIRONMENT?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  DODO_API_KEY?: string;
  DODO_WEBHOOK_SECRET?: string;
  PLAN_PRICES_USD?: string;
  DODO_PRODUCT_IDS?: string;
  APP_PAYMENT_RETURN_URL?: string;
}

interface OrderRow {
  id: string;
  account_id: string;
  region: string;
  plan: string;
  amount_usd: number;
  hourly_usd: number;
  state: string;
  idempotency_key: string;
  created_at: number;
  paid_at: number | null;
  expires_at: number | null;
  server_id: string | null;
  failure_code: string | null;
  failure_stage: string | null;
  checkout_session_id: string | null;
  checkout_url: string | null;
  paid_via: string | null;
}

interface ServerRow {
  id: string;
  account_id: string;
  order_id: string;
  region: string;
  plan: string;
  node_port: number;
}

interface StoredResponse {
  status: number;
  body: unknown;
}

/** 支付未完成时也带上链接，界面据此给「继续支付」。 */
function checkoutView(row: OrderRow) {
  return {
    order_id: row.id,
    state: row.state,
    checkout_url: row.checkout_url,
    session_id: row.checkout_session_id,
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  };
}

function orderView(row: OrderRow) {
  return {
    order_id: row.id,
    state: row.state,
    region: row.region,
    plan: row.plan,
    amount_usd: row.amount_usd,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    server_id: row.server_id,
    checkout_url: row.checkout_url ?? null,
    // 客户端要求 code / message / retryable 三个字段齐全才认这条失败（契约见 commands.md）。
    failure: row.failure_code
      ? {
          code: row.failure_code,
          message: "服务器没建成，这笔订单已结束，没有产生服务器",
          stage: row.failure_stage,
          retryable: false,
        }
      : null,
  };
}

function storedError(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  retryable = false,
): StoredResponse {
  return { status, body: { code, message, retryable, details, request_id: "" } };
}

function idempotencyKey(request: Request): string | null {
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  return key.length >= 8 && key.length <= 128 ? key : null;
}

/**
 * 幂等包装：占位 → 执行 → 写回放。并发重复请求拿到 409 in_flight，
 * 客户端 1 秒后重试（§19.5 幂等键语义）。
 */
async function withIdempotency(
  db: D1Database,
  accountId: string,
  endpoint: string,
  key: string,
  requestHash: string,
  run: () => Promise<StoredResponse>,
): Promise<Response> {
  const existing = await db.prepare(
    "SELECT request_hash, status, response FROM idempotency_keys WHERE account_id = ? AND endpoint = ? AND key = ?",
  )
    .bind(accountId, endpoint, key)
    .first<{ request_hash: string; status: number; response: string | null }>();

  if (existing) {
    if (existing.request_hash !== requestHash) {
      return apiError("PRECONDITION_FAILED", "同一个幂等键被用在了不同的请求上", {
        reason: "idempotency_conflict",
      });
    }
    if (existing.status === 0) {
      return apiError("PRECONDITION_FAILED", "这个请求正在处理中", {
        retryable: true,
        reason: "idempotency_in_flight",
      });
    }
    const stored = JSON.parse(existing.response ?? "{}") as StoredResponse;
    return json(stored.body, stored.status);
  }

  await db.prepare(
    "INSERT INTO idempotency_keys (account_id, endpoint, key, request_hash, status, created_at) VALUES (?, ?, ?, ?, 0, ?)",
  )
    .bind(accountId, endpoint, key, requestHash, Date.now())
    .run();

  try {
    const stored = await run();
    await db.prepare(
      "UPDATE idempotency_keys SET status = ?, response = ? WHERE account_id = ? AND endpoint = ? AND key = ?",
    )
      .bind(stored.status, JSON.stringify(stored), accountId, endpoint, key)
      .run();
    return json(stored.body, stored.status);
  } catch (error) {
    await db.prepare(
      "DELETE FROM idempotency_keys WHERE account_id = ? AND endpoint = ? AND key = ?",
    )
      .bind(accountId, endpoint, key)
      .run();
    throw error;
  }
}

async function loadOrder(db: D1Database, accountId: string, orderId: string) {
  return db.prepare("SELECT * FROM orders WHERE id = ? AND account_id = ?")
    .bind(orderId, accountId)
    .first<OrderRow>();
}

async function createOrder(request: Request, env: OrdersEnv): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const key = idempotencyKey(request);
  if (!key) return apiError("PRECONDITION_FAILED", "缺少 Idempotency-Key");

  let body: { region?: unknown; plan?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("PRECONDITION_FAILED", "请求体不是合法 JSON");
  }
  const region = typeof body.region === "string" ? body.region.trim() : "";
  const plan = typeof body.plan === "string" ? body.plan.trim() : "";
  if (!region || !plan) return apiError("PRECONDITION_FAILED", "缺少地区或套餐");

  const catalog: CatalogData | null = env.DO_API_TOKEN
    ? await fetchCatalogData(env.DO_API_TOKEN)
    : null;
  if (!catalog) {
    return apiError("UPSTREAM_ERROR", "暂时读不到可售目录", {
      retryable: true,
      reason: "catalog_unavailable",
    });
  }
  if (!catalog.regions.some((r) => r.id === region)) {
    return apiError("PRECONDITION_FAILED", "这个地区不可售", { reason: "invalid_region" });
  }
  const chosen = catalog.plans.find((p) => p.id === plan);
  if (!chosen) {
    return apiError("PRECONDITION_FAILED", "这个套餐不可售", { reason: "invalid_plan" });
  }

  // 生产环境必须登录后下单；开发环境保留匿名建机，方便没有登录界面时继续测链路。
  if (env.ENVIRONMENT === "production" && identity.kind !== "email") {
    return apiError("UNAUTHENTICATED", "登录后才能创建服务器", {
      retryable: true,
      reason: "auth_required",
    });
  }

  // 订单金额是售价快照。没配售价时退回目录价（只有开发环境会缺配置）。
  const salePrice = planPriceUsd(env, plan) ?? chosen.monthly_usd;
  const saleHourly = planPriceUsd(env, plan) !== null ? planHourlyUsd(salePrice) : chosen.hourly_usd;

  const db = env.DB;
  const requestHash = await sha256B64u(JSON.stringify({ region, plan }));

  return withIdempotency(db, identity.accountId, "orders.create", key, requestHash, async () => {
    const now = Date.now();
    const orderId = randomId("ord_");
    await db
      .prepare(
        "INSERT INTO orders (id, account_id, region, plan, amount_usd, hourly_usd, state, idempotency_key, created_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?)",
      )
      .bind(
        orderId,
        identity.accountId,
        region,
        plan,
        salePrice,
        saleHourly,
        key,
        now,
        now + ORDER_TTL_MS,
      )
      .run();
    await db
      .prepare("INSERT INTO audit_log (at, account_id, action, detail) VALUES (?, ?, 'order.create', ?)")
      .bind(now, identity.accountId, JSON.stringify({ region, plan }))
      .run();

    const row = await loadOrder(db, identity.accountId, orderId);
    return { status: 200, body: orderView(row as OrderRow) };
  });
}

async function getOrder(request: Request, env: OrdersEnv, orderId: string): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const row = await loadOrder(env.DB, identity.accountId, orderId);
  if (!row) return apiError("NOT_FOUND", "没有这个订单");
  return json(orderView(row));
}

async function checkout(request: Request, env: OrdersEnv, orderId: string): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const key = idempotencyKey(request);
  if (!key) return apiError("PRECONDITION_FAILED", "缺少 Idempotency-Key");

  let channel = "dodo";
  try {
    const body = (await request.json()) as { channel?: unknown };
    if (typeof body?.channel === "string" && body.channel.trim()) channel = body.channel.trim();
  } catch {
    // 没有请求体就按默认渠道走。
  }

  const db = env.DB;
  return withIdempotency(
    db,
    identity.accountId,
    `orders.checkout:${orderId}`,
    key,
    await sha256B64u(JSON.stringify({ orderId, channel })),
    async () => {
      const row = await loadOrder(db, identity.accountId, orderId);
      if (!row) return { status: 404, body: { code: "NOT_FOUND", message: "没有这个订单" } };
      if (channel === "fake") return checkoutFake(env, row);
      return checkoutDodo(env, identity.accountId, row);
    },
  );
}

/** 假支付：直接 paid + 建机。只在非生产可用，是本地开发与 E2E 的唯一后门。 */
async function checkoutFake(env: OrdersEnv, row: OrderRow): Promise<StoredResponse> {
  if (env.ENVIRONMENT === "production") {
    return storedError(409, "PRECONDITION_FAILED", "这个支付方式不可用", { reason: "channel_not_allowed" });
  }
  const db = env.DB!;
  if (row.state !== "pending_payment") {
    const current = await loadOrder(db, row.account_id, row.id);
    return { status: 200, body: checkoutView(current as OrderRow) };
  }
  if (row.expires_at && row.expires_at < Date.now()) {
    await db.prepare("UPDATE orders SET state = 'cancelled' WHERE id = ?").bind(row.id).run();
    return storedError(409, "PRECONDITION_FAILED", "这笔订单已过期，请重新下单", { reason: "order_expired" });
  }

  const now = Date.now();
  const serverId = randomId("srv_");
  const port = await pickPort(db, row.account_id);
  // 认领订单必须带状态守卫：双击、重放、两个窗口同时结账时只有一个能把
  // pending_payment 推进到 provisioning，否则同一订单会建出两台机器。
  const claim = await db
    .prepare(
      "UPDATE orders SET state = 'provisioning', paid_at = ?, server_id = ?, paid_via = 'fake' " +
        "WHERE id = ? AND state = 'pending_payment'",
    )
    .bind(now, serverId, row.id)
    .run();
  const claimed = (claim as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (claimed === 0) {
    const current = await loadOrder(db, row.account_id, row.id);
    return { status: 200, body: checkoutView(current as OrderRow) };
  }

  await db.batch([
    db
      .prepare(
        "INSERT INTO servers (id, account_id, order_id, name, region, plan, hourly_usd, monthly_usd, state, node_port, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)",
      )
      .bind(
        serverId,
        row.account_id,
        row.id,
        `我的服务器${serverId.slice(-4)}`,
        row.region,
        row.plan,
        row.hourly_usd,
        row.amount_usd,
        port,
        now,
        now,
      ),
    db
      .prepare("INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'checkout.fake_paid', ?)")
      .bind(now, row.account_id, serverId, JSON.stringify({ order_id: row.id })),
  ]);

  const provisioned = await provisionServer(
    {
      DB: db,
      DO_API_TOKEN: env.DO_API_TOKEN,
      ENROLL_BASE_URL: env.ENROLL_BASE_URL,
      ENVIRONMENT: env.ENVIRONMENT ?? "dev",
    },
    {
      id: serverId,
      account_id: row.account_id,
      order_id: row.id,
      region: row.region,
      plan: row.plan,
      node_port: port,
    },
  );

  if (!provisioned.ok) {
    return storedError(
      502,
      "UPSTREAM_ERROR",
      "服务器没建成，这笔订单已结束，没有产生服务器",
      { reason: provisioned.reason },
      true,
    );
  }

  const updated = await loadOrder(db, row.account_id, row.id);
  return { status: 200, body: checkoutView(updated as OrderRow) };
}

/** 真支付：只创建收银台会话，建机等 webhook 确认收款后再做。 */
async function checkoutDodo(
  env: OrdersEnv,
  accountId: string,
  row: OrderRow,
): Promise<StoredResponse> {
  const db = env.DB!;

  if (row.state === "cancelled") {
    return storedError(409, "PRECONDITION_FAILED", "这笔订单已取消，重新下单", { reason: "order_cancelled" });
  }
  const paidStates = ["paid", "provisioning", "ready", "failed"];
  if (paidStates.includes(row.state) || (row.state === "awaiting_payment" && row.checkout_url)) {
    return { status: 200, body: checkoutView(row) };
  }

  // 售价必须与产品价一致：显示一个价、收另一个价，两边都是错。
  const price = planPriceUsd(env, row.plan);
  if (price === null || Math.round(price * 100) !== Math.round(row.amount_usd * 100)) {
    return storedError(409, "PRECONDITION_FAILED", "价格配置不一致，暂时不能下单", {
      reason: "price_mismatch",
    });
  }

  const returnUrl = paymentReturnUrl(env);
  if (!returnUrl) {
    return storedError(502, "UPSTREAM_ERROR", "支付暂时不可用", { reason: "checkout_unavailable" }, true);
  }

  const account = await db
    .prepare("SELECT email FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ email: string | null }>();
  if (!account?.email) {
    return storedError(401, "UNAUTHENTICATED", "登录后才能支付", { reason: "auth_required" }, true);
  }

  const session = await createCheckoutSession(env, {
    orderId: row.id,
    email: account.email,
    plan: row.plan,
    returnUrl,
  });
  if (!session.ok) {
    return storedError(502, "UPSTREAM_ERROR", "支付暂时不可用", { reason: "checkout_unavailable" }, true);
  }

  const now = Date.now();
  await db
    .prepare(
      "UPDATE orders SET state = 'awaiting_payment', checkout_session_id = ?, checkout_url = ?, " +
        "paid_via = 'dodo', expires_at = ? WHERE id = ? AND state IN ('pending_payment', 'payment_failed', 'expired')",
    )
    .bind(session.sessionId, session.checkoutUrl, now + CHECKOUT_TTL_MS, row.id)
    .run();

  const updated = await loadOrder(db, accountId, row.id);
  return { status: 200, body: checkoutView(updated as OrderRow) };
}

/** 端口由控制面选定（§19.6.1）：防火墙必须在建机后立刻带端口创建。 */
async function pickPort(db: D1Database, accountId: string): Promise<number> {
  const used = await db
    .prepare("SELECT node_port FROM servers WHERE account_id = ? AND destroyed_at IS NULL")
    .bind(accountId)
    .all<{ node_port: number }>();
  const taken = new Set((used.results ?? []).map((row) => row.node_port));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = 10000 + Math.floor(Math.random() * 50000);
    if (taken.has(candidate)) continue;
    return candidate;
  }
  return 10000 + Math.floor(Math.random() * 50000);
}

/**
 * 订单已收款：确保恰好一台服务器，然后建机（webhook 与 Cron 共用）。
 *
 * `servers(order_id)` 有唯一索引，并发插入只会留下一台；建机本身不在这里等，
 * webhook 用 `waitUntil` 交给运行时，Cron 默认等它跑完。
 */
export async function provisionPaidOrder(
  env: OrdersEnv,
  orderId: string,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<{ ok: boolean; serverId?: string; reason?: string }> {
  const db = env.DB;
  if (!db) return { ok: false, reason: "db_unavailable" };
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<OrderRow>();
  if (!order) return { ok: false, reason: "order_missing" };

  let server = await db
    .prepare("SELECT id, account_id, order_id, region, plan, node_port FROM servers WHERE order_id = ?")
    .bind(order.id)
    .first<ServerRow>();

  if (!server) {
    const now = Date.now();
    const serverId = randomId("srv_");
    const port = await pickPort(db, order.account_id);
    await db
      .prepare(
        "INSERT OR IGNORE INTO servers (id, account_id, order_id, name, region, plan, hourly_usd, monthly_usd, state, node_port, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)",
      )
      .bind(
        serverId,
        order.account_id,
        order.id,
        `我的服务器${serverId.slice(-4)}`,
        order.region,
        order.plan,
        order.hourly_usd,
        order.amount_usd,
        port,
        now,
        now,
      )
      .run();
    server = await db
      .prepare("SELECT id, account_id, order_id, region, plan, node_port FROM servers WHERE order_id = ?")
      .bind(order.id)
      .first<ServerRow>();
    if (!server) return { ok: false, reason: "server_row_failed" };
  }

  await db.prepare("UPDATE orders SET server_id = ? WHERE id = ? AND server_id IS NULL").bind(server.id, order.id).run();
  await db.prepare("UPDATE orders SET state = 'provisioning' WHERE id = ? AND state = 'paid'").bind(order.id).run();

  const job = provisionServer(
    {
      DB: db,
      DO_API_TOKEN: env.DO_API_TOKEN,
      ENROLL_BASE_URL: env.ENROLL_BASE_URL,
      ENVIRONMENT: env.ENVIRONMENT ?? "dev",
    },
    {
      id: server.id,
      account_id: order.account_id,
      order_id: order.id,
      region: order.region,
      plan: order.plan,
      node_port: server.node_port,
    },
  ).then((result) => result);

  if (waitUntil) {
    waitUntil(job);
    return { ok: true, serverId: server.id };
  }
  const result = await job;
  return { ok: result.ok, serverId: server.id, reason: result.ok ? undefined : result.reason };
}

/** Cron 兜底：收了钱却一直没建机的订单（webhook 明确成功但 waitUntil 被打断等）。 */
export async function reconcilePaidOrders(env: OrdersEnv): Promise<number> {
  const db = env.DB;
  if (!db) return 0;
  const cutoff = Date.now() - 5 * 60 * 1000;
  const rows = await db
    .prepare("SELECT id FROM orders WHERE state = 'paid' AND created_at < ? LIMIT 5")
    .bind(cutoff)
    .all<{ id: string }>();
  let count = 0;
  for (const row of rows.results ?? []) {
    const result = await provisionPaidOrder(env, row.id);
    if (result.ok) count += 1;
  }
  return count;
}

async function cancelOrder(request: Request, env: OrdersEnv, orderId: string): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const key = idempotencyKey(request);
  if (!key) return apiError("PRECONDITION_FAILED", "缺少 Idempotency-Key");
  const db = env.DB;

  return withIdempotency(
    db,
    identity.accountId,
    `orders.cancel:${orderId}`,
    key,
    await sha256B64u(JSON.stringify({ orderId })),
    async () => {
      const row = await loadOrder(db, identity.accountId, orderId);
      if (!row) return { status: 404, body: { code: "NOT_FOUND", message: "没有这个订单" } };
      if (row.state === "cancelled") return { status: 200, body: orderView(row) };
      const cancellable = ["pending_payment", "awaiting_payment", "payment_failed", "expired"];
      if (!cancellable.includes(row.state)) {
        // 已支付订单要先销毁实例；销毁链路接入前明确拒绝，不做假动作。
        return storedError(409, "PRECONDITION_FAILED", "已经开始创建，请到服务器详情里销毁", {
          reason: "cancel_after_paid",
        });
      }
      await db.prepare("UPDATE orders SET state = 'cancelled' WHERE id = ?").bind(row.id).run();
      const updated = await loadOrder(db, identity.accountId, orderId);
      return { status: 200, body: orderView(updated as OrderRow) };
    },
  );
}

export async function handleOrders(request: Request, env: OrdersEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // v1, orders, {id}, action
  if (parts[0] !== "v1" || parts[1] !== "orders") return null;

  if (parts.length === 2) {
    if (request.method === "POST") return createOrder(request, env);
    return apiError("PRECONDITION_FAILED", "方法不允许", { status: 405 });
  }
  if (parts.length === 3) {
    if (request.method === "GET") return getOrder(request, env, parts[2]);
    return apiError("PRECONDITION_FAILED", "方法不允许", { status: 405 });
  }
  if (parts.length === 4 && request.method === "POST") {
    if (parts[3] === "checkout") return checkout(request, env, parts[2]);
    if (parts[3] === "cancel") return cancelOrder(request, env, parts[2]);
  }
  return null;
}
