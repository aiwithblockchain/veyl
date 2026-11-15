import { afterEach, describe, expect, it, vi } from "vitest";

import { signAccessToken } from "../src/lib/crypto";
import { handleServers } from "../src/servers";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_test0000000000000000";
const DEVICE = "dev_test00000000000000000";
const SERVER = "srv_test0000000000000000";
const PROVIDER_ID = "4242";

async function signingJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

function seedServer(db: FakeD1, state: string) {
  db.rows("servers").push({
    id: SERVER,
    account_id: ACCOUNT,
    order_id: "ord_test",
    provider: "digitalocean",
    provider_id: PROVIDER_ID,
    name: "我的服务器0001",
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    hourly_usd: 0.00893,
    monthly_usd: 6,
    state,
    node_port: 20443,
    ip: "203.0.113.10",
    node_id: null,
    enrollment_hash: null,
    enrollment_expires_at: null,
    enrollment_used_at: null,
    firewall_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    destroyed_at: null,
  });
}

async function envWith(db: FakeD1, jwk: string) {
  db.rows("accounts").push({ id: ACCOUNT, status: "active" });
  db.rows("devices").push({ id: DEVICE, account_id: ACCOUNT, revoked_at: null });
  const token = await signAccessToken(jwk, {
    sub: ACCOUNT,
    did: DEVICE,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: "jti_destroy",
  });
  return {
    DB: db as unknown as D1Database,
    TOKEN_SIGNING_JWK: jwk,
    DO_API_TOKEN: "do-token",
    ENVIRONMENT: "test",
    token,
  };
}

function destroyRequest(token: string) {
  return new Request(`https://example.com/v1/servers/${SERVER}/destroy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("销毁服务器", () => {
  it("DO 删除成功后回落本地状态", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    const res = await handleServers(destroyRequest(env.token), env as never);

    expect(res?.status).toBe(204);
    const server = db.rows("servers")[0];
    expect(server.state).toBe("destroyed");
    expect(server.destroyed_at).not.toBeNull();
    const audit = db.rows("audit_log").find((row) => String(row.action) === "server.destroy");
    expect(audit?.server_id).toBe(SERVER);
  });

  it("DO 删除失败时状态还原，机器仍然可见可重试", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    const res = await handleServers(destroyRequest(env.token), env as never);

    expect(res?.status).toBe(502);
    const body = (await res!.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe("UPSTREAM_ERROR");
    expect(body.retryable).toBe(true);

    const server = db.rows("servers")[0];
    expect(server.state).toBe("active");
    expect(server.destroyed_at).toBeNull();
    expect(db.rows("audit_log").some((row) => String(row.action) === "server.destroy")).toBe(false);
  });

  it("机器已经不在了（DO 返回 404）按销毁成功处理", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );

    const res = await handleServers(destroyRequest(env.token), env as never);

    expect(res?.status).toBe(204);
    expect(db.rows("servers")[0].state).toBe("destroyed");
  });
});
