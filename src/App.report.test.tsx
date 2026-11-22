/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import type { LlmProvider } from "./agent/bridge";
import { AGENT_EVENTS, CONTRACT_VERSION } from "./agent/protocol";
import type { ConfigDetail, ConfigSummary } from "./agent/protocol";

const CONFIG_ID = "cfg_report";

const DETAIL: ConfigDetail = {
  config_id: CONFIG_ID,
  name: "浏览器",
  connect_mode: "system_proxy",
  routing_mode: "proxy_selected",
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
};

const SUMMARY: ConfigSummary = {
  config_id: DETAIL.config_id,
  name: DETAIL.name,
  connect_mode: DETAIL.connect_mode,
  routing_mode: DETAIL.routing_mode,
  node_count: DETAIL.node_count,
  listen_port: DETAIL.listen_port,
  is_active: true,
  current_node_id: DETAIL.current_node_id,
  created_at: 0,
  updated_at: 0,
  last_used_at: null,
};

const bridge = getAgentBridge();
const modeDescriptor = Object.getOwnPropertyDescriptor(bridge, "mode");
const widthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");

let aiConfigured = true;

function providers(): LlmProvider[] {
  if (!aiConfigured) return [];
  return [
    {
      providerId: "deepseek",
      name: "DeepSeek",
      protocol: "openai",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      hasKey: true,
      isActive: true,
      isBuiltin: true,
    },
  ];
}

beforeEach(() => {
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  aiConfigured = true;
  vi.spyOn(bridge, "configList").mockResolvedValue({
    configs: [SUMMARY],
    active_config_id: CONFIG_ID,
  });
  vi.spyOn(bridge, "configDetail").mockResolvedValue(DETAIL);
  vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
  vi.spyOn(bridge, "getDeepSeekKey").mockImplementation(async () =>
    aiConfigured
      ? { masked: "sk-****abcd", verified: true, validation: "ok" as const }
      : { masked: null, verified: false, validation: "unverified" as const },
  );
  vi.spyOn(bridge, "llmProviderList").mockImplementation(async () => ({
    providers: providers(),
    activeProviderId: providers().find((item) => item.isActive)?.providerId ?? null,
  }));
  vi.spyOn(bridge, "sendMessage").mockResolvedValue({ requestId: "req_report" });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  if (modeDescriptor) Object.defineProperty(bridge, "mode", modeDescriptor);
  if (widthDescriptor) {
    Object.defineProperty(window, "innerWidth", widthDescriptor);
  } else {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  }
});

describe("问题报告入口", () => {
  it("连点只开一次会话、发一条 hidden 开场，不产生用户气泡", async () => {
    // 报告入口只在失败态：先让连接报失败，再点。
    const gate = { resolve: (_value: unknown) => {} };
    vi.spyOn(bridge, "runtimeStart").mockImplementation(
      () => new Promise((resolve) => (gate.resolve = resolve)) as never,
    );
    render(<App />);
    await waitFor(() => expect(bridge.llmProviderList).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(await screen.findByRole("button", { name: "连接节点" }));
    await waitFor(() => expect(bridge.runtimeStart).toHaveBeenCalled());
    act(() => {
      (
        bridge as unknown as { emit: (event: unknown) => void }
      ).emit({
        name: AGENT_EVENTS.runtimeStateChanged,
        payload: {
          contract_version: CONTRACT_VERSION,
          from: "starting",
          to: "failed",
          event: "failed",
          pid: null,
          upstream_version: null,
          reason: null,
          error: null,
          snapshot: {
            state: "failed",
            config_id: null,
            last_transition_at: new Date(Date.now() + 1000).toISOString(),
          },
          emitted_at: new Date(Date.now() + 1000).toISOString(),
        },
      });
    });

    const button = await screen.findByRole("button", { name: "报告问题" });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledTimes(1));
    const call = (bridge.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toContain("请帮我整理一份问题报告");
    expect(call[2]).toMatchObject({ hidden: true });

    await act(async () => {});
    expect(bridge.sendMessage).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(".msg--user")).toHaveLength(0);
    expect(document.querySelector(".chat__disclosure")?.textContent).toBe(
      "报告只保存在你的电脑上；生成时，脱敏后的日志会发给你配置的 AI 服务。要不要把它发出去，由你决定。",
    );
  }, 15_000);

  it("AI 未配置时只显示首启页，报告入口不可达", async () => {
    aiConfigured = false;
    render(<App />);
    await waitFor(() => expect(bridge.llmProviderList).toHaveBeenCalled());

    expect(await screen.findByLabelText("DeepSeek API Key")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "报告问题" })).toBeNull();
    expect(screen.queryByRole("button", { name: "报告这个问题" })).toBeNull();
    expect(screen.queryByRole("button", { name: "设置" })).toBeNull();
  }, 15_000);
});
