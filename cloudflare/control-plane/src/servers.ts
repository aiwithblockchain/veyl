// 服务器：enrollment 回传、列表、详情、销毁、凭据下发（§19.5 / §19.7 / §19.8）。
// 控制面是唯一事实源；客户端拿到的凭据必须能被内置公钥验签。

import { authenticate, isResponse, type MaybeAuthEnv } from "./auth";
import { randomId, sealSecret, sha256B64u, signDetached, openSecret } from "./lib/crypto";
import { apiError, json } from "./lib/http";
import { createFirewall, deleteDroplet, getDroplet } from "./providers/digitalocean";

// 每个环境用自己的签名密钥：dev 与 prod 的公钥都内置在客户端，靠 key_id 区分。
const DEFAULT_CREDENTIAL_KEY_ID = "cp-2026-11";
const CREDENTIAL_TTL_MS = 5 * 60 * 1000;

export interface ServersEnv extends MaybeAuthEnv {
  DO_API_TOKEN?: string;
  CREDENTIAL_SIGNING_JWK?: string;
  CREDENTIAL_ENC_KEY?: string;
  CREDENTIAL_KEY_ID?: string;
}

interface ServerRow {
  id: string;
  account_id: string;
  order_id: string;
  provider: string;
  provider_id: string | null;
  name: string;
  region: string;
  plan: string;
  hourly_usd: number;
  monthly_usd: number;
  state: string;
  node_port: number;
  ip: string | null;
  node_id: string | null;
  enrollment_hash: string | null;
  enrollment_used_at: number | null;
  enrollment_expires_at: number | null;
  firewall_id: string | null;
  singbox_version: string | null;
  created_at: number;
  updated_at: number;
  destroyed_at: number | null;
  failure_code?: string | null;
  daily_price_cents: number;
  billing_anchor_at: number;
  transfer_gib?: number;
  paid_until: number;
  billing_state: string;
}

const GRACE_MS = 7 * 24 * 3600 * 1000;

/** 钱去哪了：按账号一次聚合每台服务器的扣费与退款，列表/详情共用，避免 N+1。 */
async function serverMoney(
  db: D1Database,
  accountId: string,
): Promise<Map<string, { chargedCents: number; refundedCents: number }>> {
  const result = await db
    .prepare(
      "SELECT s.id AS server_id, " +
        "COALESCE((SELECT SUM(ABS(w.amount_cents)) FROM wallet_ledger w " +
        "WHERE w.ref_type = 'order' AND w.ref_id = s.order_id AND w.kind = 'charge'), 0) AS charged_cents, " +
        "COALESCE((SELECT SUM(w.amount_cents) FROM wallet_ledger w " +
        "WHERE w.ref_type = 'server_refund' AND w.ref_id = s.id), 0) AS refunded_cents " +
        "FROM servers s WHERE s.account_id = ?",
    )
    .bind(accountId)
    .all<{ server_id: string; charged_cents: number; refunded_cents: number }>();
  const money = new Map<string, { chargedCents: number; refundedCents: number }>();
  for (const row of result.results ?? []) {
    money.set(String(row.server_id), {
      chargedCents: Number(row.charged_cents ?? 0),
      refundedCents: Number(row.refunded_cents ?? 0),
    });
  }
  return money;
}

function serverView(
  row: ServerRow,
  money?: { chargedCents: number; refundedCents: number },
) {
  const paidUntil = Number(row.paid_until ?? 0);
  const pastDue = row.billing_state === "past_due" || row.billing_state === "expired";
  return {
    server_id: row.id,
    name: row.name,
    region: row.region,
    plan: row.plan,
    state: row.state,
    created_at: new Date(row.created_at).toISOString(),
    ip: row.ip,
    port: row.state === "destroyed" ? null : row.node_port,
    node_id: row.node_id,
    hourly_usd: row.hourly_usd,
    monthly_usd: row.monthly_usd,
    daily_price_cents: Number(row.daily_price_cents ?? 0),
    transfer_gib: Number(row.transfer_gib ?? 0),
    paid_until: new Date(paidUntil).toISOString(),
    billing_state: row.billing_state ?? "active",
    grace_ends_at: pastDue ? new Date(paidUntil + GRACE_MS).toISOString() : null,
    // 钱去哪了：失败机器也要能说清扣了多少、退了多少，不能让人误以为已付到明天。
    charged_cents: money?.chargedCents ?? 0,
    refunded_cents: money?.refundedCents ?? 0,
    failure: row.failure_code
      ? { stage: row.state, code: row.failure_code, message: "这台服务器没有创建成功", retryable: false }
      : null,
  };
}

async function loadServer(
  db: D1Database,
  accountId: string,
  serverId: string,
): Promise<ServerRow | null> {
  return db
    .prepare("SELECT * FROM servers WHERE id = ? AND account_id = ?")
    .bind(serverId, accountId)
    .first<ServerRow>();
}

type DestroyOutcome =
  | { ok: true }
  | { ok: false; status: number; reason: string; retryable: boolean };

/**
 * 先删远端再改本地状态。反过来做会在 DO 删除失败时留下一台仍在计费、
 * 界面上却已经看不到的机器（用户无从发现、也无从重试）。
 */
async function destroyInstance(
  env: ServersEnv,
  row: ServerRow,
  reason: string,
): Promise<DestroyOutcome> {
  if (!env.DB) return { ok: false, status: 503, reason: "db_unavailable", retryable: true };
  const db = env.DB;

  // 从这一刻起计费的记账守卫拒绝再扣：DO 删除可能几秒，不能让它边删边扣。
  // 所有失败分支都恢复原状态；成功后由下面的 batch 落 destroyed。
  const previousState = row.state === "destroying" ? "active" : row.state;
  await db
    .prepare(
      "UPDATE servers SET state = 'destroying', updated_at = ? WHERE id = ? AND state != 'destroyed'",
    )
    .bind(Date.now(), row.id)
    .run();
  const restore = async () => {
    await db
      .prepare("UPDATE servers SET state = ?, updated_at = ? WHERE id = ?")
      .bind(previousState, Date.now(), row.id)
      .run()
      .catch(() => {});
  };

  if (row.provider_id) {
    if (!env.DO_API_TOKEN) {
      await restore();
      return { ok: false, status: 0, reason: "credential_missing", retryable: false };
    }
    const deleted = await deleteDroplet(env.DO_API_TOKEN, row.provider_id);
    // 404 说明机器已经不在了，按成功处理，重试保持幂等。
    if (!deleted.ok && deleted.status !== 404) {
      await restore();
      return {
        ok: false,
        status: deleted.status,
        reason: deleted.reason,
        retryable: deleted.retryable,
      };
    }
  }

  const now = Date.now();
  const refund = await refundPlan(env, row, reason, now);
  const ledgerId = refund ? randomId("led_") : "";

  // 「标记销毁 + 关单 + 退款」必须在同一个 batch（D1 batch 是事务）：
  // 分开做会出现「机器没了、钱没退」，而销毁后的重试会直接返回成功，永远补不回来。
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "UPDATE servers SET state = 'destroyed', destroyed_at = ?, updated_at = ?, failure_code = ? WHERE id = ?",
    ).bind(now, now, reason === "user" ? null : reason, row.id),
    env.DB.prepare("UPDATE credentials SET destroyed_at = ? WHERE server_id = ?").bind(now, row.id),
    env.DB.prepare(
      "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'server.destroy', ?)",
    ).bind(now, row.account_id, row.id, JSON.stringify({ reason })),
  ];

  // 非用户主动销毁（装机失败、enroll 被拒、超时）要连带关单，
  // 否则订单会永远停在 provisioning。
  if (reason !== "user" && row.order_id) {
    statements.push(
      env.DB.prepare(
        "UPDATE orders SET state = 'failed', failure_code = ?, failure_stage = ? WHERE id = ? AND state != 'failed'",
      ).bind(reason, row.state, row.order_id),
    );
  }

  if (refund) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO wallet_ledger (id, account_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, note, created_at) " +
          "SELECT ?, a.id, 'adjustment', ?, a.balance_cents + ?, 'server_refund', ?, ?, ? FROM accounts a " +
          "WHERE a.id = ? AND NOT EXISTS (SELECT 1 FROM wallet_ledger w WHERE w.ref_type = 'server_refund' AND w.ref_id = ?)",
      ).bind(ledgerId, refund.amount, refund.amount, row.id, refund.note, now, row.account_id, row.id),
      env.DB.prepare(
        "UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ?)",
      ).bind(refund.amount, row.account_id, ledgerId),
    );
  }

  await env.DB.batch(statements);
  return { ok: true };
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * 销毁退款（§4.6）：用户主动销毁退「未开始的整天」；非用户原因（装机失败、enroll 超时）
 * 退这台机器已付的全部天数。同一台服务器只退一次，重试撞 `(server_refund, server_id)` 唯一键。
 */
async function refundPlan(
  env: ServersEnv,
  row: ServerRow,
  reason: string,
  now: number,
): Promise<{ amount: number; note: string } | null> {
  if (!row.order_id) return null;
  const order = await env.DB!.prepare(
    "SELECT id, amount_cents, paid_via FROM orders WHERE id = ?",
  )
    .bind(row.order_id)
    .first<{ id: string; amount_cents: number; paid_via: string | null }>();
  if (!order || order.paid_via !== "wallet") return null;

  // 从查询到现在可能已被每日 Cron 顺延一天：退款按最新 paid_until 算，
  // 否则会少退一天——用户为没用到的那天付了钱。
  const fresh = await env.DB!.prepare("SELECT * FROM servers WHERE id = ? AND account_id = ?")
    .bind(row.id, row.account_id)
    .first<ServerRow>();
  const daily = Number(fresh?.daily_price_cents ?? row.daily_price_cents ?? 0);
  const anchor = Number(fresh?.billing_anchor_at ?? row.billing_anchor_at ?? 0);
  const paidUntil = Number(fresh?.paid_until ?? row.paid_until ?? 0);
  let amount = 0;

  if (daily > 0 && anchor > 0) {
    const nPaid = Math.floor((paidUntil - anchor) / DAY_MS);
    if (reason === "user") {
      // 当天已经用掉，不退；只退还没开始的整天。
      const nNow = Math.floor((now - anchor) / DAY_MS);
      amount = Math.max(0, daily * (nPaid - nNow - 1));
    } else {
      amount = Math.max(0, daily * Math.max(0, nPaid));
    }
  } else if (reason !== "user") {
    amount = Number(order.amount_cents ?? 0);
  }

  if (amount <= 0) return null;
  return {
    amount,
    note: reason === "user" ? "销毁退还未使用天数" : `建机失败退款：${reason}`,
  };
}

/** POST /v1/enroll/{token}：实例回传端口与密码。token 自身就是幂等键，只能消费一次。 */
async function enroll(request: Request, env: ServersEnv, token: string): Promise<Response> {
  if (!env.DB) return json({ ok: false, reason: "unavailable" }, 503);
  const db = env.DB;

  let body: {
    port?: unknown;
    password?: unknown;
    version?: unknown;
    active?: unknown;
    error?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, reason: "invalid_json" }, 400);
  }

  const hash = await sha256B64u(token);
  const row = await db
    .prepare("SELECT * FROM servers WHERE enrollment_hash = ?")
    .bind(hash)
    .first<ServerRow>();
  if (!row) return json({ ok: false, reason: "unknown_token" }, 404);
  if (row.enrollment_used_at !== null) return json({ ok: false, reason: "already_used" }, 409);
  if (row.enrollment_expires_at !== null && row.enrollment_expires_at < Date.now()) {
    await destroyInstance(env, row, "enrollment_expired");
    return json({ ok: false, reason: "expired" }, 410);
  }

  const port = Number(body.port);
  const password = typeof body.password === "string" ? body.password : "";
  const version = typeof body.version === "string" ? body.version : "";
  if (port !== row.node_port) {
    await destroyInstance(env, row, "port_mismatch");
    return json({ ok: false, reason: "port_mismatch" }, 409);
  }
  // active 只认 JSON 布尔；但已有机器可能发的是 1 / "true"，一并接受，别再自己把成功的机器判死。
  const active =
    body.active === true || body.active === 1 || body.active === "true";
  if (!active || password.length < 8) {
    // 无论有没有 error，都记下回传的内容（不含密码），否则“服务没起来”这类失败查不到原因。
    await db
      .prepare(
        "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'enroll.rejected', ?)",
      )
      .bind(
        Date.now(),
        row.account_id,
        row.id,
        JSON.stringify({
          active: body.active ?? null,
          password_length: password.length,
          error: typeof body.error === "string" ? body.error.slice(0, 200) : null,
        }),
      )
      .run();
    await destroyInstance(env, row, "service_inactive");
    return json(
      {
        ok: false,
        reason: "service_inactive",
        error: typeof body.error === "string" ? body.error.slice(0, 200) : undefined,
      },
      409,
    );
  }

  // 所有可能失败的准备工作都放在消费 token 之前：反过来的话，消费后任一步失败都会
  // 让机器停在 booting 且 used_at≠null，而超时销毁要求 used_at=null——永不过期、永久计费。
  if (!env.CREDENTIAL_ENC_KEY) return json({ ok: false, reason: "storage_unavailable" }, 503);
  // enroll 通常比 DO 分配 IP 更早返回，这时 row.ip 还是 null，必须先补，
  // 否则封存进凭据的 host 就是空，客户端拿到的节点地址不可用。
  let host = row.ip;
  if (!host && env.DO_API_TOKEN && row.provider_id) {
    const droplet = await getDroplet(env.DO_API_TOKEN, row.provider_id);
    if (droplet.ok && droplet.value.ipv4) {
      host = droplet.value.ipv4;
      await db
        .prepare("UPDATE servers SET ip = ?, updated_at = ? WHERE id = ?")
        .bind(host, Date.now(), row.id)
        .run();
    }
  }
  if (!host) return json({ ok: false, reason: "host_unavailable" }, 503);
  const sealed = await sealSecret(
    env.CREDENTIAL_ENC_KEY,
    JSON.stringify({ host, port, password, method: "aes-256-gcm" }),
  );

  // 原子消费：并发或重放只有一次能成功。
  const consumed = await db
    .prepare(
      "UPDATE servers SET enrollment_used_at = ?, enrollment_hash = NULL, updated_at = ? " +
        "WHERE id = ? AND enrollment_hash = ? AND enrollment_used_at IS NULL",
    )
    .bind(Date.now(), Date.now(), row.id, hash)
    .run();
  const changed = (consumed as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changed === 0) return json({ ok: false, reason: "already_used" }, 409);

  // 从这里往后已经消费了 token：任何失败都必须销毁机器，不能留一台没人管的计费实例。
  try {
    await db
      .prepare(
        "INSERT INTO credentials (server_id, key_version, iv, ciphertext, created_at) VALUES (?, 1, ?, ?, ?) " +
          "ON CONFLICT(server_id) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext, destroyed_at = NULL",
      )
      .bind(row.id, sealed.iv, sealed.ciphertext, Date.now())
      .run();

    let firewallId: string | null = null;
    if (env.DO_API_TOKEN && row.provider_id) {
      const firewall = await createFirewall(env.DO_API_TOKEN, {
        name: `veyl-${row.id.replace(/^srv_/, "").slice(0, 12)}`,
        port,
        providerId: row.provider_id,
      });
      if (!firewall.ok) {
        await destroyInstance(env, row, firewall.reason);
        return json({ ok: false, reason: "firewall_failed" }, 502);
      }
      firewallId = firewall.value.id;
    }

    const nodeId = randomId("nd_", 12);
    await db.batch([
      db.prepare(
        "UPDATE servers SET state = 'active', node_id = ?, firewall_id = ?, singbox_version = ?, updated_at = ? WHERE id = ?",
      ).bind(nodeId, firewallId, version, Date.now(), row.id),
      db.prepare("UPDATE orders SET state = 'ready' WHERE id = ?").bind(row.order_id),
      db.prepare(
        "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'enroll.ok', ?)",
      ).bind(Date.now(), row.account_id, row.id, JSON.stringify({ version })),
    ]);

    return json({ ok: true, node_id: nodeId });
  } catch (error) {
    await destroyInstance(env, row, "activate_failed");
    return json({ ok: false, reason: "activate_failed" }, 500);
  }
}

/**
 * booting 状态下每次列表/详情顺手做两件事：
 * 1. 建机响应（202）里没有 IP —— DO 是异步分配，这里补上，否则凭据里的 host 一直是 null。
 * 2. 超过 enrollment 有效期还没回传的机器直接销毁。没有 Cron，这是唯一的兜底入口，
 *    否则装失败的机器会一直计费、界面上还看不到原因。
 */
async function refreshBooting(env: ServersEnv, rows: ServerRow[]): Promise<void> {
  if (!env.DB || !env.DO_API_TOKEN) return;
  for (const row of rows) {
    if (row.state === "destroyed" || row.state === "error") continue;

    const expired =
      row.state === "booting" &&
      row.enrollment_used_at === null &&
      row.enrollment_expires_at !== null &&
      row.enrollment_expires_at < Date.now();
    if (expired) {
      await destroyInstance(env, row, "enrollment_timeout");
      row.state = "destroyed";
      row.destroyed_at = Date.now();
      continue;
    }

    // 建机响应里没有 IP（DO 异步分配），active 之后同样要补——否则凭据里的 host 是 null。
    if (row.ip || !row.provider_id) continue;
    const droplet = await getDroplet(env.DO_API_TOKEN, row.provider_id);
    if (!droplet.ok || !droplet.value.ipv4) continue;
    row.ip = droplet.value.ipv4;
    await env.DB.prepare("UPDATE servers SET ip = ?, updated_at = ? WHERE id = ?")
      .bind(row.ip, Date.now(), row.id)
      .run();
  }
}

async function listServers(request: Request, env: ServersEnv): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const result = await env.DB.prepare(
    "SELECT * FROM servers WHERE account_id = ? AND state != 'destroyed' ORDER BY created_at DESC",
  )
    .bind(identity.accountId)
    .all<ServerRow>();
  const rows = result.results ?? [];
  await refreshBooting(env, rows);
  const money = await serverMoney(env.DB, identity.accountId);
  return json({ servers: rows.map((row) => serverView(row, money.get(row.id))) });
}

async function getServer(request: Request, env: ServersEnv, serverId: string): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const row = await loadServer(env.DB, identity.accountId, serverId);
  if (!row) return apiError("NOT_FOUND", "没有这台服务器");
  await refreshBooting(env, [row]);
  const money = await serverMoney(env.DB, identity.accountId);
  return json(serverView(row, money.get(row.id)));
}

async function destroy(request: Request, env: ServersEnv, serverId: string): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const row = await loadServer(env.DB, identity.accountId, serverId);
  if (!row) return apiError("NOT_FOUND", "没有这台服务器");
  if (row.state === "destroyed") return new Response(null, { status: 204 });

  await env.DB.prepare("UPDATE servers SET state = 'destroying', updated_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run();
  const outcome = await destroyInstance(env, row, "user");
  if (!outcome.ok) {
    // 远端没删掉：状态还原，机器继续可见、可以重试。
    await env.DB.prepare("UPDATE servers SET state = ?, updated_at = ? WHERE id = ?")
      .bind(row.state === "destroying" ? "active" : row.state, Date.now(), row.id)
      .run();
    return apiError("UPSTREAM_ERROR", "暂时删不掉这台服务器，它还在运行，稍后再试", {
      retryable: outcome.retryable,
      status: outcome.retryable ? 502 : 500,
      reason: outcome.reason,
    });
  }
  return new Response(null, { status: 204 });
}

async function credentials(request: Request, env: ServersEnv, serverId: string): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });
  if (!env.CREDENTIAL_SIGNING_JWK || !env.CREDENTIAL_ENC_KEY) {
    return apiError("INTERNAL", "控制面还没配置凭据签名", { reason: "credential_key_missing" });
  }

  const row = await loadServer(env.DB, identity.accountId, serverId);
  if (!row) return apiError("NOT_FOUND", "没有这台服务器");
  if (row.state !== "active" && row.state !== "healthy") {
    return apiError("PRECONDITION_FAILED", "这台服务器还没准备好", { reason: "not_ready" });
  }

  const sealed = await env.DB.prepare(
    "SELECT iv, ciphertext FROM credentials WHERE server_id = ? AND destroyed_at IS NULL",
  )
    .bind(row.id)
    .first<{ iv: string; ciphertext: string }>();
  if (!sealed) return apiError("PRECONDITION_FAILED", "这台服务器没有可用凭据", { reason: "no_credentials" });

  const opened = await openSecret(env.CREDENTIAL_ENC_KEY, sealed);
  if (!opened) return apiError("INTERNAL", "凭据读取失败", { reason: "credential_corrupt" });
  const secret = JSON.parse(opened) as { host: string; port: number; password: string; method: string };

  const issuedAt = Date.now();
  const payload = JSON.stringify({
    server_id: row.id,
    node_id: row.node_id,
    host: secret.host ?? row.ip,
    port: secret.port,
    method: secret.method,
    password: secret.password,
    issued_at: new Date(issuedAt).toISOString(),
    expires_at: new Date(issuedAt + CREDENTIAL_TTL_MS).toISOString(),
  });
  const signature = await signDetached(env.CREDENTIAL_SIGNING_JWK, payload);

  return json({ payload, signature, key_id: env.CREDENTIAL_KEY_ID ?? DEFAULT_CREDENTIAL_KEY_ID });
}

export async function handleServers(request: Request, env: ServersEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const post = request.method === "POST";

  if (parts[0] === "v1" && parts[1] === "enroll" && parts.length === 3 && post) {
    return enroll(request, env, parts[2]);
  }
  if (parts[0] !== "v1" || parts[1] !== "servers") return null;

  if (parts.length === 2 && request.method === "GET") return listServers(request, env);
  if (parts.length === 3 && request.method === "GET") return getServer(request, env, parts[2]);
  if (parts.length === 4 && post) {
    if (parts[3] === "destroy") return destroy(request, env, parts[2]);
    if (parts[3] === "credentials") return credentials(request, env, parts[2]);
    if (parts[3] === "rebuild") {
      return apiError("PRECONDITION_FAILED", "重建还没接入", {
        reason: "rebuild_not_supported",
      });
    }
  }
  return null;
}
