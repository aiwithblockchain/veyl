/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { MockAgentBridge } from "./mockAgent";
import { MOCK_CONFIG_STORAGE_KEY } from "../config/model";

/** mock 通道不再预置节点；连接前先放一套带节点的配置。 */
function seedConfig() {
  localStorage.setItem(
    MOCK_CONFIG_STORAGE_KEY,
    JSON.stringify({
      configs: [
        {
          config_id: "cfg_1",
          name: "测试配置",
          connect_mode: "system_proxy",
          routing_mode: "proxy_all",
          node_count: 1,
          listen_port: 7890,
          is_active: true,
          current_node_id: "node_1",
          created_at: 0,
          updated_at: 0,
          last_used_at: null,
          nodes: [
            {
              node_id: "node_1",
              name: "节点 1",
              server: "127.0.0.1",
              port: 8388,
              method: "aes-256-gcm",
              protocol: "shadowsocks",
              source: "manual",
              created_at: 0,
            },
          ],
          dns: { mode: "auto", local: [], remote: [] },
          tun_excludes: [],
          layout: null,
          layout_revision: null,
        },
      ],
      activeId: "cfg_1",
    }),
  );
}

afterEach(() => {
  localStorage.clear();
});

describe("mock 本地代理端口", () => {
  it("没设置过时返回 7890", async () => {
    const bridge = new MockAgentBridge();
    await expect(bridge.proxyPortGet()).resolves.toEqual({
      port: 7890,
      defaultPort: 7890,
    });
  });

  it("保存后读回同一个值", async () => {
    const bridge = new MockAgentBridge();
    await expect(bridge.proxyPortSet(8080)).resolves.toEqual({
      port: 8080,
      availability: "free",
    });
    await expect(bridge.proxyPortGet()).resolves.toMatchObject({ port: 8080 });
  });

  it("非法端口直接拒绝", async () => {
    const bridge = new MockAgentBridge();
    await expect(bridge.proxyPortSet(0)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(bridge.proxyPortSet(70000)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(bridge.proxyPortSet(12.5 as unknown as number)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("演示开关可造出被占用状态", async () => {
    localStorage.setItem("veyl.mock.proxyPort.occupied", "1");
    const bridge = new MockAgentBridge();
    await expect(bridge.proxyPortSet(7890)).resolves.toEqual({
      port: 7890,
      availability: "occupied",
    });
  });

  it("演示开关可造出低端口不可用", async () => {
    localStorage.setItem("veyl.mock.proxyPort.unavailable", "1");
    const bridge = new MockAgentBridge();
    await expect(bridge.proxyPortSet(80)).resolves.toEqual({
      port: 80,
      availability: "unavailable",
    });
  });

  it("连接时可用演示开关造出降级", async () => {
    seedConfig();
    localStorage.setItem("veyl.mock.proxyPort", "7900");
    localStorage.setItem("veyl.mock.portFallback", "1");
    const bridge = new MockAgentBridge();
    await bridge.runtimeStart();
    const snapshot = await bridge.getRuntimeSnapshot();
    expect(snapshot?.mixed_port).toBe(7901);
    expect(snapshot?.port_fallback).toEqual({
      requested: 7900,
      actual: 7901,
      reason: "occupied",
    });
    bridge.dispose();
  });

  it("连接时演示开关可造出低端口不可用", async () => {
    seedConfig();
    localStorage.setItem("veyl.mock.proxyPort", "80");
    localStorage.setItem("veyl.mock.portFallback", "unavailable");
    const bridge = new MockAgentBridge();
    await bridge.runtimeStart();
    const snapshot = await bridge.getRuntimeSnapshot();
    expect(snapshot?.mixed_port).toBe(7890);
    expect(snapshot?.port_fallback).toEqual({
      requested: 80,
      actual: 7890,
      reason: "unavailable",
    });
    bridge.dispose();
  });
});
