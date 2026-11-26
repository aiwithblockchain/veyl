import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { TauriAgentBridge } from "./tauriBridge";
import { rotateFailureReason } from "../myservers/rotateCredentials";

beforeEach(() => {
  invoke.mockReset();
});

const SERVER = {
  server_id: "srv_1",
  name: "新加坡 1 · DigitalOcean",
  region: "sgp1",
  plan: "s-1vcpu-1gb",
  state: "healthy",
  created_at: new Date(0).toISOString(),
  ip: "45.76.20.100",
  port: 8388,
  node_id: "nd_1",
  hourly_usd: 0.00893,
  monthly_usd: 9,
  daily_price_cents: 30,
  paid_until: new Date(86_400_000).toISOString(),
  billing_state: "active",
  grace_ends_at: null,
  transfer_gib: 1000,
  failure: null,
};

describe("按天计费的归一化", () => {
  it("目录套餐缺 daily_price_cents 时整条丢弃", async () => {
    invoke.mockResolvedValueOnce({
      currency: "USD",
      updated_at: new Date(0).toISOString(),
      regions: [],
      plans: [
        { id: "p1", label: "1 核 · 1 GB", hourly_usd: 0.01, monthly_usd: 9 },
        {
          id: "p2",
          label: "1 核 · 2 GB",
          hourly_usd: 0.02,
          monthly_usd: 18,
          daily_price_cents: 60,
          transfer_gib: 2000,
        },
      ],
    });

    const catalog = await new TauriAgentBridge().myServerCatalog();
    expect(catalog.plans).toEqual([
      {
        id: "p2",
        label: "1 核 · 2 GB",
        hourly_usd: 0.02,
        monthly_usd: 18,
        daily_price_cents: 60,
        transfer_gib: 2000,
      },
    ]);
  });

  it("服务器缺计费字段时整条丢弃，不补默认值", async () => {
    const missingDaily = { ...SERVER } as Record<string, unknown>;
    delete missingDaily.daily_price_cents;
    invoke.mockResolvedValueOnce({ servers: [SERVER, missingDaily] });

    const list = await new TauriAgentBridge().myServerList();
    expect(list.servers).toHaveLength(1);
    expect(list.servers[0].paid_until).toBe(SERVER.paid_until);
    expect(list.servers[0].billing_state).toBe("active");
  });

  it("待开通（pending）允许 paid_until 为空；其它状态仍要求有值", async () => {
    const pending = {
      ...SERVER,
      state: "installing",
      billing_state: "pending",
      paid_until: null,
    };
    const broken = { ...SERVER, paid_until: null };
    invoke.mockResolvedValueOnce({ servers: [pending, broken] });

    const list = await new TauriAgentBridge().myServerList();
    expect(list.servers).toHaveLength(1);
    expect(list.servers[0].billing_state).toBe("pending");
    expect(list.servers[0].paid_until).toBeNull();
  });

  it("钱包不要求 runway_days，也不补该字段", async () => {
    invoke.mockResolvedValueOnce({
      balance_cents: 1000,
      currency: "USD",
      denominations_cents: [1000],
      updated_at: new Date(0).toISOString(),
    });

    const wallet = await new TauriAgentBridge().myServerWallet();
    expect(wallet.balance_cents).toBe(1000);
    expect("runway_days" in wallet).toBe(false);
  });
});

describe("流量四字段（2.78.0）与账号池（2.79.0）", () => {
  it("缺字段时补 0 / 空串 / ok，条目仍保留", async () => {
    invoke.mockResolvedValueOnce({ servers: [SERVER] });

    const list = await new TauriAgentBridge().myServerList();
    expect(list.servers).toHaveLength(1);
    expect(list.servers[0].traffic_used_bytes).toBe(0);
    expect(list.servers[0].traffic_limit_bytes).toBe(0);
    expect(list.servers[0].traffic_reset_at).toBe("");
    expect(list.servers[0].traffic_state).toBe("ok");
    expect(list.traffic_pool).toBeUndefined();
  });

  it("脏值逐字段兜底，不影响同条其它字段与其它条目", async () => {
    const good = {
      ...SERVER,
      traffic_used_bytes: 4_294_967_296,
      traffic_limit_bytes: 32_212_254_720,
      traffic_reset_at: "2026-12-01T00:00:00.000Z",
      traffic_state: "unpaid",
    };
    const dirty = {
      ...SERVER,
      server_id: "srv_2",
      traffic_used_bytes: -1,
      traffic_limit_bytes: "nope",
      traffic_reset_at: null,
      traffic_state: "weird",
    };
    invoke.mockResolvedValueOnce({ servers: [good, dirty] });

    const list = await new TauriAgentBridge().myServerList();
    expect(list.servers).toHaveLength(2);
    expect(list.servers[0]).toMatchObject({
      traffic_used_bytes: 4_294_967_296,
      traffic_limit_bytes: 32_212_254_720,
      traffic_reset_at: "2026-12-01T00:00:00.000Z",
      traffic_state: "unpaid",
    });
    expect(list.servers[1]).toMatchObject({
      server_id: "srv_2",
      state: "healthy",
      traffic_used_bytes: 0,
      traffic_limit_bytes: 0,
      traffic_reset_at: "",
      traffic_state: "ok",
    });
  });

  it("旧控制面/旧 Rust 发来的 near / over 降级为 ok", async () => {
    const near = { ...SERVER, server_id: "srv_near", traffic_state: "near" };
    const over = { ...SERVER, server_id: "srv_over", traffic_state: "over" };
    invoke.mockResolvedValueOnce({ servers: [near, over] });

    const list = await new TauriAgentBridge().myServerList();
    expect(list.servers.map((server) => server.traffic_state)).toEqual([
      "ok",
      "ok",
    ]);
  });

  it("账号池可缺省；内层字段缺失按 0，非对象当没给", async () => {
    invoke.mockResolvedValueOnce({
      servers: [SERVER],
      traffic_pool: { used_bytes: 1024, limit_bytes: 2048 },
    });
    expect((await new TauriAgentBridge().myServerList()).traffic_pool).toEqual({
      usedBytes: 1024,
      limitBytes: 2048,
    });

    invoke.mockResolvedValueOnce({
      servers: [SERVER],
      traffic_pool: { used_bytes: 1024 },
    });
    expect((await new TauriAgentBridge().myServerList()).traffic_pool).toEqual({
      usedBytes: 1024,
      limitBytes: 0,
    });

    invoke.mockResolvedValueOnce({ servers: [SERVER], traffic_pool: "nope" });
    expect(
      (await new TauriAgentBridge().myServerList()).traffic_pool,
    ).toBeUndefined();
  });
});

describe("结账返回订单（2.39.0）", () => {
  it("按订单归一化：保留 server_id，不读 charged_cents", async () => {
    invoke.mockResolvedValueOnce({
      order_id: "ord_1",
      state: "provisioning",
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      amount_usd: 9,
      created_at: new Date(0).toISOString(),
      expires_at: null,
      server_id: "srv_1",
      failure: null,
      charged_cents: 30,
      balance_after_cents: 970,
    });

    const order = await new TauriAgentBridge().myServerCheckout("ord_1");
    expect(order).toMatchObject({
      order_id: "ord_1",
      state: "provisioning",
      server_id: "srv_1",
    });
    expect("charged_cents" in order).toBe(false);
    expect("balance_after_cents" in order).toBe(false);
  });
});

describe("结账余额不足的错误细节（2.37.1）", () => {
  it("required_cents / shortfall_cents / min_days 原样透传", async () => {
    invoke.mockRejectedValueOnce({
      code: "PRECONDITION_FAILED",
      message: "余额不足",
      retryable: true,
      details: {
        reason: "insufficient_balance",
        required_cents: 210,
        shortfall_cents: 210,
        min_days: 7,
      },
    });

    await expect(new TauriAgentBridge().myServerCheckout("ord_1")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      retryable: true,
      details: {
        reason: "insufficient_balance",
        required_cents: 210,
        shortfall_cents: 210,
        min_days: 7,
      },
    });
  });
});

describe("智能修复命令", () => {
  it("命令名与参数键传对，结果原样透传", async () => {
    invoke.mockResolvedValueOnce({ ok: true, port: 8555, refreshed: true });

    const result = await new TauriAgentBridge().nodeRotateCredentials("srv_1");

    expect(invoke).toHaveBeenCalledWith("node_rotate_credentials", {
      serverId: "srv_1",
    });
    expect(result).toEqual({ ok: true, port: 8555, refreshed: true });
  });

  it("失败信封里的 reason 原样透到 rotateFailureReason", async () => {
    invoke.mockRejectedValueOnce({
      code: "INTERNAL",
      message: "节点没在超时内跑完",
      retryable: true,
      details: { reason: "agent_timeout" },
    });

    const error = await new TauriAgentBridge()
      .nodeRotateCredentials("srv_1")
      .catch((err: unknown) => err);

    expect(rotateFailureReason(error)).toBe("agent_timeout");
  });
});

describe("账单流水（2.76.0）", () => {
  const LEDGER = {
    balance_cents: 11806,
    currency: "USD",
    window_days: 30,
    truncated: false,
    totals: { topup_cents: 12000, charge_cents: 294 },
    entries: [
      {
        id: "wl_2",
        kind: "machine_day",
        amount_cents: -20,
        at: 1_764_000_000_000,
        server: {
          id: "srv_1",
          name: "新加坡 1",
          plan: "s-1vcpu-1gb",
          region: "sgp1",
        },
        note: null,
      },
      {
        id: "wl_1",
        kind: "topup",
        amount_cents: 12000,
        at: 1_763_000_000_000,
        server: null,
        note: "充值",
      },
    ],
  };

  it("命令名与 days 传对；省略时不传 days；毫秒时间原样保留", async () => {
    invoke.mockResolvedValueOnce(LEDGER);
    const ledger = await new TauriAgentBridge().myServerBillingLedger(7);

    expect(invoke).toHaveBeenLastCalledWith("my_server_billing_ledger", {
      days: 7,
    });
    expect(ledger.entries[0].at).toBe(1_764_000_000_000);
    expect(ledger.entries[0].server?.region).toBe("sgp1");
    expect(ledger.entries[1].server).toBeNull();

    invoke.mockResolvedValueOnce(LEDGER);
    await new TauriAgentBridge().myServerBillingLedger();
    expect(invoke).toHaveBeenLastCalledWith("my_server_billing_ledger", {});
  });

  it("认不出的 kind 归 other；坏条目整条丢弃，null 机器合法", async () => {
    invoke.mockResolvedValueOnce({
      ...LEDGER,
      entries: [
        { ...LEDGER.entries[0], kind: "promo" },
        { ...LEDGER.entries[0], id: "" },
        { ...LEDGER.entries[0], at: 0 },
        { ...LEDGER.entries[0], at: 1_764_000_000 },
        { ...LEDGER.entries[0], at: 1_764_000_000_000.5 },
        { ...LEDGER.entries[0], amount_cents: "12" },
        { ...LEDGER.entries[0], amount_cents: 12.5 },
        { ...LEDGER.entries[0], server: { id: "srv_1" } },
        LEDGER.entries[1],
      ],
    });

    const ledger = await new TauriAgentBridge().myServerBillingLedger();
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries[0].kind).toBe("other");
    expect(ledger.entries[1]).toMatchObject({ kind: "topup", server: null });
  });

  it("totals 是全量，原样透传而不是按 entries 重算", async () => {
    invoke.mockResolvedValueOnce({
      ...LEDGER,
      truncated: true,
      totals: { topup_cents: 99999, charge_cents: 1 },
    });

    const ledger = await new TauriAgentBridge().myServerBillingLedger();
    expect(ledger.truncated).toBe(true);
    expect(ledger.totals).toEqual({ topup_cents: 99999, charge_cents: 1 });
  });

  it("顶层形状不对按上游错误处理", async () => {
    for (const broken of [
      { ...LEDGER, balance_cents: -1 },
      { ...LEDGER, balance_cents: 10.5 },
      { ...LEDGER, window_days: 31 },
      { ...LEDGER, totals: undefined },
      { ...LEDGER, totals: { topup_cents: 1.5, charge_cents: 0 } },
      { ...LEDGER, entries: "nope" },
    ]) {
      invoke.mockResolvedValueOnce(broken);
      await expect(
        new TauriAgentBridge().myServerBillingLedger(),
      ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    }
  });

  it("失败信封的 code 与 reason 原样保留", async () => {
    invoke.mockRejectedValueOnce({
      code: "UNAUTHENTICATED",
      message: "",
      retryable: true,
      details: { reason: "auth_required" },
    });

    const error = await new TauriAgentBridge()
      .myServerBillingLedger()
      .catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: "UNAUTHENTICATED",
      details: { reason: "auth_required" },
    });
  });
});

describe("检查升级命令（2.75.0）", () => {
  it("命令名与参数键传对，三个字段原样返回", async () => {
    invoke.mockResolvedValueOnce({
      installed: "1.14.4",
      target: "1.15.0",
      upgraded: true,
    });

    const result = await new TauriAgentBridge().nodeUpgradeSingbox("srv_1");

    expect(invoke).toHaveBeenCalledWith("node_upgrade_singbox", {
      serverId: "srv_1",
    });
    expect(result).toEqual({
      installed: "1.14.4",
      target: "1.15.0",
      upgraded: true,
    });
  });

  it("回包形状不对按上游错误处理", async () => {
    invoke.mockResolvedValueOnce({ installed: "1.14.4", target: "1.15.0" });

    await expect(
      new TauriAgentBridge().nodeUpgradeSingbox("srv_1"),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("失败信封的 code 与 reason 原样保留", async () => {
    invoke.mockRejectedValueOnce({
      code: "TIMEOUT",
      message: "",
      retryable: true,
      details: { reason: "agent_timeout" },
    });

    const error = await new TauriAgentBridge()
      .nodeUpgradeSingbox("srv_1")
      .catch((err: unknown) => err);

    expect(error).toMatchObject({
      code: "TIMEOUT",
      details: { reason: "agent_timeout" },
    });
  });
});
