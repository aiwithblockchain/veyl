import { describe, expect, it } from "vitest";
import { repairAvailableFor } from "./repairAvailability";

const config = {
  nodes: [
    {
      node_id: "nd_a",
      name: "东京 01",
      server: "203.0.113.1",
      port: 8388,
      method: "aes-256-gcm",
      protocol: "shadowsocks" as const,
      source: "owned" as const,
      created_at: 0,
    },
  ],
};
const unreachable = (nodeId: string) => ({ [nodeId]: { reachable: false } });
const reachable = (nodeId: string) => ({ [nodeId]: { reachable: true } });
const untested = (nodeId: string) => ({ [nodeId]: { reachable: null } });

describe("详情页智能修复入口", () => {
  it("探测不可达才显示", () => {
    expect(
      repairAvailableFor("nd_a", config, unreachable("nd_a"), new Set()),
    ).toBe(true);
  });

  it("可达 / untested / 没测过都不显示", () => {
    expect(
      repairAvailableFor("nd_a", config, reachable("nd_a"), new Set()),
    ).toBe(false);
    expect(
      repairAvailableFor("nd_a", config, untested("nd_a"), new Set()),
    ).toBe(false);
    expect(repairAvailableFor("nd_a", config, {}, new Set())).toBe(false);
  });

  it("测速中不显示", () => {
    expect(
      repairAvailableFor("nd_a", config, unreachable("nd_a"), new Set(["nd_a"])),
    ).toBe(false);
  });

  it("节点不在当前配置里（拿不到状态）不显示", () => {
    expect(
      repairAvailableFor("nd_other", config, unreachable("nd_other"), new Set()),
    ).toBe(false);
    expect(repairAvailableFor("nd_a", null, unreachable("nd_a"), new Set())).toBe(
      false,
    );
    expect(repairAvailableFor(null, config, {}, new Set())).toBe(false);
  });
});
