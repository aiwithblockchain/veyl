import { describe, expect, it } from "vitest";
import {
  createMockConfig,
  nameTaken,
  nextConfigName,
  portLabel,
  summarizeConfig,
  uniqueConfigName,
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
  it("接管全部不使用本地代理端口，仍显示自动", () => {
    expect(portLabel({ connect_mode: "tun" }, 8080)).toBe("自动");
  });

  it("本机代理显示设置里的端口，与 listen_port 无关", () => {
    expect(portLabel({ connect_mode: "system_proxy" }, 8080)).toBe("8080");
  });

  it("没有传设置值时用默认端口", () => {
    expect(portLabel({ connect_mode: "system_proxy" })).toBe("7890");
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
