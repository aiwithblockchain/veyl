/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { MockAgentBridge } from "./mockAgent";
import { MOCK_CONFIG_STORAGE_KEY, createMockConfig } from "../config/model";

afterEach(() => {
  localStorage.clear();
});

function seedConfig() {
  const detail = createMockConfig("测试", "system_proxy");
  localStorage.setItem(
    MOCK_CONFIG_STORAGE_KEY,
    JSON.stringify({ configs: [detail], activeId: detail.config_id }),
  );
  return detail;
}

describe("mock configSetMode", () => {
  it("未连接时只写库，不模拟停起", async () => {
    const detail = seedConfig();
    const bridge = new MockAgentBridge();

    const result = await bridge.configSetMode({
      configId: detail.config_id,
      mode: "tun",
    });

    expect(result).toMatchObject({
      config_id: detail.config_id,
      mode: "tun",
      previous_mode: "system_proxy",
      changed: true,
      connected: false,
      restored: true,
      confirmation: "not_needed",
    });
    const stored = JSON.parse(
      localStorage.getItem(MOCK_CONFIG_STORAGE_KEY) ?? "{}",
    ) as { configs: Array<{ connect_mode: string }> };
    expect(stored.configs[0].connect_mode).toBe("tun");
  });

  it("方式相同时不停连接", async () => {
    const detail = seedConfig();
    const bridge = new MockAgentBridge();

    const result = await bridge.configSetMode({
      configId: detail.config_id,
      mode: "system_proxy",
    });

    expect(result).toMatchObject({
      changed: false,
      connected: false,
      confirmation: "not_needed",
    });
  });

  it("找不到配置时报 config_unknown", async () => {
    const bridge = new MockAgentBridge();

    await expect(
      bridge.configSetMode({ configId: "cfg_missing", mode: "tun" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { reason: "config_unknown" },
    });
  });
});
