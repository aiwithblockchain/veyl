/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import type { LlmProvider } from "./agent/bridge";
import { AGENT_EVENTS, CONTRACT_VERSION } from "./agent/protocol";
import type {
  AgentEvent,
  ConfigDetail,
  ConfigSummary,
  NodeSummary,
} from "./agent/protocol";

const CONFIG_ID = "cfg_proxy_ask";

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

const NODE2: NodeSummary = {
  node_id: "node_2",
  name: "大阪 02",
  server: "203.0.113.2",
  port: 8389,
  method: "aes-128-gcm",
  protocol: "shadowsocks",
  source: "manual",
  created_at: 0,
};

let providers: LlmProvider[] = [];

function providerList(): LlmProvider[] {
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
    {
      providerId: "openai",
      name: "OpenAI",
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o-mini",
      hasKey: true,
      isActive: false,
      isBuiltin: false,
    },
  ];
}

function emit(event: AgentEvent) {
  (bridge as unknown as { emit(event: AgentEvent): void }).emit(event);
}

beforeEach(() => {
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  // 宽屏才默认展开右栏，服务名才在 DOM 里。
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  localStorage.setItem("veyl.onboarding.skipped", "1");
  providers = providerList();
  vi.spyOn(bridge, "configList").mockResolvedValue({
    configs: [SUMMARY],
    active_config_id: CONFIG_ID,
  });
  vi.spyOn(bridge, "configDetail").mockResolvedValue(DETAIL);
  vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
  vi.spyOn(bridge, "getDeepSeekKey").mockResolvedValue({
    masked: "sk-****abcd",
    verified: true,
    validation: "ok",
  });
  vi.spyOn(bridge, "llmProviderList").mockImplementation(async () => ({
    providers,
    activeProviderId: providers.find((item) => item.isActive)?.providerId ?? null,
  }));
  vi.spyOn(bridge, "llmProviderActivate").mockImplementation(async (providerId: string) => {
    providers = providers.map((item) => ({
      ...item,
      isActive: item.providerId === providerId,
    }));
  });
  vi.spyOn(bridge, "sendMessage").mockResolvedValue({ requestId: "req_1" });
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

describe("设置 → 问 AI", () => {
  it("从连接 tab 问 AI 后，重新打开设置回到连接 tab", async () => {
    render(<App />);
    await waitFor(() => expect(bridge.getDeepSeekKey).toHaveBeenCalled());
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("tab", { name: "连接" }));
    expect(await screen.findByText("现在怎么连")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "问 AI" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText("现在怎么连")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "连接" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  }, 15_000);

  it("问 AI 走设置同一条关闭路径，右栏服务名立即刷新", async () => {
    render(<App />);
    await waitFor(() =>
      expect(document.querySelector(".ai-panel__model")?.textContent).toBe("DeepSeek"),
    );

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "设为当前" }));
    await waitFor(() =>
      expect(bridge.llmProviderActivate).toHaveBeenCalledWith("openai"),
    );

    fireEvent.click(screen.getByRole("tab", { name: "连接" }));
    fireEvent.click(await screen.findByRole("button", { name: "问 AI" }));

    await waitFor(() =>
      expect(document.querySelector(".ai-panel__model")?.textContent).toBe("OpenAI"),
    );
  }, 15_000);
});

describe("设置 → 添加节点", () => {
  it("导入落到当前配置，主界面节点数随之变化", async () => {
    let detail: ConfigDetail = DETAIL;
    vi.spyOn(bridge, "configDetail").mockImplementation(async () => detail);
    vi.spyOn(bridge, "nodeImportText").mockImplementation(async (text, configId) => {
      expect(text).toBe("ss://new");
      expect(configId).toBe(CONFIG_ID);
      detail = {
        ...detail,
        node_count: 2,
        nodes: [...detail.nodes, NODE2],
      };
      act(() => {
        emit({
          name: AGENT_EVENTS.nodeListChanged,
          payload: {
            contract_version: CONTRACT_VERSION,
            reason: "url_import",
            config_id: CONFIG_ID,
            node_count_total: 2,
            changed_node_ids: [NODE2.node_id],
            emitted_at: "",
          },
        });
      });
      return { imported: 1, skipped: [], nodes: [NODE2] };
    });

    render(<App />);
    await screen.findByText("东京 01");

    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("tab", { name: "连接" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加" }));

    const dialog = await screen.findByRole("dialog", { name: "添加节点" });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "节点链接或订阅地址" }),
      { target: { value: "ss://new" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));

    await waitFor(() =>
      expect(bridge.nodeImportText).toHaveBeenCalledWith("ss://new", CONFIG_ID),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));

    await waitFor(() => expect(screen.getByText("2 个节点")).toBeTruthy());
  }, 15_000);
});
