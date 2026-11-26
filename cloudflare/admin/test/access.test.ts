import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/index";

const TEAM_DOMAIN = "https://veyl-test.cloudflareaccess.com";
const CERTS_URL = `${TEAM_DOMAIN}/cdn-cgi/access/certs`;
const AUD = "test-aud-tag";
const EMAIL = "admin@example.com";
const KID = "test-kid";

const encoder = new TextEncoder();

let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;
let worker: { fetch(request: Request, env: Env): Promise<Response> };
let certsBehavior: "ok" | "error" | "throw";
let fetchedUrls: string[];

function b64uBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uJson(value: unknown): string {
  return b64uBytes(encoder.encode(JSON.stringify(value)));
}

async function signJwt(
  tokenClaims: Record<string, unknown>,
  options: { kid?: string; alg?: string } = {},
): Promise<string> {
  const header = b64uJson({ alg: options.alg ?? "RS256", typ: "JWT", kid: options.kid ?? KID });
  const payload = b64uJson(tokenClaims);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      encoder.encode(`${header}.${payload}`),
    ),
  );
  return `${header}.${payload}.${b64uBytes(signature)}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: [AUD], email: EMAIL, iat: now, exp: now + 300, iss: TEAM_DOMAIN, ...overrides };
}

function env(): Env {
  return { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD };
}

function home(jwt?: string, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { ...extra };
  if (jwt !== undefined) headers["cf-access-jwt-assertion"] = jwt;
  return new Request("https://admin.test/", { headers });
}

function certsFetches(): number {
  return fetchedUrls.filter((url) => url === CERTS_URL).length;
}

beforeEach(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as unknown as Record<string, unknown>),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };

  certsBehavior = "ok";
  fetchedUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (certsBehavior === "throw") throw new Error("network down");
      if (certsBehavior === "error") return new Response("boom", { status: 500 });
      if (url === CERTS_URL) {
        return new Response(JSON.stringify({ keys: [publicJwk], public_cert: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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

describe("admin Access 门禁", () => {
  it("合法 JWT 放行并显示 email 声明", async () => {
    const res = await worker.fetch(home(await signJwt(claims())), env());

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(EMAIL);
    expect(body).toContain("/cdn-cgi/access/logout");
  });

  it("缺少 Cf-Access-Jwt-Assertion 返回 401", async () => {
    const res = await worker.fetch(home(), env());

    expect(res.status).toBe(401);
  });

  it("篡改 payload 后签名对不上返回 401", async () => {
    const jwt = await signJwt(claims());
    const [header, , signature] = jwt.split(".");
    const tampered = b64uJson({ ...claims(), email: "attacker@example.com" });

    const res = await worker.fetch(home(`${header}.${tampered}.${signature}`), env());

    expect(res.status).toBe(401);
  });

  it("aud 不匹配返回 401", async () => {
    const res = await worker.fetch(home(await signJwt(claims({ aud: ["other-aud"] }))), env());

    expect(res.status).toBe(401);
  });

  it("exp 已过期返回 401", async () => {
    const expired = Math.floor(Date.now() / 1000) - 3600;
    const res = await worker.fetch(home(await signJwt(claims({ exp: expired }))), env());

    expect(res.status).toBe(401);
  });

  it("iss 不是该 team domain 返回 401", async () => {
    const res = await worker.fetch(
      home(await signJwt(claims({ iss: "https://evil.cloudflareaccess.com" }))),
      env(),
    );

    expect(res.status).toBe(401);
  });

  it("只塞 Cf-Access-Authenticated-User-Email 头不放行", async () => {
    const res = await worker.fetch(
      home(undefined, { "cf-access-authenticated-user-email": "admin@example.com" }),
      env(),
    );

    expect(res.status).toBe(401);
  });

  it("缺少访问配置时返回 503 而不是 401", async () => {
    const res = await worker.fetch(home(await signJwt(claims())), {});

    expect(res.status).toBe(503);
  });

  it("alg 为 none 时拒绝（即使签名本身合法）", async () => {
    const res = await worker.fetch(home(await signJwt(claims(), { alg: "none" })), env());

    expect(res.status).toBe(401);
  });

  it("alg 为 HS256 时拒绝（即使签名本身合法）", async () => {
    const res = await worker.fetch(home(await signJwt(claims(), { alg: "HS256" })), env());

    expect(res.status).toBe(401);
  });

  it("nbf 在未来返回 401", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const res = await worker.fetch(home(await signJwt(claims({ nbf: future }))), env());

    expect(res.status).toBe(401);
  });

  it("nbf 缺失时照常放行", async () => {
    const token = claims();
    delete token.nbf;
    const res = await worker.fetch(home(await signJwt(token)), env());

    expect(res.status).toBe(200);
  });

  it("email 声明缺失或为空时返回 401", async () => {
    const missing = claims();
    delete missing.email;
    expect((await worker.fetch(home(await signJwt(missing)), env())).status).toBe(401);

    expect((await worker.fetch(home(await signJwt(claims({ email: "" }))), env())).status).toBe(401);
  });

  it("JWKS 拉取返回 500 时拒绝，不 fail-open", async () => {
    certsBehavior = "error";
    const res = await worker.fetch(home(await signJwt(claims())), env());

    expect(res.status).toBe(401);
  });

  it("JWKS 拉取抛错时拒绝，不 fail-open", async () => {
    certsBehavior = "throw";
    const res = await worker.fetch(home(await signJwt(claims())), env());

    expect(res.status).toBe(401);
  });

  it("未知 kid 重拉后仍无匹配则拒绝，冷却期内不再重拉", async () => {
    const jwt = await signJwt(claims(), { kid: "unknown-kid" });

    const first = await worker.fetch(home(jwt), env());
    expect(first.status).toBe(401);
    // 首次拉取 + 一次强制重拉
    expect(certsFetches()).toBe(2);

    const second = await worker.fetch(home(jwt), env());
    expect(second.status).toBe(401);
    expect(certsFetches()).toBe(2);
  });
});
