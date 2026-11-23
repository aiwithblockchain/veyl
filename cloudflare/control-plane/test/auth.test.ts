import { describe, expect, it } from "vitest";

import { bumpRateLimit, handleAuth } from "../src/auth";
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

  it("刷新轮换令牌：正常轮换；宽限内旧值再出现也给一套可用的", async () => {
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

    // 崩溃 / 双开：服务端已轮换、客户端没落盘，旧值在 60 秒宽限内再出现一次。
    // 不能整族作废把用户踢下线，要补发一套能用的。
    const grace = await refresh(first.refresh_token);
    expect(grace?.status).toBe(200);
    const redeemed = (await grace!.json()) as { refresh_token: string };
    expect(redeemed.refresh_token).not.toBe(first.refresh_token);
    expect(redeemed.refresh_token).not.toBe(next.refresh_token);

    // 宽限不是关掉重放检测：整族没被作废，补发的这套还能继续轮换。
    expect(db.rows("refresh_tokens").every((row) => row.revoked_at === null)).toBe(true);
    const continued = await refresh(redeemed.refresh_token);
    expect(continued?.status).toBe(200);
  });

  it("超出宽限再出现旧令牌：整族作废", async () => {
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

    // 消费时间推到 61 秒前：超出 60 秒宽限。
    const used = db.rows("refresh_tokens").find((row) => row.used_at != null)!;
    used.used_at = Date.now() - 61_000;

    const replay = await refresh(first.refresh_token);
    expect(replay?.status).toBe(401);
    expect(((await replay!.json()) as { details: { reason: string } }).details.reason).toBe(
      "refresh_reused",
    );

    // 整族作废：刚换出来的那一枚也一起失效。
    const after = await refresh(next.refresh_token);
    expect(after?.status).toBe(401);
    expect(db.rows("refresh_tokens").every((row) => row.revoked_at !== null)).toBe(true);
  });

  it("更早的令牌在宽限内也按重放处理", async () => {
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

    const second = (await (await refresh(first.refresh_token))!.json()) as { refresh_token: string };
    const third = (await (await refresh(second.refresh_token))!.json()) as { refresh_token: string };
    expect(third.refresh_token).toBeTruthy();

    // A 的消费时间落在宽限内，但 B 比它更晚被用掉：A 是「更早的令牌」。
    const rows = db.rows("refresh_tokens");
    rows[0].used_at = Date.now() - 10_000;
    rows[1].used_at = Date.now() - 5_000;

    const replay = await refresh(first.refresh_token);
    expect(replay?.status).toBe(401);
    expect(((await replay!.json()) as { details: { reason: string } }).details.reason).toBe(
      "refresh_reused",
    );
    expect(db.rows("refresh_tokens").every((row) => row.revoked_at !== null)).toBe(true);
  });

  it("宽限只兑现一次：同一枚旧令牌再次赎回，整族作废", async () => {
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

    // 第一次赎回：崩溃 / 双开场景，放行。
    const grace = await refresh(first.refresh_token);
    expect(grace?.status).toBe(200);

    // 第二次赎回同一枚：宽限用完了，按重放处理。
    const again = await refresh(first.refresh_token);
    expect(again?.status).toBe(401);
    expect(((await again!.json()) as { details: { reason: string } }).details.reason).toBe(
      "refresh_reused",
    );

    // 整族作废：正常换出来的那枚也一起失效。
    const after = await refresh(next.refresh_token);
    expect(after?.status).toBe(401);
    expect(db.rows("refresh_tokens").every((row) => row.revoked_at !== null)).toBe(true);
  });

  it("两枚不同的旧令牌各赎回一次，不误伤整族", async () => {
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

    const second = (await (await refresh(first.refresh_token))!.json()) as { refresh_token: string };
    // A 宽限兑换一次
    const graceA = await refresh(first.refresh_token);
    expect(graceA?.status).toBe(200);

    // B 正常轮换后，再宽限兑换一次：限次是按「每一枚」算的，不是全族总额。
    expect((await refresh(second.refresh_token))?.status).toBe(200);
    const graceB = await refresh(second.refresh_token);
    expect(graceB?.status).toBe(200);
    const final = (await graceB!.json()) as { refresh_token: string };

    expect(db.rows("refresh_tokens").every((row) => row.revoked_at === null)).toBe(true);
    expect((await refresh(final.refresh_token))?.status).toBe(200);
  });

  it("签发失败不吃掉宽限：额度退回，下一次还能兑换", async () => {
    const db = new FakeD1();
    const env = envWith(db, await signingJwk());
    const first = (await (await handleAuth(registerRequest(await registerBody()), env))!.json()) as {
      refresh_token: string;
    };
    const refreshWith = (token: string, target: { DB: D1Database; TOKEN_SIGNING_JWK?: string }) =>
      handleAuth(
        new Request("https://example.com/v1/auth/refresh", {
          method: "POST",
          body: JSON.stringify({ refresh_token: token }),
        }),
        target,
      );

    expect((await refreshWith(first.refresh_token, env))?.status).toBe(200);

    // 缺签名 JWK：补发失败，但这一次宽限不能被吃掉。
    const broken = { DB: db as unknown as D1Database };
    const failed = await refreshWith(first.refresh_token, broken);
    expect(failed?.status).toBe(500);
    expect(((await failed!.json()) as { details: { reason: string } }).details.reason).toBe(
      "signing_unavailable",
    );
    expect(db.rows("refresh_tokens")[0].redeemed_count).toBe(0);

    // 恢复后同一枚旧令牌仍能兑换一次。
    const grace = await refreshWith(first.refresh_token, env);
    expect(grace?.status).toBe(200);
  });

  it("并发抢同一枚令牌（双开）：宽限内补发一套，不签发到别人的链上", async () => {
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

    // 模拟双开：本请求读到的行还没用过，但条件更新执行前已被另一个实例用掉。
    db.beforeRefreshUse = () => {
      db.beforeRefreshUse = undefined;
      db.rows("refresh_tokens")[0].used_at = Date.now();
    };

    const res = await refresh(first.refresh_token);
    expect(res?.status).toBe(200);
    const redeemed = (await res!.json()) as { refresh_token: string };
    // 注册那一行 + 补发的一套；两边都可用，没有任何一行被作废。
    expect(db.rows("refresh_tokens")).toHaveLength(2);
    expect(db.rows("refresh_tokens").every((row) => row.revoked_at === null)).toBe(true);

    const again = await refresh(redeemed.refresh_token);
    expect(again?.status).toBe(200);
  });

  it("限流计数用单语句守卫：到上限即拒，窗口过期后重新放行", async () => {
    const db = new FakeD1();
    const key = "test:limit";
    const d1 = db as unknown as D1Database;

    expect(await bumpRateLimit(d1, key, 2, 3_600_000)).toBe(true);
    expect(await bumpRateLimit(d1, key, 2, 3_600_000)).toBe(true);
    expect(await bumpRateLimit(d1, key, 2, 3_600_000)).toBe(false);

    // 窗口过期：下一个请求放行，并把这一窗口的计数重置为 1。
    const window = db.rateLimit(key)!;
    window.window_start = Date.now() - 2 * 3_600_000;
    expect(await bumpRateLimit(d1, key, 2, 3_600_000)).toBe(true);
    expect(db.rateLimit(key)?.count).toBe(1);
  });

  it("没有 D1 绑定时返回 503 而不是崩溃", async () => {
    const res = await handleAuth(registerRequest(await registerBody()), {});
    expect(res?.status).toBe(503);
  });
});
