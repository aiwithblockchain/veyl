import { describe, expect, it } from "vitest";
import { createMockConfig, nextConfigName, summarizeConfig } from "./model";

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
