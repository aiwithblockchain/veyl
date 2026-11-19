import { describe, expect, it } from "vitest";

import { b64u, randomBytes, sealSecret, signAccessToken } from "../src/lib/crypto";
import { handleMobile, type MobileEnv } from "../src/mobile";
import { assertSqlMatchesSchema } from "./helpers/schemaGuard";

const ACCOUNT = "acct_mobile00000000000000";
const DEVICE = "dev_mobile000000000000000";
const MOBILE_KEY = b64u(new Uint8Array(32).fill(7));
const CREDENTIAL_KEY = b64u(new Uint8Array(32).fill(9));
const PROFILE_URL = "https://example.com/v1/mobile/profile";

type Row = Record<string, unknown>;

function normalise(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 只覆盖 mobile.ts 会发出的语句的最小 D1 替身。
 * 不复用 test/helpers/fakeD1.ts：那份按它自己的表集手写，改它会越过本次文件边界。
 */
class MobileD1 {
  accounts: Row[] = [];
  devices: Row[] = [];
  servers: Row[] = [];
  credentials: Row[] = [];
  audit: Row[] = [];
  tokens: Row[] = [];
  rateLimits = new Map<string, { window_start: number; count: number }>();

  prepare(sql: string): MobileStatement {
    return new MobileStatement(this, sql, []);
  }

  read(sqlRaw: string, a: unknown[]): Row | null {
    const sql = normalise(sqlRaw);
    if (sql.startsWith("select * from devices where id")) {
      return this.devices.find((device) => device.id === a[0]) ?? null;
    }
    if (sql.startsWith("select status, kind, merged_into from accounts")) {
      const account = this.accounts.find((row) => row.id === a[0]);
      return account
        ? { status: account.status, kind: account.kind, merged_into: account.merged_into ?? null }
        : null;
    }
    if (sql.startsWith("select created_at from mobile_tokens")) {
      const token = this.tokens.find((row) => row.account_id === a[0]);
      return token ? { created_at: token.created_at } : null;
    }
    if (
      sql.startsWith(
        "select token_hash, iv, ciphertext, created_at, rotated_at from mobile_tokens",
      )
    ) {
      const token = this.tokens.find((row) => row.account_id === a[0]);
      return token
        ? {
            token_hash: token.token_hash,
            iv: token.iv,
            ciphertext: token.ciphertext,
            created_at: token.created_at,
            rotated_at: token.rotated_at ?? null,
          }
        : null;
    }
    if (sql.startsWith("select mt.account_id")) {
      const token = this.tokens.find((row) => row.token_hash === a[0]);
      if (!token) return null;
      const account = this.accounts.find((row) => row.id === token.account_id);
      if (!account) return null;
      return {
        account_id: account.id,
        status: account.status,
        merged_into: account.merged_into ?? null,
      };
    }
    throw new Error(`MobileD1 未覆盖的读语句：${sqlRaw}`);
  }

  readAll(sqlRaw: string, a: unknown[]): Row[] {
    const sql = normalise(sqlRaw);
    if (sql.startsWith("select s.id as id")) {
      return this.servers
        .filter(
          (server) =>
            server.account_id === a[0] &&
            (server.state === "active" || server.state === "healthy") &&
            server.node_id != null &&
            server.destroyed_at == null,
        )
        .flatMap((server) => {
          const credential = this.credentials.find(
            (row) => row.server_id === server.id && row.destroyed_at == null,
          );
          return credential
            ? [
                {
                  id: server.id,
                  name: server.name,
                  created_at: server.created_at,
                  ip: server.ip ?? null,
                  iv: credential.iv,
                  ciphertext: credential.ciphertext,
                },
              ]
            : [];
        })
        .sort(
          (left, right) =>
            Number(left.created_at) - Number(right.created_at) ||
            String(left.id).localeCompare(String(right.id)),
        );
    }
    throw new Error(`MobileD1 未覆盖的多行读语句：${sqlRaw}`);
  }

  write(sqlRaw: string, a: unknown[]): number {
    const sql = normalise(sqlRaw);
    // 与 FakeD1 同口径：写语句先对基线表做静态校验（mobile_tokens 不在 0001–0008 基线里，跳过列检查）。
    assertSqlMatchesSchema(sql, a);

    if (sql.startsWith("update rate_limits set count = count + 1")) {
      const row = this.rateLimits.get(String(a[0]));
      if (row && row.window_start > Number(a[1]) && row.count < Number(a[2])) {
        row.count += 1;
        return 1;
      }
      return 0;
    }
    if (sql.startsWith("update rate_limits set window_start")) {
      const row = this.rateLimits.get(String(a[1]));
      if (row && row.window_start <= Number(a[2])) {
        row.window_start = Number(a[0]);
        row.count = 1;
        return 1;
      }
      return 0;
    }
    if (sql.startsWith("insert or ignore into rate_limits")) {
      if (this.rateLimits.has(String(a[0]))) return 0;
      this.rateLimits.set(String(a[0]), { window_start: Number(a[1]), count: 1 });
      return 1;
    }

    if (sql.startsWith("insert or ignore into mobile_tokens")) {
      if (this.tokens.some((row) => row.account_id === a[0])) return 0;
      this.tokens.push({
        account_id: a[0],
        token_hash: a[1],
        key_version: a[2],
        iv: a[3],
        ciphertext: a[4],
        created_at: a[5],
        rotated_at: sql.includes("rotated_at") ? a[6] : null,
        last_used_at: null,
      });
      return 1;
    }
    if (sql.startsWith("update mobile_tokens set token_hash")) {
      const token = this.tokens.find((row) => row.account_id === a[5]);
      if (!token) return 0;
      token.token_hash = a[0];
      token.iv = a[1];
      token.ciphertext = a[2];
      token.created_at = a[3];
      token.rotated_at = a[4];
      token.last_used_at = null;
      return 1;
    }
    if (sql.startsWith("update mobile_tokens set last_used_at")) {
      const token = this.tokens.find((row) => row.account_id === a[1]);
      if (!token) return 0;
      if (token.last_used_at == null || Number(token.last_used_at) < Number(a[2])) {
        token.last_used_at = a[0];
        return 1;
      }
      return 0;
    }
    if (sql.startsWith("insert into audit_log")) {
      const action = /'(mobile\.[a-z_]+)'/.exec(sqlRaw)?.[1] ?? "unknown";
      this.audit.push({ at: a[0], account_id: a[1], action, detail: a[2] });
      return 1;
    }

    throw new Error(`MobileD1 未覆盖的写语句：${sqlRaw}`);
  }
}

class MobileStatement {
  constructor(
    private db: MobileD1,
    private sql: string,
    private args: unknown[],
  ) {}

  bind(...args: unknown[]): MobileStatement {
    return new MobileStatement(this.db, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    await Promise.resolve();
    return this.db.read(this.sql, this.args) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    await Promise.resolve();
    return { results: this.db.readAll(this.sql, this.args) as T[] };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    await Promise.resolve();
    return { success: true, meta: { changes: this.db.write(this.sql, this.args) } };
  }
}

async function signingJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

async function setup(
  account: { kind?: string; status?: string } = {},
): Promise<{ db: MobileD1; env: MobileEnv; accessToken: string }> {
  const db = new MobileD1();
  const jwk = await signingJwk();
  db.accounts.push({
    id: ACCOUNT,
    kind: account.kind ?? "email",
    status: account.status ?? "active",
    merged_into: null,
  });
  db.devices.push({ id: DEVICE, account_id: ACCOUNT, revoked_at: null });
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await signAccessToken(jwk, {
    sub: ACCOUNT,
    did: DEVICE,
    iat: now,
    exp: now + 600,
    jti: "jti_mobile",
  });
  return {
    db,
    env: {
      DB: db as unknown as D1Database,
      TOKEN_SIGNING_JWK: jwk,
      MOBILE_TOKEN_ENC_KEY: MOBILE_KEY,
      CREDENTIAL_ENC_KEY: CREDENTIAL_KEY,
    },
    accessToken,
  };
}

function tokenRequest(accessToken: string, rotate = false): Request {
  return new Request(
    `https://example.com/v1/mobile/token${rotate ? "/rotate" : ""}`,
    { method: "POST", headers: { authorization: `Bearer ${accessToken}` } },
  );
}

function profileRequest(password: string | null, options: { user?: string; ip?: string } = {}): Request {
  const headers: Record<string, string> = { "CF-Connecting-IP": options.ip ?? "203.0.113.7" };
  if (password !== null) {
    headers.authorization = `Basic ${btoa(`${options.user ?? "veyl"}:${password}`)}`;
  }
  return new Request(PROFILE_URL, { headers });
}

async function createToken(env: MobileEnv, accessToken: string): Promise<string> {
  const response = await handleMobile(tokenRequest(accessToken), env);
  expect(response?.status).toBe(200);
  const body = (await response!.json()) as { token: string };
  return body.token;
}

interface SeedServer {
  id: string;
  name: string;
  createdAt: number;
  state?: string;
  nodeId?: string | null;
  ip?: string | null;
  host?: string;
  port?: number;
  password?: string;
  method?: string;
  destroyedAt?: number | null;
  credentialDestroyedAt?: number | null;
  corruptCredential?: boolean;
}

async function seedServer(db: MobileD1, seed: SeedServer): Promise<void> {
  db.servers.push({
    id: seed.id,
    account_id: ACCOUNT,
    name: seed.name,
    state: seed.state ?? "active",
    node_id: seed.nodeId === undefined ? "node-1" : seed.nodeId,
    ip: seed.ip === undefined ? "198.51.100.99" : seed.ip,
    created_at: seed.createdAt,
    destroyed_at: seed.destroyedAt ?? null,
  });
  const sealed = seed.corruptCredential
    ? { iv: b64u(randomBytes(12)), ciphertext: b64u(randomBytes(24)) }
    : await sealSecret(
        CREDENTIAL_KEY,
        JSON.stringify({
          host: seed.host ?? "198.51.100.10",
          port: seed.port ?? 8388,
          password: seed.password ?? "node-password",
          method: seed.method ?? "aes-256-gcm",
        }),
      );
  db.credentials.push({
    server_id: seed.id,
    key_version: 1,
    iv: sealed.iv,
    ciphertext: sealed.ciphertext,
    created_at: seed.createdAt,
    destroyed_at: seed.credentialDestroyedAt ?? null,
  });
}

interface MobileConfig {
  log: { level: string };
  outbounds: Array<{
    type: string;
    tag: string;
    server?: string;
    server_port?: number;
    method?: string;
    password?: string;
    outbounds?: string[];
    default?: string;
  }>;
  route: { final: string };
}

describe("POST /v1/mobile/token", () => {
  it("幂等：重复调用返回同一个令牌，只落一行", async () => {
    const { db, env, accessToken } = await setup();

    const first = await handleMobile(tokenRequest(accessToken), env);
    const second = await handleMobile(tokenRequest(accessToken), env);
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);

    const firstBody = (await first!.json()) as { token: string; created_at: number; rotated_at: null };
    const secondBody = (await second!.json()) as { token: string; created_at: number };
    expect(firstBody.token).toBe(secondBody.token);
    expect(firstBody.token).toMatch(/^mp_[A-Za-z0-9_-]{43}$/);
    expect(firstBody.rotated_at).toBeNull();
    expect(firstBody.created_at).toBeGreaterThan(0);
    expect(db.tokens).toHaveLength(1);

    const audits = db.audit.filter((row) => row.action === "mobile.token_create");
    expect(audits).toHaveLength(2);
    expect(JSON.parse(String(audits[0].detail))).toEqual({ created: true });
    expect(JSON.parse(String(audits[1].detail))).toEqual({ created: false });
  });

  it("并发创建只产生一条令牌，两端拿到同一个值", async () => {
    const { db, env, accessToken } = await setup();

    const [left, right] = await Promise.all([
      handleMobile(tokenRequest(accessToken), env),
      handleMobile(tokenRequest(accessToken), env),
    ]);
    const leftBody = (await left!.json()) as { token: string };
    const rightBody = (await right!.json()) as { token: string };

    expect(leftBody.token).toBe(rightBody.token);
    expect(db.tokens).toHaveLength(1);
    const createdFlags = db.audit
      .filter((row) => row.action === "mobile.token_create")
      .map((row) => (JSON.parse(String(row.detail)) as { created: boolean }).created)
      .sort();
    expect(createdFlags).toEqual([false, true]);
  });

  it("设备账户被挡住：PRECONDITION_FAILED / login_required", async () => {
    const { env, accessToken } = await setup({ kind: "device" });
    const response = await handleMobile(tokenRequest(accessToken), env);
    expect(response?.status).toBe(409);
    const body = (await response!.json()) as { code: string; details: { reason: string } };
    expect(body.code).toBe("PRECONDITION_FAILED");
    expect(body.details.reason).toBe("login_required");
  });

  it("缺 MOBILE_TOKEN_ENC_KEY 时返回 503 而不是崩", async () => {
    const { env, accessToken } = await setup();
    const noKey: MobileEnv = { ...env, MOBILE_TOKEN_ENC_KEY: undefined };
    const response = await handleMobile(tokenRequest(accessToken), noKey);
    expect(response?.status).toBe(503);
    const body = (await response!.json()) as { details: { reason: string }; retryable: boolean };
    expect(body.details.reason).toBe("mobile_key_missing");
    expect(body.retryable).toBe(true);
  });

  it("每账户每小时 10 次：第 11 次 429", async () => {
    const { env, accessToken } = await setup();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await handleMobile(tokenRequest(accessToken), env);
      expect(response?.status).toBe(200);
    }
    const limited = await handleMobile(tokenRequest(accessToken), env);
    expect(limited?.status).toBe(429);
    const body = (await limited!.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryable).toBe(true);
  });
});

describe("POST /v1/mobile/token/rotate", () => {
  it("轮换后旧令牌 401，新令牌可用；审计不记令牌", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, { id: "srv_a", name: "香港 01", createdAt: 1 });
    const oldToken = await createToken(env, accessToken);

    const before = await handleMobile(profileRequest(oldToken), env);
    expect(before?.status).toBe(200);

    const rotated = await handleMobile(tokenRequest(accessToken, true), env);
    expect(rotated?.status).toBe(200);
    const rotatedBody = (await rotated!.json()) as {
      token: string;
      created_at: number;
      rotated_at: number;
    };
    expect(rotatedBody.token).not.toBe(oldToken);
    expect(rotatedBody.rotated_at).toBeGreaterThan(0);

    const stale = await handleMobile(profileRequest(oldToken), env);
    expect(stale?.status).toBe(401);
    const fresh = await handleMobile(profileRequest(rotatedBody.token), env);
    expect(fresh?.status).toBe(200);

    const audit = db.audit.find((row) => row.action === "mobile.token_rotate");
    expect(audit).toBeTruthy();
    const detail = JSON.parse(String(audit!.detail)) as { previous_created_at: number };
    expect(detail.previous_created_at).toBeGreaterThan(0);
    expect(String(audit!.detail)).not.toContain("mp_");
    expect(String(audit!.detail)).not.toContain(oldToken.slice(3, 20));
  });
});

describe("GET /v1/mobile/profile", () => {
  it("忽略 Basic 用户名，只校验密码", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, { id: "srv_a", name: "香港 01", createdAt: 1 });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(
      profileRequest(token, { user: "someone-else" }),
      env,
    );
    expect(response?.status).toBe(200);
  });

  it("缺失 / 非 Basic / 畸形凭据一律 401 并带 WWW-Authenticate", async () => {
    const { env } = await setup();

    const missing = await handleMobile(profileRequest(null, { ip: "203.0.113.10" }), env);
    expect(missing?.status).toBe(401);
    expect(missing?.headers.get("WWW-Authenticate")).toBe('Basic realm="veyl", charset="UTF-8"');
    expect(missing?.headers.get("Cache-Control")).toBe("no-store");
    expect(missing?.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const bearer = await handleMobile(
      new Request(PROFILE_URL, {
        headers: { authorization: "Bearer mp_not-a-basic-header", "CF-Connecting-IP": "203.0.113.11" },
      }),
      env,
    );
    expect(bearer?.status).toBe(401);
    expect(bearer?.headers.get("WWW-Authenticate")).toBe('Basic realm="veyl", charset="UTF-8"');

    const malformed = await handleMobile(
      new Request(PROFILE_URL, {
        headers: { authorization: "Basic !!!not-base64!!!", "CF-Connecting-IP": "203.0.113.12" },
      }),
      env,
    );
    expect(malformed?.status).toBe(401);
    expect(malformed?.headers.get("WWW-Authenticate")).toBe('Basic realm="veyl", charset="UTF-8"');
  });

  it("零节点：200 + 只含 direct 的合法配置，并带 no-store", async () => {
    const { env, accessToken } = await setup();
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response?.headers.get("Content-Type")).toContain("application/json");

    const config = (await response!.json()) as MobileConfig;
    expect(config.outbounds).toEqual([{ type: "direct", tag: "direct" }]);
    expect(config.route.final).toBe("direct");
  });

  it("只出 shadowsocks + selector + direct，坏凭据 / 非 aes-256-gcm 跳过，重名加序号", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, { id: "srv_1", name: "香港 01", createdAt: 1, host: "" });
    await seedServer(db, { id: "srv_2", name: "香港 01", createdAt: 2 });
    await seedServer(db, { id: "srv_3", name: "坏凭据", createdAt: 3, corruptCredential: true });
    await seedServer(db, { id: "srv_4", name: "别的加密", createdAt: 4, method: "chacha20-ietf-poly1305" });
    await seedServer(db, { id: "srv_5", name: "凭据已销毁", createdAt: 5, credentialDestroyedAt: 1 });
    await seedServer(db, { id: "srv_6", name: "还在启动", createdAt: 6, state: "booting" });
    await seedServer(db, { id: "srv_7", name: "没有节点", createdAt: 7, nodeId: null });
    await seedServer(db, { id: "srv_8", name: "已销毁", createdAt: 8, destroyedAt: 1 });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token), env);
    expect(response?.status).toBe(200);
    const config = (await response!.json()) as MobileConfig;

    const nodes = config.outbounds.filter((outbound) => outbound.type === "shadowsocks");
    expect(nodes.map((node) => node.tag)).toEqual(["香港 01", "香港 01 (2)"]);
    // host 为空时走 row.ip 兜底（与凭据端点同源）。
    expect(nodes[0].server).toBe("198.51.100.99");
    expect(nodes[0].server_port).toBe(8388);
    expect(nodes[0].method).toBe("aes-256-gcm");
    expect(nodes[0].password).toBe("node-password");

    const selector = config.outbounds.find((outbound) => outbound.type === "selector");
    expect(selector).toMatchObject({
      tag: "proxy",
      outbounds: ["香港 01", "香港 01 (2)"],
      default: "香港 01",
    });
    const direct = config.outbounds.find((outbound) => outbound.type === "direct");
    expect(direct).toEqual({ type: "direct", tag: "direct" });
    expect(config.route.final).toBe("proxy");
  });

  it("查询到服务器但全部不可用时 503，不伪装成零节点", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, { id: "srv_bad", name: "坏凭据", createdAt: 1, corruptCredential: true });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token), env);
    expect(response?.status).toBe(503);
    const body = (await response!.json()) as {
      code: string;
      retryable: boolean;
      details: { reason: string };
    };
    expect(body.code).toBe("INTERNAL");
    expect(body.retryable).toBe(true);
    expect(body.details.reason).toBe("mobile_profile_unavailable");
  });

  it("空服务器名兜底为「节点」，重名继续加序号", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, { id: "srv_empty_1", name: "", createdAt: 1 });
    await seedServer(db, { id: "srv_empty_2", name: "   ", createdAt: 2 });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token), env);
    expect(response?.status).toBe(200);
    const config = (await response!.json()) as MobileConfig;
    const nodes = config.outbounds.filter((outbound) => outbound.type === "shadowsocks");
    expect(nodes.map((node) => node.tag)).toEqual(["节点", "节点 (2)"]);
  });

  it("账户被停用后 profile 返回 403", async () => {
    const { db, env, accessToken } = await setup();
    const token = await createToken(env, accessToken);
    const account = db.accounts.find((row) => row.id === ACCOUNT)!;
    account.status = "disabled";

    const response = await handleMobile(profileRequest(token), env);
    expect(response?.status).toBe(403);
    const body = (await response!.json()) as { code: string; details: { reason: string } };
    expect(body.code).toBe("FORBIDDEN");
    expect(body.details.reason).toBe("account_blocked");
  });

  it("每账户每小时 30 次：第 31 次 429 并带 Retry-After", async () => {
    const { env, accessToken } = await setup();
    const token = await createToken(env, accessToken);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await handleMobile(profileRequest(token), env);
      expect(response?.status).toBe(200);
    }
    const limited = await handleMobile(profileRequest(token), env);
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("Retry-After")).toBe("3600");
    expect(limited?.headers.get("Cache-Control")).toBe("no-store");
    expect(limited?.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("无效令牌按 IP 限流：第 61 次 429", async () => {
    const { env } = await setup();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await handleMobile(
        profileRequest("mp_wrong", { ip: "203.0.113.50" }),
        env,
      );
      expect(response?.status).toBe(401);
    }
    const limited = await handleMobile(profileRequest("mp_wrong", { ip: "203.0.113.50" }), env);
    expect(limited?.status).toBe(429);
  });

  it("last_used_at 5 分钟内只写一次", async () => {
    const { db, env, accessToken } = await setup();
    const token = await createToken(env, accessToken);

    await handleMobile(profileRequest(token), env);
    const first = db.tokens[0].last_used_at;
    expect(first).not.toBeNull();
    await handleMobile(profileRequest(token), env);
    expect(db.tokens[0].last_used_at).toBe(first);
  });
});
