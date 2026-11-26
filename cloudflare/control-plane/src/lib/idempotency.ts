// 幂等键（runtime §19.5）：同 key 同请求体原样回放，同 key 不同体拒绝。
// 订单与充值共用同一张表，按 endpoint 隔离。

import { sha256B64u } from "./crypto";
import { apiError, json } from "./http";

export interface StoredResponse {
  status: number;
  body: unknown;
}

/** 占位超过这个时间还没写完，视为上一个请求已经死掉，允许接管。 */
const STALE_MS = 120 * 1000;
/**
 * 5xx / 429 回放的保质期：2xx 永久回放（重复点只会拿到同一结果），
 * 但上游故障与频控都是暂时的，永久回放会让重试在同一 key 下永远拿到旧错误。
 */
const FAILED_REPLAY_MS = 60 * 1000;

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

export function idempotencyKey(request: Request): string | null {
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  return key.length >= 8 && key.length <= 128 ? key : null;
}

export function requestHashOf(body: unknown): Promise<string> {
  return sha256B64u(JSON.stringify(body));
}

export async function withIdempotency(
  db: D1Database,
  accountId: string,
  endpoint: string,
  key: string,
  requestHash: string,
  run: () => Promise<StoredResponse>,
): Promise<Response> {
  const now = Date.now();
  const existing = await db.prepare(
    "SELECT request_hash, status, response, created_at FROM idempotency_keys WHERE account_id = ? AND endpoint = ? AND key = ?",
  )
    .bind(accountId, endpoint, key)
    .first<{ request_hash: string; status: number; response: string | null; created_at: number }>();

  let claimed = false;
  if (existing) {
    if (existing.request_hash !== requestHash) {
      return apiError("PRECONDITION_FAILED", "同一个幂等键被用在了不同的请求上", {
        reason: "idempotency_conflict",
      });
    }
    const failedExpired =
      isTransientStatus(existing.status) &&
      Number(existing.created_at) <= now - FAILED_REPLAY_MS;
    if (existing.status !== 0 && !failedExpired) {
      const stored = JSON.parse(existing.response ?? "{}") as StoredResponse;
      return json(stored.body, stored.status);
    }
    if (failedExpired) {
      // 过期的失败结果：条件更新回占位，只有一个请求能接管；并发其余按「处理中」拒绝。
      const reclaimed = await db
        .prepare(
          "UPDATE idempotency_keys SET status = 0, response = NULL, request_hash = ?, created_at = ? " +
            "WHERE account_id = ? AND endpoint = ? AND key = ? AND status = ? AND created_at = ?",
        )
        .bind(requestHash, now, accountId, endpoint, key, existing.status, existing.created_at)
        .run();
      if (!reclaimed.meta.changes) {
        return apiError("PRECONDITION_FAILED", "这个请求正在处理中", {
          retryable: true,
          reason: "idempotency_in_flight",
        });
      }
      claimed = true;
    }
    if (claimed) {
      // 已接管，跳过下面的占位逻辑。
    } else {
      if (Number(existing.created_at) > now - STALE_MS) {
        return apiError("PRECONDITION_FAILED", "这个请求正在处理中", {
          retryable: true,
          reason: "idempotency_in_flight",
        });
      }
      // 超时未完成视为进程已死，接管这一行；条件更新保证只有一个请求真正接管。
      const takeover = await db
        .prepare(
          "UPDATE idempotency_keys SET created_at = ? WHERE account_id = ? AND endpoint = ? AND key = ? AND status = 0 AND created_at = ?",
        )
        .bind(now, accountId, endpoint, key, existing.created_at)
        .run();
      if (!takeover.meta.changes) {
        return apiError("PRECONDITION_FAILED", "这个请求正在处理中", {
          retryable: true,
          reason: "idempotency_in_flight",
        });
      }
      claimed = true;
    }
  }

  if (!claimed) {
    // OR IGNORE：并发同键只有一条能占位，否则第二条会撞主键直接 500。
    const claim = await db
      .prepare(
        "INSERT OR IGNORE INTO idempotency_keys (account_id, endpoint, key, request_hash, status, created_at) VALUES (?, ?, ?, ?, 0, ?)",
      )
      .bind(accountId, endpoint, key, requestHash, now)
      .run();
    if (!claim.meta.changes) {
      // 没抢到：并发请求刚占了位，交给对方完成。
      return apiError("PRECONDITION_FAILED", "这个请求正在处理中", {
        retryable: true,
        reason: "idempotency_in_flight",
      });
    }
  }

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
