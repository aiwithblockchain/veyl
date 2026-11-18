// 订单（§19.5）：下单、查询、结账、取消。金额只做展示快照，真钱由 Dodo 收。
// 所有写操作都要 Idempotency-Key：同 key 同请求体原样回放，同 key 不同体拒绝。

import { authenticate, isResponse, type MaybeAuthEnv } from "./auth";
import { randomId, sha256B64u } from "./lib/crypto";
import { apiError, json } from "./lib/http";
import { monthlyUsdFromDaily, planDailyPriceCents } from "./lib/config";
import { idempotencyKey, withIdempotency, type StoredResponse } from "./lib/idempotency";
import { fetchCatalogData, type CatalogData } from "./index";
import { provisionServer } from "./provision";
import { balanceCents } from "./wallet";

const ORDER_TTL_MS = 10 * 60 * 1000;
/** 一天的毫秒数：按天计费的基本单位。 */
const DAY_MS = 24 * 3600 * 1000;
/** 建机门槛：余额至少覆盖 7 天日价（§4.13）；只是预检，结算只卡 1 天。 */
const MIN_BALANCE_DAYS = 7;
/** 端口唯一冲突时的重试次数：并发建机撞到已占用的端口后立刻换一个。 */
const PORT_ATTEMPTS = 3;

/** 建机时把目录里的每月出口额度快照进 `servers` 行（GiB，0 = 未知）。 */
function transferGibFor(catalog: CatalogData | null, planId: string): number {
  const plan = catalog?.plans.find((candidate) => candidate.id === planId);
  return plan && Number.isInteger(plan.transfer_gib) && plan.transfer_gib > 0
    ? plan.transfer_gib
    : 0;
}

export interface OrdersEnv extends MaybeAuthEnv {
  DO_API_TOKEN?: string;
  ENROLL_BASE_URL?: string;
  ENVIRONMENT?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  DODO_API_KEY?: string;
  DODO_WEBHOOK_SECRET?: string;
  PLAN_DAILY_PRICE_CENTS?: string;
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
  charge_mode: string | null;
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
    // 扣费口径（2.39.0）：存量订单列缺省按 upfront，新单是 at_ready。
    charge_mode: row.charge_mode ?? "upfront",
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
  // 地区 × 档位只看目录：DO 的 `/sizes` 按地区给可用性，不能假设到处都能开。
  if (!chosen.regions.includes(region)) {
    return apiError("PRECONDITION_FAILED", "这个地区没有这个规格", {
      reason: "plan_unavailable_in_region",
      details: { region, plan },
    });
  }

  // 生产环境必须登录后下单；开发环境保留匿名建机，方便没有登录界面时继续测链路。
  if (env.ENVIRONMENT === "production" && identity.kind !== "email") {
    return apiError("UNAUTHENTICATED", "登录后才能创建服务器", {
      retryable: true,
      reason: "auth_required",
    });
  }

  // 日价只认配置：没配就不卖，绝不拿 DigitalOcean 成本价兜底（那等于按成本价卖出去）。
  const dailyCents = planDailyPriceCents(env, plan);
  if (dailyCents === null) {
    return apiError("PRECONDITION_FAILED", "这个套餐暂时不可售", { reason: "invalid_plan" });
  }
  const salePrice = dailyCents / 100;
  // 时价只作为内部成本口径留档，不参与售价。
  const costHourly = chosen.hourly_usd;

  const db = env.DB;
  const requestHash = await sha256B64u(JSON.stringify({ region, plan }));

  return withIdempotency(db, identity.accountId, "orders.create", key, requestHash, async () => {
    const now = Date.now();
    const orderId = randomId("ord_");
    await db
      .prepare(
        "INSERT INTO orders (id, account_id, region, plan, amount_usd, amount_cents, hourly_usd, state, idempotency_key, charge_mode, created_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, 'at_ready', ?, ?)",
      )
      .bind(
        orderId,
        identity.accountId,
        region,
        plan,
        salePrice,
        dailyCents,
        costHourly,
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

interface ConfirmOrderInput {
  accountId: string;
  orderId: string;
  serverId: string;
  port: number;
  region: string;
  plan: string;
  amountCents: number;
  hourlyUsd: number;
  transferGib: number;
  now: number;
}

/**
 * 确认下单：认领订单（pending_payment → provisioning）并建服务器行，**不扣费**。
 * 第 0 天在 enroll 确认就绪后由 `settleOrder` 结算；结算前不写计费三列：
 * `daily_price_cents = 0`、`billing_anchor_at = 0`、`paid_until = NULL`、`billing_state = 'pending'`。
 *
 * 两条语句在同一个 D1 batch：并发结账只有一个能认领；另一条 INSERT 带
 * `server_id = 本请求` 的条件，不会建出第二台服务器。
 * 端口唯一冲突会抛错并让整批回滚，调用方换端口重试。
 */
async function confirmOrder(
  env: OrdersEnv,
  input: ConfirmOrderInput,
): Promise<"claimed" | "already_confirmed" | "not_payable"> {
  const db = env.DB!;
  const results = await db.batch([
    db.prepare(
      "UPDATE orders SET state = 'provisioning', server_id = ? " +
        "WHERE id = ? AND account_id = ? AND state = 'pending_payment'",
    ).bind(input.serverId, input.orderId, input.accountId),
    db.prepare(
      "INSERT INTO servers (id, account_id, order_id, name, region, plan, hourly_usd, monthly_usd, state, node_port, created_at, updated_at, paid_until, billing_state, daily_price_cents, billing_anchor_at, transfer_gib) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, NULL, 'pending', 0, 0, ? " +
        "WHERE EXISTS (SELECT 1 FROM orders WHERE id = ? AND state = 'provisioning' AND server_id = ?)",
    ).bind(
      input.serverId,
      input.accountId,
      input.orderId,
      `我的服务器${input.serverId.slice(-4)}`,
      input.region,
      input.plan,
      input.hourlyUsd,
      monthlyUsdFromDaily(input.amountCents),
      input.port,
      input.now,
      input.now,
      input.transferGib,
      input.orderId,
      input.serverId,
    ),
  ]);
  const claimed = Number(
    (results[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0,
  );
  if (claimed === 1) return "claimed";

  // 没认领到：并发请求已经把它推进到 provisioning/ready，按已确认回放——
  // 不能再建一次机（否则会在 DO 上多一台没人认领的实例）。
  const existing = await db
    .prepare("SELECT state FROM orders WHERE id = ? AND account_id = ?")
    .bind(input.orderId, input.accountId)
    .first<{ state: string }>();
  if (existing?.state === "provisioning" || existing?.state === "ready") {
    return "already_confirmed";
  }
  return "not_payable";
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

      // 已确认下单：幂等回放订单；只有 pending_payment 才继续建机。
      if (row.state !== "pending_payment") {
        if (row.state === "provisioning" || row.state === "ready") {
          return { status: 200, body: orderView(row) };
        }
        return storedError(409, "PRECONDITION_FAILED", "这笔订单已经结束，请重新下单", {
          reason: "order_not_payable",
        });
      }

      const now = Date.now();
      if (row.expires_at && row.expires_at < now) {
        await db.prepare("UPDATE orders SET state = 'cancelled' WHERE id = ?").bind(row.id).run();
        return storedError(409, "PRECONDITION_FAILED", "这笔订单已过期，请重新下单", { reason: "order_expired" });
      }

      // 下单时的金额快照要和当前日价一致：中途调价让用户重新确认，不按旧价扣。
      const price = planDailyPriceCents(env, row.plan);
      if (price === null || price !== row.amount_cents) {
        return storedError(409, "PRECONDITION_FAILED", "价格已经变了，请重新下单", { reason: "price_mismatch" });
      }

      // 地区 × 档位在扣费前校验：目录读不到就不扣，宁可让用户稍后重试，也不先扣后退。
      const catalog = env.DO_API_TOKEN ? await fetchCatalogData(env.DO_API_TOKEN) : null;
      if (!catalog) {
        return storedError(503, "UPSTREAM_ERROR", "暂时读不到可售目录，稍后重试", {
          reason: "catalog_unavailable",
        }, true);
      }
      const chosen = catalog.plans.find((p) => p.id === row.plan);
      if (!chosen) {
        return storedError(409, "PRECONDITION_FAILED", "这个套餐不可售", { reason: "invalid_plan" });
      }
      if (!chosen.regions.includes(row.region)) {
        return storedError(409, "PRECONDITION_FAILED", "这个地区没有这个规格", {
          reason: "plan_unavailable_in_region",
          region: row.region,
          plan: row.plan,
        });
      }

      const available = await balanceCents(env, identity.accountId);
      const required = row.amount_cents * MIN_BALANCE_DAYS;
      if (available < required) {
        return storedError(
          409,
          "PRECONDITION_FAILED",
          "余额不足，先充值",
          {
            reason: "insufficient_balance",
            required_cents: required,
            shortfall_cents: required - available,
            min_days: MIN_BALANCE_DAYS,
          },
          true,
        );
      }

      const serverId = randomId("srv_");
      // 额度是套餐属性、不参与扣费；目录已在确认前取过，这里直接用同一次结果。
      const transferGib = transferGibFor(catalog, row.plan);
      let port = 0;
      let confirmed: "claimed" | "already_confirmed" | "not_payable" | null = null;
      for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
        port = await pickPort(db, identity.accountId);
        try {
          confirmed = await confirmOrder(env, {
            accountId: identity.accountId,
            orderId: row.id,
            serverId,
            port,
            region: row.region,
            plan: row.plan,
            amountCents: row.amount_cents,
            hourlyUsd: row.hourly_usd,
            transferGib,
            now,
          });
          break;
        } catch (error) {
          // 端口唯一冲突：整批已回滚（订单与服务器行都没写），换个端口重试即可。
          if (!isPortConflict(error)) throw error;
        }
      }
      if (!confirmed) {
        // 连续几次都撞端口：订单仍停在 pending_payment，用户可以原样重试。
        return storedError(
          503,
          "UPSTREAM_ERROR",
          "端口分配冲突，请重试",
          { reason: "port_conflict" },
          true,
        );
      }
      if (confirmed === "not_payable") {
        return storedError(409, "PRECONDITION_FAILED", "这笔订单已经结束，请重新下单", {
          reason: "order_not_payable",
        });
      }

      const confirmedRow = (await loadOrder(db, identity.accountId, row.id)) ?? row;
      if (confirmed === "already_confirmed") {
        // 另一个并发请求已经认领并开始建机：只回订单状态，不能再建一台。
        console.log(`[checkout] order=${row.id} state=${confirmedRow.state} charged=0 replayed=1`);
        return { status: 200, body: orderView(confirmedRow) };
      }

      const provisioned = await provisionServer(
        {
          DB: db,
          DO_API_TOKEN: env.DO_API_TOKEN,
          ENROLL_BASE_URL: env.ENROLL_BASE_URL,
          ENVIRONMENT: env.ENVIRONMENT ?? "dev",
        },
        {
          id: confirmedRow.server_id ?? serverId,
          account_id: identity.accountId,
          order_id: row.id,
          region: row.region,
          plan: row.plan,
          node_port: port,
        },
      );

      if (!provisioned.ok) {
        // 非可重试（4xx）：provision 已把订单置 failed；at_ready 没有扣过费，不会退款。
        if (!provisioned.retryable) {
          return storedError(
            502,
            "UPSTREAM_ERROR",
            provisioned.refunded ? "服务器创建失败，本次扣费已退回" : "服务器创建失败",
            { reason: provisioned.reason },
            false,
          );
        }
        // 存量 upfront 订单仍会退回 paid 等 Cron 补建；at_ready 在 provision 里按永久失败处理。
        return storedError(502, "UPSTREAM_ERROR", "服务器还在创建，稍后自动重试", { reason: provisioned.reason }, true);
      }

      // 就绪后扣款：checkout 不返回扣费金额；charged_cents 看服务器详情。
      console.log(`[checkout] order=${row.id} state=provisioning charged=0`);
      return { status: 200, body: orderView(confirmedRow) };
    },
  );
}

/** D1/SQLite 唯一约束错误的文本（部分索引会报列名）：只认端口这一条。 */
function isPortConflict(error: unknown): boolean {
  const text = String((error as Error)?.message ?? error).toLowerCase();
  return text.includes("unique constraint failed") && text.includes("node_port");
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
  // 补建只服务存量「先扣后退」订单；at_ready 由 enroll 结算与 Cron 结算兜底负责。
  // 旧订单没有该列（迁移默认 upfront），按 upfront 处理。
  if ((order.charge_mode ?? "upfront") !== "upfront") {
    return { ok: false, reason: "charge_mode_not_upfront" };
  }

  let server = await db
    .prepare("SELECT id, account_id, order_id, region, plan, node_port FROM servers WHERE order_id = ?")
    .bind(order.id)
    .first<ServerRow>();

  if (!server) {
    const now = Date.now();
    // 补建的锚点必须取「已扣过的那一天」，不能取 now：否则日桶整体漂移，用户白拿一天。
    const anchor = Number(order.paid_at ?? order.created_at);
    // 机器没建出来的空档不补扣：paid_until 直接对齐到锚点网格上的今天，
    // 只保留已经扣过的第 0 天，空档写审计豁免。
    const nNow = Math.floor((now - anchor) / DAY_MS);
    const paidUntil = Math.max(anchor + DAY_MS, anchor + (nNow + 1) * DAY_MS);
    const serverId = randomId("srv_");
    const catalog = env.DO_API_TOKEN ? await fetchCatalogData(env.DO_API_TOKEN) : null;
    const transferGib = transferGibFor(catalog, order.plan);
    // INSERT OR IGNORE 撞到「同账户端口已被活着的机器占用」时会静默跳过；
    // 换一个端口重试，别把可以补建的单报成 server_row_failed。
    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
      const port = await pickPort(db, order.account_id);
      await db
        .prepare(
          "INSERT OR IGNORE INTO servers (id, account_id, order_id, name, region, plan, hourly_usd, monthly_usd, state, node_port, created_at, updated_at, paid_until, billing_state, daily_price_cents, billing_anchor_at, transfer_gib) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, 'active', ?, ?, ?)",
        )
        .bind(
          serverId,
          order.account_id,
          order.id,
          `我的服务器${serverId.slice(-4)}`,
          order.region,
          order.plan,
          order.hourly_usd,
          monthlyUsdFromDaily(order.amount_cents),
          port,
          now,
          now,
          paidUntil,
          order.amount_cents,
          anchor,
          transferGib,
        )
        .run();
      server = await db
        .prepare("SELECT id, account_id, order_id, region, plan, node_port FROM servers WHERE order_id = ?")
        .bind(order.id)
        .first<ServerRow>();
      if (server) break;
    }
    if (!server) return { ok: false, reason: "server_row_failed" };
    if (paidUntil > anchor + DAY_MS) {
      await db
        .prepare("INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'billing.gap_waived', ?)")
        .bind(now, order.account_id, serverId, JSON.stringify({ days: nNow }))
        .run();
    }
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
