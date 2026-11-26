import { describe, expect, it } from "vitest";
import {
  buildUiContext,
  isKnownControlId,
  staticControlsFor,
} from "./controlIds";
import type { UiControl } from "../agent/bridge";

describe("静态控件登记表", () => {
  it("按 contract 的 screen 返回对应控件", () => {
    expect(staticControlsFor("client").map((item) => item.id)).toEqual([
      "client.primary",
      "client.node_pick",
      "client.probe",
      "client.ask_ai",
    ]);
    expect(staticControlsFor("settings").map((item) => item.id)).toEqual([
      "settings.ai",
      "settings.connection",
      "settings.advanced",
    ]);
    expect(isKnownControlId("client.primary")).toBe(true);
    expect(isKnownControlId("client.unknown")).toBe(false);
  });

  it("label 用界面文案覆盖，超过 24 字截断", () => {
    const controls = staticControlsFor("client", {
      "client.primary": "重新连接",
      "client.node_pick": "这是一个特别特别长的节点名字需要被截断而且还要再长一些",
    });
    expect(controls[0].label).toBe("重新连接");
    expect(controls[1].label.length).toBe(24);
  });

  it("暂时不可点的控件整条剔除，对应的 last_action 也不上报", () => {
    const context = buildUiContext({
      screen: "client",
      omitControls: ["client.probe"],
      lastAction: { id: "client.probe" },
    });
    expect(context.controls.some((item) => item.id === "client.probe")).toBe(false);
    expect(context.last_action).toBeNull();
  });
});

describe("buildUiContext", () => {
  const actionControls: UiControl[] = [
    { id: "go_on", label: "继续", kind: "button" },
  ];

  it("合并静态与 action_card 控件，last_action 必须命中同一份 controls", () => {
    const context = buildUiContext({
      screen: "client",
      actionControls,
      lastAction: { id: "go_on", value: "n_1" },
    });
    expect(context.controls.map((item) => item.id)).toContain("go_on");
    expect(context.last_action).toEqual({ id: "go_on", value: "n_1" });
  });

  it("未知 last_action 或非法 value 按 null / 省略处理", () => {
    const unknown = buildUiContext({
      screen: "client",
      lastAction: { id: "nope" },
    });
    expect(unknown.last_action).toBeNull();

    const badValue = buildUiContext({
      screen: "client",
      lastAction: { id: "client.primary", value: "带有 空格" },
    });
    expect(badValue.last_action).toEqual({ id: "client.primary" });
  });

  it("最多 20 项，重复 id 只留第一份", () => {
    const many: UiControl[] = Array.from({ length: 30 }, (_, index) => ({
      id: `x_${index}`,
      label: `按钮 ${index}`,
      kind: "button",
    }));
    const context = buildUiContext({
      screen: "client",
      actionControls: [...actionControls, ...actionControls, ...many],
    });
    expect(context.controls.length).toBe(20);
    expect(
      context.controls.filter((item) => item.id === "go_on").length,
    ).toBe(1);
  });
});
