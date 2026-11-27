import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signAccessToken } from "../src/lib/crypto";
import { handleServers } from "../src/servers";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_view_fake0000000000";
const OTHER_ACCOUNT = "acct_view_other00000000";
const DEVICE = "dev_view_fake000000000000";
const NOW = Date.parse("2026-11-26T12:00:00Z");
const CYCLE = "2026-11";

/** 与 sqlite 用例同一组固定期望值：100 GiB、11 月 1 日建机、11 月 26 日 12 点查。 */
const LIMIT_100GIB_NOV26 = 99_704_597_942;
/** 同上，但 11 月 23 日 12 点销毁：存活 22 个整天 → 23 天份。 */
const LIMIT_100GIB_DESTROYED_NOV23 = 88_200_221_257;

type Row = Record<string, unknown>;

async function signingJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

function addAccount(db: FakeD1, id: string, balance: number): void {
  db.rows("accounts").push({ id, kind: "email", status: "active", balance_cents: balance });
  db.rows("devices").push({ id: DEVICE, account_id: ACCOUNT, revoked_at: null });
}

function addServer(
  db: FakeD1,
  id: string,
  accountId: string,
  port: number,
  extra: {
    state?: string;
    destroyedAt?: number | null;
    failureCode?: string | null;
    dismissedAt?: number | null;
    providerGoneAt?: number | null;
  } = {},
): void {
  db.rows("servers").push({
    id,
    account_id: accountId,
    order_id: `ord_${id}`,
    name: `机器 ${id}`,
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    state: extra.state ?? "active",
    node_port: port,
    hourly_usd: 0,
    monthly_usd: 0,
    daily_price_cents: 0,
    billing_anchor_at: Date.UTC(2026, 10, 1),
    ready_at: Date.UTC(2026, 10, 1),
    transfer_gib: 100,
    paid_until: NOW + 24 * 3600 * 1000,
    billing_state: "active",
    created_at: Date.UTC(2026, 10, 1),
    updated_at: Date.UTC(2026, 10, 1),
    destroyed_at: extra.destroyedAt ?? null,
    failure_code: extra.failureCode ?? null,
    dismissed_at: extra.dismissedAt ?? null,
    provider_gone_at: extra.providerGoneAt ?? null,
    charge_mode: "at_ready",
  });
}

function addTraffic(db: FakeD1, serverId: string, bytes: number, cycle = CYCLE): void {
  db.rows("server_traffic").push({
    server_id: serverId,
    cycle_id: cycle,
    bytes,
    released_bytes: 0,
    charged_cents: 0,
    last_seq: 1,
    updated_at: NOW,
  });
}

async function envWith(db: FakeD1) {
  const jwk = await signingJwk();
  const token = await signAccessToken(jwk, {
    sub: ACCOUNT,
    did: DEVICE,
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 600,
    jti: "jti_view_fake",
  });
  return {
    DB: db as unknown as D1Database,
    TOKEN_SIGNING_JWK: jwk,
    ENVIRONMENT: "test",
    token,
  };
}

async function listServers(env: { token: string }): Promise<Row[]> {
  const response = await handleServers(
    new Request("https://example.com/v1/servers", {
      headers: { authorization: `Bearer ${env.token}` },
    }),
    env as never,
  );
  expect(response?.status).toBe(200);
  const body = (await response?.json()) as { servers: Row[] };
  return body.servers;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MyServer 流量四字段 · FakeD1", () => {
  it("单台只有 ok：用超自己那份额度也不变成 near / over（扣费按账号池）", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    addAccount(db, ACCOUNT, 10_000);
    addServer(db, "srv_low", ACCOUNT, 30001);
    addServer(db, "srv_over", ACCOUNT, 30002);
    addTraffic(db, "srv_low", 1024);
    addTraffic(db, "srv_over", LIMIT_100GIB_NOV26 + 1);

    const byId = Object.fromEntries((await listServers(env)).map((row) => [row.server_id, row]));
    expect(byId.srv_low).toMatchObject({
      traffic_used_bytes: 1024,
      traffic_limit_bytes: LIMIT_100GIB_NOV26,
      traffic_state: "ok",
    });
    expect(byId.srv_over).toMatchObject({
      traffic_used_bytes: LIMIT_100GIB_NOV26 + 1,
      traffic_limit_bytes: LIMIT_100GIB_NOV26,
      traffic_state: "ok",
    });
  });

  it("provider_gone 透给客户端，额度冻结在失联时刻（state 仍是 active）", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    addAccount(db, ACCOUNT, 10_000);
    addServer(db, "srv_live", ACCOUNT, 30008);
    // DO 后台删掉、还没在应用里销毁：state 仍是 active，只有 provider_gone_at 有值。
    addServer(db, "srv_gone", ACCOUNT, 30009, {
      providerGoneAt: Date.parse("2026-11-23T12:00:00Z"),
    });

    const byId = Object.fromEntries((await listServers(env)).map((row) => [row.server_id, row]));
    expect(byId.srv_live.provider_gone).toBe(false);
    expect(byId.srv_live.traffic_limit_bytes).toBe(LIMIT_100GIB_NOV26);
    expect(byId.srv_gone.provider_gone).toBe(true);
    expect(byId.srv_gone.state).toBe("active");
    // 额度停在失联那天，不会继续涨到整月。
    expect(byId.srv_gone.traffic_limit_bytes).toBe(LIMIT_100GIB_DESTROYED_NOV23);
  });

  it("另一个账户的流量行不能算进来", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    addAccount(db, ACCOUNT, 10_000);
    db.rows("accounts").push({
      id: OTHER_ACCOUNT,
      kind: "email",
      status: "active",
      balance_cents: 10_000,
    });
    addServer(db, "srv_mine", ACCOUNT, 30003);
    addServer(db, "srv_theirs", OTHER_ACCOUNT, 30004);
    addTraffic(db, "srv_theirs", 500 * 1024 * 1024 * 1024, CYCLE);

    const servers = await listServers(env);
    expect(servers.map((row) => row.server_id)).toEqual(["srv_mine"]);
    expect(servers[0].traffic_used_bytes).toBe(0);
    expect(servers[0].traffic_state).toBe("ok");
  });

  it("traffic_pool 计入列表里看不到的已销毁机器与已 dismiss 的墓碑", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    addAccount(db, ACCOUNT, 10_000);
    addServer(db, "srv_live", ACCOUNT, 30005);
    // 用户主动销毁：不在列表里，但扣费口径仍然计入。
    addServer(db, "srv_gone", ACCOUNT, 30006, {
      state: "destroyed",
      destroyedAt: NOW - 3 * 24 * 3600 * 1000,
    });
    // 已 dismiss 的余额不足墓碑：同样不在列表里，同样计入池子。
    addServer(db, "srv_dismissed", ACCOUNT, 30007, {
      state: "destroyed",
      destroyedAt: NOW - 3 * 24 * 3600 * 1000,
      failureCode: "billing_unpaid",
      dismissedAt: NOW - 24 * 3600 * 1000,
    });
    addTraffic(db, "srv_live", 1024);
    addTraffic(db, "srv_gone", 400 * 1024 * 1024 * 1024);
    addTraffic(db, "srv_dismissed", 200 * 1024 * 1024 * 1024);

    const response = await handleServers(
      new Request("https://example.com/v1/servers", {
        headers: { authorization: `Bearer ${env.token}` },
      }),
      env as never,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      servers: Row[];
      traffic_pool: { used_bytes: number; limit_bytes: number };
    };
    expect(body.servers.map((row) => row.server_id)).toEqual(["srv_live"]);
    expect(body.traffic_pool.used_bytes).toBe(
      400 * 1024 * 1024 * 1024 + 200 * 1024 * 1024 * 1024 + 1024,
    );
    // 三台都按 §4.1 释放额度：活着那台 99,704,597,942；两台 11 月 23 日销毁的各 88,200,221,257。
    expect(body.traffic_pool.limit_bytes).toBe(
      LIMIT_100GIB_NOV26 + 2 * LIMIT_100GIB_DESTROYED_NOV23,
    );
  });
});
