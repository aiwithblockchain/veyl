import { afterEach, describe, expect, it, vi } from "vitest";

import { signAccessToken, sha256B64u } from "../src/lib/crypto";
import { firewallName } from "../src/providers/digitalocean";
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

describe("DO 资源命名", () => {
  it("防火墙名把 base64url 里的下划线换成连字符", () => {
    expect(firewallName("veyl-a5_MhEgJWJ3")).toBe("veyl-a5-MhEgJWJ3");
    expect(firewallName("veyl-.-x-")).toBe("veyl-.-x");
    expect(firewallName("___")).toBe("veyl-firewall");
  });
});

describe("建机失败退款", () => {  it("enroll 超时自动销毁时，扣过的月费退回余额", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    const token = "enr_abandoned000000";
    seedServer(db, "booting");
    Object.assign(db.rows("servers")[0], {
      enrollment_hash: await sha256B64u(token),
      enrollment_expires_at: Date.now() - 1000,
    });
    db.rows("orders").push({
      id: "ord_test",
      account_id: ACCOUNT,
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      amount_usd: 6,
      amount_cents: 600,
      hourly_usd: 0.00893,
      state: "provisioning",
      idempotency_key: "idem-refund-1",
      created_at: Date.now(),
      paid_via: "wallet",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    const res = await handleServers(
      new Request(`https://example.com/v1/enroll/${token}`, {
        method: "POST",
        body: JSON.stringify({ port: 20443, password: "x", active: true, version: "1" }),
      }),
      env as never,
    );

    expect(res?.status).toBe(410);
    expect(db.rows("servers")[0].state).toBe("destroyed");
    expect(db.rows("orders")[0].state).toBe("failed");
    const refund = db.rows("wallet_ledger")[0];
    expect(refund?.amount_cents).toBe(600);
    expect(refund?.ref_id).toBe("srv_test0000000000000000");
    expect(db.rows("accounts")[0].balance_cents).toBe(600);
  });
});

describe("enroll 激活守卫", () => {
  const TOKEN = "enr_activation000000";
  const ENC_KEY = "A".repeat(43);

  async function seedBootingForActivation(db: FakeD1) {
    seedServer(db, "booting");
    Object.assign(db.rows("servers")[0], {
      // 跳过防火墙与 DO 查询：这里只验证激活这一步。
      provider_id: null,
      enrollment_hash: await sha256B64u(TOKEN),
      enrollment_expires_at: Date.now() + 60_000,
    });
    db.rows("orders").push({
      id: "ord_test",
      account_id: ACCOUNT,
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      amount_usd: 6,
      amount_cents: 600,
      hourly_usd: 0.00893,
      state: "provisioning",
      idempotency_key: "idem-activation-1",
      created_at: Date.now(),
      paid_via: "wallet",
    });
  }

  function enrollRequest() {
    return new Request(`https://example.com/v1/enroll/${TOKEN}`, {
      method: "POST",
      body: JSON.stringify({
        port: 20443,
        password: "secret-password",
        active: true,
        version: "1.14.0",
      }),
    });
  }

  it("激活成功：机器 active、订单 ready、审计 enroll.ok", async () => {
    const db = new FakeD1();
    const env = { ...(await envWith(db, await signingJwk())), CREDENTIAL_ENC_KEY: ENC_KEY };
    await seedBootingForActivation(db);

    const res = await handleServers(enrollRequest(), env as never);

    expect(res?.status).toBe(200);
    const server = db.rows("servers")[0];
    expect(server.state).toBe("active");
    expect(server.node_id).toBeTruthy();
    // 激活成功那一刻写入 ready_at，同一批落库。
    expect(typeof server.ready_at).toBe("number");
    expect(Math.abs(Number(server.ready_at) - Date.now())).toBeLessThan(5_000);
    expect(db.rows("orders")[0].state).toBe("ready");
    expect(db.rows("audit_log").some((row) => row.action === "enroll.ok")).toBe(true);

    // 详情响应带 ISO 的 ready_at。
    const detail = await handleServers(
      new Request(`https://example.com/v1/servers/${SERVER}`, {
        headers: { authorization: `Bearer ${env.token}` },
      }),
      env as never,
    );
    expect(detail?.status).toBe(200);
    const body = (await detail!.json()) as { ready_at: string | null };
    expect(body.ready_at).toBe(new Date(Number(server.ready_at)).toISOString());
  });

  it("未就绪 / 旧机器：ready_at 为 null，不拿 created_at 顶替", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");

    const detail = await handleServers(
      new Request(`https://example.com/v1/servers/${SERVER}`, {
        headers: { authorization: `Bearer ${env.token}` },
      }),
      env as never,
    );

    expect(detail?.status).toBe(200);
    const body = (await detail!.json()) as { ready_at: string | null };
    expect(body.ready_at).toBeNull();
  });

  it("激活丢失要收尾：凭据标记销毁、防火墙删除、不会多退款", async () => {
    const db = new FakeD1();
    const env = { ...(await envWith(db, await signingJwk())), CREDENTIAL_ENC_KEY: ENC_KEY };
    await seedBootingForActivation(db);
    // 这次是真的有 droplet 与防火墙的路径。
    Object.assign(db.rows("servers")[0], {
      provider_id: PROVIDER_ID,
      firewall_id: null,
    });
    // 并发销毁已经退过一次款：本次收尾不能再退。
    db.rows("accounts")[0].balance_cents = 600;
    db.rows("wallet_ledger").push({
      id: "led_prior_refund",
      account_id: ACCOUNT,
      kind: "adjustment",
      amount_cents: 600,
      balance_after_cents: 600,
      ref_type: "server_refund",
      ref_id: SERVER,
      note: "并发销毁已退",
      created_at: Date.now() - 1000,
    });

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const href = String(input);
        if (href.includes("/firewalls") && init?.method === "POST") {
          return new Response(JSON.stringify({ firewall: { id: "fw_1" } }), { status: 201 });
        }
        if (init?.method === "DELETE") {
          calls.push(href);
          // droplet 已被并发销毁删掉；防火墙正常删除。
          return new Response(null, { status: href.includes("/firewalls/fw_1") ? 204 : 404 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    db.beforeServerActivate = () => {
      db.beforeServerActivate = undefined;
      const server = db.rows("servers")[0];
      server.state = "destroyed";
      server.destroyed_at = Date.now();
      db.rows("orders")[0].state = "failed";
    };

    const res = await handleServers(enrollRequest(), env as never);

    expect(res?.status).toBe(410);
    // 本次插入的凭据要跟着销毁，不能留着一条指向已删机器的密文。
    expect(db.rows("credentials")).toHaveLength(1);
    expect(db.rows("credentials")[0].destroyed_at).not.toBeNull();
    // 机器仍是 destroyed，退款只有并发那次的一条。
    expect(db.rows("servers")[0].state).toBe("destroyed");
    expect(
      db.rows("wallet_ledger").filter(
        (row) => row.ref_type === "server_refund" && row.ref_id === SERVER,
      ),
    ).toHaveLength(1);
    expect(db.rows("accounts")[0].balance_cents).toBe(600);
    // 刚建的防火墙被删掉，不留孤儿。
    expect(calls.some((href) => href.includes("/firewalls/fw_1"))).toBe(true);
    const lost = db.rows("audit_log").find((row) => row.action === "enroll.activation_lost");
    expect(lost).toBeTruthy();
    expect(String(lost?.detail)).toContain('"cleaned":true');
  });

  it("激活成功但订单没能置 ready：记 order_ready_lost，不静默半成功", async () => {
    const db = new FakeD1();
    const env = { ...(await envWith(db, await signingJwk())), CREDENTIAL_ENC_KEY: ENC_KEY };
    await seedBootingForActivation(db);
    // 订单不在 provisioning（例如并发路径已改过状态）：ready 那条会 0 行。
    db.rows("orders")[0].state = "paid";

    const res = await handleServers(enrollRequest(), env as never);

    expect(res?.status).toBe(200);
    expect(db.rows("servers")[0].state).toBe("active");
    const lost = db.rows("audit_log").find((row) => row.action === "enroll.order_ready_lost");
    expect(lost).toBeTruthy();
    expect(String(lost?.detail)).toContain("ord_test");
    expect(db.rows("orders")[0].state).toBe("paid");
  });

  it("消费 token 后机器被并发销毁：激活不生效，订单不 ready，记 activation_lost", async () => {
    const db = new FakeD1();
    const env = { ...(await envWith(db, await signingJwk())), CREDENTIAL_ENC_KEY: ENC_KEY };
    await seedBootingForActivation(db);

    // 模拟 sweep / refreshBooting 在「消费 token 之后、写 active 之前」完成销毁（含退款与关单）。
    db.beforeServerActivate = () => {
      db.beforeServerActivate = undefined;
      const server = db.rows("servers")[0];
      server.state = "destroyed";
      server.destroyed_at = Date.now();
      db.rows("orders")[0].state = "failed";
    };

    const res = await handleServers(enrollRequest(), env as never);

    expect(res?.status).toBe(410);
    expect(((await res!.json()) as { reason: string }).reason).toBe("server_destroyed");
    const server = db.rows("servers")[0];
    // 已销毁的机器不能被改回 active，也不该拿到 node_id。
    expect(server.state).toBe("destroyed");
    expect(server.destroyed_at).not.toBeNull();
    expect(server.node_id ?? null).toBeNull();
    expect(server.ready_at ?? null).toBeNull();
    expect(db.rows("orders")[0].state).toBe("failed");
    const lost = db.rows("audit_log").find((row) => row.action === "enroll.activation_lost");
    expect(lost).toBeTruthy();
    expect(db.rows("audit_log").some((row) => row.action === "enroll.ok")).toBe(false);
  });

  function stageRequest(body: Record<string, unknown>) {
    return new Request(`https://example.com/v1/enroll/${TOKEN}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("三段上报推进：installing → verifying → active，token 只在最终消费", async () => {
    const db = new FakeD1();
    const env = { ...(await envWith(db, await signingJwk())), CREDENTIAL_ENC_KEY: ENC_KEY };
    await seedBootingForActivation(db);

    const installing = await handleServers(stageRequest({ stage: "installing" }), env as never);
    expect(installing?.status).toBe(200);
    expect(db.rows("servers")[0].state).toBe("installing");
    expect(db.rows("servers")[0].installing_at).toBeTruthy();
    expect(db.rows("servers")[0].enrollment_used_at).toBeNull();

    const verifying = await handleServers(stageRequest({ stage: "verifying" }), env as never);
    expect(verifying?.status).toBe(200);
    expect(db.rows("servers")[0].state).toBe("verifying");
    expect(db.rows("servers")[0].verifying_at).toBeTruthy();
    expect(db.rows("servers")[0].enrollment_used_at).toBeNull();

    const active = await handleServers(
      stageRequest({
        stage: "active",
        port: 20443,
        password: "secret-password",
        active: true,
        version: "1.14.0",
      }),
      env as never,
    );
    expect(active?.status).toBe(200);
    const server = db.rows("servers")[0];
    expect(server.state).toBe("active");
    expect(server.enrollment_used_at).toBeTruthy();
    expect(server.ready_at).toBeTruthy();
    // 消费后 hash 仍在：晚到的进度能按 hash 找到行并忽略，而不是 404。
    expect(server.enrollment_hash).toBeTruthy();

    const late = await handleServers(stageRequest({ stage: "verifying" }), env as never);
    expect(late?.status).toBe(200);
    expect(((await late!.json()) as { ignored: boolean }).ignored).toBe(true);
    expect(db.rows("servers")[0].state).toBe("active");
  });

  it("乱序与回退被拒：只许前进，拒绝时回 200 ignored", async () => {
    const db = new FakeD1();
    const env = { ...(await envWith(db, await signingJwk())), CREDENTIAL_ENC_KEY: ENC_KEY };
    await seedBootingForActivation(db);

    // 跳过 installing 直接 verifying：忽略。
    const skipped = await handleServers(stageRequest({ stage: "verifying" }), env as never);
    expect(skipped?.status).toBe(200);
    expect(((await skipped!.json()) as { ignored: boolean }).ignored).toBe(true);
    expect(db.rows("servers")[0].state).toBe("booting");

    await handleServers(stageRequest({ stage: "installing" }), env as never);
    await handleServers(stageRequest({ stage: "verifying" }), env as never);
    expect(db.rows("servers")[0].state).toBe("verifying");

    // 回退到 installing：忽略，状态不变。
    const back = await handleServers(stageRequest({ stage: "installing" }), env as never);
    expect(back?.status).toBe(200);
    expect(((await back!.json()) as { ignored: boolean }).ignored).toBe(true);
    expect(db.rows("servers")[0].state).toBe("verifying");
  });

  it("失败阶段落库：failed_stage=verifying → 销毁、verify_failed、退款", async () => {
    const db = new FakeD1();
    const env = { ...(await envWith(db, await signingJwk())), CREDENTIAL_ENC_KEY: ENC_KEY };
    await seedBootingForActivation(db);
    await handleServers(stageRequest({ stage: "installing" }), env as never);
    await handleServers(stageRequest({ stage: "verifying" }), env as never);

    const res = await handleServers(
      stageRequest({
        stage: "failed",
        failed_stage: "verifying",
        error: "sing-box check failed",
      }),
      env as never,
    );

    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { reason: string; failed_stage: string };
    expect(body.reason).toBe("verify_failed");
    expect(body.failed_stage).toBe("verifying");
    const server = db.rows("servers")[0];
    expect(server.state).toBe("destroyed");
    expect(server.failure_code).toBe("verify_failed");
    expect(server.failure_stage).toBe("verifying");
    expect(db.rows("orders")[0].state).toBe("failed");
    expect(
      db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund"),
    ).toHaveLength(1);
    const audit = db.rows("audit_log").find((row) => row.action === "enroll.rejected");
    expect(String(audit?.detail)).toContain('"failed_stage":"verifying"');
  });
});

describe("服务器重命名", () => {
  function patchRequest(token: string, name: unknown, id = SERVER) {
    return new Request(`https://example.com/v1/servers/${id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
    });
  }

  it("改自己的服务器：成功并返回完整详情", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");

    const res = await handleServers(patchRequest(env.token, "  我的东京机  "), env as never);

    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { server_id: string; name: string };
    expect(body.server_id).toBe(SERVER);
    // 服务端 trim 后落库。
    expect(body.name).toBe("我的东京机");
    expect(db.rows("servers")[0].name).toBe("我的东京机");
  });

  it("改别人的服务器：一律 404，不泄露是否存在", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    db.rows("servers")[0].account_id = "acct_someone_else";

    const res = await handleServers(patchRequest(env.token, "抢过来"), env as never);

    expect(res?.status).toBe(404);
    expect(db.rows("servers")[0].name).toBe("我的服务器0001");
  });

  it("空名 / 纯空格 / 25 个字符被拒，details 带长度约束", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");

    for (const bad of ["", "   ", "a".repeat(25)]) {
      const res = await handleServers(patchRequest(env.token, bad), env as never);
      expect(res?.status).toBe(400);
      const body = (await res!.json()) as {
        code: string;
        details: { reason: string; min_length: number; max_length: number };
      };
      expect(body.code).toBe("INVALID_ARGUMENT");
      expect(body.details).toEqual({
        reason: "invalid_name",
        min_length: 1,
        max_length: 24,
      });
    }
    expect(db.rows("servers")[0].name).toBe("我的服务器0001");
  });

  it("按 Unicode 码点计长：中文与 emoji 各算 1，24 个通过、25 个被拒", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");

    const ok = await handleServers(
      patchRequest(env.token, "机".repeat(12) + "😀".repeat(12)),
      env as never,
    );
    expect(ok?.status).toBe(200);
    expect(db.rows("servers")[0].name).toBe("机".repeat(12) + "😀".repeat(12));

    const tooLong = await handleServers(
      patchRequest(env.token, "机".repeat(12) + "😀".repeat(13)),
      env as never,
    );
    expect(tooLong?.status).toBe(400);
    expect(
      ((await tooLong!.json()) as { details: { reason: string } }).details.reason,
    ).toBe("invalid_name");
  });

  it("重复改成同一个名字幂等", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");

    const first = await handleServers(patchRequest(env.token, "名字"), env as never);
    const second = await handleServers(patchRequest(env.token, "名字"), env as never);

    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(db.rows("servers")[0].name).toBe("名字");
    expect(db.rows("servers")).toHaveLength(1);
  });
});

describe("阶段超时清理（列表/详情入口）", () => {
  it("卡在 verifying 过期：详情入口销毁并记 verify_timeout", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "verifying");
    Object.assign(db.rows("servers")[0], {
      enrollment_expires_at: Date.now() - 1000,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    const res = await handleServers(
      new Request(`https://example.com/v1/servers/${SERVER}`, {
        headers: { authorization: `Bearer ${env.token}` },
      }),
      env as never,
    );

    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      state: string;
      failure: { stage: string; code: string } | null;
    };
    expect(body.state).toBe("destroyed");
    expect(body.failure?.stage).toBe("verifying");
    expect(body.failure?.code).toBe("verify_timeout");
  });
});

describe("用户销毁退款", () => {
  it("退还未开始的整天，与标记销毁同一批写入", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    const DAY = 24 * 3600 * 1000;
    const anchor = Date.now() - 5 * DAY;
    Object.assign(db.rows("servers")[0], {
      daily_price_cents: 20,
      billing_anchor_at: anchor,
      paid_until: anchor + 8 * DAY,
    });
    db.rows("accounts")[0].balance_cents = 100;
    db.rows("orders").push({
      id: "ord_test",
      account_id: ACCOUNT,
      amount_cents: 20,
      paid_via: "wallet",
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      amount_usd: 0.2,
      hourly_usd: 0,
      state: "ready",
      idempotency_key: "idem-refund-user",
      created_at: Date.now(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    const res = await handleServers(destroyRequest(env.token), env as never);

    expect(res?.status).toBe(204);
    // 已付 8 天、现在是第 5 天：当天不退，退第 6、7 两天 = 40 分。
    const refund = db.rows("wallet_ledger").find((row) => row.ref_type === "server_refund");
    expect(refund?.amount_cents).toBe(40);
    expect(refund?.ref_id).toBe(SERVER);
    expect(db.rows("accounts")[0].balance_cents).toBe(140);
    expect(db.rows("servers")[0].state).toBe("destroyed");
  });

  it("退款按最新 paid_until 计算：加载后又被扣一天", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedServer(db, "active");
    const DAY = 24 * 3600 * 1000;
    const anchor = Date.now() - 5 * DAY;
    Object.assign(db.rows("servers")[0], {
      daily_price_cents: 20,
      billing_anchor_at: anchor,
      paid_until: anchor + 8 * DAY,
    });
    db.rows("accounts")[0].balance_cents = 100;
    db.rows("orders").push({
      id: "ord_test",
      account_id: ACCOUNT,
      amount_cents: 20,
      paid_via: "wallet",
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      amount_usd: 0.2,
      hourly_usd: 0,
      state: "ready",
      idempotency_key: "idem-refund-reread",
      created_at: Date.now(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // 处理开头加载的是 8 天；DO 删除这几秒里 Cron 又扣了一天。
        // 必须整行替换：FakeD1 的 first() 返回同一行对象，原地改会连
        // destroyInstance 手里的 row 一起改掉，用例就变成假绿。
        db.rows("servers")[0] = {
          ...db.rows("servers")[0],
          paid_until: anchor + 9 * DAY,
        };
        return new Response(null, { status: 204 });
      }),
    );

    const res = await handleServers(destroyRequest(env.token), env as never);

    expect(res?.status).toBe(204);
    const refund = db.rows("wallet_ledger").find((row) => row.ref_type === "server_refund");
    expect(refund?.amount_cents).toBe(60);
  });
});

describe("销毁服务器", () => {  it("DO 删除成功后回落本地状态", async () => {
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

describe("钱的去向（charged_cents / refunded_cents）", () => {
  function detailRequest(token: string) {
    return new Request(`https://example.com/v1/servers/${SERVER}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  function seedFailedServer(db: FakeD1) {
    seedServer(db, "error");
    Object.assign(db.rows("servers")[0], {
      failure_code: "upstream_422",
      daily_price_cents: 30,
      billing_anchor_at: Date.now(),
      paid_until: Date.now() + 24 * 3600 * 1000,
      billing_state: "active",
      transfer_gib: 1000,
    });
    db.rows("orders").push({ id: "ord_test", account_id: ACCOUNT, state: "failed" });
  }

  it("扣了又退：两个字段都如实上报", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedFailedServer(db);
    db.rows("wallet_ledger").push(
      { ref_type: "order", ref_id: "ord_test", kind: "charge", amount_cents: -30 },
      { ref_type: "server_refund", ref_id: SERVER, kind: "adjustment", amount_cents: 30 },
      // 同一订单上的人工调整不算「扣过的钱」。
      { ref_type: "order", ref_id: "ord_test", kind: "adjustment", amount_cents: -5 },
    );

    const res = await handleServers(detailRequest(env.token), env as never);
    const body = (await res!.json()) as { charged_cents: number; refunded_cents: number };
    expect(body.charged_cents).toBe(30);
    expect(body.refunded_cents).toBe(30);
  });

  it("没扣过费：两个都是 0", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedFailedServer(db);

    const res = await handleServers(detailRequest(env.token), env as never);
    const body = (await res!.json()) as { charged_cents: number; refunded_cents: number };
    expect(body.charged_cents).toBe(0);
    expect(body.refunded_cents).toBe(0);
  });

  it("扣了没退（修复前的失败记录）：refunded 必须是 0，列表也一样", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    seedFailedServer(db);
    db.rows("wallet_ledger").push({ ref_type: "order", ref_id: "ord_test", kind: "charge", amount_cents: -30 });

    const res = await handleServers(detailRequest(env.token), env as never);
    const body = (await res!.json()) as { charged_cents: number; refunded_cents: number };
    expect(body.charged_cents).toBe(30);
    expect(body.refunded_cents).toBe(0);

    const list = await handleServers(
      new Request("https://example.com/v1/servers", {
        headers: { authorization: `Bearer ${env.token}` },
      }),
      env as never,
    );
    const { servers } = (await list!.json()) as {
      servers: Array<{ charged_cents: number; refunded_cents: number; failure: unknown }>;
    };
    expect(servers[0].failure).not.toBeNull();
    expect(servers[0].charged_cents).toBe(30);
    expect(servers[0].refunded_cents).toBe(0);
  });
});
