import { describe, expect, it } from "vitest";
import {
  createMockConfig,
  nameTaken,
  portLabel,
  summarizeConfig,
  uniqueConfigName,
} from "./model";

const named = (...names: string[]) => names.map((name) => ({ name }));

describe("uniqueConfigName", () => {
  it("没有重名时原样返回", () => {
    expect(uniqueConfigName("公司", named())).toBe("公司");
  });

  it("重名时追加 2", () => {
    expect(uniqueConfigName("公司", named("公司"))).toBe("公司 2");
  });

  it("连续重名继续递增", () => {
    expect(uniqueConfigName("公司", named("公司", "公司 2", "公司 3"))).toBe(
      "公司 4",
    );
  });
});

describe("nameTaken", () => {
  it("按 trim 后比较", () => {
    expect(nameTaken("  公司  ", named("公司"))).toBe(true);
  });

  it("不同名返回 false", () => {
    expect(nameTaken("家里", named("公司"))).toBe(false);
  });
});

describe("portLabel", () => {
  it("接管全部显示自动", () => {
    expect(portLabel({ connect_mode: "tun", listen_port: null })).toBe("自动");
  });

  it("本机代理但端口为空也显示自动", () => {
    expect(portLabel({ connect_mode: "system_proxy", listen_port: null })).toBe(
      "自动",
    );
  });

  it("本机代理显示实际端口", () => {
    expect(
      portLabel({ connect_mode: "system_proxy", listen_port: 7890 }),
    ).toBe("7890");
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
