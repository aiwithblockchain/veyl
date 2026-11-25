/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MOCK_CONFIG_STORAGE_KEY,
  createMockConfig,
} from "../config/model";
import { MockAgentBridge } from "./mockAgent";

let bridge: MockAgentBridge | null = null;

beforeEach(() => {
  bridge = new MockAgentBridge();
});

afterEach(() => {
  bridge?.dispose();
  bridge = null;
  localStorage.clear();
});

describe("浏览器演示用的节点命令", () => {
  it("粘贴文本逐行解析：好的进 nodes，坏的行进 skipped", async () => {
    const result = await bridge!.nodeImportText("ss://abc#东京\n不是链接\nss://def#大阪");
    expect(result.imported).toBe(2);
    expect(result.nodes.map((node) => node.name)).toEqual(["东京", "大阪"]);
    expect(result.skipped).toEqual([{ name: null, reason: "unsupported_scheme" }]);
  });

  it("一条都解析不出来时按 not_node_text 拒绝", async () => {
    await expect(bridge!.nodeImportText("hello")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "not_node_text" },
    });
  });

  it("订阅地址只接受 https，拉取失败走 fetch_failed", async () => {
    await expect(bridge!.nodeImportUrl("http://example.com/sub")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "insecure_url" },
    });
    await expect(bridge!.nodeImportUrl("https://example.com/fail")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      details: { reason: "fetch_failed" },
    });
    await expect(bridge!.nodeImportUrl("https://example.com/sub")).resolves.toMatchObject({
      imported: 2,
    });
  });

  it("手动节点返回五个字段的摘要", async () => {
    const node = await bridge!.nodeCreate({
      name: "东京",
      server: "203.0.113.9",
      port: 8388,
      method: "aes-256-gcm",
      password: "secret",
    });
    expect(node).toMatchObject({
      name: "东京",
      server: "203.0.113.9",
      port: 8388,
      method: "aes-256-gcm",
      protocol: "shadowsocks",
      source: "manual",
    });
  });

  it("移除当前节点会先结束连接，并回报 wasCurrent", async () => {
    const node = await bridge!.nodeCreate({
      name: "自建",
      server: "203.0.113.9",
      port: 8388,
      method: "aes-256-gcm",
      password: "secret",
    });
    const config = createMockConfig("本机", "system_proxy", {
      nodeIds: [node.node_id],
    });
    config.current_node_id = node.node_id;
    localStorage.setItem(
      MOCK_CONFIG_STORAGE_KEY,
      JSON.stringify({ configs: [config], activeId: config.config_id }),
    );

    await bridge!.runtimeStart(config.config_id);
    expect((await bridge!.getRuntimeSnapshot())?.state).not.toBe("idle");

    const result = await bridge!.nodeRemove({ nodeId: node.node_id });

    expect(result).toEqual({ removed: true, wasCurrent: true });
    expect((await bridge!.getRuntimeSnapshot())?.state).toBe("idle");
  });

  it("编辑手动节点：改名与参数写回，改的是正在用的节点会先断开", async () => {
    const node = await bridge!.nodeCreate({
      name: "旧名",
      server: "203.0.113.9",
      port: 8388,
      method: "aes-256-gcm",
      password: "secret",
    });
    const config = createMockConfig("本机", "system_proxy", {
      nodeIds: [node.node_id],
    });
    config.current_node_id = node.node_id;
    localStorage.setItem(
      MOCK_CONFIG_STORAGE_KEY,
      JSON.stringify({ configs: [config], activeId: config.config_id }),
    );
    await bridge!.runtimeStart(config.config_id);

    const result = await bridge!.nodeUpdate({
      nodeId: node.node_id,
      name: "新名",
      server: "198.51.100.7",
      port: 9000,
      method: "chacha20-ietf-poly1305",
      password: "new-secret",
    });

    expect(result).toMatchObject({
      updated: true,
      wasCurrent: true,
      disconnected: true,
      paramsChanged: true,
      rebuilt: false,
      rebuildStatus: null,
      message: null,
    });
    expect((await bridge!.getRuntimeSnapshot())?.state).toBe("idle");
    const store = JSON.parse(
      localStorage.getItem(MOCK_CONFIG_STORAGE_KEY) as string,
    ) as { configs: { nodes: { node_id: string; name: string; server: string; port: number }[] }[] };
    const stored = store.configs[0].nodes[0];
    expect(stored).toMatchObject({
      node_id: node.node_id,
      name: "新名",
      server: "198.51.100.7",
      port: 9000,
    });
  });

  it("订阅节点只允许改名：带连接参数直接拒绝", async () => {
    const node = await bridge!.nodeCreate({
      name: "订阅 01",
      server: "203.0.113.9",
      port: 8388,
      method: "aes-256-gcm",
      password: "secret",
    });
    const config = createMockConfig("本机", "system_proxy", {
      nodeIds: [node.node_id],
    });
    config.nodes = config.nodes.map((item) => ({ ...item, source: "url" as const }));
    localStorage.setItem(
      MOCK_CONFIG_STORAGE_KEY,
      JSON.stringify({ configs: [config], activeId: config.config_id }),
    );

    await expect(
      bridge!.nodeUpdate({
        nodeId: node.node_id,
        name: "订阅 01",
        server: "198.51.100.8",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      details: { reason: "subscription_params_readonly" },
    });

    await expect(
      bridge!.nodeUpdate({ nodeId: node.node_id, name: "我的订阅" }),
    ).resolves.toMatchObject({ updated: true, paramsChanged: false });
  });

  it("服务目录可搜索", async () => {
    const all = await bridge!.categoryList();
    expect(all.categories.length).toBeGreaterThan(3);
    const filtered = await bridge!.categoryList("chat");
    expect(filtered.categories.map((category) => category.id)).toEqual(["chatgpt"]);
  });

  it("地区默认中国大陆，可用 localStorage 演示未知", async () => {
    await expect(bridge!.systemRegion()).resolves.toEqual({ region: "cn", source: "system" });
    localStorage.setItem("veyl.mock.region", "unknown");
    await expect(bridge!.systemRegion()).resolves.toEqual({ region: null, source: "system" });
    localStorage.setItem("veyl.mock.region", "JP");
    await expect(bridge!.systemRegion()).resolves.toEqual({ region: "jp", source: "system" });
    localStorage.setItem("veyl.mock.regionSource", "ai");
    await expect(bridge!.systemRegion()).resolves.toEqual({ region: "jp", source: "ai" });
  });

  it("route_get / route_set_mode：未连接只写库，返回 next_connection", async () => {
    localStorage.setItem(
      "veyl.configs.mock.v1",
      JSON.stringify({
        activeId: "cfg_1",
        configs: [
          {
            config_id: "cfg_1",
            name: "配置 1",
            connect_mode: "tun",
            routing_mode: "direct",
            node_count: 1,
            listen_port: null,
            is_active: true,
            current_node_id: "n1",
            created_at: 1,
            updated_at: 1,
            last_used_at: null,
            nodes: [],
          },
        ],
      }),
    );
    const state = await bridge!.routeGet("cfg_1");
    expect(state).toMatchObject({
      config_id: "cfg_1",
      routing_mode: "direct",
      effective: "next_connection",
      detected_region: "cn",
      local_direct_basis: "domain_and_ip",
    });

    const result = await bridge!.routeSetMode("proxy_all", "cfg_1");
    expect(result).toMatchObject({
      routing_mode: "proxy_all",
      hot_switched: false,
      reconnect: "not_running",
      effective: "next_connection",
    });
    expect((await bridge!.routeGet("cfg_1")).routing_mode).toBe("proxy_all");
    const stored = JSON.parse(localStorage.getItem("veyl.configs.mock.v1") ?? "{}");
    expect(stored.configs[0].routing_mode).toBe("proxy_all");
  });
});
