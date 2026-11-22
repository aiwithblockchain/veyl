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
  local_node_id: "local_1",
  hourly_usd: 0.00893,
  monthly_usd: 9,
  daily_price_cents: 30,
  paid_until: new Date(86_400_000).toISOString(),
  billing_state: "active",
  grace_ends_at: null,
  transfer_gib: 1000,
  failure: null,
};

const CHANGED = {
  server_id: "srv_1",
  node_id: "local_1",
  name: "新加坡 1",
  port_changed: true,
  password_changed: false,
};

const FAILED = {
  server_id: "srv_2",
  code: "NODE_CREDENTIALS_FAILED",
};

describe("my_server_sync", () => {
  it("命令名正确，servers / changed / failed 原样解析", async () => {
    invoke.mockResolvedValueOnce({
      servers: [SERVER],
      changed: [CHANGED],
      failed: [FAILED],
    });

    const data = await new TauriAgentBridge().myServerSync();

    expect(invoke).toHaveBeenCalledWith("my_server_sync", undefined);
    expect(data.servers).toHaveLength(1);
    expect(data.servers[0].server_id).toBe("srv_1");
    expect(data.changed).toEqual([CHANGED]);
    expect(data.failed).toEqual([FAILED]);
  });

  it("缺 changed / failed 时按空数组，不猜值", async () => {
    invoke.mockResolvedValueOnce({ servers: [] });

    const data = await new TauriAgentBridge().myServerSync();

    expect(data).toEqual({ servers: [], changed: [], failed: [] });
  });

  it("changed / failed 条目缺字段时丢弃该条", async () => {
    invoke.mockResolvedValueOnce({
      servers: [],
      changed: [{ node_id: "local_1" }, CHANGED],
      failed: [{ code: "E" }, FAILED],
    });

    const data = await new TauriAgentBridge().myServerSync();

    expect(data.changed).toEqual([CHANGED]);
    expect(data.failed).toEqual([FAILED]);
  });

  it("servers 不是数组时报 UPSTREAM_ERROR", async () => {
    invoke.mockResolvedValueOnce({ changed: [], failed: [] });

    await expect(new TauriAgentBridge().myServerSync()).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });
});

describe("server_sync_interval_get / set", () => {
  it("读取命令名与返回值", async () => {
    invoke.mockResolvedValueOnce({ minutes: 30 });

    const data = await new TauriAgentBridge().serverSyncIntervalGet();

    expect(invoke).toHaveBeenCalledWith("server_sync_interval_get", undefined);
    expect(data).toEqual({ minutes: 30 });
  });

  it("读取值非法时报错，不兜默认 30", async () => {
    invoke.mockResolvedValueOnce({ minutes: 7 });

    await expect(
      new TauriAgentBridge().serverSyncIntervalGet(),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("保存传 minutes，并返回 Host 写入后的值", async () => {
    invoke.mockResolvedValueOnce({ minutes: 60 });

    const data = await new TauriAgentBridge().serverSyncIntervalSet(60);

    expect(invoke).toHaveBeenCalledWith("server_sync_interval_set", {
      minutes: 60,
    });
    expect(data).toEqual({ minutes: 60 });
  });

  it("保存返回非法值时报错", async () => {
    invoke.mockResolvedValueOnce({ minutes: 12 });

    await expect(
      new TauriAgentBridge().serverSyncIntervalSet(60),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});
