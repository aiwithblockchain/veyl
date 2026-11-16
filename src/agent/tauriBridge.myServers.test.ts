import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { TauriAgentBridge } from "./tauriBridge";

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
