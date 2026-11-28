import { afterEach, describe, expect, it, vi } from "vitest";

import { pruneDestroyedServers, pruneOpsAudit, pruneServerTraffic, runBilling } from "../src/billing";
import { openMigratedDb, sqliteAvailable, type SqliteD1 } from "./helpers/sqliteD1";

const DAY_MS = 24 * 3600 * 1000;
const NOW = Date.parse("2026-11-26T00:00:00Z");

// Node 22 上 node:sqlite 需要 --experimental-sqlite；拿不到就跳过，不让环境差异变成红。
const hasSqlite = sqliteAvailable();
if (!hasSqlite) {
  console.warn(
    "[retention_sqlite] 跳过真实 SQL 用例：node:sqlite 不可用（Node 22 需要 --experimental-sqlite）",
  );
}
const describeSqlite = hasSqlite ? describe : describe.skip;

function envWith(db: SqliteD1) {
  return { DB: db as unknown as D1Database, ENVIRONMENT: "test" };
}

function addTraffic(
  db: SqliteD1,
  serverId: string,
  cycleId: string,
  seq: number,
  updatedAt: number,
): void {
  db.run(
    "INSERT INTO server_traffic (server_id, cycle_id, bytes, released_bytes, charged_cents, last_seq, updated_at) " +
      "VALUES (?, ?, 0, 0, 0, ?, ?)",
    serverId,
    cycleId,
    seq,
    updatedAt,
  );
}

function addAudit(db: SqliteD1, action: string, at: number): void {
  db.run(
    "INSERT INTO audit_log (at, account_id, action, detail) VALUES (?, 'acct_sql', ?, '{}')",
    at,
    action,
  );
}

function addOrder(db: SqliteD1, id: string, state: string): void {
  db.run(
    "INSERT INTO orders (id, account_id, region, plan, amount_usd, amount_cents, hourly_usd, state, idempotency_key, created_at) " +
      "VALUES (?, 'acct_sql', 'sgp1', 's-1vcpu-1gb', 0, 0, 0, ?, ?, ?)",
    id,
    state,
    id,
    NOW,
  );
}

function addServer(
  db: SqliteD1,
  id: string,
  state: string,
  destroyedAt: number | null,
  orderId: string,
  port: number,
): void {
  db.run(
    "INSERT INTO servers (id, account_id, order_id, name, region, plan, hourly_usd, monthly_usd, " +
      "daily_price_cents, billing_anchor_at, state, node_port, created_at, updated_at, destroyed_at) " +
      "VALUES (?, 'acct_sql', ?, 'n', 'sgp1', 's-1vcpu-1gb', 0, 0, 0, 0, ?, ?, ?, ?, ?)",
    id,
    orderId,
    state,
    port,
    NOW,
    NOW,
    destroyedAt,
  );
  db.run(
    "INSERT INTO credentials (server_id, key_version, iv, ciphertext, created_at) VALUES (?, 1, 'iv', 'ct', ?)",
    id,
    NOW,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describeSqlite("保留清理 · 真实 SQL（node:sqlite + 全部迁移）", () => {
  it("D1 参数上限回归：绑定超过 100 个参数直接抛错", async () => {
    const db = await openMigratedDb();
    try {
      const tooMany = Array.from({ length: 101 }, (_, index) => index);
      expect(() => db.prepare("SELECT 1").bind(...tooMany)).toThrow(/100/);
      // 100 个参数仍然可用（99 个 id + 1 个 cutoff 恰好是上限）。
      expect(() => db.prepare("SELECT 1").bind(...tooMany.slice(0, 100))).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("三条谓词都生效：当前周期行与最大 seq 行保留，其余超龄行删除", async () => {
    const db = await openMigratedDb();
    try {
      addTraffic(db, "srv_a", "2026-11", 1, NOW - 90 * DAY_MS); // 当前周期
      addTraffic(db, "srv_a", "2026-10", 50, NOW - 90 * DAY_MS); // 历史最大 seq
      addTraffic(db, "srv_a", "2026-09", 2, NOW - 90 * DAY_MS); // 删除
      addTraffic(db, "srv_b", "2026-09", 7, NOW - 90 * DAY_MS); // 最大 seq
      addTraffic(db, "srv_b", "2026-08", 3, NOW - 90 * DAY_MS); // 删除
      addTraffic(db, "srv_c", "2026-10", 3, NOW - DAY_MS); // 未超龄

      expect(await pruneServerTraffic(envWith(db), NOW)).toBe(2);

      const left = db.rows<{ server_id: string; cycle_id: string }>(
        "SELECT server_id, cycle_id FROM server_traffic ORDER BY server_id, cycle_id",
      );
      expect(left.map((row) => `${row.server_id}:${row.cycle_id}`)).toEqual([
        "srv_a:2026-10",
        "srv_a:2026-11",
        "srv_b:2026-09",
        "srv_c:2026-10",
      ]);
    } finally {
      db.close();
    }
  });

  it("servers、credentials、计量行同批删；paid/provisioning 订单的机器保留", async () => {
    const db = await openMigratedDb();
    try {
      addOrder(db, "ord_failed", "failed");
      addOrder(db, "ord_pending", "provisioning");
      addOrder(db, "ord_ready", "ready");

      addServer(db, "srv_old", "destroyed", NOW - 46 * DAY_MS, "ord_failed", 1);
      addServer(db, "srv_pending", "destroyed", NOW - 46 * DAY_MS, "ord_pending", 2);
      addServer(db, "srv_recent", "destroyed", NOW - 44 * DAY_MS, "ord_recent", 3);
      addServer(db, "srv_alive", "active", null, "ord_alive", 4);
      for (const id of ["srv_old", "srv_pending", "srv_recent", "srv_alive"]) {
        addTraffic(db, id, "2026-09", 1, NOW - 46 * DAY_MS);
      }

      expect(await pruneDestroyedServers(envWith(db), NOW)).toBe(1);

      const servers = db.rows<{ id: string }>("SELECT id FROM servers ORDER BY id");
      expect(servers.map((row) => row.id)).toEqual([
        "srv_alive",
        "srv_pending",
        "srv_recent",
      ]);
      const credentials = db.rows<{ server_id: string }>(
        "SELECT server_id FROM credentials ORDER BY server_id",
      );
      expect(credentials.map((row) => row.server_id)).toEqual([
        "srv_alive",
        "srv_pending",
        "srv_recent",
      ]);
      const traffic = db.rows<{ server_id: string }>(
        "SELECT server_id FROM server_traffic ORDER BY server_id",
      );
      expect(traffic.map((row) => row.server_id)).toEqual([
        "srv_alive",
        "srv_pending",
        "srv_recent",
      ]);
    } finally {
      db.close();
    }
  });

  it("运维审计只删 ops.* 且超过 12 个月；业务审计与 11 个月前的运维审计保留", async () => {
    const db = await openMigratedDb();
    try {
      addAudit(db, "ops.ticket.issued", NOW - 400 * DAY_MS);
      addAudit(db, "ops.ticket.issued", NOW - 400 * DAY_MS);
      addAudit(db, "ops.status.read", NOW - 400 * DAY_MS);
      addAudit(db, "ops.ticket.issued", NOW - 330 * DAY_MS);
      addAudit(db, "enroll.ok", NOW - 400 * DAY_MS);
      addAudit(db, "settle.ok", NOW - 400 * DAY_MS);
      addAudit(db, "destroy.ok", NOW - 400 * DAY_MS);

      expect(await pruneOpsAudit(envWith(db), NOW)).toBe(3);

      const left = db.rows<{ action: string }>("SELECT action FROM audit_log ORDER BY id");
      expect(left.map((row) => row.action)).toEqual([
        "ops.ticket.issued",
        "enroll.ok",
        "settle.ok",
        "destroy.ok",
      ]);
    } finally {
      db.close();
    }
  });

  it("接线与分页：runBilling 报告清理数量，超过一批的数据能删干净", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const db = await openMigratedDb();
    try {
      db.exec("BEGIN");
      // 1100 台机器各两个周期：2026-10 的最大 seq 保留，2026-09 的可删 → 跨两页（1000 + 100）。
      for (let index = 0; index < 1100; index += 1) {
        const id = `srv_t${index}`;
        addTraffic(db, id, "2026-09", 1, NOW - 60 * DAY_MS);
        addTraffic(db, id, "2026-10", 2, NOW - 60 * DAY_MS);
      }
      // 120 台超龄已销毁机器 → 99 + 21 两页删完。
      for (let index = 0; index < 120; index += 1) {
        addServer(db, `srv_d${index}`, "destroyed", NOW - 46 * DAY_MS, `ord_d${index}`, 1000 + index);
      }
      // 运维审计：超龄的删、业务审计同岁也保留。
      addAudit(db, "ops.ticket.issued", NOW - 400 * DAY_MS);
      addAudit(db, "enroll.ok", NOW - 400 * DAY_MS);
      db.exec("COMMIT");

      const report = await runBilling(envWith(db));

      expect(report.trafficPruned).toBe(1100);
      expect(report.serversPruned).toBe(120);
      expect(report.opsAuditPruned).toBe(1);
      expect(
        db.rows<{ action: string }>("SELECT action FROM audit_log WHERE action = 'enroll.ok'"),
      ).toHaveLength(1);
      expect(Number(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM servers")[0].n)).toBe(0);
      expect(
        Number(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM credentials")[0].n),
      ).toBe(0);
      // 每台机器保留最大 seq 那一行。
      expect(
        Number(db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM server_traffic")[0].n),
      ).toBe(1100);
    } finally {
      db.close();
    }
  });
});
