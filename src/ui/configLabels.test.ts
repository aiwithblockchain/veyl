import { describe, expect, it } from "vitest";
import { levelLabel, modeSummary, regionLabel } from "./configLabels";

const base = { connect_mode: "system_proxy" as const, routing_mode: "direct" as const };
const proxyAll = { connect_mode: "system_proxy" as const, routing_mode: "proxy_all" as const };
const selected = {
  connect_mode: "system_proxy" as const,
  routing_mode: "proxy_selected" as const,
};

describe("左栏接管方式标签", () => {
  it("只由 connect_mode 决定", () => {
    expect(levelLabel({ connect_mode: "tun" })).toBe("全部软件");
    expect(levelLabel({ connect_mode: "system_proxy" })).toBe("本机代理");
    // routing_mode 不再参与：切换流量范围不会让标签变来变去。
    expect(levelLabel(proxyAll)).toBe("本机代理");
    expect(levelLabel(selected)).toBe("本机代理");
  });

  it("方式读数也只描述接管范围", () => {
    expect(modeSummary(base)).toEqual({ value: "本机代理", sub: "需要手动填地址" });
    expect(modeSummary({ ...base, connect_mode: "tun" })).toEqual({
      value: "接管全部软件",
      sub: "所有软件都走节点",
    });
  });

  it("地区显示名：已知用中文，未知明确写未知", () => {
    expect(regionLabel("cn")).toBe("中国大陆");
    expect(regionLabel("jp")).toBe("日本");
    expect(regionLabel(null)).toBe("未知");
    expect(regionLabel("zz")).toBe("ZZ");
  });
});
