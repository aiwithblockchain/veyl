import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";

import type { Env } from "../src/index";
import type { ServerRow } from "../src/render";

const TEAM_DOMAIN = "https://veyl-test.cloudflareaccess.com";
const CERTS_URL = `${TEAM_DOMAIN}/cdn-cgi/access/certs`;
const AUD = "test-aud-tag";
const EMAIL = "admin@example.com";
const KID = "test-kid";

const HOUR = 3_600_000;
const DAY = 86_400_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let accessPrivateKey: CryptoKey;
let accessPublicJwk: Record<string, unknown>;
let opsPrivateJwk: string;
let opsPublicKey: CryptoKey;
let worker: { fetch(request: Request, env: Env): Promise<Response> };

function b64uBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uJson(value: unknown): string {
  return b64uBytes(encoder.encode(JSON.stringify(value)));
}

function decodePart<T>(part: string): T {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return JSON.parse(decoder.decode(Uint8Array.from(atob(padded + pad), (c) => c.charCodeAt(0)))) as T;
}

async function signAccessJwt(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64uJson({ alg: "RS256", typ: "JWT", kid: KID });
  const payload = b64uJson({
    aud: [AUD],
    email: EMAIL,
    iat: now,
    exp: now + 300,
    iss: TEAM_DOMAIN,
    ...overrides,
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      accessPrivateKey,
      encoder.encode(`${header}.${payload}`),
    ),
  );
  return `${header}.${payload}.${b64uBytes(signature)}`;
}

interface AuditRow {
  at: number;
  account_id: string | null;
  server_id: string;
  action: string;
  detail: Record<string, unknown>;
}

/** 只实现这个 worker 会发的那三条语句；遇到别的语句直接抛，避免测试悄悄走错分支。 */
class FakeDb {
  servers: Array<ServerRow & { account_id: string; destroyed_at: number | null }> = [];
  audit: AuditRow[] = [];

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
    const db = this;
    const statement = {
      args: [] as unknown[],
      bind(...args: unknown[]) {
        statement.args = args;
        return statement;
      },
      async all() {
        if (norm.startsWith("select id, name, state")) {
          return { results: db.servers.filter((row) => row.destroyed_at === null) };
        }
        throw new Error(`unexpected all(): ${norm}`);
      },
      async first() {
        if (norm.startsWith("select id, account_id, ip, control_port")) {
          const id = statement.args[0];
          const row = db.servers.find((entry) => entry.id === id && entry.destroyed_at === null);
          if (!row) return null;
          return {
            id: row.id,
            account_id: row.account_id,
            ip: row.ip,
            control_port: row.control_port,
          };
        }
        throw new Error(`unexpected first(): ${norm}`);
      },
      async run() {
        if (norm.startsWith("insert into audit_log")) {
          const [at, accountId, serverId, action, detail] = statement.args as [
            number,
            string,
            string,
            string,
            string,
          ];
          db.audit.push({
            at,
            account_id: accountId,
            server_id: serverId,
            action,
            detail: JSON.parse(detail) as Record<string, unknown>,
          });
          return { meta: { changes: 1 } };
        }
        throw new Error(`unexpected run(): ${norm}`);
      },
    };
    return statement;
  }
}

function server(overrides: Partial<ServerRow> = {}): ServerRow {
  return {
    id: "srv_alpha",
    name: "alpha",
    state: "active",
    agent_version: "0.1.7",
    ip: "203.0.113.7",
    control_port: 32100,
    cert_not_after: Math.floor((Date.now() + 100 * DAY) / 1000),
    last_seen_at: Date.now() - HOUR,
    provider_gone_at: null,
    failure_code: null,
    failure_stage: null,
    ...overrides,
  };
}

function envWith(prod: FakeDb, dev: FakeDb = new FakeDb()): Env {
  return {
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUD,
    DB_PROD: prod as unknown as D1Database,
    DB_DEV: dev as unknown as D1Database,
    OPS_TOKEN_SIGNING_JWK: opsPrivateJwk,
  };
}

function request(
  path: string,
  init: { method?: string; body?: unknown; jwt?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.jwt !== undefined) headers["cf-access-jwt-assertion"] = init.jwt;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://admin.test${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeEach(async () => {
  const accessPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  accessPrivateKey = accessPair.privateKey;
  accessPublicJwk = {
    ...((await crypto.subtle.exportKey("jwk", accessPair.publicKey)) as unknown as Record<string, unknown>),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };

  const opsPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  opsPrivateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", opsPair.privateKey));
  opsPublicKey = opsPair.publicKey;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === CERTS_URL) {
        return new Response(JSON.stringify({ keys: [accessPublicJwk] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }),
  );

  // JWKS 缓存与强制重拉冷却都在模块作用域，每个用例重新加载模块避免互相污染。
  vi.resetModules();
  worker = (await import("../src/index")).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("第一屏", () => {
  it("缺失值渲染成中性色，且数据库里的字符串全部转义", async () => {
    const db = new FakeDb();
    db.servers.push({
      ...server({ name: "<script>alert(1)</script>", id: "srv_<b>", state: "active" }),
      account_id: "acct_1",
      destroyed_at: null,
      agent_version: null,
      cert_not_after: null,
      last_seen_at: null,
    });

    const res = await worker.fetch(request("/", { jwt: await signAccessJwt() }), envWith(db, new FakeDb()));
    expect(res.status).toBe(200);
    const body = await res.text();

    // 面板要直连 https://<IP>:32100/mcp，CSP 必须放行该端口的跨源 https，
    // 否则 fetch 在 CORS 之前就被拦掉。
    expect(res.headers.get("content-security-policy")).toContain(
      "connect-src 'self' https://*:32100",
    );

    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("srv_&lt;b&gt;");
    expect(body).not.toContain("srv_<b>");

    // 缺失值：未签发 / — ，并且用 --text-missing 那一档，不借用状态色。
    expect(body).toContain(">未签发<");
    expect(body).toMatch(/class="num missing">—</);
    expect(body).toContain('class="mono missing">—<');
    expect(body).not.toMatch(/class="[^"]*(warntext|dangertext)[^"]*">未签发/);
  });

  it("证书到期列带剩余天数：729 天 / 临近 / 不足一天算已到期", async () => {
    const db = new FakeDb();
    const base = { account_id: "acct_1", destroyed_at: null };
    // 多给一小时余量，避免「刚好 N 天」被秒级取整吃掉一天。
    const at = (offsetMs: number) => Math.floor((Date.now() + offsetMs) / 1000);
    db.servers.push(
      { ...server({ id: "srv_far", name: "A-far", cert_not_after: at(729 * DAY + HOUR) }), ...base },
      { ...server({ id: "srv_soon", name: "B-soon", cert_not_after: at(3 * DAY + HOUR) }), ...base },
      { ...server({ id: "srv_zero", name: "C-zero", cert_not_after: at(12 * HOUR) }), ...base },
      { ...server({ id: "srv_expired", name: "D-expired", cert_not_after: at(-DAY) }), ...base },
    );

    const res = await worker.fetch(request("/", { jwt: await signAccessJwt() }), envWith(db, new FakeDb()));
    const body = await res.text();

    // 远期：日期 + 间隔号 + 剩余天数，文字保持 --text-3（dim）。
    expect(body).toMatch(/class="num text3">\d{4}-\d{2}-\d{2} · 剩余 729 天</);
    // 7 天内：天数与日期一起用 warn。
    expect(body).toMatch(/class="num text3 warntext">\d{4}-\d{2}-\d{2} · 剩余 3 天</);
    // 0 天与负数都显示「已到期」，用 danger。带 < 才是渲染出来的单元格——
    // 页面里还嵌着客户端脚本，「已到期」三个字在源码里也有一份。
    expect(body.match(/已到期</g)).toHaveLength(2);
    expect(body).toMatch(/class="num text3 dangertext">\d{4}-\d{2}-\d{2} · 已到期</);
  });

  it("云服务商已删除：状态列替代 active、只贡献 gone 一条、排在 active 之前", async () => {
    const db = new FakeDb();
    const base = { account_id: "acct_1", destroyed_at: null };
    db.servers.push(
      // state 仍是 active、30 小时没上报，但 provider_gone_at 非空：
      // 不该显示 active，也不该再算一条失联（否则一台机器进两栏）。
      {
        ...server({
          id: "srv_gone",
          name: "A-gone",
          state: "active",
          provider_gone_at: Date.now() - 2 * HOUR,
          last_seen_at: Date.now() - 30 * HOUR,
        }),
        ...base,
      },
      { ...server({ id: "srv_ok", name: "B-ok" }), ...base },
    );

    const res = await worker.fetch(request("/", { jwt: await signAccessJwt() }), envWith(db, new FakeDb()));
    const body = await res.text();

    expect(body).toContain('chip-danger">云服务商已删除<');
    // 只有那台健康节点还带 active chip。
    expect(body.match(/chip-ok">active</g)).toHaveLength(1);
    expect(body).toContain("待处理 1 台");
    expect(body).toContain("云服务商已删除 1");
    expect(body).not.toContain("失联 1");
    expect(body.indexOf("A-gone")).toBeLessThan(body.indexOf("B-ok"));
  });

  it("建机中的节点不进待处理：只有 active 缺版本才算", async () => {
    const db = new FakeDb();
    const base = { account_id: "acct_1", destroyed_at: null };
    db.servers.push(
      // 建机中：没版本、30 小时没上报，但既不该进横幅，也不该染 alert 色。
      {
        ...server({
          id: "srv_building",
          name: "A-building",
          state: "booting",
          agent_version: null,
          cert_not_after: null,
          last_seen_at: Date.now() - 30 * HOUR,
        }),
        ...base,
      },
      { ...server({ id: "srv_live", name: "B-live", state: "active", agent_version: null }), ...base },
    );

    const res = await worker.fetch(request("/", { jwt: await signAccessJwt() }), envWith(db, new FakeDb()));
    const body = await res.text();

    expect(body).toContain("A-building");
    expect(body).toContain('chip-neutral">booting');
    expect(body).toContain("待处理 1 台");
    expect(body).toContain("无版本 1");
    expect(body).not.toContain("失联 1");
    // 样式表里本来就有 .warntext，这里断言的是没有任何单元格用上它。
    expect(body).not.toMatch(/class="[^"]*warntext/);

    // 有问题的 active 行排在建机中的行前面，即使名字排序相反。
    expect(body.indexOf("B-live")).toBeLessThan(body.indexOf("A-building"));
  });

  it("需要处理的排最上面：failed > 证书 > 失联 > 无版本 > 正常", async () => {
    const db = new FakeDb();
    const base = { account_id: "acct_1", destroyed_at: null };
    const far = Math.floor((Date.now() + 100 * DAY) / 1000);
    const soon = Math.floor((Date.now() + 3 * DAY) / 1000);
    const recent = Date.now() - HOUR;

    db.servers.push(
      { ...server({ id: "srv_5", name: "E-healthy" }), ...base },
      { ...server({ id: "srv_4", name: "D-no-version", agent_version: null, cert_not_after: far }), ...base },
      { ...server({ id: "srv_3", name: "C-stale", last_seen_at: Date.now() - 30 * HOUR, cert_not_after: far }), ...base },
      { ...server({ id: "srv_2", name: "B-cert", cert_not_after: soon }), ...base },
      { ...server({ id: "srv_1", name: "A-failed", state: "error", cert_not_after: far }), ...base },
    );

    const res = await worker.fetch(request("/", { jwt: await signAccessJwt() }), envWith(db, new FakeDb()));
    const body = await res.text();

    const order = ["A-failed", "B-cert", "C-stale", "D-no-version", "E-healthy"].map((name) =>
      body.indexOf(name),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    expect(body).toContain("待处理 4 台");
    expect(body).toContain("失败 1");
    expect(body).toContain("证书 1");
    expect(body).toContain("失联 1");
    expect(body).toContain("无版本 1");
    // 失败行是唯一整行变色的地方。
    expect(body).toContain('class="is-failed"');
  });
});

describe("POST /ticket", () => {
  it("签出 EdDSA 票，claims 正确、有效期一小时，并把 env 与 jti 记进审计", async () => {
    const db = new FakeDb();
    db.servers.push({ ...server({ id: "srv_alpha" }), account_id: "acct_1", destroyed_at: null });

    const before = Math.floor(Date.now() / 1000);
    const res = await worker.fetch(
      request("/ticket", { method: "POST", body: { env: "prod", server_id: "srv_alpha" }, jwt: await signAccessJwt() }),
      envWith(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jwt: string; exp: number };

    const [headerPart, payloadPart, signaturePart] = body.jwt.split(".");
    expect(decodePart<{ alg: string }>(headerPart)).toMatchObject({ alg: "EdDSA", typ: "JWT" });

    const claims = decodePart<{ server_id: string; jti: string; exp: number }>(payloadPart);
    expect(claims.server_id).toBe("srv_alpha");
    expect(typeof claims.jti).toBe("string");
    expect(claims.jti.length).toBeGreaterThan(8);
    expect(claims.exp).toBeGreaterThanOrEqual(before + 3600);
    expect(claims.exp).toBeLessThanOrEqual(before + 3600 + 5);
    expect(Object.keys(claims).sort()).toEqual(["exp", "jti", "server_id"]);

    const signature = Uint8Array.from(atob(signaturePart.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      opsPublicKey,
      signature,
      encoder.encode(`${headerPart}.${payloadPart}`),
    );
    expect(valid).toBe(true);

    // 审计记 env、jti 与操作者；JWT 绝不落库。
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({
      account_id: "acct_1",
      server_id: "srv_alpha",
      action: "ops.ticket.issued",
      detail: { env: "prod", jti: claims.jti, actor: EMAIL },
    });
    expect(JSON.stringify(db.audit)).not.toContain(body.jwt);
  });

  it("审计的操作者是验过的 Access 邮箱，且不含票的任何一段", async () => {
    const db = new FakeDb();
    db.servers.push({ ...server({ id: "srv_alpha" }), account_id: "acct_1", destroyed_at: null });
    const jwt = await signAccessJwt({ email: "oncall@example.com" });

    const res = await worker.fetch(
      request("/ticket", { method: "POST", body: { env: "prod", server_id: "srv_alpha" }, jwt }),
      envWith(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jwt: string };

    // actor 来自验签后的 claims，不是请求头里的自称。
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0].detail).toMatchObject({ actor: "oncall@example.com" });

    // 头、载荷、签名三段都不进审计。
    const stored = JSON.stringify(db.audit);
    for (const part of body.jwt.split(".")) expect(stored).not.toContain(part);
  });

  it("伪造的 Actor 头无效：审计里的 actor 只认验签后的邮箱", async () => {
    const db = new FakeDb();
    db.servers.push({ ...server({ id: "srv_alpha" }), account_id: "acct_1", destroyed_at: null });

    const res = await worker.fetch(
      request("/ticket", {
        method: "POST",
        body: { env: "prod", server_id: "srv_alpha" },
        jwt: await signAccessJwt(),
        // 客户端可以随便带这类自称头；它们不是身份来源。
        headers: {
          "x-actor": "someone@evil.example",
          "x-authenticated-user-email": "someone@evil.example",
        },
      }),
      envWith(db),
    );
    expect(res.status).toBe(200);

    expect(db.audit).toHaveLength(1);
    expect(db.audit[0].detail).toMatchObject({ actor: EMAIL });
    expect(JSON.stringify(db.audit)).not.toContain("evil.example");
  });

  it("已销毁的节点拒绝签票，也不写审计", async () => {
    const db = new FakeDb();
    db.servers.push({ ...server({ id: "srv_gone" }), account_id: "acct_1", destroyed_at: Date.now() });

    const res = await worker.fetch(
      request("/ticket", { method: "POST", body: { env: "prod", server_id: "srv_gone" }, jwt: await signAccessJwt() }),
      envWith(db),
    );

    expect(res.status).toBe(404);
    expect(db.audit).toHaveLength(0);
  });

  it("没配运维签名密钥：页面照常渲染，签票回 503 且不回显任何密钥材料", async () => {
    const db = new FakeDb();
    db.servers.push({ ...server({ id: "srv_alpha" }), account_id: "acct_1", destroyed_at: null });
    const env = envWith(db);
    delete env.OPS_TOKEN_SIGNING_JWK;

    const page = await worker.fetch(request("/", { jwt: await signAccessJwt() }), env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("alpha");

    const res = await worker.fetch(
      request("/ticket", { method: "POST", body: { env: "prod", server_id: "srv_alpha" }, jwt: await signAccessJwt() }),
      env,
    );
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("signing_key_missing");

    const secret = (JSON.parse(opsPrivateJwk) as JsonWebKey).d!;
    expect(body).not.toContain(secret);
    expect(body).not.toContain('"d"');
    expect(db.audit).toHaveLength(0);
  });

  it("签名密钥配坏：对外只回固定 code，响应与日志都不带密钥正文", async () => {
    const db = new FakeDb();
    db.servers.push({ ...server({ id: "srv_alpha" }), account_id: "acct_1", destroyed_at: null });
    const canary = "SECRET-LEAK-CANARY";
    // 故意缺右花括号：JSON.parse 抛的 SyntaxError 在部分 V8 版本里会把输入片段带进 message，
    // 这里放的 canary 就是用来证明那段正文不会被回显。
    const env = {
      ...envWith(db),
      OPS_TOKEN_SIGNING_JWK: `{"kty":"OKP","crv":"Ed25519","d":"${canary}",`,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await worker.fetch(
        request("/ticket", { method: "POST", body: { env: "prod", server_id: "srv_alpha" }, jwt: await signAccessJwt() }),
        env,
      );

      expect(res.status).toBe(500);
      const body = await res.text();
      // 响应体必须是固定的两个字段——多一个字符的错误正文都算回显。
      expect(JSON.parse(body)).toEqual({ error: "签票失败", code: "sign_failed" });
      expect(body).not.toContain(canary);
      expect(db.audit).toHaveLength(0);

      const logged = warn.mock.calls.map(([line]) => String(line)).join("\n");
      expect(logged).not.toContain(canary);
      expect(logged).toContain("ops_ticket_sign_failed");
    } finally {
      warn.mockRestore();
    }
  });

  it("env 不是 prod/dev 时拒绝，不读库", async () => {
    const db = new FakeDb();
    const res = await worker.fetch(
      request("/ticket", { method: "POST", body: { env: "staging", server_id: "srv_alpha" }, jwt: await signAccessJwt() }),
      envWith(db),
    );

    expect(res.status).toBe(400);
    expect(db.audit).toHaveLength(0);
  });

  it("没有 Access JWT 时 401，签票接口同样受门禁保护", async () => {
    const db = new FakeDb();
    const res = await worker.fetch(
      request("/ticket", { method: "POST", body: { env: "prod", server_id: "srv_alpha" } }),
      envWith(db),
    );

    expect(res.status).toBe(401);
  });
});
