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

describe("设置 → 咨询 AI", () => {
  it("咨询时不关设置，助手并排；关闭后重开回到连接 tab", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(bridge.llmProviderList).toHaveBeenCalled());
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("tab", { name: "连接" }));
    expect(await screen.findByText("接管方式")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "咨询 AI" }));
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
    await waitFor(() =>
      expect(container.querySelector(".settings-assistant")).toBeTruthy(),
    );
    expect(container.querySelector(".assistant-slot")).toBeNull();
    expect(container.querySelector(".assistant-overlay")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "咨询 AI" }));
    await waitFor(() =>
      expect(container.querySelector(".settings-assistant")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull(),
    );

    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    expect(await screen.findByText("接管方式")).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "连接" }).getAttribute("aria-selected"),
    ).toBe("true");
  }, 15_000);

  it("咨询开场带上当前分区与这一区的事实", async () => {
    render(<App />);
    await waitFor(() => expect(bridge.llmProviderList).toHaveBeenCalled());
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("tab", { name: "连接" }));
    await screen.findByText("接管方式");

    fireEvent.click(screen.getByRole("button", { name: "咨询 AI" }));

    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalled());
    // 只发一条：咨询开场不会重复发。
    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledTimes(1));
    const call = (bridge.sendMessage as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(call[1]).toContain("我在 Veyl 的设置页，当前在「连接」分区");
    expect(call[1]).toContain("本地代理端口：");
    // 不再反问模块。
    expect(call[1]).not.toContain("想咨询哪个模块");
  }, 15_000);

  it("咨询开关来回切两次，输入框里的草稿还在", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(bridge.llmProviderList).toHaveBeenCalled());
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    const consult = await screen.findByRole("button", { name: "咨询 AI" });
    const textarea = () =>
      container.querySelector<HTMLTextAreaElement>(".settings-assistant textarea");

    fireEvent.click(consult);
    await waitFor(() => expect(textarea()).toBeTruthy());
    fireEvent.change(textarea()!, { target: { value: "草稿还在吗" } });
    expect(textarea()!.value).toBe("草稿还在吗");

    for (let round = 0; round < 2; round += 1) {
      fireEvent.click(consult);
      await waitFor(() =>
        expect(container.querySelector(".settings-assistant")).toBeNull(),
      );
      fireEvent.click(consult);
      await waitFor(() => expect(textarea()).toBeTruthy());
      expect(textarea()!.value).toBe("草稿还在吗");
    }
  }, 15_000);

  it("关闭设置后右栏服务名立即刷新", async () => {
    render(<App />);
    await waitFor(() =>
      expect(document.querySelector(".ai-panel__model")?.textContent).toBe("DeepSeek"),
    );

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "设为当前" }));
    await waitFor(() =>
      expect(bridge.llmProviderActivate).toHaveBeenCalledWith("openai"),
    );

    fireEvent.click(await screen.findByRole("button", { name: "关闭设置" }));

    await waitFor(() =>
      expect(document.querySelector(".ai-panel__model")?.textContent).toBe("OpenAI"),
    );
  }, 15_000);
});

describe("节点卡 → 添加节点", () => {
  it("导入落到当前配置，主界面节点数随之变化", async () => {
    let detail: ConfigDetail = DETAIL;
    vi.spyOn(bridge, "configDetail").mockImplementation(async () => detail);
    vi.spyOn(bridge, "nodeImportText").mockImplementation(async (text) => {
      expect(text).toBe("ss://new");
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
    await screen.findAllByText("东京 01");

    fireEvent.click(await screen.findByRole("button", { name: "添加节点" }));

    const dialog = await screen.findByRole("dialog", { name: "添加节点" });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "节点链接或订阅地址" }),
      { target: { value: "ss://new" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));

    await waitFor(() =>
      expect(bridge.nodeImportText).toHaveBeenCalledWith("ss://new"),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(screen.getByText("大阪 02")).toBeTruthy();
      const nodeCard = document.querySelector(
        ".stage-card:not(.stage-card--free)",
      );
      expect(
        nodeCard?.querySelector(".stage-card__sub")?.textContent,
      ).toContain("1 个节点");
    });
  }, 15_000);
});

describe("设置页 Esc 与输入法", () => {
  it("组合态的 Esc 不关闭设置，普通 Esc 才关", async () => {
    render(<App />);
    await waitFor(() => expect(bridge.llmProviderList).toHaveBeenCalled());
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: "设置" }));
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape", keyCode: 229 });
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();

    const composing = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composing, "isComposing", { value: true });
    window.dispatchEvent(composing);
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull(),
    );
  });
});

describe("settings-point（AI 指路）", () => {
  function point(
    section: "ai" | "connection" | "account" | "advanced",
    row: string | null,
  ) {
    act(() => {
      (
        bridge as unknown as {
          pointSettingsDemo: (
            section: "ai" | "connection" | "account" | "advanced",
            row: string | null,
          ) => void;
        }
      ).pointSettingsDemo(section, row);
    });
  }

  async function readyApp() {
    render(<App />);
    await waitFor(() => expect(bridge.llmProviderList).toHaveBeenCalled());
    await act(async () => {});
  }

  it("打开设置、切到对应段，并把行高亮 2 秒", async () => {
    await readyApp();
    point("connection", "connection.mode");

    await screen.findByRole("dialog", { name: "设置" });
    expect(
      screen.getByRole("tab", { name: "连接" }).getAttribute("aria-selected"),
    ).toBe("true");

    const row = document.querySelector('[data-point="connection.mode"]') as HTMLElement;
    expect(row).toBeTruthy();
    await waitFor(() => expect(row.getAttribute("data-pointed")).toBe("true"));
    await waitFor(() => expect(row.getAttribute("data-pointed")).toBeNull(), {
      timeout: 3000,
    });
  }, 15_000);

  it("指向账户时打开账户弹层，不打开设置，也不高亮任何行", async () => {
    await readyApp();
    point("account", null);

    await screen.findByRole("dialog", { name: "账户" });
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();
    expect(document.querySelector('[data-pointed="true"]')).toBeNull();
  }, 15_000);

  it("高级里的行会先展开折叠块再高亮", async () => {
    await readyApp();
    point("advanced", "advanced.logs");

    await screen.findByRole("dialog", { name: "设置" });
    const row = document.querySelector('[data-point="advanced.logs"]') as HTMLElement;
    await waitFor(() => expect(row.getAttribute("data-pointed")).toBe("true"));
    expect(row.closest("details")?.open).toBe(true);
  }, 15_000);
});

describe("余额刷新的门禁（App 接线）", () => {
  function prepareWallet() {
    vi.spyOn(bridge, "myServerAccount").mockResolvedValue({
      logged_in: true,
      email: "buyer@example.com",
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "email",
      session_expires_at: null,
    });
    vi.spyOn(bridge, "myServerIdentity").mockResolvedValue({
      has_identity: true,
      account_id: "acct_1",
    });
    vi.spyOn(bridge, "trialStatus").mockResolvedValue({
      state: "active",
      started_at: new Date(0).toISOString(),
      expires_at: new Date(7 * 86_400_000).toISOString(),
      remaining_ms: 7 * 86_400_000,
      seed_node_count: 1,
    });
    vi.spyOn(bridge, "myServerCatalog").mockResolvedValue({
      regions: [],
      plans: [],
      currency: "USD",
      updated_at: new Date(0).toISOString(),
    });
    vi.spyOn(bridge, "myServerList").mockResolvedValue({ servers: [] });
    return vi.spyOn(bridge, "myServerWallet").mockResolvedValue({
      balance_cents: 920,
      currency: "USD",
      denominations_cents: [1000],
      updated_at: new Date(0).toISOString(),
    });
  }

  it("账户弹层打开即刷新：30 秒内重开只发一次；「刷新」不受门禁", async () => {
    const wallet = prepareWallet();
    render(<App />);

    const avatar = await screen.findByRole("button", { name: /^账户，/ });
    fireEvent.click(avatar);
    await screen.findByRole("dialog", { name: "账户" });
    await waitFor(() => expect(wallet.mock.calls.length).toBe(1));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "账户" })).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^账户，/ }));
    await screen.findByRole("dialog", { name: "账户" });
    expect(wallet.mock.calls.length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(wallet.mock.calls.length).toBe(2));
  });

  it("收银台打开后：面板留着显示等待态，回窗口时补刷一次余额", async () => {
    const wallet = prepareWallet();
    vi.spyOn(bridge, "myServerTopup").mockResolvedValue({
      topup_id: "top_1",
      checkout_url: "https://pay.example.com/session/abc",
      denomination_cents: 1000,
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /^账户，/ }));
    fireEvent.click(await screen.findByRole("button", { name: "充值" }));
    fireEvent.click(await screen.findByRole("button", { name: "$10" }));

    // 面板不关、也不再弹 toast：就地换成等待态。
    expect(await screen.findByText("已在浏览器打开收付款页")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "账户" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "$10" })).toBeNull();

    const before = wallet.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(wallet.mock.calls.length).toBe(before + 1));

    // 余额没变：仍是等待态，不误报已到账。
    expect(screen.getByText("已在浏览器打开收付款页")).toBeTruthy();
    expect(screen.queryByText(/已到账/)).toBeNull();

    // 一次性：再回窗口不再补刷。
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(wallet.mock.calls.length).toBe(before + 1);
  });

});
