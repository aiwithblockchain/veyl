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

describe("ai_cancel 的返回值", () => {
  it("取消成功返回 true", async () => {
    invoke.mockResolvedValueOnce({ cancelled: true });
    const bridge = new TauriAgentBridge();
    await expect(bridge.cancel("req_1")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("ai_cancel", { requestId: "req_1" });
  });

  it("请求已经不在了返回 false", async () => {
    invoke.mockResolvedValueOnce({ cancelled: false });
    const bridge = new TauriAgentBridge();
    await expect(bridge.cancel("req_1")).resolves.toBe(false);
  });

  it("旧后端没给字段：按 false（已经不在）处理", async () => {
    invoke.mockResolvedValueOnce({});
    const bridge = new TauriAgentBridge();
    await expect(bridge.cancel("req_1")).resolves.toBe(false);
  });
});
