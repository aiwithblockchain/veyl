// 订单（§19.5）：下单、查询、结账、取消。金额只做展示快照，真钱由 Dodo 收。
// 所有写操作都要 Idempotency-Key：同 key 同请求体原样回放，同 key 不同体拒绝。

import { authenticate, isResponse, type MaybeAuthEnv } from "./auth";
import { randomId, sha256B64u } from "./lib/crypto";
import { apiError, json } from "./lib/http";
import { planHourlyUsd, planPriceUsd } from "./lib/config";
import { idempotencyKey, withIdempotency, type StoredResponse } from "./lib/idempotency";
import { fetchCatalogData, type CatalogData } from "./index";
import { provisionServer } from "./provision";
import { balanceCents, recordLedgerEntry } from "./wallet";

const ORDER_TTL_MS = 10 * 60 * 1000;
/** 一个计费周期：扣费后 paid_until 顺延这么久。 */
const PERIOD_MS = 30 * 24 * 3600 * 1000;
/** 扣费接口能回的状态；其它状态说明订单已经结束，不能再按「已付款」回放。 */
const CHARGE_STATES = ["paid", "provisioning", "ready"] as const;

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
  amount_cents: number;
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

/**
 * 扣费成功的统一回包：Host 按 `order_id + state` 决定轮询与界面状态。
 * 只回金额会让客户端解析失败，用户再点一次就会新建订单、再扣一次钱。
 */
async function chargeResult(
  db: D1Database,
  orderId: string,
  chargedCents: number,
  balanceAfterCents: number,
): Promise<StoredResponse> {
  const row = await db
    .prepare("SELECT state FROM orders WHERE id = ?")
    .bind(orderId)
    .first<{ state: string }>();
  const state = row?.state ?? "";
  if (!(CHARGE_STATES as readonly string[]).includes(state)) {
    return storedError(409, "PRECONDITION_FAILED", "这笔订单已经结束，请重新下单", {
      reason: "order_not_payable",
    });
  }
  return {
    status: 200,
    body: {
      order_id: orderId,
      state,
      charged_cents: chargedCents,
      balance_after_cents: balanceAfterCents,
    },
  };
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

  // 售价只认配置：没配就不卖，绝不拿 DigitalOcean 成本价兜底（那等于按成本价卖出去）。
  const salePrice = planPriceUsd(env, plan);
  if (salePrice === null) {
    return apiError("PRECONDITION_FAILED", "这个套餐暂时不可售", { reason: "invalid_plan" });
  }
  const saleHourly = planHourlyUsd(salePrice);

  const db = env.DB;
  const requestHash = await sha256B64u(JSON.stringify({ region, plan }));

  return withIdempotency(db, identity.accountId, "orders.create", key, requestHash, async () => {
    const now = Date.now();
    const orderId = randomId("ord_");
    await db
      .prepare(
        "INSERT INTO orders (id, account_id, region, plan, amount_usd, amount_cents, hourly_usd, state, idempotency_key, created_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?)",
      )
      .bind(
        orderId,
        identity.accountId,
        region,
        plan,
        salePrice,
        Math.round(salePrice * 100),
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
  const db = env.DB;

  return withIdempotency(
    db,
    identity.accountId,
    `orders.checkout:${orderId}`,
    key,
    await sha256B64u(JSON.stringify({ orderId })),
    async () => {
      const row = await loadOrder(db, identity.accountId, orderId);
      if (!row) return { status: 404, body: { code: "NOT_FOUND", message: "没有这个订单" } };

      // 已经扣过款：幂等返回当前余额，绝不重复扣。
      if (row.state !== "pending_payment") {
        return chargeResult(db, row.id, 0, await balanceCents(env, identity.accountId));
      }

      const now = Date.now();
      if (row.expires_at && row.expires_at < now) {
        await db.prepare("UPDATE orders SET state = 'cancelled' WHERE id = ?").bind(row.id).run();
        return storedError(409, "PRECONDITION_FAILED", "这笔订单已过期，请重新下单", { reason: "order_expired" });
      }

      // 下单时的金额快照要和当前售价一致：中途调价让用户重新确认，不按旧价扣。
      const price = planPriceUsd(env, row.plan);
      if (price === null || Math.round(price * 100) !== row.amount_cents) {
        return storedError(409, "PRECONDITION_FAILED", "价格已经变了，请重新下单", { reason: "price_mismatch" });
      }

      const available = await balanceCents(env, identity.accountId);
      if (available < row.amount_cents) {
        return storedError(
          409,
          "PRECONDITION_FAILED",
          "余额不足，先充值",
          {
            reason: "insufficient_balance",
            shortfall_cents: row.amount_cents - available,
          },
          true,
        );
      }

      const serverId = randomId("srv_");
      const port = await pickPort(db, identity.accountId);
      const charged = await recordLedgerEntry(env, {
        accountId: identity.accountId,
        kind: "charge",
        amountCents: -row.amount_cents,
        refType: "order",
        refId: row.id,
        followUps: (ledgerId) => [
          db
            .prepare(
              "UPDATE orders SET state = 'provisioning', paid_at = ?, server_id = ?, paid_via = 'wallet' " +
                "WHERE id = ? AND state = 'pending_payment' AND EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ?)",
            )
            .bind(now, serverId, row.id, ledgerId),
          db
            .prepare(
              "INSERT INTO servers (id, account_id, order_id, name, region, plan, hourly_usd, monthly_usd, state, node_port, created_at, updated_at, paid_until, billing_state, plan_price_cents) " +
                "SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, 'active', ? WHERE EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ?)",
            )
            .bind(
              serverId,
              identity.accountId,
              row.id,
              `我的服务器${serverId.slice(-4)}`,
              row.region,
              row.plan,
              row.hourly_usd,
              row.amount_usd,
              port,
              now,
              now,
              now + PERIOD_MS,
              row.amount_cents,
              ledgerId,
            ),
        ],
      });

      if (!charged.ok) {
        if (charged.reason === "duplicate") {
          return chargeResult(db, row.id, 0, await balanceCents(env, identity.accountId));
        }
        if (charged.reason === "insufficient") {
          const current = await balanceCents(env, identity.accountId);
          return storedError(
            409,
            "PRECONDITION_FAILED",
            "余额不足，先充值",
            {
              reason: "insufficient_balance",
              shortfall_cents: row.amount_cents - current,
            },
            true,
          );
        }
        return storedError(503, "INTERNAL", "记账暂时不可用，请稍后重试", { reason: "wallet_unavailable" }, true);
      }

      const provisioned = await provisionServer(
        {
          DB: db,
          DO_API_TOKEN: env.DO_API_TOKEN,
          ENROLL_BASE_URL: env.ENROLL_BASE_URL,
          ENVIRONMENT: env.ENVIRONMENT ?? "dev",
        },
        {
          id: serverId,
          account_id: identity.accountId,
          order_id: row.id,
          region: row.region,
          plan: row.plan,
          node_port: port,
        },
      );

      if (!provisioned.ok) {
        // 钱已经扣了：provision 的失败分支已把订单退回 paid，Cron 会继续补建。
        return storedError(502, "UPSTREAM_ERROR", "服务器还在创建，稍后自动重试", { reason: provisioned.reason }, true);
      }

      return chargeResult(db, row.id, row.amount_cents, charged.balanceAfterCents);
    },
  );
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
        "INSERT OR IGNORE INTO servers (id, account_id, order_id, name, region, plan, hourly_usd, monthly_usd, state, node_port, created_at, updated_at, paid_until, billing_state, plan_price_cents) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, 'active', ?)",
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
        now + PERIOD_MS,
        order.amount_cents,
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
