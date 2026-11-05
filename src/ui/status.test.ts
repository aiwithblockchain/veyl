import { describe, expect, it } from "vitest";
import { consolePrimary } from "./status";

describe("consolePrimary", () => {
  it("过渡态与已连接各自的文案", () => {
    expect(consolePrimary("starting", true).label).toBe("正在启动…");
    expect(consolePrimary("stopping", true)).toMatchObject({
      label: "正在断开…",
      stop: true,
      disabled: true,
    });
    expect(consolePrimary("connected", true)).toMatchObject({
      label: "断开 VPN",
      stop: true,
    });
  });

  it("未连接时是启动 VPN，没节点就禁用", () => {
    expect(consolePrimary("idle", true)).toMatchObject({
      label: "启动 VPN",
      disabled: false,
      stop: false,
    });
    expect(consolePrimary("idle", false).disabled).toBe(true);
  });

  it("failed 归在 idle 里，但按钮要写重新连接", () => {
    expect(consolePrimary("idle", true, true)).toMatchObject({
      label: "重新连接",
      disabled: false,
      stop: false,
    });
    expect(consolePrimary("idle", false, true).disabled).toBe(true);
  });

  it("failed 标记不覆盖已连接与过渡态", () => {
    expect(consolePrimary("connected", true, true).label).toBe("断开 VPN");
    expect(consolePrimary("starting", true, true).label).toBe("正在启动…");
    expect(consolePrimary("stopping", true, true).label).toBe("正在断开…");
  });
});
