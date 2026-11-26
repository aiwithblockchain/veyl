import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleBillingLedger } from "../src/billing_report";
import { route } from "../src/index";
import { signAccessToken } from "../src/lib/crypto";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_ledger00000000000000";
const OTHER_ACCOUNT = "acct_ledger_other0000000";
const DEVICE = "dev_ledger000000000000000";
const NOW = Date.parse("2026-11-26T12:00:00Z");
const DAY_MS = 24 * 3600 * 1000;

type Row = Record<string, unknown>;

async function signingJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

async function envWith(db: FakeD1, balance = 11_806) {
  const jwk = await signingJwk();
  db.rows("accounts").push({
    id: ACCOUNT,
    kind: "email",
    status: "active",
    balance_cents: balance,
  });
  db.rows("devices").push({ id: DEVICE, account_id: ACCOUNT, revoked_at: null });
  const token = await signAccessToken(jwk, {
    sub: ACCOUNT,
    did: DEVICE,
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 600,
    jti: "jti_ledger_test",
  });
  return {
    DB: db as unknown as D1Database,
    TOKEN_SIGNING_JWK: jwk,
    ENVIRONMENT: "test",
    token,
  };
}

function addEntry(
  db: FakeD1,
  entry: {
    id: string;
    ref_type: string;
    ref_id: string;
    amount_cents: number;
    created_at?: number;
    account_id?: string;
    note?: string | null;
  },
): void {
  db.rows("wallet_ledger").push({
    kind: entry.amount_cents < 0 ? "charge" : "topup",
    balance_after_cents: 0,
    created_at: NOW - 1000,
    account_id: ACCOUNT,
    note: null,
    ...entry,
  });
}

function addServer(db: FakeD1, id: string, orderId: string, name = "东京-01"): void {
  db.rows("servers").push({
    id,
    account_id: ACCOUNT,
    order_id: orderId,
    name,
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    state: "active",
    created_at: NOW,
    updated_at: NOW,
    destroyed_at: null,
  });
}

function request(token: string | null, query = "") {
  return new Request(`https://example.com/v1/billing/ledger${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function ledgerOf(env: { token: string }, query = ""): Promise<Row> {
  const response = await handleBillingLedger(request(env.token, query), env as never);
  expect(response).not.toBeNull();
  return (await response?.json()) as Row;
}

beforeEach(() => {
  // 窗口上界是 now：把时钟钉死，行不会因为「测试机器时间早于常量」被判成未来时间。
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("账单流水 · 接口", () => {
  it("五种 ref_type 各自映射；order 与 server_day 都归 machine_day，未知类型归 other 但不丢行", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    addEntry(db, { id: "led_topup_stripe", ref_type: "stripe_payment", ref_id: "cs_1", amount_cents: 7000 });
    addEntry(db, { id: "led_topup_dodo", ref_type: "dodo_payment", ref_id: "pay_1", amount_cents: 5000 });
    addEntry(db, { id: "led_order", ref_type: "order", ref_id: "ord_1", amount_cents: -164 });
    addEntry(db, { id: "led_day", ref_type: "server_day", ref_id: "srv_1:2026-11-25", amount_cents: -30 });
    addEntry(db, { id: "led_traffic", ref_type: "server_traffic", ref_id: "srv_1:2026-11:2", amount_cents: -2 });
    addEntry(db, { id: "led_refund", ref_type: "server_refund", ref_id: "srv_1", amount_cents: 60 });
    addEntry(db, { id: "led_manual", ref_type: "manual", ref_id: "adj_1", amount_cents: -5 });

    const body = await ledgerOf(env);
    const kinds = (body.entries as Row[]).map((entry) => [entry.id, entry.kind]);
    expect(Object.fromEntries(kinds)).toEqual({
      led_topup_stripe: "topup",
      led_topup_dodo: "topup",
      led_order: "machine_day",
      led_day: "machine_day",
      led_traffic: "traffic",
      led_refund: "refund",
      led_manual: "other",
    });
  });

  it("order 的机器走 orders.order_id 解析；解析不到时整行仍返回、server 为 null", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    addServer(db, "srv_1", "ord_1");
    db.rows("orders").push({ id: "ord_1", account_id: ACCOUNT, state: "ready" });
    addEntry(db, { id: "led_order_ok", ref_type: "order", ref_id: "ord_1", amount_cents: -164 });
    addEntry(db, { id: "led_order_missing", ref_type: "order", ref_id: "ord_gone", amount_cents: -164 });
    addEntry(db, { id: "led_day_ok", ref_type: "server_day", ref_id: "srv_1:2026-11-25", amount_cents: -30 });
    addEntry(db, { id: "led_day_missing", ref_type: "server_day", ref_id: "srv_gone:2026-11-25", amount_cents: -30 });

    const body = await ledgerOf(env);
    const byId = Object.fromEntries((body.entries as Row[]).map((entry) => [entry.id, entry]));
    expect(byId.led_order_ok.server).toEqual({
      id: "srv_1",
      name: "东京-01",
      plan: "s-1vcpu-1gb",
      region: "sgp1",
    });
    expect(byId.led_day_ok.server).toEqual(byId.led_order_ok.server);
    expect(byId.led_order_missing).toMatchObject({ server: null, amount_cents: -164 });
    expect(byId.led_day_missing).toMatchObject({ server: null, amount_cents: -30 });
  });

  it("snapshot 行不进结果", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    addEntry(db, { id: "led_snap", ref_type: "snapshot", ref_id: `${ACCOUNT}:2026-09`, amount_cents: 0 });
    addEntry(db, { id: "led_real", ref_type: "server_day", ref_id: "srv_1:2026-11-25", amount_cents: -30 });

    const body = await ledgerOf(env);
    expect((body.entries as Row[]).map((entry) => entry.id)).toEqual(["led_real"]);
  });

  it("账号隔离：别人的行不进列表、不进合计，余额是本人余额", async () => {
    const db = new FakeD1();
    const env = await envWith(db, 11_806);
    db.rows("accounts").push({
      id: OTHER_ACCOUNT,
      kind: "email",
      status: "active",
      balance_cents: 999_999,
    });
    addEntry(db, { id: "led_mine", ref_type: "server_day", ref_id: "srv_1:d1", amount_cents: -30 });
    addEntry(db, {
      id: "led_theirs_topup",
      ref_type: "stripe_payment",
      ref_id: "cs_theirs",
      amount_cents: 50_000,
      account_id: OTHER_ACCOUNT,
    });
    addEntry(db, {
      id: "led_theirs_charge",
      ref_type: "server_day",
      ref_id: "srv_9:d1",
      amount_cents: -700,
      account_id: OTHER_ACCOUNT,
    });

    const body = await ledgerOf(env);
    expect((body.entries as Row[]).map((entry) => entry.id)).toEqual(["led_mine"]);
    expect(body.totals).toEqual({ topup_cents: 0, charge_cents: 30 });
    expect(body.balance_cents).toBe(11_806);
  });

  it("totals 与逐行求和一致：退款是正数、只进 topup 不计入 charge", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    addEntry(db, { id: "led_topup", ref_type: "stripe_payment", ref_id: "cs_1", amount_cents: 12_000 });
    addEntry(db, { id: "led_day", ref_type: "server_day", ref_id: "srv_1:2026-11-25", amount_cents: -30 });
    addEntry(db, { id: "led_order", ref_type: "order", ref_id: "ord_1", amount_cents: -164 });
    addEntry(db, { id: "led_traffic", ref_type: "server_traffic", ref_id: "srv_1:2026-11:2", amount_cents: -100 });
    addEntry(db, { id: "led_refund", ref_type: "server_refund", ref_id: "srv_1", amount_cents: 60 });

    const body = await ledgerOf(env);
    const entries = body.entries as Row[];
    const topupCents = entries
      .filter((entry) => entry.kind === "topup")
      .reduce((total, entry) => total + Number(entry.amount_cents), 0);
    const chargeCents = entries
      .filter((entry) => Number(entry.amount_cents) < 0)
      .reduce((total, entry) => total - Number(entry.amount_cents), 0);
    expect(body.totals).toEqual({ topup_cents: topupCents, charge_cents: chargeCents });
    expect(body.totals).toEqual({ topup_cents: 12_000, charge_cents: 294 });
  });

  it("时间窗：半开区间排除边界毫秒；days=7 真的缩小窗口；days 只认十进制 1–30", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    addEntry(db, { id: "led_edge", ref_type: "server_day", ref_id: "srv_1:d1", amount_cents: -30, created_at: NOW - 30 * DAY_MS });
    addEntry(db, { id: "led_inside", ref_type: "server_day", ref_id: "srv_1:d2", amount_cents: -30, created_at: NOW - 30 * DAY_MS + 1 });
    addEntry(db, { id: "led_8d", ref_type: "server_day", ref_id: "srv_1:d3", amount_cents: -30, created_at: NOW - 8 * DAY_MS });
    addEntry(db, { id: "led_6d", ref_type: "server_day", ref_id: "srv_1:d4", amount_cents: -30, created_at: NOW - 6 * DAY_MS });
    addEntry(db, { id: "led_today", ref_type: "server_day", ref_id: "srv_1:d5", amount_cents: -30, created_at: NOW });

    const body = await ledgerOf(env);
    expect((body.entries as Row[]).map((entry) => entry.id)).toEqual([
      "led_today",
      "led_6d",
      "led_8d",
      "led_inside",
    ]);
    expect(body.window_days).toBe(30);

    // 上界是 now：未来时间的行（回填/时钟漂移）不算进窗口。
    addEntry(db, { id: "led_future", ref_type: "server_day", ref_id: "srv_1:d6", amount_cents: -30, created_at: NOW + 1 });
    expect((await ledgerOf(env)).entries as Row[]).toHaveLength(4);

    // days 联动：7 天窗口排除 8 天前那行，合计跟着变。
    const week = await ledgerOf(env, "?days=7");
    expect(week.window_days).toBe(7);
    expect((week.entries as Row[]).map((entry) => entry.id)).toEqual(["led_today", "led_6d"]);
    expect(week.totals).toEqual({ topup_cents: 0, charge_cents: 60 });

    for (const query of ["?days=0", "?days=31", "?days=abc", "?days=1.5", "?days=", "?days=0x10", "?days=1e1", "?days=+7"]) {
      expect((await ledgerOf(env, query)).window_days).toBe(30);
    }
    expect((await ledgerOf(env, "?days=7")).window_days).toBe(7);
  });

  it("排序 created_at DESC、id DESC，最多 1000 条", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    for (let index = 0; index < 1005; index += 1) {
      addEntry(db, {
        id: `led_${String(index).padStart(4, "0")}`,
        ref_type: "server_day",
        ref_id: `srv_1:d${index}`,
        amount_cents: -30,
        // 每三行同一毫秒，验证同秒时按 id 倒序。
        created_at: NOW - 1000 - Math.floor(index / 3),
      });
    }

    const body = await ledgerOf(env);
    const entries = body.entries as Row[];
    expect(entries).toHaveLength(1000);
    expect(body.truncated).toBe(true);
    // 同一毫秒内按 id 倒序：最新一组是 led_0000–0002。
    expect(entries.slice(0, 3).map((entry) => entry.id)).toEqual(["led_0002", "led_0001", "led_0000"]);
    // 最旧的三行 led_1002–1004 被上限截掉，第 1000 条正好是 led_1001。
    expect(entries[999].id).toBe("led_1001");
    const times = entries.map((entry) => Number(entry.at));
    expect(times).toEqual([...times].sort((left, right) => right - left));
  });

  it("超过 1000 笔：列表截断、truncated=true，totals 仍是全量求和", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    // 200 笔充值放在最旧的一端，1000 笔扣费更新：列表里只剩扣费，合计不能跟着变少。
    for (let index = 0; index < 200; index += 1) {
      addEntry(db, {
        id: `led_top_${index}`,
        ref_type: "stripe_payment",
        ref_id: `cs_${index}`,
        amount_cents: 100,
        created_at: NOW - 200_000 - index,
      });
    }
    for (let index = 0; index < 1000; index += 1) {
      addEntry(db, {
        id: `led_day_${index}`,
        ref_type: "server_day",
        ref_id: `srv_1:d${index}`,
        amount_cents: -3,
        created_at: NOW - 1000 - index,
      });
    }

    const body = await ledgerOf(env);
    const entries = body.entries as Row[];
    expect(entries).toHaveLength(1000);
    expect(body.truncated).toBe(true);
    expect(entries.every((entry) => entry.kind === "machine_day")).toBe(true);
    expect(body.totals).toEqual({ topup_cents: 200 * 100, charge_cents: 1000 * 3 });
  });

  it("挂到路由上：/v1/billing/ledger 返回契约形状", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    addEntry(db, { id: "led_topup", ref_type: "stripe_payment", ref_id: "cs_1", amount_cents: 12_000 });

    const response = await route(request(env.token), env as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      balance_cents: 11_806,
      currency: "USD",
      window_days: 30,
      truncated: false,
      totals: { topup_cents: 12_000, charge_cents: 0 },
      entries: [
        {
          id: "led_topup",
          kind: "topup",
          amount_cents: 12_000,
          at: NOW - 1000,
          server: null,
          note: null,
        },
      ],
    });
  });

  it("未登录返回 401；非 GET 返回 405", async () => {
    const db = new FakeD1();
    const env = await envWith(db);
    const missing = await handleBillingLedger(request(null), env as never);
    expect(missing?.status).toBe(401);
    const wrongMethod = await handleBillingLedger(
      new Request("https://example.com/v1/billing/ledger", { method: "POST" }),
      env as never,
    );
    expect(wrongMethod?.status).toBe(405);
  });
});
