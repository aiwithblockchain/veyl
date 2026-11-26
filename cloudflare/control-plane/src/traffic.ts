// 节点流量计量与超支扣费（docs/design/traffic-billing.md §4–§7）。
//
// agent 只上报增量字节数；周期归属、去重、额度与扣费全部在控制面做。
// 三条硬约束：
// 1) seq 按 server 单调递增、跨周期不清零，`seq <= last_seq` 一律不记账；
// 2) 归属周期 = 收到请求时的 UTC 年月，不信任客户端；
// 3) 超额按账号总已用 / 总已释放判断，只扣增量，余额扣不动就停机。

import { sha256B64u } from "./lib/crypto";
import { json } from "./lib/http";
import { destroyUnpaidServer, type ServersEnv } from "./servers";
import { GIB, cycleIdOf, releasedBytes, type ReleasedRow } from "./traffic_cycle";
import { accountTotals, type TrafficTotals } from "./traffic_pool";
import { balanceCents, recordLedgerEntry } from "./wallet";

// 周期与额度的纯函数在 traffic_cycle.ts（断开与 servers.ts 的循环 import），
// 这里沿用旧导出，调用点不用改。
export { cycleIdOf, cycleStartOf, releasedBytes, GIB, DAY_MS, RELEASE_DAYS } from "./traffic_cycle";
export type { ReleasedRow } from "./traffic_cycle";

/** 超出单价：$0.02/GiB = 2 分/GiB（§3）。 */
const CENTS_PER_GIB = 2;

export interface TrafficEnv {
  DB?: D1Database;
  DO_API_TOKEN?: string;
}

interface TrafficServerRow extends ReleasedRow {
  id: string;
  account_id: string;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token === "" ? null : token;
}

function agentJson(body: unknown, status = 200): Response {
  return json(body, status, { "cache-control": "no-store" });
}

function dueCents(totals: TrafficTotals): number {
  const overBytes = Math.max(0, totals.used - totals.released);
  return Math.floor((overBytes / GIB) * CENTS_PER_GIB);
}

/**
 * 按 §5.1 结算本次上报后的超支增量：
 * 应付 = floor(账号超出字节 / GiB × 2)，本次应扣 = max(0, 应付 − 账号已扣)。
 * 余额不足时扣到 0，再走现有停机销毁路径（原因 `traffic_overage`）。
 */
async function settleOverage(
  env: TrafficEnv,
  db: D1Database,
  server: TrafficServerRow,
  cycleId: string,
  seq: number,
  now: number,
): Promise<void> {
  const totals = await accountTotals(db, server.account_id, cycleId, now);
  const due = dueCents(totals);
  const delta = Math.max(0, due - totals.charged);
  if (delta <= 0) return;

  const balance = await balanceCents({ DB: db }, server.account_id);
  if (balance <= 0) {
    await destroyForTraffic(env, server);
    return;
  }

  const pay = Math.min(delta, balance);
  // 并发上报可能同时算出同一笔增量：守卫要求「账号已扣」仍等于本次读取值，
  // 否则这笔不写（另一笔已经扣过），不会重复收钱。
  const result = await recordLedgerEntry(
    { DB: db },
    {
      accountId: server.account_id,
      kind: "charge",
      amountCents: -pay,
      refType: "server_traffic",
      refId: `${server.id}:${cycleId}:${seq}`,
      note: `流量超支 ${cycleId}`,
      guard: {
        sql:
          "SELECT 1 FROM server_traffic st JOIN servers s ON s.id = st.server_id " +
          "WHERE s.account_id = ? AND st.cycle_id = ? AND (" +
          "SELECT COALESCE(SUM(st2.charged_cents), 0) FROM server_traffic st2 " +
          "JOIN servers s2 ON s2.id = st2.server_id " +
          "WHERE s2.account_id = ? AND st2.cycle_id = ?) <= ?",
        args: [server.account_id, cycleId, server.account_id, cycleId, totals.charged],
      },
      followUps: (ledgerId) => [
        db
          .prepare(
            "UPDATE server_traffic SET charged_cents = charged_cents + ? " +
              "WHERE server_id = ? AND cycle_id = ? AND EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ?)",
          )
          .bind(pay, server.id, cycleId, ledgerId),
      ],
    },
  );

  if (result.ok || result.reason === "duplicate") {
    if (pay < delta) await destroyForTraffic(env, server);
    return;
  }
  if (result.reason !== "insufficient") return;

  // 充值前的余额可能刚被另一笔并发上报扣掉：复核一次，只有确实还欠且余额为 0 才停机。
  const after = await accountTotals(db, server.account_id, cycleId, now);
  if (dueCents(after) > after.charged && (await balanceCents({ DB: db }, server.account_id)) <= 0) {
    await destroyForTraffic(env, server);
  }
}

async function destroyForTraffic(env: TrafficEnv, server: TrafficServerRow): Promise<void> {
  const destroyed = await destroyUnpaidServer(
    env as ServersEnv,
    server.id,
    server.account_id,
    "traffic_overage",
  );
  if (!destroyed) {
    // 销毁失败（DO 暂时删不掉）由状态还原兜底，下一轮计费 Cron 继续按欠费处理。
    console.warn(`[traffic] destroy_failed server=${server.id} reason=traffic_overage`);
  }
}

/**
 * POST /v1/agent/traffic（§7.2，契约冻结）。
 *
 * 请求 `{ seq, delta_bytes }`；200 `{ ok: true }`、400 invalid_body、
 * 401 unknown token、409 server_destroyed。`seq <= last_seq` 回 200 但不记账。
 */
export async function handleTraffic(
  request: Request,
  env: TrafficEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/agent/traffic" || request.method !== "POST") return null;
  const db = env.DB;
  if (!db) return agentJson({ ok: false, reason: "unavailable" }, 503);

  const token = bearerToken(request);
  if (!token) return agentJson({ ok: false, reason: "missing_token" }, 401);

  const server = await db
    .prepare("SELECT * FROM servers WHERE server_token_hash = ?")
    .bind(await sha256B64u(token))
    .first<TrafficServerRow>();
  if (!server) return agentJson({ ok: false, reason: "unknown_token" }, 401);
  if (server.destroyed_at !== null) {
    return agentJson({ ok: false, reason: "server_destroyed" }, 409);
  }

  let body: { seq?: unknown; delta_bytes?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return agentJson({ ok: false, reason: "invalid_body" }, 400);
  }
  const seq = body.seq;
  const delta = body.delta_bytes;
  if (
    typeof seq !== "number" ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    typeof delta !== "number" ||
    !Number.isSafeInteger(delta) ||
    delta < 0
  ) {
    return agentJson({ ok: false, reason: "invalid_body" }, 400);
  }

  const now = Date.now();
  const cycleId = cycleIdOf(now);

  // 去重按 server、跨周期：上次接受过的最大序号在同一台机器的任何周期行里。
  // 没有任何行时取 -1，这样从 0 开始的序号也能被接受一次（之后严格递增）。
  const last = await db
    .prepare(
      "SELECT COALESCE(MAX(last_seq), -1) AS last_seq FROM server_traffic WHERE server_id = ?",
    )
    .bind(server.id)
    .first<{ last_seq: number }>();
  if (seq <= Number(last?.last_seq ?? 0)) {
    return agentJson({ ok: true });
  }

  const released = releasedBytes(server, cycleId, now);
  // 同一笔写入里累加并推进 last_seq；last_seq 已被并发请求推高时 changes = 0，按重复处理。
  const written = await db
    .prepare(
      "INSERT INTO server_traffic (server_id, cycle_id, bytes, released_bytes, charged_cents, last_seq, updated_at) " +
        "VALUES (?, ?, ?, ?, 0, ?, ?) " +
        "ON CONFLICT(server_id, cycle_id) DO UPDATE SET " +
        "bytes = server_traffic.bytes + excluded.bytes, " +
        "released_bytes = MAX(server_traffic.released_bytes, excluded.released_bytes), " +
        "last_seq = excluded.last_seq, updated_at = excluded.updated_at " +
        "WHERE server_traffic.last_seq < excluded.last_seq",
    )
    .bind(server.id, cycleId, delta, released, seq, now)
    .run();
  if (Number((written as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
    return agentJson({ ok: true });
  }

  // §6.7：上报刷新活跃时间，但控制面不据此做任何动作。
  await db
    .prepare("UPDATE servers SET last_seen_at = ? WHERE id = ?")
    .bind(now, server.id)
    .run()
    .catch(() => {});

  // 额度未知的旧行（transfer_gib = 0）只累计，不扣费——没有月额度就算不出公平的超支。
  if (Math.round(Math.max(0, Number(server.transfer_gib ?? 0)) * GIB) > 0) {
    await settleOverage(env, db, server, cycleId, seq, now);
  }

  return agentJson({ ok: true });
}
