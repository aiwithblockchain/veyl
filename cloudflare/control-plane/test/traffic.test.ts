import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256B64u } from "../src/lib/crypto";
import { handleTraffic } from "../src/traffic";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_traffic00000000000";
const SERVER = "srv_traffic0000000000";
const SECOND = "srv_traffic_second0000";
const TOKEN = "agt_traffic_known";
const SECOND_TOKEN = "agt_traffic_second";
const GIB = 1024 ** 3;

interface ServerOptions {
  balance?: number;
  transferGib?: number;
  readyAt?: number;
  state?: string;
  destroyedAt?: number | null;
  providerGoneAt?: number | null;
  paidUntil?: number;
}

function serverRecord(id: string, options: ServerOptions, tokenHash: string | null) {
  const now = Date.now();
  return {
    id,
    account_id: ACCOUNT,
    order_id: `ord_${id}`,
    provider: "digitalocean",
    provider_id: "4242",
    name: "流量",
    region: "sgp1",
    plan: "s-1vcpu-512mb-10gb",
    hourly_usd: 0.007,
    monthly_usd: 5,
    state: options.state ?? "active",
    node_port: 30412,
    ip: "203.0.113.9",
    node_id: `nd_${id}`,
    enrollment_hash: null,
    enrollment_expires_at: null,
    enrollment_used_at: null,
    firewall_id: null,
    server_token_hash: tokenHash,
    control_port: 32100,
    cert_fingerprint: null,
    ca_pem: null,
    last_seen_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
    destroyed_at: options.destroyedAt ?? null,
    provider_gone_at: options.providerGoneAt ?? null,
    ready_at: options.readyAt ?? now,
    billing_anchor_at: now,
    transfer_gib: options.transferGib ?? 500,
    daily_price_cents: 0,
    billing_state: "active",
    paid_until: options.paidUntil ?? now + 24 * 3600 * 1000,
  };
}

async function seedServer(
  db: FakeD1,
  options: ServerOptions = {},
): Promise<void> {
  db.rows("accounts").push({
    id: ACCOUNT,
    kind: "email",
    status: "active",
    balance_cents: options.balance ?? 10_000,
  });
  db.rows("servers").push(serverRecord(SERVER, options, await sha256B64u(TOKEN)));
}

async function addServer(
  db: FakeD1,
  id: string,
  options: ServerOptions = {},
  token?: string,
): Promise<void> {
  db.rows("servers").push(
    serverRecord(id, options, token ? await sha256B64u(token) : null),
  );
}

function envWith(db: FakeD1) {
  return { DB: db as unknown as D1Database, DO_API_TOKEN: "do-token" };
}

function trafficRequest(token: string, body: unknown): Request {
  return new Request("https://example.com/v1/agent/traffic", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("POST /v1/agent/traffic", () => {
  it("重复 seq 只记一次账", async () => {
    const db = new FakeD1();
    await seedServer(db);
    const env = envWith(db);

    const first = await handleTraffic(trafficRequest(TOKEN, { seq: 1, delta_bytes: GIB }), env);
    const again = await handleTraffic(trafficRequest(TOKEN, { seq: 1, delta_bytes: GIB }), env);

    expect(first?.status).toBe(200);
    expect(again?.status).toBe(200);
    expect(db.rows("server_traffic")).toHaveLength(1);
    expect(db.rows("server_traffic")[0].bytes).toBe(GIB);
    // 未超出已释放额度，余额不动。
    expect(db.rows("accounts")[0].balance_cents).toBe(10_000);
  });

  it("失联标记被 agent 上报清空：恢复计费与额度增长，并留一条审计", async () => {
    const db = new FakeD1();
    // DO 404 可能只是一次抖动：标记从来不是终态，机器真的还在就会自己上报。
    await seedServer(db, { providerGoneAt: Date.now() - 3600 * 1000 });
    const env = envWith(db);

    const response = await handleTraffic(trafficRequest(TOKEN, { seq: 1, delta_bytes: 0 }), env);

    expect(response?.status).toBe(200);
    expect(db.rows("servers")[0].provider_gone_at ?? null).toBeNull();
    expect(
      db.rows("audit_log").filter((row) => row.action === "billing.gone_recovered"),
    ).toHaveLength(1);
  });

  it("跨周期：按收到请求的 UTC 年月归到新行，用量与已扣金额从 0 起", async () => {
    const db = new FakeD1();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    const readyAt = Date.parse("2026-11-15T00:00:00Z");
    // 一直续费到 12 月 3 日：额度被已付天数封顶，这个用例要的是「12 月 2 日拿到第 2 份」。
    await seedServer(db, { readyAt, paidUntil: Date.parse("2026-12-03T00:00:00Z") });
    const env = envWith(db);

    await handleTraffic(
      trafficRequest(TOKEN, { seq: 1, delta_bytes: GIB }),
      env,
    );
    vi.setSystemTime(new Date("2026-12-02T12:00:00Z"));
    await handleTraffic(
      trafficRequest(TOKEN, { seq: 2, delta_bytes: 2 * GIB }),
      env,
    );

    const rows = db.rows("server_traffic");
    expect(rows).toHaveLength(2);
    const november = rows.find((row) => row.cycle_id === "2026-11");
    const december = rows.find((row) => row.cycle_id === "2026-12");
    expect(november?.bytes).toBe(GIB);
    expect(december?.bytes).toBe(2 * GIB);
    expect(december?.charged_cents).toBe(0);
    // 不再落额度快照：额度一律由 `releasedBytes` 现算，这一列只保留 schema 默认值。
    expect(december?.released_bytes).toBe(0);
  });

  it("超支按账号口径扣费：floor(超出 GiB × 2 分)", async () => {
    const db = new FakeD1();
    await seedServer(db, { balance: 10_000, transferGib: 500 });
    const env = envWith(db);

    const res = await handleTraffic(
      trafficRequest(TOKEN, { seq: 1, delta_bytes: 100 * GIB }),
      env,
    );
    expect(res?.status).toBe(200);

    // 新机只释放 1 天额度（500/28 GiB），其余 82.14 GiB 按 2 分/GiB 扣 164 分。
    const released = Math.floor((500 * GIB) / 28);
    const due = Math.floor(((100 * GIB - released) / GIB) * 2);
    expect(due).toBe(164);
    expect(db.rows("accounts")[0].balance_cents).toBe(10_000 - due);
    expect(db.rows("server_traffic")[0].bytes).toBe(100 * GIB);
    expect(db.rows("server_traffic")[0].charged_cents).toBe(due);
    expect(db.rows("servers")[0].state).toBe("active");
  });

  it("账号里有一台零额度的存量机器在上报：不能因此跳过整个账号的超支结算", async () => {
    const db = new FakeD1();
    // A 是 transfer_gib = 0 的老行，且这一笔是它上报的；B 有正常额度、本周期没上报。
    await seedServer(db, { balance: 10_000, transferGib: 0 });
    await addServer(db, SECOND, { transferGib: 500 }, SECOND_TOKEN);
    const env = envWith(db);

    const res = await handleTraffic(
      trafficRequest(TOKEN, { seq: 1, delta_bytes: 100 * GIB }),
      env,
    );
    expect(res?.status).toBe(200);

    // 判定口径是账号池：A 不算额度、B 释放 1 天份额（500/28 GiB），超支照扣。
    const released = Math.floor((500 * GIB) / 28);
    const due = Math.floor(((100 * GIB - released) / GIB) * 2);
    expect(due).toBe(164);
    expect(db.rows("accounts")[0].balance_cents).toBe(10_000 - due);
    expect(db.rows("server_traffic")[0].charged_cents).toBe(due);
  });

  it("账号所有机器额度都是 0：整段不结算，不能把全部用量当超支扣钱", async () => {
    const db = new FakeD1();
    await seedServer(db, { balance: 10_000, transferGib: 0 });
    await addServer(db, SECOND, { transferGib: 0 }, SECOND_TOKEN);
    const env = envWith(db);

    const res = await handleTraffic(
      trafficRequest(TOKEN, { seq: 1, delta_bytes: 100 * GIB }),
      env,
    );
    expect(res?.status).toBe(200);

    // 额度未知就没有「超出多少」可算：只累计用量，不扣费、不停机。
    expect(db.rows("accounts")[0].balance_cents).toBe(10_000);
    expect(db.rows("server_traffic")[0].bytes).toBe(100 * GIB);
    expect(db.rows("server_traffic")[0].charged_cents).toBe(0);
    expect(db.rows("servers")[0].state).toBe("active");
  });

  it("余额不足：扣到 0 后按 traffic_overage 停机销毁", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const db = new FakeD1();
    await seedServer(db, { balance: 50, transferGib: 500 });
    const env = envWith(db);

    const res = await handleTraffic(
      trafficRequest(TOKEN, { seq: 1, delta_bytes: 100 * GIB }),
      env,
    );
    expect(res?.status).toBe(200);

    expect(db.rows("accounts")[0].balance_cents).toBe(0);
    expect(db.rows("server_traffic")[0].charged_cents).toBe(50);
    const server = db.rows("servers")[0];
    expect(server.state).toBe("destroyed");
    expect(server.destroyed_at).not.toBeNull();
    expect(server.failure_code).toBe("traffic_overage");
  });

  it("零额度的存量机器上报时不是停机对象：真正有额度的机器才停", async () => {
    const doFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", doFetch);
    const db = new FakeD1();
    // A 是零额度存量行，余额为 0；B 有额度，超支是账号池口径算出来的。
    await seedServer(db, { balance: 0, transferGib: 0 });
    await addServer(db, SECOND, { transferGib: 500 }, SECOND_TOKEN);
    const env = envWith(db);

    const first = await handleTraffic(
      trafficRequest(TOKEN, { seq: 1, delta_bytes: 100 * GIB }),
      env,
    );
    expect(first?.status).toBe(200);
    // 销毁 A 既减不了超支，也会把它的未用整天退回去：A 不动，也不打 DO。
    expect(db.rows("servers")[0].state).toBe("active");
    expect(db.rows("servers")[0].failure_code ?? null).toBeNull();
    expect(doFetch).not.toHaveBeenCalled();

    // 有额度的 B 一上报就轮到自己停机。
    const second = await handleTraffic(
      trafficRequest(SECOND_TOKEN, { seq: 1, delta_bytes: 0 }),
      env,
    );
    expect(second?.status).toBe(200);
    expect(db.rows("servers")[0].state).toBe("active");
    expect(db.rows("servers")[1].state).toBe("destroyed");
    expect(db.rows("servers")[1].failure_code).toBe("traffic_overage");
  });

  it("并发同一 seq：只有一次记账", async () => {
    const db = new FakeD1();
    await seedServer(db);
    const env = envWith(db);

    const [left, right] = await Promise.all([
      handleTraffic(trafficRequest(TOKEN, { seq: 7, delta_bytes: GIB }), env),
      handleTraffic(trafficRequest(TOKEN, { seq: 7, delta_bytes: GIB }), env),
    ]);
    expect([left?.status, right?.status]).toEqual([200, 200]);
    expect(db.rows("server_traffic")).toHaveLength(1);
    expect(db.rows("server_traffic")[0].bytes).toBe(GIB);
  });

  it("同账号静默机器也计入额度池（不依赖本周期有上报行）", async () => {
    const db = new FakeD1();
    await seedServer(db);
    await addServer(db, SECOND, { readyAt: Date.now() });
    const env = envWith(db);

    await handleTraffic(trafficRequest(TOKEN, { seq: 1, delta_bytes: 100 * GIB }), env);

    // 两台各释放 1 天额度（500/28 GiB）：超出 64.29 GiB → 128 分。
    expect(db.rows("accounts")[0].balance_cents).toBe(10_000 - 128);
  });

  it("两台机器同账号同时结算：守卫只放行一笔扣费", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const db = new FakeD1();
    await seedServer(db);
    await addServer(db, SECOND, { readyAt: Date.now() }, SECOND_TOKEN);
    const now = Date.now();
    for (const id of [SERVER, SECOND]) {
      db.rows("server_traffic").push({
        server_id: id,
        cycle_id: "2026-11",
        bytes: 100 * GIB,
        released_bytes: 0,
        charged_cents: 0,
        last_seq: 0,
        updated_at: now,
      });
    }
    const env = envWith(db);

    const [left, right] = await Promise.all([
      handleTraffic(trafficRequest(TOKEN, { seq: 1, delta_bytes: 0 }), env),
      handleTraffic(trafficRequest(SECOND_TOKEN, { seq: 1, delta_bytes: 0 }), env),
    ]);

    expect([left?.status, right?.status]).toEqual([200, 200]);
    const charges = db.rows("wallet_ledger").filter((row) => row.ref_type === "server_traffic");
    expect(charges).toHaveLength(1);
    const charged = db
      .rows("server_traffic")
      .reduce((sum, row) => sum + Number(row.charged_cents), 0);
    // 两台各 100 GiB、各释放 1 天：超出 164.29 GiB → 328 分，且只扣一次。
    expect(charged).toBe(328);
    expect(db.rows("accounts")[0].balance_cents).toBe(10_000 - 328);
  });

  it("周期内销毁的机器按 destroyed_at 截止计入额度池", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const cycleStart = Date.parse("2026-11-01T00:00:00Z");
    const db = new FakeD1();
    await seedServer(db);
    await addServer(db, SECOND, {
      readyAt: cycleStart,
      // 本周期存活 0 整天 → 仍计 1 天预付额度。
      destroyedAt: cycleStart + 12 * 3600 * 1000,
    });
    const env = envWith(db);

    await handleTraffic(trafficRequest(TOKEN, { seq: 1, delta_bytes: 100 * GIB }), env);

    expect(db.rows("accounts")[0].balance_cents).toBe(10_000 - 128);
  });

  it("周期开始前已销毁的机器不计入额度池", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const cycleStart = Date.parse("2026-11-01T00:00:00Z");
    const db = new FakeD1();
    await seedServer(db);
    await addServer(db, SECOND, {
      readyAt: Date.parse("2026-10-20T00:00:00Z"),
      destroyedAt: cycleStart - 12 * 3600 * 1000,
    });
    const env = envWith(db);

    await handleTraffic(trafficRequest(TOKEN, { seq: 1, delta_bytes: 100 * GIB }), env);

    // 只有本机 1 天额度：超出 82.14 GiB → 164 分。
    expect(db.rows("accounts")[0].balance_cents).toBe(10_000 - 164);
  });

  it("契约边界：非法 body 400、未知令牌 401、已销毁 409", async () => {
    const db = new FakeD1();
    await seedServer(db);
    const env = envWith(db);

    const invalid = await handleTraffic(trafficRequest(TOKEN, { seq: 1 }), env);
    expect(invalid?.status).toBe(400);
    expect(((await invalid!.json()) as { reason: string }).reason).toBe("invalid_body");

    const unknown = await handleTraffic(
      trafficRequest("agt_wrong", { seq: 1, delta_bytes: 1 }),
      env,
    );
    expect(unknown?.status).toBe(401);

    db.rows("servers")[0].destroyed_at = Date.now();
    const destroyed = await handleTraffic(
      trafficRequest(TOKEN, { seq: 1, delta_bytes: 1 }),
      env,
    );
    expect(destroyed?.status).toBe(409);
    expect(((await destroyed!.json()) as { reason: string }).reason).toBe("server_destroyed");
  });
});
