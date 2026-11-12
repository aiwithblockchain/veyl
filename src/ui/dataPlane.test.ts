import { describe, expect, it } from "vitest";
import { emptyRuntimeView } from "../agent/bridge";
import { dataPlaneDown, DATA_PLANE_FRESH_MS } from "./dataPlane";

const NOW = Date.parse("2026-11-12T08:00:00.000Z");

function runtime(over: {
  state?: "running" | "degraded" | "idle";
  data_plane?: boolean;
  checkedAt?: string;
} = {}) {
  const view = emptyRuntimeView();
  return {
    ...view,
    state: over.state ?? "running",
    health: {
      ...view.health,
      data_plane: over.data_plane ?? false,
      checked_at: over.checkedAt ?? new Date(NOW - 1_000).toISOString(),
    },
  };
}

describe("dataPlaneDown", () => {
  it("running 且探测失败、快照新鲜时成立", () => {
    expect(dataPlaneDown(runtime(), NOW)).toBe(true);
  });

  it("快照超过 30 秒即视为未知，不再停留在这个结论上", () => {
    const stale = new Date(NOW - DATA_PLANE_FRESH_MS - 1).toISOString();
    expect(dataPlaneDown(runtime({ checkedAt: stale }), NOW)).toBe(false);
  });

  it("degraded 不进这个状态，交给「连接不稳定」", () => {
    expect(dataPlaneDown(runtime({ state: "degraded" }), NOW)).toBe(false);
  });

  it("探测恢复正常就不成立", () => {
    expect(dataPlaneDown(runtime({ data_plane: true }), NOW)).toBe(false);
  });

  it("checked_at 读不出来时按未知处理", () => {
    expect(dataPlaneDown(runtime({ checkedAt: "" }), NOW)).toBe(false);
  });
});
