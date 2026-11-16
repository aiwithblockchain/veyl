import { describe, expect, it } from "vitest";
import {
  createMockConfig,
  nextConfigName,
  rememberMockNode,
  summarizeConfig,
} from "./model";

const named = (...names: string[]) => names.map((name) => ({ name }));

describe("nextConfigName", () => {
  it("从「配置 1」开始，取最小可用整数", () => {
    expect(nextConfigName(named())).toBe("配置 1");
    expect(nextConfigName(named("配置 1"))).toBe("配置 2");
    expect(nextConfigName(named("配置 1", "配置 3"))).toBe("配置 2");
    expect(nextConfigName(named("配置 1", "配置 2"))).toBe("配置 3");
  });
});

describe("summarizeConfig", () => {
  it("当前配置标记为 active，且不带节点明细", () => {
    const detail = createMockConfig("公司", "tun");
    const summary = summarizeConfig(detail, detail.config_id);

    expect(summary.is_active).toBe(true);
    expect(summary.node_count).toBe(detail.nodes.length);
    expect(summary).not.toHaveProperty("nodes");
    expect(summary).not.toHaveProperty("dns");
    expect(summary).not.toHaveProperty("layout");
  });

  it("不是当前配置时 is_active 为 false", () => {
    const detail = createMockConfig("公司", "tun");
    expect(summarizeConfig(detail, null).is_active).toBe(false);
  });
});

describe("createMockConfig 的 nodeIds", () => {
  it("按给定顺序绑定已登记的节点", () => {
    rememberMockNode({
      node_id: "n1",
      name: "东京 01",
      server: "10.0.0.1",
      port: 8388,
      method: "aes-256-gcm",
      protocol: "shadowsocks",
      source: "manual",
      created_at: 0,
    });
    const detail = createMockConfig("公司", "tun", { nodeIds: ["n1", "n2"] });

    expect(detail.nodes.map((node) => node.node_id)).toEqual(["n1", "n2"]);
    expect(detail.nodes[0]).toMatchObject({ server: "10.0.0.1", name: "东京 01" });
    expect(detail.node_count).toBe(2);
    expect(detail.current_node_id).toBe("n1");
  });
});
