import { afterEach, describe, expect, it, vi } from "vitest";

import { handleServers } from "../src/servers";
import { openSecret, sha256B64u, signAccessToken } from "../src/lib/crypto";
import { fromB64u } from "../src/lib/crypto";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_agent000000000000000";
const DEVICE = "dev_agent000000000000000";
const SERVER = "srv_agent00000000000000";
const ENROLL_TOKEN = "enr_agent000000000000";
const ENC_KEY = "A".repeat(43);

async function signingJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

function seedServer(db: FakeD1, state = "booting") {
  db.rows("servers").push({
    id: SERVER,
    account_id: ACCOUNT,
    order_id: "ord_agent",
    provider: "digitalocean",
    provider_id: "4242",
    name: "我的服务器0001",
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    hourly_usd: 0.00893,
    monthly_usd: 6,
    state,
    node_port: 30412,
    ip: "203.0.113.10",
    node_id: null,
    enrollment_hash: null,
    enrollment_expires_at: null,
    enrollment_used_at: null,
    firewall_id: null,
    server_token_hash: null,
    control_port: null,
    cert_fingerprint: null,
    last_seen_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    destroyed_at: null,
  });
  db.rows("orders").push({
    id: "ord_agent",
    account_id: ACCOUNT,
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    amount_usd: 0.3,
    amount_cents: 30,
    hourly_usd: 0.00893,
    state: "provisioning",
    idempotency_key: "idem-agent",
    charge_mode: "at_ready",
    created_at: Date.now(),
  });
}

async function envWith(db: FakeD1, jwk: string) {
  db.rows("accounts").push({
    id: ACCOUNT,
    kind: "email",
    status: "active",
    balance_cents: 100,
  });
  db.rows("devices").push({ id: DEVICE, account_id: ACCOUNT, revoked_at: null });
  const token = await signAccessToken(jwk, {
    sub: ACCOUNT,
    did: DEVICE,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: "jti_agent",
  });
  const agentJwk = await signingJwk();
  return {
    DB: db as unknown as D1Database,
    TOKEN_SIGNING_JWK: jwk,
    DO_API_TOKEN: "do-token",
    ENVIRONMENT: "test",
    CREDENTIAL_ENC_KEY: ENC_KEY,
    AGENT_TOKEN_SIGNING_JWK: agentJwk,
    AGENT_TOKEN_KEY_ID: "agent-test",
    SING_BOX_VERSION: "1.14.4",
    SING_BOX_SHA256: "b".repeat(64),
    SING_BOX_DOWNLOAD_URL: "https://control.example.com/sing-box.tar.gz",
    token,
  };
}

async function seedEnrollment(db: FakeD1) {
  Object.assign(db.rows("servers")[0], {
    enrollment_hash: await sha256B64u(ENROLL_TOKEN),
    enrollment_expires_at: Date.now() + 60_000,
  });
}

/** 直接给服务器塞一把已知 server_token，省掉 enroll 流程。 */
async function seedAgentToken(db: FakeD1, token = "agt_known"): Promise<string> {
  db.rows("servers")[0].server_token_hash = await sha256B64u(token);
  return token;
}

function enrollRequest() {
  return new Request("https://example.com/v1/agent/enroll", {
    method: "POST",
    headers: { authorization: `Bearer ${ENROLL_TOKEN}` },
  });
}

function reportRequest(serverToken: string, body: Record<string, unknown>) {
  return new Request("https://example.com/v1/agent/report", {
    method: "POST",
    headers: { authorization: `Bearer ${serverToken}` },
    body: JSON.stringify(body),
  });
}

async function enrollAndGetToken(env: never): Promise<string> {
  const res = await handleServers(enrollRequest(), env);
  const body = (await res!.json()) as { server_token: string };
  return body.server_token;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /v1/agent/enroll", () => {
  it("消费一次性 token，下发凭据与期望状态，server_token 只返回一次且只存哈希", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db);
    await seedEnrollment(db);

    const res = await handleServers(enrollRequest(), env as never);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      server_id: string;
      server_token: string;
      desired: {
        port: number;
        password: string;
        control_port: number;
        singbox: { version: string; sha256: string; url: string };
      };
      token_public_key: string;
    };

    expect(body.server_id).toBe(SERVER);
    expect(body.server_token.startsWith("agt_")).toBe(true);
    expect(body.desired.port).toBe(30412);
    // 32 位十六进制密码。
    expect(body.desired.password).toMatch(/^[0-9a-f]{32}$/);
    expect(body.desired.control_port).toBe(32100);
    expect(body.desired.singbox).toEqual({
      version: "1.14.4",
      sha256: "b".repeat(64),
      url: "https://control.example.com/sing-box.tar.gz",
    });

    // 公钥只能验签，不含私钥参数。
    const publicKey = JSON.parse(body.token_public_key) as Record<string, unknown>;
    expect(publicKey.kty).toBe("OKP");
    expect(publicKey.crv).toBe("Ed25519");
    expect(typeof publicKey.x).toBe("string");
    expect(publicKey.d).toBeUndefined();

    const server = db.rows("servers")[0];
    expect(server.enrollment_used_at).toBeTruthy();
    expect(server.node_id).toBeTruthy();
    expect(server.server_token_hash).toBeTruthy();
    expect(server.server_token_hash).not.toBe(body.server_token);

    // 凭据封存的内容必须与下发的期望状态一致（host 取 IP）。
    const sealed = db.rows("credentials")[0];
    expect(sealed).toBeTruthy();
    const opened = await openSecret(ENC_KEY, {
      iv: sealed.iv as string,
      ciphertext: sealed.ciphertext as string,
    });
    expect(JSON.parse(opened!)).toEqual({
      host: "203.0.113.10",
      port: 30412,
      password: body.desired.password,
      method: "aes-256-gcm",
    });

    // TTL 内重放不再 409：换发新的 server_token（旧令牌失效），凭据保持不变。
    const replay = await handleServers(enrollRequest(), env as never);
    expect(replay?.status).toBe(200);
    const replayBody = (await replay!.json()) as { server_token: string };
    expect(replayBody.server_token).not.toBe(body.server_token);
  });

  it("TTL 内重放：换发 token、旧 token 失效、凭据端口与密码不变", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db);
    await seedEnrollment(db);

    const first = (await (
      await handleServers(enrollRequest(), env as never)
    )!.json()) as { server_token: string; desired: { port: number; password: string } };
    const sealedBefore = { ...db.rows("credentials")[0] };

    const replay = await handleServers(enrollRequest(), env as never);
    expect(replay?.status).toBe(200);
    const second = (await replay!.json()) as {
      server_token: string;
      desired: { port: number; password: string };
    };
    expect(second.server_token).not.toBe(first.server_token);
    expect(second.desired.port).toBe(first.desired.port);
    expect(second.desired.password).toBe(first.desired.password);

    const desiredRequest = (token: string) =>
      new Request("https://example.com/v1/agent/desired-state", {
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await handleServers(desiredRequest(second.server_token), env as never))?.status).toBe(200);
    // 旧令牌立即失效。
    expect((await handleServers(desiredRequest(first.server_token), env as never))?.status).toBe(401);

    // 凭据重封（新 IV），明文端口与密码不变。
    const sealed = db.rows("credentials")[0];
    expect(sealed.iv).not.toBe(sealedBefore.iv);
    const opened = await openSecret(ENC_KEY, {
      iv: sealed.iv as string,
      ciphertext: sealed.ciphertext as string,
    });
    expect(JSON.parse(opened!)).toMatchObject({
      port: first.desired.port,
      password: first.desired.password,
    });
    expect(db.rows("audit_log").some((row) => row.action === "agent.re_enrolled")).toBe(true);
  });

  it("重放限流：同一服务器 5 分钟内第 4 次 429", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db);
    await seedEnrollment(db);

    expect((await handleServers(enrollRequest(), env as never))?.status).toBe(200);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await handleServers(enrollRequest(), env as never))?.status).toBe(200);
    }
    const limited = await handleServers(enrollRequest(), env as never);
    expect(limited?.status).toBe(429);
    expect(((await limited!.json()) as { reason: string }).reason).toBe("rate_limited");
  });

  it("enrollment 过期：409 expired 并销毁；期望状态构建信息不合规：503 invalid", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db);
    await seedEnrollment(db);
    // 先正常 enroll 消费 token，再把有效期拉到「还剩 1 分钟」：仍在 20 分钟 TTL 内，可以重放。
    expect((await handleServers(enrollRequest(), env as never))?.status).toBe(200);
    db.rows("servers")[0].enrollment_expires_at = Date.now() + 60_000;
    expect((await handleServers(enrollRequest(), env as never))?.status).toBe(200);

    // 超过 20 分钟（expires_at 已过）：409 expired 并销毁。
    db.rows("servers")[0].enrollment_expires_at = Date.now() - 1;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    const expired = await handleServers(enrollRequest(), env as never);
    expect(expired?.status).toBe(409);
    expect(((await expired!.json()) as { reason: string }).reason).toBe("expired");
    expect(db.rows("servers")[0].state).toBe("destroyed");

    // 构建信息校验：sha 不是 64 位 hex，拒绝下发。
    const db2 = new FakeD1();
    const env2 = await envWith(db2, await signingJwk());
    seedServer(db2);
    await seedEnrollment(db2);
    const invalid = await handleServers(enrollRequest(), {
      ...env2,
      SING_BOX_SHA256: "g".repeat(64),
    } as never);
    expect(invalid?.status).toBe(503);
    expect(((await invalid!.json()) as { reason: string }).reason).toBe("agent_config_invalid");
    expect(db2.rows("credentials")).toHaveLength(0);
  });

  it("未知 token 404；缺 token 401", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db);

    const unknown = await handleServers(enrollRequest(), env as never);
    expect(unknown?.status).toBe(404);
    expect(((await unknown!.json()) as { reason: string }).reason).toBe("unknown_token");

    const missing = await handleServers(
      new Request("https://example.com/v1/agent/enroll", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      env as never,
    );
    expect(missing?.status).toBe(401);
  });
});

describe("POST /v1/agent/report", () => {
  it("三段上报推进并激活：node_id 沿用 enroll 生成的值，登记信息落库", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db);
    await seedEnrollment(db);
    const serverToken = await enrollAndGetToken(env as never);
    const nodeId = db.rows("servers")[0].node_id;
    expect(nodeId).toBeTruthy();

    const installing = await handleServers(
      reportRequest(serverToken, { stage: "installing", agent_version: "0.1.0" }),
      env as never,
    );
    expect(installing?.status).toBe(200);
    expect(db.rows("servers")[0].state).toBe("installing");
    expect(db.rows("servers")[0].agent_version).toBe("0.1.0");
    expect(db.rows("servers")[0].last_seen_at).toBeTruthy();

    const verifying = await handleServers(
      reportRequest(serverToken, {
        stage: "verifying",
        control_port: 32100,
        cert_fingerprint: "AA:BB:CC",
      }),
      env as never,
    );
    expect(verifying?.status).toBe(200);
    expect(db.rows("servers")[0].state).toBe("verifying");
    expect(db.rows("servers")[0].control_port).toBe(32100);
    expect(db.rows("servers")[0].cert_fingerprint).toBe("AA:BB:CC");

    const active = await handleServers(
      reportRequest(serverToken, {
        stage: "active",
        port: 30412,
        agent_version: "0.1.0",
        singbox_version: "1.14.4",
      }),
      env as never,
    );
    expect(active?.status).toBe(200);
    const server = db.rows("servers")[0];
    expect(server.state).toBe("active");
    expect(server.node_id).toBe(nodeId);
    expect(server.singbox_version).toBe("1.14.4");
    expect(server.ready_at).toBeTruthy();
    expect(db.rows("orders")[0].state).toBe("ready");
    // 就绪结算第 0 天。
    expect(db.rows("accounts")[0].balance_cents).toBe(100 - 30);
  });

  it("非法 stage 返回 400，不改状态", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db);
    await seedEnrollment(db);
    const serverToken = await enrollAndGetToken(env as never);

    const res = await handleServers(
      reportRequest(serverToken, { stage: "rebooting" }),
      env as never,
    );
    expect(res?.status).toBe(400);
    expect(((await res!.json()) as { reason: string }).reason).toBe("invalid_stage");
    expect(db.rows("servers")[0].state).toBe("booting");
  });

  it("错误令牌 401；failed 上报销毁服务器并关单", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db);
    await seedEnrollment(db);
    const serverToken = await enrollAndGetToken(env as never);

    const unauthorized = await handleServers(
      reportRequest("agt_wrong", { stage: "installing" }),
      env as never,
    );
    expect(unauthorized?.status).toBe(401);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const failed = await handleServers(
      reportRequest(serverToken, { stage: "failed" }),
      env as never,
    );
    expect(failed?.status).toBe(409);
    const body = (await failed!.json()) as { reason: string; failed_stage: string };
    expect(body.reason).toBe("service_inactive");
    expect(body.failed_stage).toBe("booting");
    expect(db.rows("servers")[0].state).toBe("destroyed");
    expect(db.rows("orders")[0].state).toBe("failed");
  });
});

describe("GET /v1/agent/desired-state", () => {
  it("用 server_token 拉取端口、密码与 sing-box 版本", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db);
    await seedEnrollment(db);
    const serverToken = await enrollAndGetToken(env as never);

    const res = await handleServers(
      new Request("https://example.com/v1/agent/desired-state", {
        headers: { authorization: `Bearer ${serverToken}` },
      }),
      env as never,
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      server_id: string;
      desired: { port: number; password: string; control_port: number; singbox: unknown };
    };
    expect(body.server_id).toBe(SERVER);
    expect(body.desired.port).toBe(30412);
    expect(body.desired.password).toMatch(/^[0-9a-f]{32}$/);
    expect(body.desired.control_port).toBe(32100);
    expect(body.desired.singbox).toEqual({
      version: "1.14.4",
      sha256: "b".repeat(64),
      url: "https://control.example.com/sing-box.tar.gz",
    });

    const bad = await handleServers(
      new Request("https://example.com/v1/agent/desired-state", {
        headers: { authorization: "Bearer agt_wrong" },
      }),
      env as never,
    );
    expect(bad?.status).toBe(401);
  });
  it("构建信息不合规：503 agent_config_invalid，不下发脏值", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    const serverToken = await seedAgentToken(db);

    const res = await handleServers(
      new Request("https://example.com/v1/agent/desired-state", {
        headers: { authorization: `Bearer ${serverToken}` },
      }),
      { ...env, SING_BOX_VERSION: "1.14.4/../x" } as never,
    );
    expect(res?.status).toBe(503);
    expect(((await res!.json()) as { reason: string }).reason).toBe("agent_config_invalid");
  });
});

describe("POST /v1/agent/report · rotated", () => {
  it("轮换成功：改 node_port、重封凭据、记审计，不销毁", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    const serverToken = await seedAgentToken(db);

    const res = await handleServers(
      reportRequest(serverToken, {
        stage: "rotated",
        port: 30500,
        password: "p".repeat(32),
      }),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true, port: 30500 });

    const server = db.rows("servers")[0];
    expect(server.node_port).toBe(30500);
    expect(server.state).toBe("active");
    expect(server.destroyed_at).toBeNull();

    const sealed = db.rows("credentials")[0];
    const opened = await openSecret(ENC_KEY, {
      iv: sealed.iv as string,
      ciphertext: sealed.ciphertext as string,
    });
    expect(JSON.parse(opened!)).toEqual({
      host: "203.0.113.10",
      port: 30500,
      password: "p".repeat(32),
      method: "aes-256-gcm",
    });

    const audit = db.rows("audit_log").find((row) => row.action === "server.rotated");
    expect(audit).toBeTruthy();
    expect(String(audit?.detail)).toContain("30500");
    // 审计里不能出现密码。
    expect(String(audit?.detail)).not.toContain("p".repeat(32));
  });

  it("同一事务里凭据重封失败：node_port 不生效，返回非 2xx", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    const serverToken = await seedAgentToken(db);
    db.beforeCredentialInsert = () => {
      db.beforeCredentialInsert = undefined;
      throw new Error("disk full");
    };

    const res = await handleServers(
      reportRequest(serverToken, {
        stage: "rotated",
        port: 30500,
        password: "p".repeat(32),
      }),
      env as never,
    );
    expect(res?.status).toBe(500);
    expect(((await res!.json()) as { reason: string }).reason).toBe("rotation_failed");
    // 事务回滚：端口仍是旧值，审计也没有落。
    expect(db.rows("servers")[0].node_port).toBe(30412);
    expect(db.rows("audit_log").some((row) => row.action === "server.rotated")).toBe(false);
  });

  it("端口越界、密码过短、端口被同账户占用都 409，且不销毁", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    const serverToken = await seedAgentToken(db);

    const outOfBand = await handleServers(
      reportRequest(serverToken, { stage: "rotated", port: 29999, password: "p".repeat(32) }),
      env as never,
    );
    expect(outOfBand?.status).toBe(409);
    expect(((await outOfBand!.json()) as { reason: string }).reason).toBe("port_out_of_band");

    const shortPassword = await handleServers(
      reportRequest(serverToken, { stage: "rotated", port: 30500, password: "short" }),
      env as never,
    );
    expect(shortPassword?.status).toBe(409);
    expect(((await shortPassword!.json()) as { reason: string }).reason).toBe(
      "password_too_short",
    );

    // 同账户另一台活着的服务器占着 30501。
    db.rows("servers").push({
      ...db.rows("servers")[0],
      id: "srv_other00000000000000",
      node_port: 30501,
      server_token_hash: null,
    });
    const taken = await handleServers(
      reportRequest(serverToken, { stage: "rotated", port: 30501, password: "p".repeat(32) }),
      env as never,
    );
    expect(taken?.status).toBe(409);
    expect(((await taken!.json()) as { reason: string }).reason).toBe("port_taken");

    const server = db.rows("servers")[0];
    expect(server.node_port).toBe(30412);
    expect(server.state).toBe("active");
    expect(server.destroyed_at).toBeNull();
  });
});

describe("POST /v1/agent/report · failed 与 CA", () => {
  it.each(["active", "healthy"])(
    "%s 机器收到 failed：只记录不销毁，机器继续服务",
    async (state) => {
      const db = new FakeD1();
      const env = await envWith(db, await signingJwk());
      seedServer(db, state);
      const serverToken = await seedAgentToken(db);
      const longError = `sing-box 起不来：${"x".repeat(400)}`;

      const res = await handleServers(
        reportRequest(serverToken, { stage: "failed", error: longError }),
        env as never,
      );
      expect(res?.status).toBe(200);
      expect(await res!.json()).toEqual({ ok: true, recorded: true });

      const server = db.rows("servers")[0];
      expect(server.last_error).toHaveLength(300);
      expect(server.state).toBe(state);
      expect(server.destroyed_at).toBeNull();
      const audit = db.rows("audit_log").find((row) => row.action === "agent.report.failed");
      expect(String(audit?.detail)).toContain("sing-box 起不来");
    },
  );

  it("report 收 ca_pem 落库，agent-token 原样返回", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "verifying");
    const serverToken = await seedAgentToken(db);
    const caPem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

    const report = await handleServers(
      reportRequest(serverToken, {
        stage: "active",
        port: 30412,
        control_port: 32100,
        cert_fingerprint: "AA:BB",
        ca_pem: caPem,
      }),
      env as never,
    );
    expect(report?.status).toBe(200);
    expect(db.rows("servers")[0].ca_pem).toBe(caPem);

    const res = await handleServers(
      new Request(`https://example.com/v1/servers/${SERVER}/agent-token`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}` },
      }),
      env as never,
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { ca_pem: string | null; cert_fingerprint: string };
    expect(body.ca_pem).toBe(caPem);
    expect(body.cert_fingerprint).toBe("AA:BB");
  });
});

describe("POST /v1/agent/report · 边界", () => {
  it("已激活机器的旧端口报文只忽略，不销毁健康机器", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    const serverToken = await seedAgentToken(db);

    const res = await handleServers(
      reportRequest(serverToken, { stage: "active", port: 39999 }),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true, ignored: true });
    const server = db.rows("servers")[0];
    expect(server.state).toBe("active");
    expect(server.destroyed_at).toBeNull();
    expect(server.node_port).toBe(30412);
  });

  it("进度阶段端口不一致仍按 port_mismatch 销毁", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "installing");
    const serverToken = await seedAgentToken(db);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    const res = await handleServers(
      reportRequest(serverToken, { stage: "active", port: 39999 }),
      env as never,
    );
    expect(res?.status).toBe(409);
    expect(db.rows("servers")[0].state).toBe("destroyed");
  });

  it("成功上报清空上一次的失败原文", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "booting");
    db.rows("servers")[0].last_error = "上一次失败了";
    const serverToken = await seedAgentToken(db);

    const res = await handleServers(
      reportRequest(serverToken, { stage: "installing" }),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(db.rows("servers")[0].last_error).toBeNull();
  });

  it("agent 接口带 no-store", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db);
    await seedEnrollment(db);

    const res = await handleServers(enrollRequest(), env as never);
    expect(res?.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /v1/agent/fail", () => {
  it("消费一次性 token 后销毁并关单", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db);
    await seedEnrollment(db);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    const res = await handleServers(
      new Request("https://example.com/v1/agent/fail", {
        method: "POST",
        headers: { authorization: `Bearer ${ENROLL_TOKEN}` },
      }),
      env as never,
    );
    expect(res?.status).toBe(200);
    const server = db.rows("servers")[0];
    expect(server.state).toBe("destroyed");
    expect(server.destroyed_at).not.toBeNull();
    expect(server.enrollment_used_at).toBeTruthy();
    expect(db.rows("orders")[0].state).toBe("failed");
    expect(
      db.rows("audit_log").some((row) => row.action === "agent.install_failed"),
    ).toBe(true);

    // token 已消费 / 机器已销毁：重放一律 409。
    const replay = await handleServers(
      new Request("https://example.com/v1/agent/fail", {
        method: "POST",
        headers: { authorization: `Bearer ${ENROLL_TOKEN}` },
      }),
      env as never,
    );
    expect(replay?.status).toBe(409);
  });
});

describe("已销毁的服务器", () => {
  it("agent enroll 拒绝已销毁的行", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "destroyed");
    db.rows("servers")[0].destroyed_at = Date.now();
    await seedEnrollment(db);

    const res = await handleServers(enrollRequest(), env as never);
    expect(res?.status).toBe(409);
    expect(((await res!.json()) as { reason: string }).reason).toBe("destroyed");
    expect(db.rows("credentials")).toHaveLength(0);
  });

  it("rotated 撞上并发销毁：409 且不复活凭据", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    const serverToken = await seedAgentToken(db);
    // 请求处理前机器已经被并发销毁。
    db.rows("servers")[0].destroyed_at = Date.now();
    db.rows("servers")[0].state = "destroyed";

    const res = await handleServers(
      reportRequest(serverToken, {
        stage: "rotated",
        port: 30500,
        password: "p".repeat(32),
      }),
      env as never,
    );
    expect(res?.status).toBe(409);
    expect(((await res!.json()) as { reason: string }).reason).toBe("server_destroyed");
    expect(db.rows("credentials")).toHaveLength(0);
    expect(db.rows("servers")[0].node_port).toBe(30412);
  });
});

describe("active 幂等", () => {
  it("已 active 的机器再报 active：200 already_active，不销毁", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    const serverToken = await seedAgentToken(db);

    const res = await handleServers(
      reportRequest(serverToken, { stage: "active", port: 30412 }),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true, already_active: true });
    const server = db.rows("servers")[0];
    expect(server.state).toBe("active");
    expect(server.destroyed_at).toBeNull();
  });

  it("并发两次 active：只激活一次，另一次也 200", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "installing");
    const serverToken = await seedAgentToken(db);

    const [first, second] = await Promise.all([
      handleServers(
        reportRequest(serverToken, { stage: "active", port: 30412 }),
        env as never,
      ),
      handleServers(
        reportRequest(serverToken, { stage: "active", port: 30412 }),
        env as never,
      ),
    ]);

    expect([first?.status, second?.status]).toEqual([200, 200]);
    expect(db.rows("servers")[0].state).toBe("active");
    expect(db.rows("servers")[0].destroyed_at).toBeNull();
    expect(db.rows("orders")[0].state).toBe("ready");
    const charges = db.rows("wallet_ledger").filter(
      (row) => row.ref_type === "order" && row.kind === "charge",
    );
    expect(charges).toHaveLength(1);
  });

  it("行已 destroyed 时 active 仍按原语义处理，不复活", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "destroyed");
    db.rows("servers")[0].destroyed_at = Date.now();
    // 存量 upfront 单：走激活守卫路径（at_ready 的结算守卫在替身里没有完整建模）。
    db.rows("orders")[0].charge_mode = "upfront";
    const serverToken = await seedAgentToken(db);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    const res = await handleServers(
      reportRequest(serverToken, { stage: "active", port: 30412 }),
      env as never,
    );
    expect(res?.status).toBe(410);
    const server = db.rows("servers")[0];
    expect(server.state).toBe("destroyed");
    expect(server.destroyed_at).not.toBeNull();
    expect(
      db.rows("audit_log").some((row) => row.action === "enroll.activation_lost"),
    ).toBe(true);
  });
});

describe("POST /v1/servers/{id}/agent-token", () => {
  async function activatedEnv() {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    Object.assign(db.rows("servers")[0], {
      control_port: 32100,
      cert_fingerprint: "AA:BB:CC:DD",
    });
    return { db, env };
  }

  function tokenRequest(token: string) {
    return new Request(`https://example.com/v1/servers/${SERVER}/agent-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("返回端点、指纹与可用内置公钥验签的 60 秒令牌", async () => {
    const { db, env } = await activatedEnv();

    const res = await handleServers(tokenRequest(env.token), env as never);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      endpoint: string;
      cert_fingerprint: string;
      token: string;
      key_id: string;
    };
    expect(body.endpoint).toBe("https://203.0.113.10:32100/mcp");
    expect(body.cert_fingerprint).toBe("AA:BB:CC:DD");
    expect(body.key_id).toBe("agent-test");

    const parts = body.token.split(".");
    expect(parts).toHaveLength(3);
    const [header, payload, signature] = parts;
    const publicJwk = JSON.parse(env.AGENT_TOKEN_SIGNING_JWK) as JsonWebKey;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromB64u(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);

    const claims = JSON.parse(new TextDecoder().decode(fromB64u(payload))) as {
      server_id: string;
      jti: string;
      exp: number;
    };
    expect(claims.server_id).toBe(SERVER);
    expect(claims.jti.startsWith("jti_")).toBe(true);
    // 60 秒有效期（允许几秒误差）。
    const ttl = claims.exp - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(50);
    expect(ttl).toBeLessThanOrEqual(60);
    expect(db.rows("audit_log").some((row) => row.action === "agent.token_issued")).toBe(true);
  });

  it("agent 还没登记指纹时拒绝签发", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");

    const res = await handleServers(tokenRequest(env.token), env as never);
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { details?: { reason?: string } };
    expect(body.details?.reason).toBe("agent_not_registered");
  });
});
