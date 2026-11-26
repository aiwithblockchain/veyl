import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleServers } from "../src/servers";
import { signAccessToken } from "../src/lib/crypto";
import { accountTotals } from "../src/traffic_pool";
import { openMigratedDb, sqliteAvailable, type SqliteD1 } from "./helpers/sqliteD1";

const ACCOUNT = "acct_traffic_view";
const DEVICE = "dev_traffic_view";
const NOW = Date.parse("2026-11-26T12:00:00Z");
const CYCLE = "2026-11";
const DAY_MS = 24 * 3600 * 1000;
const GIB = 1024 ** 3;

// Node 22 上 node:sqlite 需要 --experimental-sqlite；拿不到就跳过，不让环境差异变成红。
const hasSqlite = sqliteAvailable();
if (!hasSqlite) {
  console.warn(
    "[traffic_view_sqlite] 跳过真实 SQL 用例：node:sqlite 不可用（Node 22 需要 --experimental-sqlite）",
  );
}
const describeSqlite = hasSqlite ? describe : describe.skip;

async function signingJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

/**
 * §4.1 的固定期望值（不是把生产公式再算一遍）：
 * 100 GiB 月额度 = 107,374,182,400 字节；11 月 1 日 0 点建机、11 月 26 日 12 点查 =
 * 本周期存活 25 个整天 → 26 天份 = floor(107,374,182,400 × 26 / 28)。
 */
const LIMIT_100GIB_NOV26 = 99_704_597_942;
/** 同上，但 11 月 23 日 12 点销毁：存活 22 个整天 → 23 天份。 */
const LIMIT_100GIB_DESTROYED_NOV23 = 88_200_221_257;
/** near 阈值 = ceil(LIMIT × 4 / 5)，见实现的整数判据。 */
const THRESHOLD_100GIB_NOV26 = 79_763_678_354;
/** 12 月 15 日查、11 月 1 日建机：从 12 月 1 日起算 14 个整天 → 15 天份。 */
const LIMIT_100GIB_DEC15 = 57_521_883_428;

interface ServerSpec {
  id: string;
  transferGib?: number;
  readyAt?: number;
  state?: string;
  destroyedAt?: number | null;
  failureCode?: string | null;
  dismissedAt?: number | null;
  port?: number;
}

function addServer(db: SqliteD1, spec: ServerSpec): void {
  db.run(
    "INSERT INTO servers (id, account_id, order_id, name, region, plan, hourly_usd, monthly_usd, " +
      "daily_price_cents, billing_anchor_at, state, node_port, transfer_gib, ready_at, failure_code, " +
      "created_at, updated_at, destroyed_at, billing_state, dismissed_at) " +
      "VALUES (?, ?, ?, ?, 'sgp1', 's-1vcpu-1gb', 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
    spec.id,
    ACCOUNT,
    `ord_${spec.id}`,
    `机器 ${spec.id}`,
    spec.readyAt ?? Date.UTC(2026, 10, 1),
    spec.state ?? "active",
    spec.port ?? 30001,
    spec.transferGib ?? 100,
    spec.readyAt ?? Date.UTC(2026, 10, 1),
    spec.failureCode ?? null,
    NOW - 60 * DAY_MS,
    NOW - 60 * DAY_MS,
    spec.destroyedAt ?? null,
    spec.dismissedAt ?? null,
  );
}

function addTraffic(db: SqliteD1, serverId: string, cycle: string, bytes: number): void {
  db.run(
    "INSERT INTO server_traffic (server_id, cycle_id, bytes, released_bytes, charged_cents, last_seq, updated_at) " +
      "VALUES (?, ?, ?, 0, 0, 1, ?)",
    serverId,
    cycle,
    bytes,
    NOW,
  );
}

async function setup(clock = NOW) {
  const db = await openMigratedDb();
  db.run(
    "INSERT INTO accounts (id, kind, email, status, balance_cents, created_at) VALUES (?, 'email', ?, 'active', 10000, ?)",
    ACCOUNT,
    "view@example.com",
    clock - 60 * DAY_MS,
  );
  db.run(
    "INSERT INTO devices (id, account_id, secret_hash, platform, app_version, refresh_family, created_at, last_seen_at) " +
      "VALUES (?, ?, 'hash', 'macos', '1.0.0', 'rf_view', ?, ?)",
    DEVICE,
    ACCOUNT,
    clock - 60 * DAY_MS,
    clock,
  );
  const jwk = await signingJwk();
  const token = await signAccessToken(jwk, {
    sub: ACCOUNT,
    did: DEVICE,
    iat: Math.floor(clock / 1000),
    exp: Math.floor(clock / 1000) + 600,
    jti: "jti_traffic_view",
  });
  const env = {
    DB: db as unknown as D1Database,
    TOKEN_SIGNING_JWK: jwk,
    ENVIRONMENT: "test",
  };
  return { db, env, token };
}

function listRequest(token: string) {
  return new Request("https://example.com/v1/servers", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function detailRequest(token: string, serverId: string) {
  return new Request(`https://example.com/v1/servers/${serverId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

type ServerBody = Record<string, unknown>;

async function listServers(db: SqliteD1, env: unknown, token: string): Promise<ServerBody[]> {
  const response = await handleServers(listRequest(token), env as never);
  expect(response?.status).toBe(200);
  const body = (await response?.json()) as { servers: ServerBody[] };
  return body.servers;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describeSqlite("MyServer 流量四字段 · 真实 SQL", () => {
  it("本周期无上报行：used=0、额度现算、state=ok、reset_at 是下个 UTC 月 1 日", async () => {
    const { db, env, token } = await setup();
    try {
      addServer(db, { id: "srv_fresh", transferGib: 100 });
      const [server] = await listServers(db, env, token);

      expect(server.traffic_used_bytes).toBe(0);
      expect(server.traffic_limit_bytes).toBe(LIMIT_100GIB_NOV26);
      expect(server.traffic_limit_bytes).toBeGreaterThan(0);
      expect(server.traffic_reset_at).toBe("2026-12-01T00:00:00.000Z");
      expect(server.traffic_state).toBe("ok");
      // 既有字段不受影响。
      expect(server.transfer_gib).toBe(100);
      expect(server.server_id).toBe("srv_fresh");
    } finally {
      db.close();
    }
  });

  it("near 边界：恰好 80% 是 near，少 1 字节仍是 ok；over 只看是否超过额度", async () => {
    const { db, env, token } = await setup();
    try {
      addServer(db, { id: "srv_near", transferGib: 100, port: 30002 });
      addServer(db, { id: "srv_under", transferGib: 100, port: 30003 });
      addServer(db, { id: "srv_over", transferGib: 100, port: 30004 });
      addTraffic(db, "srv_near", CYCLE, THRESHOLD_100GIB_NOV26);
      addTraffic(db, "srv_under", CYCLE, THRESHOLD_100GIB_NOV26 - 1);
      addTraffic(db, "srv_over", CYCLE, LIMIT_100GIB_NOV26 + 1);

      const byId = Object.fromEntries(
        (await listServers(db, env, token)).map((server) => [server.server_id, server]),
      );
      expect(byId.srv_near.traffic_state).toBe("near");
      expect(byId.srv_near.traffic_used_bytes).toBe(THRESHOLD_100GIB_NOV26);
      expect(byId.srv_near.traffic_limit_bytes).toBe(LIMIT_100GIB_NOV26);
      expect(byId.srv_under.traffic_state).toBe("ok");
      expect(byId.srv_over.traffic_state).toBe("over");
      expect(byId.srv_over.traffic_used_bytes).toBe(LIMIT_100GIB_NOV26 + 1);
    } finally {
      db.close();
    }
  });

  it("已用恰好等于额度：near，不是 over", async () => {
    const { db, env, token } = await setup();
    try {
      addServer(db, { id: "srv_exact", transferGib: 100 });
      addTraffic(db, "srv_exact", CYCLE, LIMIT_100GIB_NOV26);

      const [server] = await listServers(db, env, token);
      expect(server.traffic_used_bytes).toBe(server.traffic_limit_bytes);
      expect(server.traffic_state).toBe("near");
    } finally {
      db.close();
    }
  });

  it("上周期有上报行、本周期没有：不能把上月算进本周期", async () => {
    const { db, env, token } = await setup();
    try {
      addServer(db, { id: "srv_last_month" });
      addTraffic(db, "srv_last_month", "2026-10", 90 * GIB);

      const [server] = await listServers(db, env, token);
      expect(server.traffic_used_bytes).toBe(0);
      expect(server.traffic_state).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("因流量超支停机：已用超过额度也仍是 unpaid，已用保留；详情接口同口径", async () => {
    const { db, env, token } = await setup();
    try {
      const destroyedAt = NOW - 3 * DAY_MS;
      addServer(db, {
        id: "srv_unpaid",
        state: "destroyed",
        destroyedAt,
        failureCode: "traffic_overage",
      });
      const used = LIMIT_100GIB_DESTROYED_NOV23 + 1;
      addTraffic(db, "srv_unpaid", CYCLE, used);

      const [server] = await listServers(db, env, token);
      expect(server.traffic_state).toBe("unpaid");
      expect(server.traffic_used_bytes).toBe(used);
      expect(server.traffic_limit_bytes).toBe(LIMIT_100GIB_DESTROYED_NOV23);

      const response = await handleServers(detailRequest(token, "srv_unpaid"), env as never);
      expect(response?.status).toBe(200);
      const detail = (await response?.json()) as ServerBody;
      expect(detail).toMatchObject({
        traffic_used_bytes: used,
        traffic_limit_bytes: LIMIT_100GIB_DESTROYED_NOV23,
        traffic_reset_at: "2026-12-01T00:00:00.000Z",
        traffic_state: "unpaid",
      });
    } finally {
      db.close();
    }
  });

  it("额度未知（transfer_gib = 0）：有上报也不判 over，落 ok", async () => {
    const { db, env, token } = await setup();
    try {
      addServer(db, { id: "srv_unknown", transferGib: 0 });
      addTraffic(db, "srv_unknown", CYCLE, 100 * 1024 * 1024);

      const [server] = await listServers(db, env, token);
      expect(server.traffic_limit_bytes).toBe(0);
      expect(server.traffic_used_bytes).toBe(100 * 1024 * 1024);
      expect(server.traffic_state).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("已销毁机器的额度仍留在池里：按 destroyed_at 截止，不归零", async () => {
    const { db, env, token } = await setup();
    try {
      const destroyedAt = NOW - 3 * DAY_MS;
      addServer(db, {
        id: "srv_destroyed",
        state: "destroyed",
        destroyedAt,
        failureCode: "billing_unpaid",
        port: 30009,
      });
      // 周期开始前就销毁的机器不计额度。
      addServer(db, {
        id: "srv_before_cycle",
        state: "destroyed",
        destroyedAt: Date.UTC(2026, 9, 20),
        failureCode: "billing_unpaid",
        port: 30010,
      });

      const byId = Object.fromEntries(
        (await listServers(db, env, token)).map((server) => [server.server_id, server]),
      );
      expect(byId.srv_destroyed.traffic_limit_bytes).toBe(LIMIT_100GIB_DESTROYED_NOV23);
      expect(byId.srv_before_cycle.traffic_limit_bytes).toBe(0);
    } finally {
      db.close();
    }
  });

  it("traffic_pool 计入列表里看不到的已销毁机器与已 dismiss 的墓碑，且与 accountTotals 同源", async () => {
    const { db, env, token } = await setup();
    try {
      addServer(db, { id: "srv_live", transferGib: 100, port: 30011 });
      // 用户主动销毁：不在列表里，但扣费口径仍然计入。
      addServer(db, {
        id: "srv_gone",
        transferGib: 100,
        state: "destroyed",
        destroyedAt: NOW - 3 * DAY_MS,
        port: 30012,
      });
      // 已 dismiss 的余额不足墓碑：同样不在列表里，同样计入池子。
      addServer(db, {
        id: "srv_dismissed",
        transferGib: 100,
        state: "destroyed",
        destroyedAt: NOW - 3 * DAY_MS,
        failureCode: "billing_unpaid",
        dismissedAt: NOW - DAY_MS,
        port: 30013,
      });
      addTraffic(db, "srv_live", CYCLE, 1024);
      addTraffic(db, "srv_gone", CYCLE, 400 * GIB);
      addTraffic(db, "srv_dismissed", CYCLE, 200 * GIB);

      const response = await handleServers(listRequest(token), env as never);
      expect(response?.status).toBe(200);
      const body = (await response?.json()) as {
        servers: ServerBody[];
        traffic_pool: { used_bytes: number; limit_bytes: number };
      };
      expect(body.servers.map((server) => server.server_id)).toEqual(["srv_live"]);
      expect(body.traffic_pool).toEqual({
        used_bytes: 400 * GIB + 200 * GIB + 1024,
        limit_bytes: LIMIT_100GIB_NOV26 + 2 * LIMIT_100GIB_DESTROYED_NOV23,
      });

      // 防「另写一份求和」：必须与扣费用的 accountTotals 逐字节一致。
      const totals = await accountTotals(db as unknown as D1Database, ACCOUNT, CYCLE, NOW);
      expect(body.traffic_pool).toEqual({
        used_bytes: totals.used,
        limit_bytes: totals.released,
      });
    } finally {
      db.close();
    }
  });

  it("12 月查询：reset_at 是次年 1 月 1 日，额度按 12 月存活天数重算", async () => {
    const DEC_NOW = Date.parse("2026-12-15T00:00:00Z");
    vi.setSystemTime(new Date(DEC_NOW));
    const { db, env, token } = await setup(DEC_NOW);
    try {
      addServer(db, { id: "srv_dec", transferGib: 100 });
      addTraffic(db, "srv_dec", "2026-12", 0);

      const [server] = await listServers(db, env, token);
      expect(server.traffic_reset_at).toBe("2027-01-01T00:00:00.000Z");
      expect(server.traffic_limit_bytes).toBe(LIMIT_100GIB_DEC15);
      expect(server.traffic_state).toBe("ok");
    } finally {
      db.close();
    }
  });
});
