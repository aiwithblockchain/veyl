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

describe("新建配置用到的节点命令", () => {
  it("node_create 按契约传参并归一化返回值", async () => {
    invoke.mockResolvedValueOnce({
      node_id: "node_1",
      name: "东京",
      server: "203.0.113.9",
      port: 8388,
      method: "aes-256-gcm",
      protocol: "shadowsocks",
      source: "manual",
      created_at: 1,
    });
    const bridge = new TauriAgentBridge();
    const node = await bridge.nodeCreate({
      name: "东京",
      server: "203.0.113.9",
      port: 8388,
      method: "aes-256-gcm",
      password: "secret",
    });

    expect(invoke).toHaveBeenCalledWith("node_create", {
      name: "东京",
      server: "203.0.113.9",
      port: 8388,
      method: "aes-256-gcm",
      password: "secret",
    });
    expect(node.node_id).toBe("node_1");
    expect(node.source).toBe("manual");
  });

  it("node_import_text 的 skipped 归一到已知原因", async () => {
    invoke.mockResolvedValueOnce({
      imported: 1,
      skipped: [
        { name: "坏的", reason: "unsupported_scheme" },
        { name: null, reason: "something_new" },
      ],
      nodes: [
        {
          node_id: "n1",
          name: "好的",
          server: "203.0.113.9",
          port: 8388,
          method: "aes-256-gcm",
          protocol: "shadowsocks",
          source: "manual",
          created_at: 1,
        },
      ],
    });
    const bridge = new TauriAgentBridge();
    const result = await bridge.nodeImportText("ss://a");

    expect(invoke).toHaveBeenCalledWith("node_import_text", { text: "ss://a" });
    expect(result.imported).toBe(1);
    expect(result.nodes).toHaveLength(1);
    expect(result.skipped).toEqual([
      { name: "坏的", reason: "unsupported_scheme" },
      { name: null, reason: "malformed" },
    ]);
  });

  it("node_import_url 带上 configId", async () => {
    invoke.mockResolvedValueOnce({ imported: 0, skipped: [], nodes: [] });
    const bridge = new TauriAgentBridge();
    await bridge.nodeImportUrl("https://example.com/sub", "config_1");
    expect(invoke).toHaveBeenCalledWith("node_import_url", {
      url: "https://example.com/sub",
      configId: "config_1",
    });
  });

  it("category_list 过滤掉没有 id 的项", async () => {
    invoke.mockResolvedValueOnce({
      categories: [
        {
          id: "chatgpt",
          name_zh: "ChatGPT",
          name_en: "ChatGPT",
          description: "",
          item_count: 1,
          rule_sets: ["openai"],
          dns_classifiable: true,
        },
        { name_zh: "没有 id" },
      ],
      total: 2,
    });
    const bridge = new TauriAgentBridge();
    const result = await bridge.categoryList();
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].id).toBe("chatgpt");
    expect(result.total).toBe(2);
  });

  it("system_region：地区取小写 cc，并带 source", async () => {
    const bridge = new TauriAgentBridge();
    invoke.mockResolvedValueOnce({ region: "CN", source: "ai" });
    await expect(bridge.systemRegion()).resolves.toEqual({ region: "cn", source: "ai" });
    invoke.mockResolvedValueOnce({ region: null });
    await expect(bridge.systemRegion()).resolves.toEqual({ region: null, source: "system" });
    invoke.mockResolvedValueOnce({});
    await expect(bridge.systemRegion()).resolves.toEqual({ region: null, source: "system" });
  });

  it("route_get / route_set_mode：归一化模式与热切标记", async () => {
    const bridge = new TauriAgentBridge();
    invoke.mockResolvedValueOnce({
      config_id: "cfg_1",
      routing_mode: "direct",
      applied_mode: null,
      targets: [],
      custom_rules: [],
      route_revision: 2,
      applied_revision: null,
      effective: "next_connection",
      reconnect_required: false,
      local_direct_basis: "domain_and_ip",
      detected_region: "CN",
      applied_region: null,
    });
    await expect(bridge.routeGet("cfg_1")).resolves.toMatchObject({
      routing_mode: "direct",
      detected_region: "cn",
      applied_mode: null,
    });

    invoke.mockResolvedValueOnce({
      config_id: "cfg_1",
      routing_mode: "proxy_all",
      applied_mode: "proxy_all",
      targets: [],
      custom_rules: [],
      route_revision: 3,
      applied_revision: 3,
      effective: "current_connection",
      reconnect_required: false,
      local_direct_basis: "domain_and_ip",
      detected_region: "cn",
      applied_region: "cn",
      hot_switched: true,
      reconnect: null,
    });
    const result = await bridge.routeSetMode("proxy_all", "cfg_1");
    expect(result).toMatchObject({
      routing_mode: "proxy_all",
      hot_switched: true,
      reconnect: "not_running",
      effective: "current_connection",
    });
  });
});
