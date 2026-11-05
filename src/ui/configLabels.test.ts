import { describe, expect, it } from "vitest";
import { levelLabel, modeSummary, scopeSummary } from "./configLabels";

const base = { connect_mode: "system_proxy" as const, routing_mode: "direct" as const };

describe("左栏级别提示词", () => {
  it("接管全部软件 / 本机代理 / 浏览器", () => {
    expect(levelLabel({ ...base, connect_mode: "tun" })).toBe("全部软件");
    expect(levelLabel({ ...base, routing_mode: "proxy_selected" })).toBe("本机代理");
    expect(levelLabel(base)).toBe("浏览器");
  });

  it("方式与范围随配置变化", () => {
    expect(modeSummary(base)).toEqual({ value: "浏览器代理", sub: "只影响浏览器" });
    expect(modeSummary({ ...base, connect_mode: "tun" })).toEqual({
      value: "接管全部软件",
      sub: "所有软件都走节点",
    });
    expect(scopeSummary({ ...base, routing_mode: "proxy_all" })).toEqual({
      value: "全部走节点",
      sub: "没有直连",
    });
    expect(scopeSummary({ ...base, routing_mode: "proxy_selected" })).toEqual({
      value: "指定服务走节点",
      sub: "其余直连",
    });
    expect(scopeSummary(base)).toEqual({ value: "本地网站直连", sub: "其它走节点" });
  });
});
