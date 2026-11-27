// 流量上报的写入走真实 SQL：FakeD1 只按 SQL 前缀分流、不校验列名与占位符，
// 生产 INSERT 写错列在 fake 里一样全绿，上线才会 500。这里验的是控制面实际发出的语句。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleTraffic } from "../src/traffic";
import { sha256B64u } from "../src/lib/crypto";
import { openMigratedDb, sqliteAvailable, type SqliteD1 } from "./helpers/sqliteD1";

const ACCOUNT = "acct_traffic_sqlite";
const SERVER = "srv_traffic_sqlite";
const TOKEN = "agent-token-traffic-sqlite";
const NOW = Date.parse("2026-11-26T12:00:00Z");
const DAY_MS = 24 * 3600 * 1000;
const GIB = 1024 ** 3;

// Node 22 上 node:sqlite 需要 --experimental-sqlite；拿不到就跳过，不让环境差异变成红。
const hasSqlite = sqliteAvailable();
if (!hasSqlite) {
  console.warn(
    "[traffic_sqlite] 跳过真实 SQL 用例：node:sqlite 不可用（Node 22 需要 --experimental-sqlite）",
  );
}
const describeSqlite = hasSqlite ? describe : describe.skip;

async function setup(): Promise<SqliteD1> {
  const db = await openMigratedDb();
  const anchor = Date.UTC(2026, 10, 1);
  db.run(
    "INSERT INTO accounts (id, kind, email, status, balance_cents, created_at) VALUES (?, 'email', ?, 'active', 10000, ?)",
    ACCOUNT,
    "traffic@example.com",
    NOW - 60 * DAY_MS,
  );
  db.run(
    "INSERT INTO servers (id, account_id, order_id, name, region, plan, hourly_usd, monthly_usd, " +
      "daily_price_cents, billing_anchor_at, state, node_port, transfer_gib, ready_at, " +
      "created_at, updated_at, paid_until, server_token_hash) " +
      "VALUES (?, ?, ?, '机器', 'sgp1', 's-1vcpu-1gb', 0, 0, 20, ?, 'healthy', 40001, 100, ?, ?, ?, ?, ?)",
    SERVER,
    ACCOUNT,
    "ord_traffic_sqlite",
    anchor,
    anchor,
    anchor,
    NOW,
    NOW + DAY_MS,
    await sha256B64u(TOKEN),
  );
  return db;
}

function reportRequest(seq: number, deltaBytes: number): Request {
  return new Request("https://example.com/v1/agent/traffic", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ seq, delta_bytes: deltaBytes }),
  });
}

interface TrafficRow extends Record<string, unknown> {
  bytes: number;
  released_bytes: number;
  charged_cents: number;
  last_seq: number;
}

function trafficRows(db: SqliteD1): TrafficRow[] {
  return db.rows<TrafficRow>(
    "SELECT bytes, released_bytes, charged_cents, last_seq FROM server_traffic " +
      "WHERE server_id = ? AND cycle_id = '2026-11'",
    SERVER,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describeSqlite("流量上报的写入 · 真实 SQL", () => {
  it("上报一次：行写进去、bytes 正确、released_bytes 是 schema 默认 0", async () => {
    const db = await setup();
    try {
      const response = await handleTraffic(reportRequest(1, 3 * GIB), {
        DB: db as unknown as D1Database,
      });

      expect(response?.status).toBe(200);
      expect(trafficRows(db)).toEqual([
        { bytes: 3 * GIB, released_bytes: 0, charged_cents: 0, last_seq: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  it("同一 seq 重放：不累加 bytes（ON CONFLICT 的 last_seq 守卫也走真实 SQL）", async () => {
    const db = await setup();
    try {
      await handleTraffic(reportRequest(1, 3 * GIB), { DB: db as unknown as D1Database });
      const replay = await handleTraffic(reportRequest(1, 3 * GIB), {
        DB: db as unknown as D1Database,
      });

      expect(replay?.status).toBe(200);
      expect(trafficRows(db)).toEqual([
        { bytes: 3 * GIB, released_bytes: 0, charged_cents: 0, last_seq: 1 },
      ]);
    } finally {
      db.close();
    }
  });
});
