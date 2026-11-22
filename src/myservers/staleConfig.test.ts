import { describe, expect, it } from "vitest";
import type { NodeListChangedPayload } from "../agent/protocol";
import { staleConfigNodeId } from "./staleConfig";

const payload = (
  over: Partial<Pick<NodeListChangedPayload, "reason" | "changed_node_ids">> = {},
) => ({
  reason: "node_synced" as NodeListChangedPayload["reason"],
  changed_node_ids: ["nd_current"],
  ...over,
});

describe("周期同步发现当前节点配置变更", () => {
  it("含当前连接节点（本地 nd id）且已连接 → 返回该节点", () => {
    expect(
      staleConfigNodeId(payload(), { state: "running", node_id: "nd_current" }),
    ).toBe("nd_current");
    expect(
      staleConfigNodeId(payload(), { state: "degraded", node_id: "nd_current" }),
    ).toBe("nd_current");
  });

  it("只含其它节点 → 不提示", () => {
    expect(
      staleConfigNodeId(
        payload({ changed_node_ids: ["nd_other"] }),
        { state: "running", node_id: "nd_current" },
      ),
    ).toBeNull();
  });

  it("拿 server id（srv_…）去对比本地节点 id 不会命中", () => {
    expect(
      staleConfigNodeId(
        payload({ changed_node_ids: ["srv_current"] }),
        { state: "running", node_id: "nd_current" },
      ),
    ).toBeNull();
  });

  it("隧道没在跑或不是同步事件 → 不提示", () => {
    expect(
      staleConfigNodeId(payload(), { state: "idle", node_id: "nd_current" }),
    ).toBeNull();
    expect(
      staleConfigNodeId(
        payload({ reason: "node_rotated" }),
        { state: "running", node_id: "nd_current" },
      ),
    ).toBeNull();
  });
});
