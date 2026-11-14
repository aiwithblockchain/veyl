import { describe, expect, it } from "vitest";

import { handleAuth } from "../src/auth";
import { sha256B64u } from "../src/lib/crypto";
import { FakeD1 } from "./helpers/fakeD1";

async function signingJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return JSON.stringify(jwk);
}

function envWith(db: FakeD1, jwk: string) {
  return { DB: db as unknown as D1Database, TOKEN_SIGNING_JWK: jwk };
}

function registerRequest(body: unknown): Request {
  return new Request("https://example.com/v1/auth/device", {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}

async function registerBody() {
  const secret = "device-secret-plain";
  return {
    device_id: "dev_abcdefghijklmnopqrstuv",
    secret_hash: await sha256B64u(secret),
    platform: "macos",
    app_version: "0.9.0",
  };
}

describe("device auth", () => {
  it("首次注册创建账户与设备，并且只存哈希", async () => {
    const db = new FakeD1();
    const env = envWith(db, await signingJwk());
    const res = await handleAuth(registerRequest(await registerBody()), env);

    expect(res?.status).toBe(200);
    const body = (await res!.json()) as Record<string, string>;
    expect(body.account_id.startsWith("acct_")).toBe(true);
    expect(body.access_token.split(".")).toHaveLength(3);
    expect(body.refresh_token.length).toBeGreaterThan(20);

    expect(db.rows("accounts")).toHaveLength(1);
    expect(db.rows("devices")).toHaveLength(1);
    const device = db.rows("devices")[0];
    expect(JSON.stringify(device)).not.toContain("device-secret-plain");
    expect(db.rows("refresh_tokens")).toHaveLength(1);
    expect(JSON.stringify(db.rows("refresh_tokens"))).not.toContain(body.refresh_token);
  });

  it("同 id 同哈希再次注册沿用原账户", async () => {
    const db = new FakeD1();
    const env = envWith(db, await signingJwk());
    const first = (await (await handleAuth(registerRequest(await registerBody()), env))!.json()) as {
      account_id: string;
    };
    const second = (await (await handleAuth(registerRequest(await registerBody()), env))!.json()) as {
      account_id: string;
    };
    expect(second.account_id).toBe(first.account_id);
    expect(db.rows("accounts")).toHaveLength(1);
  });

  it("同 id 不同哈希返回 device_mismatch，不覆盖原记录", async () => {
    const db = new FakeD1();
    const env = envWith(db, await signingJwk());
    await handleAuth(registerRequest(await registerBody()), env);

    const other = await registerBody();
    other.secret_hash = await sha256B64u("another-secret");
    const res = await handleAuth(registerRequest(other), env);
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("device_mismatch");
    expect(db.rows("devices")).toHaveLength(1);
  });

  it("刷新轮换令牌：旧值作废，新值可用", async () => {
    const db = new FakeD1();
    const env = envWith(db, await signingJwk());
    const first = (await (await handleAuth(registerRequest(await registerBody()), env))!.json()) as {
      refresh_token: string;
    };

    const refresh = (token: string) =>
      handleAuth(
        new Request("https://example.com/v1/auth/refresh", {
          method: "POST",
          body: JSON.stringify({ refresh_token: token }),
        }),
        env,
      );

    const rotated = await refresh(first.refresh_token);
    expect(rotated?.status).toBe(200);
    const next = (await rotated!.json()) as { refresh_token: string };
    expect(next.refresh_token).not.toBe(first.refresh_token);

    const replay = await refresh(first.refresh_token);
    expect(replay?.status).toBe(401);
    const body = (await replay!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("refresh_reused");

    const family = db.rows("refresh_tokens");
    expect(family.every((row) => row.used_at !== null || row.revoked_at !== null)).toBe(true);
  });

  it("没有 D1 绑定时返回 503 而不是崩溃", async () => {
    const res = await handleAuth(registerRequest(await registerBody()), {});
    expect(res?.status).toBe(503);
  });
});
