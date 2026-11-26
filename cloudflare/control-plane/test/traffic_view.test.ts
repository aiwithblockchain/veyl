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
const THRESHOLD_100GIB_NOV26 = 79_763_678_354;

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

function addServer(db: FakeD1, id: string, accountId: string, port: number): void {
  db.rows("servers").push({
    id,
    account_id: accountId,
    order_id: `ord_${id}`,
    name: `机器 ${id}`,
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    state: "active",
    node_port: port,
    hourly_usd: 0,
    monthly_usd: 0,
    daily_price_cents: 0,
    billing_anchor_at: Date.UTC(2026, 10, 1),
    ready_at: Date.UTC(2026, 10, 1),
    transfer_gib: 100,
    paid_until: 0,
    billing_state: "active",
    created_at: Date.UTC(2026, 10, 1),
    updated_at: Date.UTC(2026, 10, 1),
    destroyed_at: null,
    failure_code: null,
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
  it("按账号聚合出的已用字节决定 state：near 与 over", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    addAccount(db, ACCOUNT, 10_000);
    addServer(db, "srv_near", ACCOUNT, 30001);
    addServer(db, "srv_over", ACCOUNT, 30002);
    addTraffic(db, "srv_near", THRESHOLD_100GIB_NOV26);
    addTraffic(db, "srv_over", LIMIT_100GIB_NOV26 + 1);

    const byId = Object.fromEntries((await listServers(env)).map((row) => [row.server_id, row]));
    expect(byId.srv_near).toMatchObject({
      traffic_used_bytes: THRESHOLD_100GIB_NOV26,
      traffic_limit_bytes: LIMIT_100GIB_NOV26,
      traffic_state: "near",
    });
    expect(byId.srv_over).toMatchObject({
      traffic_used_bytes: LIMIT_100GIB_NOV26 + 1,
      traffic_state: "over",
    });
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
});
