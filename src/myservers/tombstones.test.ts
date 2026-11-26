import { describe, expect, it } from "vitest";
import type { MyServer } from "../agent/bridge";
import { collectDanglingNodeIds, isTombstone } from "./tombstones";

function server(over: Partial<MyServer>): MyServer {
  return {
    server_id: "srv_1",
    name: "东京 1",
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    state: "active",
    created_at: new Date(0).toISOString(),
    ip: "203.0.113.1",
    port: 8388,
    node_id: "nd_remote_1",
    local_node_id: "local_1",
    hourly_usd: 0.00893,
    monthly_usd: 9,
    daily_price_cents: 30,
    paid_until: new Date(86_400_000).toISOString(),
    billing_state: "active",
    grace_ends_at: null,
    transfer_gib: 1000,
    traffic_used_bytes: 0,
    traffic_limit_bytes: 0,
    traffic_reset_at: "",
    traffic_state: "ok",
    failure: null,
    ...over,
  };
}

describe("isTombstone", () => {
  it("只有 destroyed 是墓碑", () => {
    expect(isTombstone(server({ state: "destroyed" }))).toBe(true);
    for (const state of ["active", "healthy", "destroying", "error", "gone"] as const) {
      expect(isTombstone(server({ state }))).toBe(false);
    }
  });
});

describe("collectDanglingNodeIds", () => {
  it("配置里的节点命中墓碑的 local_node_id 才算悬挂", () => {
    const servers = [server({ state: "destroyed", local_node_id: "local_1" })];
    expect([...collectDanglingNodeIds(servers, ["local_1", "local_2"])]).toEqual([
      "local_1",
    ]);
  });

  it("活着的服务器点名的节点不算悬挂", () => {
    const servers = [server({ state: "active", local_node_id: "local_1" })];
    expect(collectDanglingNodeIds(servers, ["local_1"]).size).toBe(0);
  });

  it("重签发后控制面 id 变了：只认 local_node_id，不拿 node_id 兜底", () => {
    const servers = [
      server({
        state: "destroyed",
        node_id: "nd_reissued",
        local_node_id: "local_1",
      }),
    ];
    expect(collectDanglingNodeIds(servers, ["nd_reissued"]).size).toBe(0);
    expect([...collectDanglingNodeIds(servers, ["local_1"])]).toEqual(["local_1"]);
  });

  it("墓碑没有 local_node_id 时不冤枉任何节点", () => {
    const servers = [server({ state: "destroyed", local_node_id: null })];
    expect(collectDanglingNodeIds(servers, ["local_1", "local_2"]).size).toBe(0);
  });

  it("配置里没有的节点不会凭空出现", () => {
    const servers = [server({ state: "destroyed", local_node_id: "local_9" })];
    expect(collectDanglingNodeIds(servers, ["local_1"]).size).toBe(0);
  });
});
