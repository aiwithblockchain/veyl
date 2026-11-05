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

describe("networkForceReset 的命令映射", () => {
  it("调用 network_force_reset，并把 snake_case 与逐项状态归一", async () => {
    invoke.mockResolvedValueOnce({
      ok: false,
      verified: false,
      exit_ip: "198.51.100.9",
      steps: [
        { id: "stop_runtime", ok: true, detail: "代理模式已停止" },
        { id: "flush_dns", ok: false, detail: "刷新 DNS 失败" },
        { id: "verify", ok: true, detail: "部分项未通过", status: "skipped" },
        { id: "unknown_step" },
      ],
    });

    const bridge = new TauriAgentBridge();
    const result = await bridge.networkForceReset();

    expect(invoke).toHaveBeenCalledWith("network_force_reset", undefined);
    expect(result).toEqual({
      ok: false,
      verified: false,
      exitIp: "198.51.100.9",
      steps: [
        { id: "stop_runtime", ok: true, detail: "代理模式已停止", status: "ok" },
        { id: "flush_dns", ok: false, detail: "刷新 DNS 失败", status: "failed" },
        { id: "verify", ok: true, detail: "部分项未通过", status: "skipped" },
        { id: "unknown_step", ok: false, detail: "", status: "failed" },
      ],
    });
  });

  it("缺字段时按失败处理，不让界面误报成功", async () => {
    invoke.mockResolvedValueOnce({});
    const bridge = new TauriAgentBridge();
    await expect(bridge.networkForceReset()).resolves.toEqual({
      ok: false,
      verified: false,
      exitIp: null,
      steps: [],
    });
  });

  it("命令失败时抛 BridgeError，交给界面显示「没有开始」", async () => {
    invoke.mockRejectedValueOnce({
      code: "INTERNAL",
      message: "unknown command: network_force_reset",
    });
    const bridge = new TauriAgentBridge();
    await expect(bridge.networkForceReset()).rejects.toMatchObject({
      code: "INTERNAL",
      message: "unknown command: network_force_reset",
    });
  });
});
