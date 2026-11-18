// 幂等键回放策略：2xx 永久、5xx 只保 60 秒（上游故障是暂时的，永久回放会让重试永远拿到旧错误）。
import { describe, expect, it } from "vitest";

import { withIdempotency } from "../src/lib/idempotency";
import { sha256B64u } from "../src/lib/crypto";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_idem000000000000000";
const ENDPOINT = "orders.create";
const KEY = "idem-key-0000001";

async function hashOf(body: unknown): Promise<string> {
  return sha256B64u(JSON.stringify(body));
}

function seed(
  db: FakeD1,
  hash: string,
  status: number,
  createdAt: number,
  body: unknown = { code: "UPSTREAM_ERROR" },
): void {
  db.rows("idempotency_keys").push({
    account_id: ACCOUNT,
    endpoint: ENDPOINT,
    key: KEY,
    request_hash: hash,
    status,
    response: JSON.stringify({ status, body }),
    created_at: createdAt,
  });
}

function run(db: FakeD1, hash: string, result: () => { status: number; body: unknown }) {
  return withIdempotency(
    db as unknown as D1Database,
    ACCOUNT,
    ENDPOINT,
    KEY,
    hash,
    async () => result(),
  );
}

describe("幂等键", () => {
  it("2xx 永久回放：一天后再来仍返回原结果，不重新执行", async () => {
    const db = new FakeD1();
    const hash = await hashOf({ region: "sgp1" });
    seed(db, hash, 200, Date.now() - 24 * 3600 * 1000, { order_id: "ord_old" });

    let ran = 0;
    const res = await run(db, hash, () => {
      ran += 1;
      return { status: 200, body: { order_id: "ord_new" } };
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { order_id: string }).order_id).toBe("ord_old");
    expect(ran).toBe(0);
  });

  it("5xx 在 60 秒内回放，过期后允许重新执行并覆盖记录", async () => {
    const db = new FakeD1();
    const hash = await hashOf({ region: "sgp1" });

    // 刚失败：短时间重试仍拿同一个错误，避免瞬间打爆上游。
    seed(db, hash, 503, Date.now() - 10_000);
    let ran = 0;
    const recent = await run(db, hash, () => {
      ran += 1;
      return { status: 200, body: { ok: true } };
    });
    expect(recent.status).toBe(503);
    expect(ran).toBe(0);

    // 超过 60 秒：视为过期错误，重新执行。
    db.rows("idempotency_keys")[0].created_at = Date.now() - 61_000;
    const expired = await run(db, hash, () => {
      ran += 1;
      return { status: 200, body: { ok: true } };
    });
    expect(expired.status).toBe(200);
    expect(ran).toBe(1);
    expect(db.rows("idempotency_keys")).toHaveLength(1);
    expect(db.rows("idempotency_keys")[0].status).toBe(200);
  });
});
