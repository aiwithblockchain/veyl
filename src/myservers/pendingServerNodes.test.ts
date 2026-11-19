import { describe, expect, it } from "vitest";
import type { MyServer } from "../agent/bridge";
import { collectPendingServerNodes } from "./pendingServerNodes";

function server(over: Partial<MyServer> = {}): MyServer {
  return {
    server_id: "srv_1",
    name: "法兰克福 3 · Vultr",
    region: "fra1",
    plan: "s-1vcpu-1gb",
    state: "active",
    created_at: new Date(0).toISOString(),
    ip: "45.76.20.12",
    port: 8388,
    node_id: "nd_1",
    local_node_id: "local_1",
    hourly_usd: 0.00893,
    monthly_usd: 6,
    daily_price_cents: 30,
    paid_until: null,
    billing_state: "active",
    grace_ends_at: null,
    transfer_gib: 1000,
    failure: null,
    ...over,
  };
}

describe("待接入的服务器节点", () => {
  it("只算已就绪的机器：进行中、失败、销毁都不出现", () => {
    const pending = collectPendingServerNodes(
      [
        server({ server_id: "a", state: "creating" }),
        server({ server_id: "b", state: "installing" }),
        server({ server_id: "c", state: "error" }),
        server({ server_id: "d", state: "destroyed" }),
        server({ server_id: "e", state: "healthy", local_node_id: "local_e", node_id: "nd_e" }),
        server({ server_id: "f", state: "active", local_node_id: "local_f", node_id: "nd_f" }),
      ],
      new Set(),
    );

    expect(pending.map((item) => item.nodeId)).toEqual(["local_e", "local_f"]);
  });

  it("本地节点行 id 优先，没有时退回控制面 id", () => {
    const pending = collectPendingServerNodes(
      [
        server({ server_id: "a", local_node_id: "local_a", node_id: "nd_a" }),
        server({ server_id: "b", local_node_id: null, node_id: "nd_b" }),
      ],
      new Set(),
    );

    expect(pending).toEqual([
      { nodeId: "local_a", name: "法兰克福 3 · Vultr" },
      { nodeId: "nd_b", name: "法兰克福 3 · Vultr" },
    ]);
  });

  it("两个 id 任一已在配置里就排除，剩下的按 id 去重", () => {
    const pending = collectPendingServerNodes(
      [
        // 本地 id 已在配置里。
        server({ server_id: "a", local_node_id: "local_a", node_id: "nd_a" }),
        // 本地 id 不在，但控制面 id 已在配置里（重签发）——同样算已接入。
        server({ server_id: "b", local_node_id: "local_b", node_id: "nd_b" }),
        // 两个 id 都不在配置里：待接入。
        server({ server_id: "c", local_node_id: "local_c", node_id: "nd_c" }),
        // 同一个节点出现两次只留一条。
        server({ server_id: "c", local_node_id: "local_c", node_id: "nd_c" }),
        // 没有任何可用 id：不编行。
        server({ server_id: "d", local_node_id: null, node_id: null }),
      ],
      new Set(["local_a", "nd_b"]),
    );

    expect(pending.map((item) => item.nodeId)).toEqual(["local_c"]);
  });
});
