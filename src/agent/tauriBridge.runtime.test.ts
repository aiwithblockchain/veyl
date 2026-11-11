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

describe("runtime_status 的系统 DNS 状态", () => {
  it("tunnel / unchanged 原样透传", async () => {
    invoke.mockResolvedValueOnce({ system_dns: "tunnel" });
    const bridge = new TauriAgentBridge();
    expect((await bridge.getRuntimeSnapshot())?.system_dns).toBe("tunnel");

    invoke.mockResolvedValueOnce({ system_dns: "unchanged" });
    expect((await bridge.getRuntimeSnapshot())?.system_dns).toBe("unchanged");
  });

  it("旧后端缺字段或未知值：归一为 null，不猜", async () => {
    invoke.mockResolvedValueOnce({});
    const bridge = new TauriAgentBridge();
    expect((await bridge.getRuntimeSnapshot())?.system_dns).toBeNull();

    invoke.mockResolvedValueOnce({ system_dns: "weird" });
    expect((await bridge.getRuntimeSnapshot())?.system_dns).toBeNull();
  });
});
