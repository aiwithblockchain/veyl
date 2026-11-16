/** @vitest-environment jsdom */
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

describe("config_set_mode 归一化", () => {
  it("透传正常返回", async () => {
    invoke.mockResolvedValueOnce({
      config_id: "cfg_1",
      mode: "tun",
      previous_mode: "system_proxy",
      changed: true,
      connected: true,
      restored: true,
      confirmation: "accepted",
    });
    const bridge = new TauriAgentBridge();

    await expect(
      bridge.configSetMode({ configId: "cfg_1", mode: "tun" }),
    ).resolves.toEqual({
      config_id: "cfg_1",
      mode: "tun",
      previous_mode: "system_proxy",
      changed: true,
      connected: true,
      restored: true,
      confirmation: "accepted",
    });
    expect(invoke).toHaveBeenCalledWith("config_set_mode", {
      configId: "cfg_1",
      mode: "tun",
    });
  });

  it("restored 缺字段时按 false，不猜成已恢复", async () => {
    invoke.mockResolvedValueOnce({
      config_id: "cfg_1",
      mode: "tun",
      previous_mode: "system_proxy",
      changed: true,
      connected: false,
    });
    const bridge = new TauriAgentBridge();

    const result = await bridge.configSetMode({ mode: "tun" });
    expect(result.restored).toBe(false);
    expect(invoke).toHaveBeenCalledWith("config_set_mode", { mode: "tun" });
  });
});
