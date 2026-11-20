// 服务器：enrollment 回传、列表、详情、销毁、凭据下发（§19.5 / §19.7 / §19.8）。
// 控制面是唯一事实源；客户端拿到的凭据必须能被内置公钥验签。

import { authenticate, isResponse, type MaybeAuthEnv } from "./auth";
import { randomId, sealSecret, sha256B64u, signDetached, openSecret } from "./lib/crypto";
import { apiError, json } from "./lib/http";
import { createFirewall, deleteDroplet, deleteFirewall, getDroplet } from "./providers/digitalocean";
import { recordLedgerEntry } from "./wallet";

// 每个环境用自己的签名密钥：dev 与 prod 的公钥都内置在客户端，靠 key_id 区分。
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
  /** 激活成功的那一刻；旧机器为 null（用时未知）。 */
  ready_at?: number | null;
  /** 首次进入 installing / verifying 的时刻；进度上报只写一次。 */
  installing_at?: number | null;
  verifying_at?: number | null;
  failure_code?: string | null;
  failure_stage?: string | null;
  /** 沿用「余额不足停机」的墓碑行被用户忽略的时刻；手动销毁的行不使用。 */
  dismissed_at?: number | null;
  daily_price_cents: number;
  billing_anchor_at: number;
  transfer_gib?: number;
  paid_until: number | null;
  billing_state: string;
  /** 扣费口径来自订单行（`LEFT JOIN orders`），服务器表本身不存。 */
  charge_mode?: string | null;
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
  // 结算前没有「已付到」的时刻（at_ready 的服务器在 pending 阶段 paid_until = NULL）。
  const paidUntil = row.paid_until == null ? null : Number(row.paid_until);
  const pastDue = row.billing_state === "past_due" || row.billing_state === "expired";
  return {
    server_id: row.id,
    name: row.name,
    region: row.region,
    plan: row.plan,
    state: row.state,
    created_at: new Date(row.created_at).toISOString(),
    // 激活成功那一刻；旧机器没有这一列的值 -> null，界面按「用时未知」显示。
    ready_at: row.ready_at ? new Date(Number(row.ready_at)).toISOString() : null,
    // 首次进入各阶段的时刻；没上报过就是 null（旧机器或脚本丢了进度）。
    installing_at: row.installing_at
      ? new Date(Number(row.installing_at)).toISOString()
      : null,
    verifying_at: row.verifying_at
      ? new Date(Number(row.verifying_at)).toISOString()
      : null,
    ip: row.ip,
    port: row.state === "destroyed" ? null : row.node_port,
    node_id: row.node_id,
    hourly_usd: row.hourly_usd,
    monthly_usd: row.monthly_usd,
    daily_price_cents: Number(row.daily_price_cents ?? 0),
    transfer_gib: Number(row.transfer_gib ?? 0),
    paid_until: paidUntil == null ? null : new Date(paidUntil).toISOString(),
    billing_state: row.billing_state ?? "active",
    // 扣费口径（2.39.0）：存量服务器/订单行缺省按 upfront，新单是 at_ready。
    charge_mode: row.charge_mode ?? "upfront",
    grace_ends_at:
      pastDue && paidUntil != null
        ? new Date(paidUntil + GRACE_MS).toISOString()
        : null,
    // 钱去哪了：失败机器也要能说清扣了多少、退了多少，不能让人误以为已付到明天。
    charged_cents: money?.chargedCents ?? 0,
    refunded_cents: money?.refundedCents ?? 0,
    failure: row.failure_code
      ? {
          // 失败阶段以 failure_stage 为准；旧行没有该列时退回当时的状态。
          stage: row.failure_stage ?? row.state,
          code: row.failure_code,
          message:
            row.failure_code === "billing_unpaid"
              ? "余额不足，已停机删除"
              : "这台服务器没有创建成功",
          retryable: false,
        }
      : null,
  };
}

async function loadServer(
  db: D1Database,
  accountId: string,
  serverId: string,
): Promise<ServerRow | null> {
  return db
    .prepare(
      "SELECT s.*, o.charge_mode AS charge_mode FROM servers s LEFT JOIN orders o ON o.id = s.order_id " +
        "WHERE s.id = ? AND s.account_id = ?",
    )
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
  options: { firewallId?: string | null; failureStage?: string | null } = {},
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
    // 只回滚自己刚写下的 destroying：并发销毁已经把行标成 destroyed 时不能改回 booting。
    await db
      .prepare(
        "UPDATE servers SET state = ?, updated_at = ? WHERE id = ? AND state = 'destroying' AND destroyed_at IS NULL",
      )
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

  // droplet 已经删掉（或本就不在）之后再删防火墙：先删防火墙会让还活着的机器直接裸奔。
  // 激活前就失败时防火墙 id 还没写进库，由调用方通过 options 传进来。
  // 防火墙删除失败不影响销毁与退款——留着它只是多一条规则，不会继续计费。
  const firewallId = options.firewallId ?? row.firewall_id ?? null;
  if (firewallId && env.DO_API_TOKEN) {
    const removed = await deleteFirewall(env.DO_API_TOKEN, firewallId);
    if (!removed.ok && removed.status !== 404) {
      console.warn(`[servers] firewall_delete_failed id=${firewallId} reason=${removed.reason}`);
    }
  }

  const now = Date.now();
  const refund = await refundPlan(env, row, reason, now);
  const ledgerId = refund ? randomId("led_") : "";

  // 「标记销毁 + 关单 + 退款」必须在同一个 batch（D1 batch 是事务）：
  // 分开做会出现「机器没了、钱没退」，而销毁后的重试会直接返回成功，永远补不回来。
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "UPDATE servers SET state = 'destroyed', destroyed_at = ?, updated_at = ?, failure_code = ?, " +
        "failure_stage = COALESCE(?, failure_stage) WHERE id = ?",
    ).bind(now, now, reason === "user" ? null : reason, options.failureStage ?? null, row.id),
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

  // 退款必须先确认真的扣过钱：at_ready 的服务器在结算前没有 charge 流水，
  // 失败销毁不能凭空退一笔。存量 upfront 订单在 checkout 时写过一笔 charge。
  const charge = await env.DB!.prepare(
    "SELECT amount_cents FROM wallet_ledger WHERE ref_type = 'order' AND ref_id = ? AND kind = 'charge' " +
      "ORDER BY created_at ASC LIMIT 1",
  )
    .bind(row.order_id)
    .first<{ amount_cents: number }>();
  const chargedCents = Math.abs(Number(charge?.amount_cents ?? 0));
  if (!charge || chargedCents <= 0) {
    await env.DB!.prepare(
      "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'refund_skipped_no_charge', ?)",
    )
      .bind(now, row.account_id, row.id, JSON.stringify({ order_id: row.order_id, reason }))
      .run()
      .catch((error) =>
        console.warn(`[servers] audit_failed action=refund_skipped_no_charge server=${row.id} error=${String(error)}`),
      );
    return null;
  }

  // 从查询到现在可能已被每日 Cron 顺延一天：退款按最新 paid_until 算，
  // 否则会少退一天——用户为没用到的那天付了钱。
  const fresh = await env.DB!.prepare("SELECT * FROM servers WHERE id = ? AND account_id = ?")
    .bind(row.id, row.account_id)
    .first<ServerRow>();
  const daily = chargedCents;
  const anchor = Number(fresh?.billing_anchor_at ?? row.billing_anchor_at ?? 0);
  const paidUntil = Number(fresh?.paid_until ?? row.paid_until ?? 0);
  let amount = 0;

  if (daily > 0 && anchor > 0 && paidUntil > 0) {
    const nPaid = Math.floor((paidUntil - anchor) / DAY_MS);
    // 「余额不足停机」和用户主动销毁同一口径：只退未开始的整天。
    // 照「非用户原因全额退」等于让欠费停机白送已用天数。
    const userLike = reason === "user" || reason === "billing_unpaid";
    if (userLike) {
      // 当天已经用掉，不退；只退还没开始的整天。
      const nNow = Math.floor((now - anchor) / DAY_MS);
      amount = Math.max(0, daily * (nPaid - nNow - 1));
    } else {
      amount = Math.max(0, daily * Math.max(0, nPaid));
    }
  } else if (reason !== "user" && reason !== "billing_unpaid") {
    amount = chargedCents;
  }

  if (amount <= 0) return null;
  return {
    amount,
    note:
      reason === "user" || reason === "billing_unpaid"
        ? "销毁退还未使用天数"
        : `建机失败退款：${reason}`,
  };
}

/** 结算（就绪后扣款，§4.14）：扣第 0 天 + 订单 ready + 服务器 active，全部同一个 batch。 */
async function settleOrder(
  env: ServersEnv,
  row: ServerRow,
  dailyCents: number,
  info: { nodeId: string; firewallId: string | null; version: string; readyAt: number },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!Number.isFinite(dailyCents) || dailyCents <= 0) {
    return { ok: false, reason: "invalid_price" };
  }
  const db = env.DB!;
  const paidUntil = info.readyAt + DAY_MS;
  const result = await recordLedgerEntry(env, {
    accountId: row.account_id,
    kind: "charge",
    amountCents: -dailyCents,
    refType: "order",
    refId: row.order_id,
    // 结算只卡 1 天余额；服务器在这段窗口里被销毁/超时清理时不能再写账。
    guard: {
      sql:
        "SELECT 1 FROM accounts a, servers s WHERE a.id = ? AND a.balance_cents >= ? " +
        "AND s.id = ? AND s.destroyed_at IS NULL AND s.state IN ('booting', 'installing', 'verifying')",
      args: [row.account_id, dailyCents, row.id],
    },
    followUps: (ledgerId) => [
      db
        .prepare(
          "UPDATE orders SET state = 'ready', paid_at = ?, paid_via = 'wallet' " +
            "WHERE id = ? AND state = 'provisioning' AND EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ?)",
        )
        .bind(info.readyAt, row.order_id, ledgerId),
      db
        .prepare(
          "UPDATE servers SET state = 'active', node_id = ?, firewall_id = ?, singbox_version = ?, " +
            "ready_at = ?, billing_state = 'active', daily_price_cents = ?, billing_anchor_at = ?, " +
            "paid_until = ?, updated_at = ? " +
            "WHERE id = ? AND destroyed_at IS NULL AND state IN ('booting', 'installing', 'verifying') " +
            "AND EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ?)",
        )
        .bind(
          info.nodeId,
          info.firewallId,
          info.version,
          info.readyAt,
          dailyCents,
          info.readyAt,
          paidUntil,
          info.readyAt,
          row.id,
          ledgerId,
        ),
      db
        .prepare(
          "INSERT INTO audit_log (at, account_id, server_id, action, detail) " +
            "SELECT ?, ?, ?, 'settle.ok', ? WHERE EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ?)",
        )
        .bind(
          info.readyAt,
          row.account_id,
          row.id,
          JSON.stringify({ order_id: row.order_id, amount_cents: dailyCents }),
          ledgerId,
        ),
    ],
  });
  if (result.ok) return { ok: true };
  // 已经是同一笔结算（崩溃后重放）：账本与状态都在原批里，按成功处理，不重复扣。
  if (result.reason === "duplicate") return { ok: true };
  return { ok: false, reason: result.reason };
}

/**
 * 结算失败/N 分钟未结算：**先认领订单**（provisioning → failed），抢到的那一次才删远端实例；
 * 抢不到说明别处已经处置（并发结算成功了就是订单 ready），这里绝不能再删——多删一次就是
 * 删掉用户刚付过钱的机器。服务器标成 error 但**不写 destroyed**，列表保留错误行给用户看原因。
 *
 * 认领之后、删除之前进程死掉会留下仍在进度阶段的机器：`sweepExpiredEnrollments` 到
 * enrollment 过期时会按 `destroyInstance` 收尾，而防火墙 id 在创建时就已落库，不会留孤儿规则。
 */
async function failSettlement(
  env: ServersEnv,
  row: ServerRow,
  firewallId: string | null,
  reason: string,
): Promise<boolean> {
  const db = env.DB!;
  const now = Date.now();
  const claimed = await db
    .prepare(
      "UPDATE orders SET state = 'failed', failure_code = ?, failure_stage = ? " +
        "WHERE id = ? AND state = 'provisioning'",
    )
    .bind(reason, "active", row.order_id)
    .run();
  if (Number((claimed as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) return false;

  const remoteFirewall = firewallId ?? row.firewall_id ?? null;
  if (row.provider_id && env.DO_API_TOKEN) {
    const deleted = await deleteDroplet(env.DO_API_TOKEN, row.provider_id);
    if (!deleted.ok && deleted.status !== 404) {
      console.warn(`[servers] settle_cleanup_failed server=${row.id} reason=${deleted.reason}`);
    }
  }
  if (remoteFirewall && env.DO_API_TOKEN) {
    const removed = await deleteFirewall(env.DO_API_TOKEN, remoteFirewall);
    if (!removed.ok && removed.status !== 404) {
      console.warn(`[servers] settle_firewall_delete_failed id=${remoteFirewall} reason=${removed.reason}`);
    }
  }

  await db.batch([
    db
      .prepare(
        "UPDATE servers SET state = 'error', failure_code = ?, failure_stage = 'active', updated_at = ? " +
          "WHERE id = ? AND destroyed_at IS NULL",
      )
      .bind(reason, now, row.id),
    db.prepare("UPDATE credentials SET destroyed_at = ? WHERE server_id = ?").bind(now, row.id),
    db
      .prepare(
        "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'settle_insufficient', ?)",
      )
      .bind(now, row.account_id, row.id, JSON.stringify({ order_id: row.order_id, reason })),
  ]);
  return true;
}

/** 阶段只许前进：installing 只能从 booting 来，verifying 只能从 installing 来。 */
async function advanceStage(
  env: ServersEnv,
  row: ServerRow,
  stage: "installing" | "verifying",
): Promise<Response> {
  const now = Date.now();
  const from = stage === "installing" ? "booting" : "installing";
  const column = stage === "installing" ? "installing_at" : "verifying_at";
  const updated = await env.DB!.prepare(
    `UPDATE servers SET state = ?, ${column} = COALESCE(${column}, ?), updated_at = ? ` +
      "WHERE id = ? AND destroyed_at IS NULL AND state = ?",
  )
    .bind(stage, now, now, row.id, from)
    .run();
  const changed = Number((updated as { meta?: { changes?: number } }).meta?.changes ?? 0);
  if (changed === 1) return json({ ok: true, stage });
  // 乱序 / 回退 / 已销毁：200 + ignored，脚本重试不该变成错误风暴。
  return json({ ok: true, ignored: true });
}

/** 允许被超时清理的阶段：进度上报之后就卡住同样会一直计费。 */
const PROGRESS_STATES = ["booting", "installing", "verifying"];

/** 卡在某阶段超时的失败码：独立可查，不要都混成一个。 */
function stageTimeoutReason(state: string, enrollmentUsedAt: number | null): string {
  if (state === "installing") return "install_timeout";
  if (state === "verifying") return "verify_timeout";
  return enrollmentUsedAt === null ? "enrollment_timeout" : "activate_stalled";
}

/** 失败阶段 → 失败原因码；有明确阶段就用阶段专属码，否则沿用旧的 service_inactive。 */
function failureReason(failedStage: string): string {
  if (failedStage === "installing") return "install_failed";
  if (failedStage === "verifying") return "verify_failed";
  return "service_inactive";
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
    stage?: unknown;
    failed_stage?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, reason: "invalid_json" }, 400);
  }

  // 旧脚本没有 stage：它只发最终一报，按 active 处理（失败由 active=false 决定）。
  const rawStage = typeof body.stage === "string" ? body.stage.trim() : "";
  const stage =
    rawStage === "installing" || rawStage === "verifying" || rawStage === "failed"
      ? rawStage
      : "active";

  const hash = await sha256B64u(token);
  const row = await db
    .prepare("SELECT * FROM servers WHERE enrollment_hash = ?")
    .bind(hash)
    .first<ServerRow>();
  if (!row) return json({ ok: false, reason: "unknown_token" }, 404);
  if (row.enrollment_used_at !== null) {
    // token 只在最终 active 消费；消费之后的进度上报回 200 ignored，
    // 不要 409——脚本的重试循环会把 409 变成风暴。
    if (stage === "installing" || stage === "verifying") {
      return json({ ok: true, ignored: true });
    }
    return json({ ok: false, reason: "already_used" }, 409);
  }
  if (row.enrollment_expires_at !== null && row.enrollment_expires_at < Date.now()) {
    await destroyInstance(env, row, "enrollment_expired");
    return json({ ok: false, reason: "expired" }, 410);
  }

  // 进度上报：不消费 token，只按阶段前进；乱序 / 回退 / 已销毁一律 ignored。
  if (stage === "installing" || stage === "verifying") {
    return advanceStage(env, row, stage);
  }

  const port = Number(body.port);
  const password = typeof body.password === "string" ? body.password : "";
  const version = typeof body.version === "string" ? body.version : "";
  // 失败阶段由脚本回传；旧脚本没有这个字段时按当前状态记录。
  const rawFailedStage =
    typeof body.failed_stage === "string" ? body.failed_stage.trim() : "";
  const failedStage = ["booting", "installing", "verifying", "active"].includes(
    rawFailedStage,
  )
    ? rawFailedStage
    : row.state;
  // 脚本自己已经判定失败时端口没有意义（trap 里的 PORT 可能还没赋值）。
  if (stage !== "failed" && port !== row.node_port) {
    await destroyInstance(env, row, "port_mismatch", { failureStage: "active" });
    return json({ ok: false, reason: "port_mismatch" }, 409);
  }
  // active 只认 JSON 布尔；但已有机器可能发的是 1 / "true"，一并接受，别再自己把成功的机器判死。
  const active =
    body.active === true || body.active === 1 || body.active === "true";
  if (stage === "failed" || !active || password.length < 8) {
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
          stage,
          failed_stage: failedStage,
          active: body.active ?? null,
          password_length: password.length,
          error: typeof body.error === "string" ? body.error.slice(0, 200) : null,
        }),
      )
      .run();
    const reason = failureReason(failedStage);
    await destroyInstance(env, row, reason, { failureStage: failedStage });
    return json(
      {
        ok: false,
        reason,
        failed_stage: failedStage,
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

  // 原子消费：并发或重放只有一次能成功。**保留 enrollment_hash**，
  // 这样消费之后晚到的进度上报还能按 hash 找到行并回 ignored，而不是 404。
  const consumed = await db
    .prepare(
      "UPDATE servers SET enrollment_used_at = ?, updated_at = ? " +
        "WHERE id = ? AND enrollment_hash = ? AND enrollment_used_at IS NULL",
    )
    .bind(Date.now(), Date.now(), row.id, hash)
    .run();
  const changed = (consumed as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changed === 0) return json({ ok: false, reason: "already_used" }, 409);

  // 从这里往后已经消费了 token：任何失败都必须销毁机器，不能留一台没人管的计费实例。
  // `firewallId` 声明在 try 外：id 写库失败时会走 catch，销毁路径拿不到库里的值，
  // 只能靠这个内存变量把刚建好的防火墙删掉。
  let firewallId: string | null = null;
  try {
    await db
      .prepare(
        "INSERT INTO credentials (server_id, key_version, iv, ciphertext, created_at) VALUES (?, 1, ?, ?, ?) " +
          "ON CONFLICT(server_id) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext, destroyed_at = NULL",
      )
      .bind(row.id, sealed.iv, sealed.ciphertext, Date.now())
      .run();

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
      // 建好就落库：结算失败或进程在中途死掉时，Cron 兜底只能靠库里的 id 删防火墙。
      await db
        .prepare("UPDATE servers SET firewall_id = ?, updated_at = ? WHERE id = ?")
        .bind(firewallId, Date.now(), row.id)
        .run();
    }

    const nodeId = randomId("nd_", 12);
    const readyAt = Date.now();
    const orderRow = await db
      .prepare("SELECT id, amount_cents, charge_mode FROM orders WHERE id = ?")
      .bind(row.order_id)
      .first<{ id: string; amount_cents: number; charge_mode: string | null }>();
    // 存量 upfront 订单在 checkout 已扣过费，这里只做激活；
    // at_ready 订单在就绪这一刻结算第 0 天（§4.14）。
    let activated: number;
    let orderReady: number;
    if (orderRow?.charge_mode === "at_ready") {
      const settled = await settleOrder(env, row, Number(orderRow.amount_cents ?? 0), {
        nodeId,
        firewallId,
        version,
        readyAt,
      });
      if (!settled.ok) {
        // token 已消费、凭据已写：必须显式收尾，不能留一台没开通却在跑、也没人管的实例。
        await failSettlement(env, row, firewallId, "settle_insufficient");
        return json({ ok: false, reason: "settle_insufficient" }, 409);
      }
      activated = 1;
      orderReady = 1;
    } else {
      // 激活必须带状态守卫：sweep / refreshBooting 可能在这段窗口里已经把机器销毁并退了钱，
      // 晚到的激活不能把一台 DO 上已删除的机器改回 active（幽灵机器）。
      const activation = await db.batch([
        db.prepare(
          "UPDATE servers SET state = 'active', node_id = ?, firewall_id = ?, singbox_version = ?, ready_at = ?, updated_at = ? " +
            "WHERE id = ? AND state IN ('booting', 'installing', 'verifying') AND destroyed_at IS NULL",
        ).bind(nodeId, firewallId, version, readyAt, readyAt, row.id),
        db.prepare(
          "UPDATE orders SET state = 'ready' WHERE id = ? AND state = 'provisioning'",
        ).bind(row.order_id),
      ]);
      activated = Number(
        (activation[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0,
      );
      orderReady = Number(
        (activation[1] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0,
      );
    }
    if (activated !== 1) {
      // 激活被守卫拦下：本次刚插的凭据与刚建的防火墙都要收尾。
      // destroyInstance 幂等：DO 删除 404 按成功；退款撞 `(server_refund, server_id)` 唯一键，
      // 不会因为并发销毁已经退过而退第二次。
      const cleanup = await destroyInstance(env, row, "activation_lost", { firewallId });
      if (!cleanup.ok) {
        console.warn(
          `[servers] activation_lost_cleanup_failed server=${row.id} reason=${cleanup.reason}`,
        );
      }
      await db
        .prepare(
          "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'enroll.activation_lost', ?)",
        )
        .bind(
          Date.now(),
          row.account_id,
          row.id,
          JSON.stringify({
            node_id: nodeId,
            changes: activated,
            firewall_id: firewallId,
            cleaned: cleanup.ok,
          }),
        )
        .run()
        .catch((error) =>
          console.warn(
            `[servers] audit_failed action=enroll.activation_lost server=${row.id} error=${String(error)}`,
          ),
        );
      return json({ ok: false, reason: "server_destroyed" }, 410);
    }

    if (orderReady !== 1) {
      // 服务器已经 active，订单却没能置 ready：先留证，别让将来出现的半成功无声无息。
      await db
        .prepare(
          "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'enroll.order_ready_lost', ?)",
        )
        .bind(
          Date.now(),
          row.account_id,
          row.id,
          JSON.stringify({ order_id: row.order_id, changes: orderReady }),
        )
        .run()
        .catch((error) =>
          console.warn(
            `[servers] audit_failed action=enroll.order_ready_lost server=${row.id} error=${String(error)}`,
          ),
        );
    }

    await db
      .prepare(
        "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'enroll.ok', ?)",
      )
      .bind(Date.now(), row.account_id, row.id, JSON.stringify({ version }))
      .run()
      // 机器已经 active、订单已经 ready：审计写不进去不能反过来把它判死。
      .catch((error) =>
        console.warn(
          `[servers] audit_failed action=enroll.ok server=${row.id} error=${String(error)}`,
        ),
      );

    return json({ ok: true, node_id: nodeId });
  } catch (error) {
    // 失败点可能就是「防火墙 id 写库」：销毁路径读库拿不到它，把内存里的 id 传进去补删，
    // 否则 DO 上会留下一条永远没人认领的防火墙规则。
    await destroyInstance(env, row, "activate_failed", { firewallId });
    return json({ ok: false, reason: "activate_failed" }, 500);
  }
}

/**
 * 建机中的服务器（booting / installing / verifying）每次列表/详情顺手做两件事：
 * 1. 建机响应（202）里没有 IP —— DO 是异步分配，这里补上，否则凭据里的 host 一直是 null。
 * 2. 超过 enrollment 有效期仍卡在这三个阶段的机器直接销毁。没有 Cron 时这是唯一的兜底入口，
 *    否则装失败的机器会一直计费、界面上还看不到原因。
 */
async function refreshBooting(env: ServersEnv, rows: ServerRow[]): Promise<void> {
  if (!env.DB || !env.DO_API_TOKEN) return;
  for (const row of rows) {
    if (row.state === "destroyed" || row.state === "error") continue;

    // booting / installing / verifying 都可能卡住：只要过了 enrollment 有效期就按超时清理。
    const expired =
      PROGRESS_STATES.includes(row.state) &&
      row.enrollment_expires_at !== null &&
      row.enrollment_expires_at < Date.now();
    if (expired) {
      // 先记住阶段：销毁会改状态，不能拿改过的值写 failure_stage。
      const stage = row.state;
      const reason = stageTimeoutReason(stage, row.enrollment_used_at);
      await destroyInstance(env, row, reason, { failureStage: stage });
      row.state = "destroyed";
      row.destroyed_at = Date.now();
      // 行是查询快照、不会回读：失败码在这里补上，否则这一次响应只说「已销毁」不说原因。
      row.failure_code = reason;
      row.failure_stage = stage;
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

/** 单页扫描条数、单轮销毁上限与最多扫几页：最老的先修，失败的行不会把后面的挡住。 */
const ENROLL_REAP_SCAN = 50;
const ENROLL_REAP_BATCH = 10;
const ENROLL_REAP_PAGES = 10;
/** 结算兜底：enroll 已消费 token 之后仍未写 charge 流水，超过这个时间视为结算进程已死。 */
const SETTLE_SWEEP_AFTER_MS = 10 * 60 * 1000;
const SETTLE_SWEEP_BATCH = 10;

/**
 * 结算兜底（§4.14）：at_ready 订单已经消费 enrollment token，但没有 charge 流水，
 * 服务器还停在 booting / installing / verifying。正常结算在同一请求里完成；
 * 超过 10 分钟说明 Worker 中途死掉，按「结算失败」同一处置收尾，避免永久占着实例。
 */
export async function sweepUnsettledSettlements(
  env: ServersEnv,
  now = Date.now(),
): Promise<number> {
  if (!env.DB) return 0;
  const db = env.DB;
  const rows = await db
    .prepare(
      "SELECT s.* FROM servers s JOIN orders o ON o.id = s.order_id " +
        "WHERE o.charge_mode = 'at_ready' AND o.state = 'provisioning' " +
        "AND s.destroyed_at IS NULL AND s.state IN ('booting', 'installing', 'verifying') " +
        "AND s.enrollment_used_at IS NOT NULL AND s.enrollment_used_at < ? " +
        "AND NOT EXISTS (SELECT 1 FROM wallet_ledger w " +
        "WHERE w.ref_type = 'order' AND w.ref_id = o.id AND w.kind = 'charge') " +
        "ORDER BY s.enrollment_used_at ASC LIMIT ?",
    )
    .bind(now - SETTLE_SWEEP_AFTER_MS, SETTLE_SWEEP_BATCH)
    .all<ServerRow>();

  let reaped = 0;
  for (const row of rows.results ?? []) {
    // 扫描到处理之间可能已经结算或销毁：以库里的最新状态为准。
    const fresh = await db
      .prepare("SELECT * FROM servers WHERE id = ? AND account_id = ?")
      .bind(row.id, row.account_id)
      .first<ServerRow>();
    if (!fresh || fresh.destroyed_at != null || !PROGRESS_STATES.includes(fresh.state)) {
      continue;
    }
    const charged = await db
      .prepare(
        "SELECT id FROM wallet_ledger WHERE ref_type = 'order' AND ref_id = ? AND kind = 'charge'",
      )
      .bind(fresh.order_id)
      .first<{ id: string }>();
    if (charged) continue;
    const claimed = await failSettlement(env, fresh, fresh.firewall_id, "settle_insufficient");
    if (claimed) reaped += 1;
  }
  return reaped;
}

/**
 * 计费 Cron 的兜底（2026-11-18）：enrollment 过期仍停在 booting / installing / verifying 的机器，
 * 用户可能已经关掉 App，list/get 永远不会再触发 `refreshBooting`——它们会一直计费，DO 那边也一直计费。
 * 这里按「没建成」销毁：关单 + 退已扣的钱（destroyInstance 负责）。
 *
 * 不看 `enrollment_used_at`：已回传 enroll 但在 activate 前进程死掉的机器同样永远 booting，
 * 而且正是 consume token 之后最容易出的形态。`used_at` 只用来区分失败原因——
 * 从没回传过是 `enrollment_timeout`，回传过但没激活是 `activate_stalled`。
 *
 * 按 `(enrollment_expires_at, id)` 游标分页扫：销毁失败的行不占销毁名额，
 * 也不会像「单次 LIMIT 50」那样把后面的行挡在窗口外。
 */
export async function sweepExpiredEnrollments(env: ServersEnv): Promise<number> {
  if (!env.DB) return 0;
  const db = env.DB;
  const now = Date.now();

  let destroyed = 0;
  let cursorExpires = -1;
  let cursorId = "";
  for (let page = 0; page < ENROLL_REAP_PAGES && destroyed < ENROLL_REAP_BATCH; page += 1) {
    const rows = await db
      .prepare(
        "SELECT * FROM servers WHERE state IN ('booting', 'installing', 'verifying') " +
          "AND enrollment_expires_at IS NOT NULL AND enrollment_expires_at < ? " +
          "AND destroyed_at IS NULL " +
          "AND (enrollment_expires_at > ? OR (enrollment_expires_at = ? AND id > ?)) " +
          "ORDER BY enrollment_expires_at ASC, id ASC LIMIT ?",
      )
      .bind(now, cursorExpires, cursorExpires, cursorId, ENROLL_REAP_SCAN)
      .all<ServerRow>();
    const pageRows = rows.results ?? [];
    if (pageRows.length === 0) break;

    for (const row of pageRows) {
      if (destroyed >= ENROLL_REAP_BATCH) break;
      // 扫描到处理之间可能已被别处销毁或刚回传：以库里的最新行为准。
      const fresh = await db
        .prepare("SELECT * FROM servers WHERE id = ? AND account_id = ?")
        .bind(row.id, row.account_id)
        .first<ServerRow>();
      if (
        !fresh ||
        !PROGRESS_STATES.includes(fresh.state) ||
        fresh.destroyed_at != null ||
        fresh.enrollment_expires_at == null ||
        Number(fresh.enrollment_expires_at) >= now
      ) {
        continue;
      }

      // 先记住阶段：销毁会改状态，不能拿改过的值写 failure_stage。
      const stage = fresh.state;
      const reason = stageTimeoutReason(stage, fresh.enrollment_used_at);
      const outcome = await destroyInstance(env, fresh, reason, { failureStage: stage });
      if (!outcome.ok) {
        console.error(
          `[billing] enroll_reap_failed server=${fresh.id} reason=${outcome.reason}`,
        );
        continue;
      }
      destroyed += 1;
      await db
        .prepare(
          `INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'provision.${reason}', ?)`,
        )
        .bind(
          now,
          fresh.account_id,
          fresh.id,
          JSON.stringify({
            enrollment_expires_at: fresh.enrollment_expires_at,
            enrollment_used_at: fresh.enrollment_used_at,
          }),
        )
        .run()
        // 机器已销毁、钱已退：审计写不进去不能反过来让本轮失败。
        .catch(() => {});
    }

    const last = pageRows[pageRows.length - 1];
    cursorExpires = Number(last.enrollment_expires_at ?? 0);
    cursorId = last.id;
    if (pageRows.length < ENROLL_REAP_SCAN) break;
  }
  return destroyed;
}

async function listServers(request: Request, env: ServersEnv): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const result = await env.DB.prepare(
    "SELECT s.*, o.charge_mode AS charge_mode FROM servers s LEFT JOIN orders o ON o.id = s.order_id " +
      "WHERE s.account_id = ? AND (s.state != 'destroyed' OR " +
      "(s.state = 'destroyed' AND s.failure_code = 'billing_unpaid' AND s.dismissed_at IS NULL)) " +
      "ORDER BY s.created_at DESC",
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

/** 名字按 Unicode 码点计长：中文与单个 emoji 都算 1。 */
const NAME_MIN_CODE_POINTS = 1;
const NAME_MAX_CODE_POINTS = 24;

/** PATCH /v1/servers/{id} { name }：只能改自己的，允许重名。 */
async function rename(request: Request, env: ServersEnv, serverId: string): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  let body: { name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("PRECONDITION_FAILED", "请求体不是合法 JSON");
  }
  const raw = typeof body.name === "string" ? body.name.trim() : "";
  const length = [...raw].length;
  if (length < NAME_MIN_CODE_POINTS || length > NAME_MAX_CODE_POINTS) {
    return apiError("INVALID_ARGUMENT", "名字需要 1–24 个字符", {
      reason: "invalid_name",
      details: {
        min_length: NAME_MIN_CODE_POINTS,
        max_length: NAME_MAX_CODE_POINTS,
      },
    });
  }

  // 按 account_id 过滤：别人的服务器与不存在一律 404，不泄露是否真的存在。
  const row = await loadServer(env.DB, identity.accountId, serverId);
  if (!row) return apiError("NOT_FOUND", "没有这台服务器");

  // 与销毁并发时要按最新状态判断：销毁中/已销毁的机器不能再改名（会发出误导的 renamed 事件）。
  const updated = await env.DB.prepare(
    "UPDATE servers SET name = ?, updated_at = ? WHERE id = ? AND account_id = ? " +
      "AND destroyed_at IS NULL AND state NOT IN ('destroying', 'destroyed')",
  )
    .bind(raw, Date.now(), serverId, identity.accountId)
    .run();
  if (Number((updated as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
    return apiError("NOT_FOUND", "没有这台服务器");
  }
  row.name = raw;

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

/**
 * 计费窗口内扣不动（余额不足）：停机销毁，没有宽限、不可恢复。
 *
 * 由每小时 Cron 触发。销毁失败（DO 暂时删不掉）返回 `false`，状态由
 * `destroyInstance` 还原，下一轮 Cron 继续试；返回 `true` 表示机器已经不在。
 */
export async function destroyUnpaidServer(
  env: ServersEnv,
  serverId: string,
  accountId: string,
): Promise<boolean> {
  if (!env.DB) return false;
  const row = await loadServer(env.DB, accountId, serverId);
  if (!row) return true;
  if (row.state === "destroyed") return true;
  const outcome = await destroyInstance(env, row, "billing_unpaid");
  return outcome.ok;
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
  // key_id 是发给客户端的验签索引：拿错密钥签出去，客户端会直接拒收。
  // 每个环境在 wrangler 里配自己的 key_id；缺了就拒绝签发，不回退到任何默认值。
  const keyId = env.CREDENTIAL_KEY_ID;
  if (!keyId) {
    return apiError("INTERNAL", "凭据签名密钥未配置", { reason: "credential_key_missing" });
  }

  const signature = await signDetached(env.CREDENTIAL_SIGNING_JWK, payload);

  return json({ payload, signature, key_id: keyId });
}

/**
 * POST /v1/servers/{id}/dismiss：用户忽略「余额不足停机」留下的墓碑行。
 *
 * 只对 `state = 'destroyed' AND failure_code = 'billing_unpaid'` 生效；重复调用幂等。
 * 手动销毁的行不会出现在列表里，也不该有忽略入口。
 */
async function dismiss(request: Request, env: ServersEnv, serverId: string): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const row = await loadServer(env.DB, identity.accountId, serverId);
  if (!row || row.state !== "destroyed" || row.failure_code !== "billing_unpaid") {
    return apiError("NOT_FOUND", "没有这台服务器");
  }
  if (row.dismissed_at == null) {
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE servers SET dismissed_at = ?, updated_at = ? WHERE id = ? AND account_id = ?",
    )
      .bind(now, now, serverId, identity.accountId)
      .run();
  }
  return new Response(null, { status: 204 });
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
  if (parts.length === 3 && request.method === "PATCH") return rename(request, env, parts[2]);
  if (parts.length === 4 && post) {
    if (parts[3] === "destroy") return destroy(request, env, parts[2]);
    if (parts[3] === "dismiss") return dismiss(request, env, parts[2]);
    if (parts[3] === "credentials") return credentials(request, env, parts[2]);
    if (parts[3] === "rebuild") {
      return apiError("PRECONDITION_FAILED", "重建还没接入", {
        reason: "rebuild_not_supported",
      });
    }
  }
  return null;
}
