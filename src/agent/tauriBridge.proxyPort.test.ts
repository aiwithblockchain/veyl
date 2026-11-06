import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { TauriAgentBridge } from "./tauriBridge";

beforeEach(() => {
  invoke.mockReset();
});

describe("本地代理端口", () => {
  it("读设置：透传端口与后端常量默认值，不带占用状态", async () => {
    invoke.mockResolvedValueOnce({ port: 8080, default_port: 7890 });
    const bridge = new TauriAgentBridge();
    await expect(bridge.proxyPortGet()).resolves.toEqual({
      port: 8080,
      defaultPort: 7890,
    });
    expect(invoke).toHaveBeenCalledWith("proxy_port_get", undefined);
  });

  it("旧后端缺字段：端口与默认值都回落 7890", async () => {
    invoke.mockResolvedValueOnce({});
    const bridge = new TauriAgentBridge();
    await expect(bridge.proxyPortGet()).resolves.toEqual({
      port: 7890,
      defaultPort: 7890,
    });
  });

  it("保存时后端没回端口：用提交的值", async () => {
    invoke.mockResolvedValueOnce({});
    const bridge = new TauriAgentBridge();
    await expect(bridge.proxyPortSet(8081)).resolves.toEqual({
      port: 8081,
      availability: "free",
    });
    expect(invoke).toHaveBeenCalledWith("proxy_port_set", { port: 8081 });
  });

  it("保存结果三态原样透传", async () => {
    invoke.mockResolvedValueOnce({ port: 7890, availability: "occupied" });
    const bridge = new TauriAgentBridge();
    await expect(bridge.proxyPortSet(7890)).resolves.toEqual({
      port: 7890,
      availability: "occupied",
    });
  });

  it("认不出的可用性按 free 处理，不猜", async () => {
    invoke.mockResolvedValueOnce({ port: 7890, availability: "weird" });
    const bridge = new TauriAgentBridge();
    await expect(bridge.proxyPortSet(7890)).resolves.toEqual({
      port: 7890,
      availability: "free",
    });
  });
});

describe("端口的运行时回退信息", () => {
  it("快照带 port_fallback 时透传端口与原因", async () => {
    invoke.mockResolvedValueOnce({
      state: "running",
      port_fallback: { requested: 7890, actual: 7891, reason: "occupied" },
    });
    const bridge = new TauriAgentBridge();
    const snapshot = await bridge.getRuntimeSnapshot();
    expect(snapshot?.port_fallback).toEqual({
      requested: 7890,
      actual: 7891,
      reason: "occupied",
    });
  });

  it("认不出的原因不显示说明", async () => {
    invoke.mockResolvedValueOnce({
      state: "running",
      port_fallback: { requested: 7890, actual: 7891, reason: "weird" },
    });
    const bridge = new TauriAgentBridge();
    const snapshot = await bridge.getRuntimeSnapshot();
    expect(snapshot?.port_fallback).toBeNull();
  });

  it("旧后端没有该字段：归一成 null", async () => {
    invoke.mockResolvedValueOnce({ state: "running" });
    const bridge = new TauriAgentBridge();
    const snapshot = await bridge.getRuntimeSnapshot();
    expect(snapshot?.port_fallback).toBeNull();
  });

  it("字段形状不对：按没有降级处理", async () => {
    invoke.mockResolvedValueOnce({ state: "running", port_fallback: { requested: "x" } });
    const bridge = new TauriAgentBridge();
    const snapshot = await bridge.getRuntimeSnapshot();
    expect(snapshot?.port_fallback).toBeNull();
  });
});
