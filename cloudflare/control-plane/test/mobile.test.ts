import { describe, expect, it } from "vitest";

import geoipCnMrs from "../assets/rules/geoip-cn.mrs";
import geoipCn from "../assets/rules/geoip-cn.srs";
import geositeCnMrs from "../assets/rules/geosite-cn.mrs";
import geositeCn from "../assets/rules/geosite-cn.srs";
import { route, type Env } from "../src/index";
import { b64u, fromB64u, randomBytes, sealSecret, signAccessToken } from "../src/lib/crypto";
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

function profileRequest(
  password: string | null,
  options: { user?: string; ip?: string; format?: "clash" | "ss" | "shadowrocket" } = {},
): Request {
  const headers: Record<string, string> = { "CF-Connecting-IP": options.ip ?? "203.0.113.7" };
  if (password !== null) {
    headers.authorization = `Basic ${btoa(`${options.user ?? "veyl"}:${password}`)}`;
  }
  const url = options.format ? `${PROFILE_URL}/${options.format}` : PROFILE_URL;
  return new Request(url, { headers });
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

/** 取 YAML 里以 prefix 开头的那一行，把后缀当作 JSON 双引号标量解析。 */
function yamlScalarFrom(yaml: string, prefix: string): unknown {
  const line = yaml.split("\n").find((entry) => entry.startsWith(prefix));
  expect(line).toBeTruthy();
  return JSON.parse(line!.slice(prefix.length));
}

/** 只取 proxies 段里的节点名，跳过 proxy-groups 的 Veyl。 */
function clashProxyNames(yaml: string): string[] {
  const names: string[] = [];
  let inProxies = false;
  for (const line of yaml.split("\n")) {
    if (line === "proxies:") {
      inProxies = true;
      continue;
    }
    if (line === "proxy-groups:") break;
    if (inProxies && line.startsWith("  - name: ")) {
      names.push(JSON.parse(line.slice("  - name: ".length)) as string);
    }
  }
  return names;
}

interface MobileConfig {
  log: { level: string };
  dns?: {
    servers: Array<{ type: string; tag: string; server: string; detour?: string }>;
    rules?: Array<{ rule_set: string[]; server: string }>;
    final: string;
  };
  inbounds?: Array<{
    type: string;
    tag: string;
    address: string[];
    stack: string;
    mtu: number;
    dns_mode: string;
    dns_address: string[];
    auto_route: boolean;
  }>;
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
  route: {
    final: string;
    auto_detect_interface?: boolean;
    rule_set?: Array<{
      tag: string;
      type: string;
      format: string;
      url: string;
      update_interval: string;
      download_detour?: string;
    }>;
    rules?: Array<{
      action: string;
      protocol?: string;
      sniffer?: string[];
      timeout?: string;
      rule_set?: string[];
      ip_cidr?: string[];
      outbound?: string;
      ip_is_private?: boolean;
    }>;
  };
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

    for (const format of [undefined, "clash", "ss"] as const) {
      const stale = await handleMobile(profileRequest(oldToken, { format }), env);
      expect(stale?.status).toBe(401);
      const fresh = await handleMobile(profileRequest(rotatedBody.token, { format }), env);
      expect(fresh?.status).toBe(200);
    }

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

    for (const [index, format] of ([undefined, "clash", "ss"] as const).entries()) {
      const response = await handleMobile(
        profileRequest(null, { ip: `203.0.113.${20 + index}`, format }),
        env,
      );
      expect(response?.status).toBe(401);
      expect(response?.headers.get("WWW-Authenticate")).toBe('Basic realm="veyl", charset="UTF-8"');
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
      expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }

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
    expect(config.route).toEqual({ final: "direct" });
    // 零节点不能带 rule_set：没有代理出站，规则集只会白下载。
    expect(config.route.rule_set).toBeUndefined();
    // 零节点不能带 DNS 块：detour: "proxy" 会指向不存在的 outbound。
    expect(config.dns).toBeUndefined();
    // 零节点也不声明 TUN：不建立隧道，避免把所有流量 direct 进一个假 VPN。
    expect(config.inbounds).toBeUndefined();
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
    // 1.14 起不能靠「隐式默认客户端」下载规则集：必须显式给，并由 route 指到它。
    expect((config as unknown as { http_clients?: unknown }).http_clients).toEqual([
      { tag: "veyl-download", detour: "proxy" },
    ]);
    expect(config.route).toEqual({
      final: "proxy",
      auto_detect_interface: true,
      // 1.14 的 remote rule_set 域名 URL 需要解析器，否则内核直接拒整份配置。
      default_domain_resolver: "dns-cn",
      // 1.14 起必须显式给 http_client，否则「隐式默认客户端」弃用告警会弹到客户端界面上。
      default_http_client: "veyl-download",
      // 规则集必须与 profile 同 origin；remote 不带 download_detour（1.14 废弃）。
      rule_set: [
        {
          tag: "geosite-cn",
          type: "remote",
          format: "binary",
          url: "https://example.com/rules/geosite-cn.srs",
          update_interval: "7d",
        },
        {
          tag: "geoip-cn",
          type: "remote",
          format: "binary",
          url: "https://example.com/rules/geoip-cn.srs",
          update_interval: "7d",
        },
      ],
      // 顺序：sniff → hijack-dns → 国内 DNS 直连 → 国内直连 → 私网直连。
      rules: [
        { action: "sniff", sniffer: ["http", "tls", "quic", "dns"], timeout: "300ms" },
        { protocol: "dns", action: "hijack-dns" },
        { ip_cidr: ["223.5.5.5/32"], action: "route", outbound: "direct" },
        { rule_set: ["geosite-cn", "geoip-cn"], action: "route", outbound: "direct" },
        { ip_is_private: true, action: "route", outbound: "direct" },
      ],
    });
    // 手机 DNS 常指向 LAN 路由器：DoH 必须走 proxy 从服务端出网。
    // 国内域名交给国内 DNS，否则解析出海外 IP，geoip-cn 规则永远不命中。
    // dns-cn 不能写 detour: "direct"——空配置的 direct 出站不允许被显式 detour，1.14 启动即 FATAL。
    expect(config.dns).toEqual({
      servers: [
        { type: "https", tag: "dns", server: "1.1.1.1", detour: "proxy" },
        { type: "udp", tag: "dns-cn", server: "223.5.5.5" },
      ],
      rules: [{ rule_set: ["geosite-cn"], server: "dns-cn" }],
      final: "dns",
    });
    // Apple / SFA 只有声明 TUN 入站才会真正建隧道，auto_route 必须为真。
    expect(config.inbounds).toHaveLength(1);
    expect(config.inbounds![0]).toMatchObject({
      type: "tun",
      tag: "tun-in",
      address: ["172.18.0.1/30", "fdfe:dcba:9876::1/126"],
      stack: "gvisor",
      dns_mode: "hijack",
      auto_route: true,
    });
    // sniff 必须在 hijack-dns 之前：顺序反了 `protocol: "dns"` 永不命中，静默失效。
    const actions = config.route.rules!.map((rule) => rule.action);
    expect(actions.indexOf("sniff")).toBeLessThan(actions.indexOf("hijack-dns"));
  });

  it("dns.servers 不得显式 detour 到 direct（1.14 启动即 FATAL）", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, { id: "srv_dns_guard", name: "香港 01", createdAt: 1 });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token), env);
    expect(response?.status).toBe(200);
    const config = (await response!.json()) as MobileConfig;
    expect(config.dns?.servers.length).toBeGreaterThan(0);
    // 空配置的 direct 出站不允许被显式 detour：不写 detour 本身就是直连。
    for (const server of config.dns!.servers) {
      expect(server.detour).not.toBe("direct");
    }
  });

  it("查询到服务器但全部不可用时 503，不伪装成零节点", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, { id: "srv_bad", name: "坏凭据", createdAt: 1, corruptCredential: true });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token), env);
    expect(response?.status).toBe(503);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
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

  it("Clash YAML：最小形状与精确输出", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, {
      id: "srv_clash",
      name: "东京 1 号",
      createdAt: 1,
      host: "203.0.113.10",
      port: 20343,
      password: "s3cret-password",
    });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token, { format: "clash" }), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("text/yaml; charset=utf-8");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response!.text()).toBe(
      "proxies:\n" +
        '  - name: "东京 1 号"\n' +
        "    type: ss\n" +
        '    server: "203.0.113.10"\n' +
        "    port: 20343\n" +
        "    cipher: aes-256-gcm\n" +
        '    password: "s3cret-password"\n' +
        "    udp: true\n" +
        "proxy-groups:\n" +
        '  - name: "Veyl"\n' +
        "    type: select\n" +
        "    proxies:\n" +
        '      - "东京 1 号"\n' +
        "rule-providers:\n" +
        "  cn-domain:\n" +
        "    type: http\n" +
        "    behavior: domain\n" +
        "    format: mrs\n" +
        '    url: "https://example.com/rules/geosite-cn.mrs"\n' +
        '    path: "./providers/cn-domain.mrs"\n' +
        "    interval: 86400\n" +
        "  cn-ip:\n" +
        "    type: http\n" +
        "    behavior: ipcidr\n" +
        "    format: mrs\n" +
        '    url: "https://example.com/rules/geoip-cn.mrs"\n' +
        '    path: "./providers/cn-ip.mrs"\n' +
        "    interval: 86400\n" +
        "rules:\n" +
        '  - "RULE-SET,cn-domain,DIRECT"\n' +
        '  - "RULE-SET,cn-ip,DIRECT"\n' +
        '  - "DOMAIN-SUFFIX,cn,DIRECT"\n' +
        '  - "MATCH,Veyl"\n',
    );
  });

  it("Clash YAML：特殊字符保持双引号标量，注释符与换行不破坏结构", async () => {
    // U+2028 放在中间：String.trim() 会把它当空白，放行尾会被去掉。
    const name = "-东京:\"1\" # - 换行\n😀\u2028\u0085\u007f尾";
    const password = "p#a\"ss";
    const { db, env, accessToken } = await setup();
    await seedServer(db, {
      id: "srv_clash_special",
      name,
      createdAt: 1,
      host: "203.0.113.10",
      port: 20343,
      password,
    });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token, { format: "clash" }), env);
    expect(response?.status).toBe(200);
    const yaml = await response!.text();

    expect(yamlScalarFrom(yaml, "  - name: ")).toBe(name);
    expect(yamlScalarFrom(yaml, "    password: ")).toBe(password);
    expect(yamlScalarFrom(yaml, "      - ")).toBe(name);
    expect(yaml).not.toContain("\u2028");
    expect(yaml).not.toContain("\u0085");
    expect(yaml).not.toContain("\u007f");
    expect(yaml).toContain("\\u2028");
    expect(yaml).toContain("\\u0085");
    expect(yaml).toContain("\\u007f");
    expect(yaml).toContain("    cipher: aes-256-gcm");
    expect(yaml).toContain("    udp: true");
    expect(yaml).toContain('  - name: "Veyl"');
    // provider 指向我们自己的域名；顺序固定，`.cn` 是 provider 失败时的兜底，必须留在最后一条 RULE-SET 之后。
    expect(yaml).toContain('    url: "https://example.com/rules/geosite-cn.mrs"');
    expect(yaml).toContain('    url: "https://example.com/rules/geoip-cn.mrs"');
    expect(yaml).toContain("    behavior: domain");
    expect(yaml).toContain("    behavior: ipcidr");
    expect(yaml).toContain("    format: mrs");
    const rules = [
      '  - "RULE-SET,cn-domain,DIRECT"',
      '  - "RULE-SET,cn-ip,DIRECT"',
      '  - "DOMAIN-SUFFIX,cn,DIRECT"',
      '  - "MATCH,Veyl"',
    ].map((line) => yaml.indexOf(line));
    expect(rules).toEqual([...rules].sort((left, right) => left - right));
    expect(new Set(rules).size).toBe(4);
    expect(yaml).not.toContain("GEOIP");
    // Clash 不配 DNS：DOMAIN-SUFFIX 在解析前匹配；加 dns 只会覆盖用户设置并多一层故障面。
    expect(yaml).not.toContain("\ndns:");
    expect(yaml).not.toContain("fake-ip");
  });

  it("Clash 零节点：200 + 空 proxies 与 MATCH,DIRECT", async () => {
    const { env, accessToken } = await setup();
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token, { format: "clash" }), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response!.text()).toBe('proxies: []\nproxy-groups: []\nrules:\n  - "MATCH,DIRECT"\n');
  });

  it("Clash 全部凭据不可用：503", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, { id: "srv_clash_bad", name: "坏凭据", createdAt: 1, corruptCredential: true });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token, { format: "clash" }), env);
    expect(response?.status).toBe(503);
    const body = (await response!.json()) as { code: string; details: { reason: string } };
    expect(body.code).toBe("INTERNAL");
    expect(body.details.reason).toBe("mobile_profile_unavailable");
  });

  it("ss SIP002：base64url 与 percent-encode 逐字节", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, {
      id: "srv_ss",
      name: "东京 1 号",
      createdAt: 1,
      host: "203.0.113.10",
      port: 20343,
      password: "s3cret-password",
    });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token, { format: "ss" }), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response!.text()).toBe(
      "ss://YWVzLTI1Ni1nY206czNjcmV0LXBhc3N3b3Jk@203.0.113.10:20343#%E4%B8%9C%E4%BA%AC%201%20%E5%8F%B7\n",
    );
  });

  it("ss：IPv6 加方括号，空格与 # 按 RFC 3986 编码", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, {
      id: "srv_ss_v6",
      name: "东京 1 #😀",
      createdAt: 1,
      host: "2001:db8::1",
      port: 8388,
      password: "p",
    });
    const token = await createToken(env, accessToken);

    const userinfo = b64u(new TextEncoder().encode("aes-256-gcm:p"));
    const response = await handleMobile(profileRequest(token, { format: "ss" }), env);
    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe(
      `ss://${userinfo}@[2001:db8::1]:8388#%E4%B8%9C%E4%BA%AC%201%20%23%F0%9F%98%80\n`,
    );
  });

  it("ss：password 含冒号与非 ASCII 时按 UTF-8 参与 base64url", async () => {
    const { db, env, accessToken } = await setup();
    const password = "p:密码 🔑";
    await seedServer(db, {
      id: "srv_ss_password",
      name: "特殊密码",
      createdAt: 1,
      host: "203.0.113.10",
      port: 20343,
      password,
    });
    const token = await createToken(env, accessToken);

    const userinfo = b64u(new TextEncoder().encode(`aes-256-gcm:${password}`));
    expect(new TextDecoder().decode(fromB64u(userinfo))).toBe(`aes-256-gcm:${password}`);
    const response = await handleMobile(profileRequest(token, { format: "ss" }), env);
    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe(
      `ss://${userinfo}@203.0.113.10:20343#%E7%89%B9%E6%AE%8A%E5%AF%86%E7%A0%81\n`,
    );
  });

  it("ss 零节点：200 + 0 字节 body", async () => {
    const { env, accessToken } = await setup();
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token, { format: "ss" }), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response!.text()).toBe("");
  });

  it("ss 全部凭据不可用：503", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, { id: "srv_ss_bad", name: "坏凭据", createdAt: 1, corruptCredential: true });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(profileRequest(token, { format: "ss" }), env);
    expect(response?.status).toBe(503);
    const body = (await response!.json()) as { code: string; details: { reason: string } };
    expect(body.code).toBe("INTERNAL");
    expect(body.details.reason).toBe("mobile_profile_unavailable");
  });

  it("Shadowrocket 配置：节点、select 组、国内直连与兜底，精确输出", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, {
      id: "srv_sr",
      name: "东京 1 号",
      createdAt: 1,
      host: "203.0.113.10",
      port: 20343,
      password: "s3cret-password",
    });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(
      profileRequest(token, { format: "shadowrocket" }),
      env,
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response!.text()).toBe(
      "[General]\n" +
        "bypass-system = true\n" +
        "dns-server = system, 223.5.5.5, 119.29.29.29\n" +
        "skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local\n" +
        "\n" +
        "[Proxy]\n" +
        "东京 1 号 = ss, 203.0.113.10, 20343, encrypt-method=aes-256-gcm, password=s3cret-password, udp-relay=true\n" +
        "\n" +
        "[Proxy Group]\n" +
        "Veyl = select, 东京 1 号\n" +
        "\n" +
        "[Rule]\n" +
        "DOMAIN-SUFFIX,cn,DIRECT\n" +
        "GEOIP,CN,DIRECT\n" +
        "FINAL,Veyl\n",
    );
  });

  it("Shadowrocket 配置：逗号或引号进名字与密码时用双引号包住，行结构不破", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, {
      id: "srv_sr_special",
      name: "东京,1\n号",
      createdAt: 1,
      host: "203.0.113.10",
      port: 20343,
      password: "p,a\"ss",
    });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(
      profileRequest(token, { format: "shadowrocket" }),
      env,
    );
    expect(response?.status).toBe(200);
    const conf = await response!.text();

    // 换行被压成空格：行式配置里出现裸换行会切断一整行。
    expect(conf).toContain('"东京,1 号" = ss, ');
    expect(conf).toContain("password=\"p,a'ss\", udp-relay=true");
    const groupLine = conf.split("\n").find((line) => line.startsWith("Veyl = select, "));
    expect(groupLine).toBeDefined();
    expect(groupLine!).toContain('"东京,1 号"');
    // 每条 [Proxy] 行都必须自带 = 与 ss，没有被换行切成两半。
    const proxyLines = conf.split("[Proxy]\n")[1].split("\n\n")[0].split("\n");
    for (const line of proxyLines) expect(line).toContain(" = ss, ");
  });

  it("Shadowrocket 零节点：无 [Proxy Group]，规则兜底 DIRECT", async () => {
    const { env, accessToken } = await setup();
    const token = await createToken(env, accessToken);

    const response = await handleMobile(
      profileRequest(token, { format: "shadowrocket" }),
      env,
    );
    expect(response?.status).toBe(200);
    const conf = await response!.text();
    expect(conf).not.toContain("[Proxy Group]");
    expect(conf.endsWith("FINAL,DIRECT\n")).toBe(true);
  });

  it("Shadowrocket 全部凭据不可用：503", async () => {
    const { db, env, accessToken } = await setup();
    await seedServer(db, { id: "srv_sr_bad", name: "坏凭据", createdAt: 1, corruptCredential: true });
    const token = await createToken(env, accessToken);

    const response = await handleMobile(
      profileRequest(token, { format: "shadowrocket" }),
      env,
    );
    expect(response?.status).toBe(503);
    const body = (await response!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("mobile_profile_unavailable");
  });

  it("保留名冲突：节点名避开内建名，且三种格式里名字一致", async () => {
    const { db, env, accessToken } = await setup();
    const names = ["proxy", "Direct", "Veyl", "REJECT"];
    for (const [index, name] of names.entries()) {
      await seedServer(db, { id: `srv_reserved_${index}`, name, createdAt: index + 1 });
    }
    const token = await createToken(env, accessToken);
    const expected = ["proxy (2)", "Direct (2)", "Veyl (2)", "REJECT (2)"];

    const singboxResponse = await handleMobile(profileRequest(token), env);
    expect(singboxResponse?.status).toBe(200);
    const singbox = (await singboxResponse!.json()) as MobileConfig;
    expect(
      singbox.outbounds.filter((outbound) => outbound.type === "shadowsocks").map((o) => o.tag),
    ).toEqual(expected);

    const clashResponse = await handleMobile(profileRequest(token, { format: "clash" }), env);
    expect(clashResponse?.status).toBe(200);
    expect(clashProxyNames(await clashResponse!.text())).toEqual(expected);

    const ssResponse = await handleMobile(profileRequest(token, { format: "ss" }), env);
    expect(ssResponse?.status).toBe(200);
    const ssNames = (await ssResponse!.text())
      .trim()
      .split("\n")
      .map((line) => decodeURIComponent(line.split("#")[1]));
    expect(ssNames).toEqual(expected);
  });

  it("账户被停用后 profile 返回 403", async () => {
    const { db, env, accessToken } = await setup();
    const token = await createToken(env, accessToken);
    const account = db.accounts.find((row) => row.id === ACCOUNT)!;
    account.status = "disabled";

    const response = await handleMobile(profileRequest(token), env);
    expect(response?.status).toBe(403);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = (await response!.json()) as { code: string; details: { reason: string } };
    expect(body.code).toBe("FORBIDDEN");
    expect(body.details.reason).toBe("account_blocked");
  });

  it("三种格式共享 30 次/小时预算", async () => {
    const { env, accessToken } = await setup();
    const token = await createToken(env, accessToken);
    for (let attempt = 0; attempt < 29; attempt += 1) {
      const response = await handleMobile(profileRequest(token), env);
      expect(response?.status).toBe(200);
    }
    const clash = await handleMobile(profileRequest(token, { format: "clash" }), env);
    expect(clash?.status).toBe(200);
    const limited = await handleMobile(profileRequest(token, { format: "ss" }), env);
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

  it("last_used_at 5 分钟内只写一次（三种格式共用）", async () => {
    const { db, env, accessToken } = await setup();
    const token = await createToken(env, accessToken);

    await handleMobile(profileRequest(token), env);
    const first = db.tokens[0].last_used_at;
    expect(first).not.toBeNull();
    await handleMobile(profileRequest(token, { format: "ss" }), env);
    expect(db.tokens[0].last_used_at).toBe(first);
  });
});

describe("GET /rules", () => {
  const cases = [
    { path: "/rules/geosite-cn.srs", bytes: geositeCn, size: 57_792 },
    { path: "/rules/geoip-cn.srs", bytes: geoipCn, size: 34_259 },
    { path: "/rules/geosite-cn.mrs", bytes: geositeCnMrs, size: 532_882 },
    { path: "/rules/geoip-cn.mrs", bytes: geoipCnMrs, size: 37_527 },
  ];

  it.each(cases)("$path 原样下发：字节数、缓存头、无需认证", async ({ path, bytes, size }) => {
    // 大小与 assets/rules/README.md 记录的上游文件一致。
    expect(bytes.byteLength).toBe(size);

    // 不带任何 Authorization：规则是公开数据。
    const response = await route(new Request(`https://cp.example.com${path}`), {} as Env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const body = await response.arrayBuffer();
    expect(body.byteLength).toBe(size);
    expect(await sha256Hex(body)).toBe(await sha256Hex(bytes));
  });

  it("/rules 以外的路径不会被规则路由吞掉", async () => {
    const response = await route(new Request("https://cp.example.com/rules/other.srs"), {} as Env);
    expect(response.status).toBe(404);
  });
});

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
