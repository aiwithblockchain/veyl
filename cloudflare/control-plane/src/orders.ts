// 订单（§19.5）：下单、查询、假支付、取消。金额只做展示快照，不扣款。
// 所有写操作都要 Idempotency-Key：同 key 同请求体原样回放，同 key 不同体拒绝。

import { authenticate, isResponse, type MaybeAuthEnv } from "./auth";
import { randomId, sha256B64u } from "./lib/crypto";
import { apiError, json } from "./lib/http";
import { fetchCatalogData, type CatalogData } from "./index";
import { provisionServer } from "./provision";

const ORDER_TTL_MS = 10 * 60 * 1000;

export interface OrdersEnv extends MaybeAuthEnv {
  DO_API_TOKEN?: string;
  ENROLL_BASE_URL?: string;
  ENVIRONMENT?: string;
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
}

interface StoredResponse {
  status: number;
  body: unknown;
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
    failure: row.failure_code
      ? { code: row.failure_code, stage: row.failure_stage, retryable: false }
      : null,
  };
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
        chosen.monthly_usd,
        chosen.hourly_usd,
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
      if (row.state !== "pending_payment") {
        return { status: 200, body: orderView(row) };
      }
      if (row.expires_at && row.expires_at < Date.now()) {
        await db.prepare("UPDATE orders SET state = 'cancelled' WHERE id = ?").bind(row.id).run();
        return {
          status: 409,
          body: {
            code: "PRECONDITION_FAILED",
            message: "这笔订单已过期，请重新下单",
            retryable: false,
            details: { reason: "order_expired" },
          },
        };
      }

      const now = Date.now();
      const serverId = randomId("srv_");
      const port = await pickPort(db, identity.accountId);
      await db.batch([
        db
          .prepare("UPDATE orders SET state = 'provisioning', paid_at = ?, server_id = ? WHERE id = ?")
          .bind(now, serverId, row.id),
        db
          .prepare(
            "INSERT INTO servers (id, account_id, order_id, name, region, plan, hourly_usd, monthly_usd, state, node_port, created_at, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)",
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
          ),
        db
          .prepare("INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'checkout.fake_paid', ?)")
          .bind(now, identity.accountId, serverId, JSON.stringify({ order_id: row.id })),
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
          account_id: identity.accountId,
          order_id: row.id,
          region: row.region,
          plan: row.plan,
          node_port: port,
        },
      );

      if (!provisioned.ok) {
        return {
          status: 502,
          body: {
            code: "UPSTREAM_ERROR",
            message: "服务器没建成，这笔订单已结束，没有产生服务器",
            retryable: true,
            details: { reason: provisioned.reason },
            request_id: "",
          },
        };
      }

      const updated = await loadOrder(db, identity.accountId, orderId);
      return { status: 200, body: orderView(updated as OrderRow) };
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
      if (row.state !== "pending_payment") {
        // 已支付订单要先销毁实例；销毁链路接入前明确拒绝，不做假动作。
        return {
          status: 409,
          body: {
            code: "PRECONDITION_FAILED",
            message: "已经开始创建，请到服务器详情里销毁",
            retryable: false,
            details: { reason: "cancel_after_paid" },
          },
        };
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
