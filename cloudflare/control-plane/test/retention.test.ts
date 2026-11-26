import { describe, expect, it } from "vitest";

import { archiveCutoff, pruneDestroyedServers, pruneServerTraffic } from "../src/billing";
import { FakeD1 } from "./helpers/fakeD1";

const DAY_MS = 24 * 3600 * 1000;
const NOW = Date.parse("2026-11-26T00:00:00Z");

function envWith(db: FakeD1) {
  return { DB: db as unknown as D1Database, ENVIRONMENT: "test" };
}

function trafficRow(overrides: Record<string, unknown>) {
  return {
    server_id: "srv_retention",
    cycle_id: "2026-09",
    bytes: 1,
    released_bytes: 1,
    charged_cents: 0,
    last_seq: 1,
    updated_at: NOW - 60 * DAY_MS,
    ...overrides,
  };
}

describe("server_traffic 保留清理", () => {
  it("当前周期行即使超龄也不删（seq 小于其它周期的最大值）", async () => {
    const db = new FakeD1();
    // 当前周期行 seq=1，旧周期行 seq=50 是历史最大：去掉周期守卫就会被当成可删行。
    db.rows("server_traffic").push(
      trafficRow({ cycle_id: "2026-11", updated_at: NOW - 90 * DAY_MS, last_seq: 1 }),
      trafficRow({ cycle_id: "2026-10", updated_at: NOW - 90 * DAY_MS, last_seq: 50 }),
    );
    const pruned = await pruneServerTraffic(envWith(db), NOW);

    expect(pruned).toBe(0);
    expect(db.rows("server_traffic")).toHaveLength(2);
  });

  it("保留该 server 的最大 last_seq 行，其余超龄行删除", async () => {
    const db = new FakeD1();
    db.rows("server_traffic").push(
      trafficRow({ cycle_id: "2026-08", last_seq: 3 }),
      trafficRow({ cycle_id: "2026-09", last_seq: 7 }),
    );
    const pruned = await pruneServerTraffic(envWith(db), NOW);

    expect(pruned).toBe(1);
    expect(db.rows("server_traffic")).toHaveLength(1);
    expect(db.rows("server_traffic")[0].cycle_id).toBe("2026-09");
    expect(db.rows("server_traffic")[0].last_seq).toBe(7);
  });

  it("未超龄的历史行不动", async () => {
    const db = new FakeD1();
    db.rows("server_traffic").push(
      trafficRow({ cycle_id: "2026-08", last_seq: 3, updated_at: NOW - 44 * DAY_MS }),
      trafficRow({ cycle_id: "2026-09", last_seq: 7, updated_at: NOW - 44 * DAY_MS }),
    );
    expect(await pruneServerTraffic(envWith(db), NOW)).toBe(0);
    expect(db.rows("server_traffic")).toHaveLength(2);
  });
});

describe("servers 与 credentials 保留清理", () => {
  it("已销毁超 45 天的 servers、credentials 与计量行同批删除，其余不动", async () => {
    const db = new FakeD1();
    db.rows("servers").push(
      { id: "srv_old", state: "destroyed", destroyed_at: NOW - 46 * DAY_MS, order_id: "ord_failed" },
      {
        id: "srv_recent",
        state: "destroyed",
        destroyed_at: NOW - 44 * DAY_MS,
        order_id: "ord_ready",
      },
      { id: "srv_alive", state: "active", destroyed_at: null, order_id: "ord_ready" },
      // P2-2：订单仍在 provisioning（用户在 provisioning 阶段主动销毁），不能删。
      {
        id: "srv_pending",
        state: "destroyed",
        destroyed_at: NOW - 46 * DAY_MS,
        order_id: "ord_pending",
      },
    );
    db.rows("orders").push({ id: "ord_pending", state: "provisioning" });
    for (const id of ["srv_old", "srv_recent", "srv_alive", "srv_pending"]) {
      db.rows("credentials").push({ server_id: id });
      db.rows("server_traffic").push({
        server_id: id,
        cycle_id: "2026-09",
        bytes: 1,
        released_bytes: 1,
        charged_cents: 0,
        last_seq: 1,
        updated_at: NOW - 46 * DAY_MS,
      });
    }

    const pruned = await pruneDestroyedServers(envWith(db), NOW);

    expect(pruned).toBe(1);
    expect(db.rows("servers").map((row) => row.id)).toEqual([
      "srv_recent",
      "srv_alive",
      "srv_pending",
    ]);
    expect(db.rows("credentials").map((row) => row.server_id)).toEqual([
      "srv_recent",
      "srv_alive",
      "srv_pending",
    ]);
    // servers 行被删时，它的计量行同批删掉；其余机器的行保留。
    expect(db.rows("server_traffic").map((row) => row.server_id)).toEqual([
      "srv_recent",
      "srv_alive",
      "srv_pending",
    ]);
  });
});

describe("账本裁剪边界", () => {
  it.each([
    ["2026-03-01T00:00:00Z", "2026-01-29T00:00:00Z"],
    ["2026-03-02T12:00:00Z", "2026-01-30T12:00:00Z"],
  ])("%s 的边界夹到 now − 31 天", (nowIso, expectedIso) => {
    const now = Date.parse(nowIso);
    expect(archiveCutoff(now)).toBe(Date.parse(expectedIso));
    expect(now - archiveCutoff(now)).toBeGreaterThanOrEqual(31 * DAY_MS);
  });

  it("4 月 1 日不会因为上上个月末更早而少于 31 天", () => {
    const now = Date.parse("2026-04-01T00:00:00Z");
    expect(now - archiveCutoff(now)).toBeGreaterThanOrEqual(31 * DAY_MS);
    // 上上个月末（2 月末）比 now − 31 天早 1 毫秒，仍要夹到 now − 31 天。
    expect(archiveCutoff(now)).toBe(Date.parse("2026-03-01T00:00:00Z") - 1);
  });
});
