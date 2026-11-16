/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import type { ConfigSummary } from "./agent/protocol";
import { persistGroups } from "./groups/mockGroups";
import type { NodeGroup } from "./groups/mockGroups";

const CONFIG_ID = "cfg_1";

const SUMMARY: ConfigSummary = {
  config_id: CONFIG_ID,
  name: "全部流量",
  connect_mode: "tun",
  routing_mode: "proxy_all",
  node_count: 1,
  listen_port: null,
  is_active: true,
  current_node_id: "node_1",
  created_at: 0,
  updated_at: 0,
  last_used_at: null,
};

const bridge = getAgentBridge();
const modeDescriptor = Object.getOwnPropertyDescriptor(bridge, "mode");

const MINE: NodeGroup = {
  group_id: "grp_mine",
  name: "我的节点",
  read_only: false,
  nodes: [
    {
      node_id: "n1",
      name: "东京 01",
      server: "45.76.20.100",
      port: 8388,
      protocol: "ss",
      latency_ms: 63,
    },
  ],
};

const FREE: NodeGroup = {
  group_id: "grp_free",
  name: "Veyl 免费节点",
  read_only: true,
  nodes: [],
};

function prepare() {
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  vi.spyOn(bridge, "getDeepSeekKey").mockResolvedValue({
    masked: "sk-****abcd",
    verified: true,
    validation: "ok",
  });
  vi.spyOn(bridge, "configList").mockResolvedValue({
    configs: [SUMMARY],
    active_config_id: CONFIG_ID,
  });
  vi.spyOn(bridge, "configDetail").mockResolvedValue({
    config_id: CONFIG_ID,
    name: SUMMARY.name,
    connect_mode: "tun",
    routing_mode: "proxy_all",
    node_count: 1,
    listen_port: null,
    is_active: true,
    current_node_id: "node_1",
    created_at: 0,
    updated_at: 0,
    last_used_at: null,
    nodes: [
      {
        node_id: "node_1",
        name: "东京 01",
        server: "203.0.113.1",
        port: 8388,
        method: "aes-128-gcm",
        protocol: "shadowsocks",
        source: "seed",
        created_at: 0,
      },
    ],
    dns: { mode: "auto", local: [], remote: [] },
    tun_excludes: [],
    layout: null,
    layout_revision: null,
  });
  vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
  vi.spyOn(bridge, "tunHelperInfo").mockResolvedValue({
    runningBuild: null,
    expectedBuild: "2026.11.1",
    stale: false,
    state: "not_running",
    needsAdminRestart: false,
  } as never);
  vi.spyOn(bridge, "myServerCatalog").mockResolvedValue({
    regions: [{ id: "sgp1", name: "新加坡 1", continent: "asia" }],
    plans: [],
    currency: "USD",
    updated_at: new Date(0).toISOString(),
  });
  vi.spyOn(bridge, "myServerList").mockResolvedValue({ servers: [] });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  if (modeDescriptor) Object.defineProperty(bridge, "mode", modeDescriptor);
});

describe("节点组 destination", () => {
  it("没有节点组时是诚实空态：不显示组，也没有新建入口", async () => {
    prepare();
    render(<App />);
    await screen.findByRole("button", { name: "启动 VPN" });

    expect(document.querySelector(".node-card__group")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "节点组" }));
    expect(await screen.findByText("节点组尚未接入")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新建组" })).toBeNull();
    expect(
      screen.getByRole("complementary", { name: "节点组列表" }),
    ).toBeTruthy();
  });

  it("已有节点组只读展示：控制台「组 · X」可跳到详情，没有写入口", async () => {
    persistGroups([MINE], MINE.group_id);
    prepare();
    render(<App />);
    await screen.findByRole("button", { name: "启动 VPN" });

    const link = await waitFor(() => {
      const el = document.querySelector(".node-card__group");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(link.textContent).toBe("组·我的节点");
    fireEvent.click(link);

    expect(await screen.findByRole("heading", { name: "我的节点" })).toBeTruthy();
    expect(screen.getByText("45.76.20.100:8388")).toBeTruthy();
    expect(screen.getByText("节点组尚未接入，暂时只能查看。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "添加节点" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除组" })).toBeNull();
  });

  it("左栏列出已有的免费组与自建组，点子项切换详情", async () => {
    persistGroups([FREE, MINE], FREE.group_id);
    prepare();
    render(<App />);
    await screen.findByRole("button", { name: "启动 VPN" });

    fireEvent.click(screen.getByRole("button", { name: "节点组" }));
    expect(await screen.findByRole("heading", { name: "Veyl 免费节点" })).toBeTruthy();
    expect(document.querySelector(".rail__count")?.textContent).toBe("2");

    fireEvent.click(await screen.findByRole("button", { name: /我的节点/ }));
    expect(await screen.findByRole("heading", { name: "我的节点" })).toBeTruthy();
  });
});
