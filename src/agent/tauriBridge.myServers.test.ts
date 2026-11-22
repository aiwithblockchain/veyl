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
