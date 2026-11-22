/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import type { LlmProvider, MyServer } from "./agent/bridge";
import { AGENT_EVENTS, CONTRACT_VERSION } from "./agent/protocol";
import type { ConfigDetail, ConfigSummary } from "./agent/protocol";

const CONFIG_ID = "cfg_ai_optional";
const SKIP_KEY = "veyl.onboarding.skipped";

const DETAIL: ConfigDetail = {
  config_id: CONFIG_ID,
  name: "浏览器",
  connect_mode: "tun",
  routing_mode: "direct",
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

let aiConfigured = false;

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

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
}

beforeEach(() => {
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  setWidth(1440);
  aiConfigured = false;
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
  vi.spyOn(bridge, "sendMessage").mockResolvedValue({ requestId: "req_ai_optional" });
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

async function waitForShell() {
  await waitFor(() => expect(document.querySelector(".app")).not.toBeNull());
}

function seedSkipped() {
  localStorage.setItem(SKIP_KEY, "1");
}

describe("首启跳过", () => {
  it("点「我懂网络，不用 AI」进主界面，不发开场词；重启不再弹首启", async () => {
    const send = vi.mocked(bridge.sendMessage);
    const { unmount } = render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "我懂网络，不用 AI" }),
    );
    await waitForShell();

    expect(localStorage.getItem(SKIP_KEY)).toBe("1");
    expect(send).not.toHaveBeenCalled();

    unmount();
    render(<App />);
    await waitForShell();
    expect(screen.queryByLabelText("DeepSeek API Key")).toBeNull();
  }, 15_000);

  it("重启后读标记，不再弹首启", async () => {
    seedSkipped();
    render(<App />);
    await waitForShell();
    expect(screen.queryByLabelText("DeepSeek API Key")).toBeNull();
  }, 15_000);
});

describe("未配置 AI 的右栏", () => {
  it("点开右栏只看到配置引导，不弹告警；「配置 AI」落设置 › AI", async () => {
    seedSkipped();
    setWidth(1024);
    render(<App />);
    await waitForShell();

    fireEvent.click(await screen.findByRole("button", { name: "展开助手" }));

    expect(await screen.findByText("还没有配置 AI 服务")).toBeTruthy();
    expect(screen.getByRole("button", { name: "配置 AI" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "还没有配置 AI 服务" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "配置 AI" }));
    expect(await screen.findByRole("dialog", { name: "设置" })).toBeTruthy();
    expect(
      screen.getByText("AI 助手用这里的服务回答你；换服务或换模型都在这里。"),
    ).toBeTruthy();
  }, 15_000);

  it("配置成功后右栏恢复输入框并自动展开一次", async () => {
    seedSkipped();
    setWidth(1024);
    render(<App />);
    await waitForShell();

    // 窄屏默认收起，用户没有手动关过。
    expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy();

    aiConfigured = true;
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "关闭设置" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "展开助手" })).toBeNull(),
    );
    expect(screen.getByRole("textbox")).toBeTruthy();
  }, 15_000);

  it("关闭右栏后重启保持关闭", async () => {
    seedSkipped();
    render(<App />);
    await waitForShell();

    fireEvent.click(screen.getByRole("button", { name: "收起助手" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy(),
    );

    cleanup();
    render(<App />);
    await waitForShell();
    expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy();
  }, 15_000);
});

describe("未配置 AI 的动作入口", () => {
  it("建机向导「让 AI 帮我选」被拦：告警、无消息、面板不展开、向导不前进", async () => {
    seedSkipped();
    vi.mocked(bridge.configList).mockResolvedValue({
      configs: [],
      active_config_id: null,
    });
    render(<App />);
    await waitForShell();
    fireEvent.click(screen.getByRole("button", { name: "收起助手" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy(),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /新建节点/ }),
    );
    await screen.findByRole("heading", { name: "新建节点" });
    fireEvent.click(screen.getByRole("button", { name: "让 AI 帮我选" }));

    expect(
      await screen.findByRole("dialog", { name: "还没有配置 AI 服务" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "还没有配置 AI 服务" }),
      ).toBeNull(),
    );

    expect(vi.mocked(bridge.sendMessage)).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy();
    // 还停在向导同一屏。
    expect(screen.getByRole("heading", { name: "新建节点" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "让 AI 帮我选" })).toBeTruthy();
  }, 15_000);

  it("报告问题被拦：告警，取消后不建会话、不调 AI", async () => {
    seedSkipped();
    render(<App />);
    await waitForShell();
    fireEvent.click(screen.getByRole("button", { name: "收起助手" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy(),
    );
    await failConnection();

    fireEvent.click(screen.getByRole("button", { name: "报告问题" }));
    expect(
      await screen.findByRole("dialog", { name: "还没有配置 AI 服务" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "还没有配置 AI 服务" }),
      ).toBeNull(),
    );

    expect(vi.mocked(bridge.sendMessage)).not.toHaveBeenCalled();
    // 没有建报告会话，也没有展开右栏。
    expect(document.querySelector(".chat__disclosure")).toBeNull();
    expect(document.querySelectorAll(".msg--user")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy();
  }, 15_000);

  it("连接、测速、建机照常可用", async () => {
    seedSkipped();
    render(<App />);
    await waitForShell();

    expect(screen.getByRole("button", { name: "测速" })).toBeTruthy();

    // 建机入口在服务器页左栏，未配置 AI 也能打开向导。
    fireEvent.click(screen.getByRole("button", { name: "我的服务器" }));
    const newNode = await screen.findAllByRole("button", { name: "新建节点" });
    expect(newNode.length).toBeGreaterThan(0);
    fireEvent.click(newNode[0]);
    expect(
      await screen.findByRole("heading", { name: "新建节点" }),
    ).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "新建节点" })).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    const start = vi.spyOn(bridge, "runtimeStart").mockImplementation(
      () => new Promise(() => {}) as never,
    );
    fireEvent.click(await screen.findByRole("button", { name: "连接节点" }));
    await waitFor(() => expect(start).toHaveBeenCalled());
  }, 15_000);

  it("「问 AI」弹统一告警：取消后不建会话、不进设置、面板不展开", async () => {
    seedSkipped();
    render(<App />);
    await waitForShell();
    fireEvent.click(screen.getByRole("button", { name: "收起助手" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy(),
    );

    const send = vi.mocked(bridge.sendMessage);
    fireEvent.click(screen.getByRole("button", { name: "问 AI" }));

    expect(
      await screen.findByRole("dialog", { name: "还没有配置 AI 服务" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "还没有配置 AI 服务" }),
      ).toBeNull(),
    );
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();
    expect(send).not.toHaveBeenCalled();
    // 右栏仍是收起的 tab：没有输入框，也没有被塞进一个空会话。
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy();

    // Esc 同样只关闭告警。
    fireEvent.click(screen.getByRole("button", { name: "问 AI" }));
    await screen.findByRole("dialog", { name: "还没有配置 AI 服务" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "还没有配置 AI 服务" }),
      ).toBeNull(),
    );
    expect(send).not.toHaveBeenCalled();
  }, 15_000);

  it("设置页「咨询 AI」被拦：弹告警，设置不关也不切并排布局", async () => {
    seedSkipped();
    render(<App />);
    await waitForShell();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog", { name: "设置" });
    fireEvent.click(screen.getByRole("button", { name: "咨询 AI" }));

    expect(
      await screen.findByRole("dialog", { name: "还没有配置 AI 服务" }),
    ).toBeTruthy();
    // 被拦下：设置仍在，且没有切到并排咨询布局。
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
    expect(document.querySelector(".settings-assistant")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "还没有配置 AI 服务" }),
      ).toBeNull(),
    );
    // 取消后设置态不变。
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
    expect(vi.mocked(bridge.sendMessage)).not.toHaveBeenCalled();
  }, 15_000);

  it("设置内咨询被拦：Esc 只关告警，设置仍在", async () => {
    seedSkipped();
    render(<App />);
    await waitForShell();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog", { name: "设置" });
    fireEvent.click(screen.getByRole("button", { name: "咨询 AI" }));
    await screen.findByRole("dialog", { name: "还没有配置 AI 服务" });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "还没有配置 AI 服务" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
    expect(document.querySelector(".settings-assistant")).toBeNull();
  }, 15_000);

  it("移动导出 › 问 AI 被拦：告警出现，取消后导出弹层仍开着", async () => {
    seedSkipped();
    render(<App />);
    await waitForShell();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settings = await screen.findByRole("dialog", { name: "设置" });
    fireEvent.click(within(settings).getByRole("tab", { name: "账户" }));
    fireEvent.click(await within(settings).findByRole("button", { name: "查看" }));

    const exportDialog = await screen.findByRole("dialog", {
      name: "在手机上使用",
    });
    fireEvent.click(
      within(exportDialog).getByRole("button", { name: "不会操作？问 AI" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "还没有配置 AI 服务" }),
    ).toBeTruthy();
    // 被拦下：既不关导出层，也不关设置。
    expect(screen.getByRole("dialog", { name: "在手机上使用" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "还没有配置 AI 服务" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "在手机上使用" })).toBeTruthy();
    expect(vi.mocked(bridge.sendMessage)).not.toHaveBeenCalled();
  }, 15_000);

  it("移动导出被拦：Esc 只关告警，导出层与设置仍在", async () => {
    seedSkipped();
    render(<App />);
    await waitForShell();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settings = await screen.findByRole("dialog", { name: "设置" });
    fireEvent.click(within(settings).getByRole("tab", { name: "账户" }));
    fireEvent.click(await within(settings).findByRole("button", { name: "查看" }));
    const exportDialog = await screen.findByRole("dialog", {
      name: "在手机上使用",
    });
    fireEvent.click(
      within(exportDialog).getByRole("button", { name: "不会操作？问 AI" }),
    );
    await screen.findByRole("dialog", { name: "还没有配置 AI 服务" });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "还没有配置 AI 服务" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "在手机上使用" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
  }, 15_000);

  it("「AI 定位」被拦：弹告警，取消后不建会话、面板不展开", async () => {
    const failed: MyServer = {
      server_id: "srv_failed",
      name: "新加坡 1 · DigitalOcean",
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      state: "error",
      created_at: new Date(0).toISOString(),
      ip: "45.76.20.100",
      port: 8388,
      node_id: null,
      local_node_id: null,
      hourly_usd: 0.007,
      monthly_usd: 5,
      daily_price_cents: 30,
      paid_until: null,
      billing_state: "pending",
      grace_ends_at: null,
      transfer_gib: 1000,
      failure: {
        stage: "verifying",
        code: "install_failed",
        message: "服务端安装失败",
        retryable: true,
      },
    };
    vi.spyOn(bridge, "myServerAccount").mockResolvedValue({
      logged_in: true,
      email: "me@example.com",
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "email",
    });
    vi.spyOn(bridge, "myServerList").mockResolvedValue({ servers: [failed] });
    vi.spyOn(bridge, "myServerGet").mockResolvedValue(failed);

    seedSkipped();
    render(<App />);
    await waitForShell();

    // 先把右栏收起，才能证明「被拦后没有展开」。
    fireEvent.click(screen.getByRole("button", { name: "收起助手" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    const rail = await screen.findByRole("complementary", {
      name: "服务器列表",
    });
    fireEvent.click(
      await within(rail).findByRole("button", { name: /新加坡 1/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "AI 定位" }));

    expect(
      await screen.findByRole("dialog", { name: "还没有配置 AI 服务" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "还没有配置 AI 服务" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy();
    expect(vi.mocked(bridge.sendMessage)).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".msg--user")).toHaveLength(0);
  }, 15_000);
});

/** 连接失败态：让「让 AI 检查」入口出现。 */
async function failConnection() {
  const start = vi.spyOn(bridge, "runtimeStart").mockImplementation(
    () => new Promise(() => {}) as never,
  );
  fireEvent.click(await screen.findByRole("button", { name: "连接节点" }));
  await waitFor(() => expect(start).toHaveBeenCalled());
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
  return screen.findByRole("button", { name: "让 AI 检查" });
}

/** 自有节点测不通：让行内的「智能修复 · 问 AI」入口出现。 */
function useOwnedUnreachable(): () => void {
  vi.mocked(bridge.configDetail).mockResolvedValue({
    ...DETAIL,
    nodes: [{ ...DETAIL.nodes[0], source: "owned" }],
  });
  // 行内动作要能把节点 id 映射到 server id，否则按设计不渲染。
  vi.spyOn(bridge, "myServerAccount").mockResolvedValue({
    logged_in: true,
    email: "me@example.com",
    account_id: "acct_1",
    device_id: "dev_1",
    account_kind: "email",
  });
  const server: MyServer = {
    server_id: "srv_tokyo",
    name: "东京 01",
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    state: "healthy",
    created_at: new Date(0).toISOString(),
    ip: "203.0.113.1",
    port: 8388,
    node_id: "nd_tokyo",
    local_node_id: "node_1",
    hourly_usd: 0.007,
    monthly_usd: 5,
    daily_price_cents: 30,
    paid_until: new Date(86_400_000).toISOString(),
    billing_state: "active",
    grace_ends_at: null,
    transfer_gib: 1000,
    failure: null,
  };
  vi.spyOn(bridge, "myServerList").mockResolvedValue({ servers: [server] });
  // 账户已登录：余额读不到会被当成登录过期而清空服务器列表，这里给一个正常值。
  vi.spyOn(bridge, "myServerWallet").mockResolvedValue({
    balance_cents: 1000,
    currency: "USD",
    denominations_cents: [1000],
    updated_at: new Date(0).toISOString(),
  });
  vi.spyOn(bridge, "myServerIdentity").mockResolvedValue({
    has_identity: true,
    account_id: "acct_1",
  });
  // 定时同步会用它的返回值整体覆盖列表：保持一致，别把映射冲掉。
  vi.spyOn(bridge, "myServerSync").mockResolvedValue({
    servers: [server],
    changed: [],
    failed: [],
  });
  vi.spyOn(bridge, "nodeProbeSnapshot").mockResolvedValue({
    configId: CONFIG_ID,
    results: [],
    run: null,
  } as never);
  const runId = "run_unreachable";
  vi.spyOn(bridge, "nodeProbeAll").mockResolvedValue({
    runId,
    configId: CONFIG_ID,
    total: 1,
    concurrency: 6,
    ignoredNodeIds: [],
  } as never);
  return () =>
    act(() => {
      (
        bridge as unknown as { emit: (event: unknown) => void }
      ).emit({
        name: AGENT_EVENTS.nodeProbeProgress,
        payload: {
          contract_version: CONTRACT_VERSION,
          run_id: runId,
          config_id: CONFIG_ID,
          phase: "probing",
          method: "clash",
          done: 1,
          total: 1,
          result: {
            node_id: "node_1",
            status: "unreachable",
            reachable: false,
            latency_ms: null,
            probe_method: "clash_delay",
            checked_at: Date.now(),
            error: { code: "PROBE_TIMEOUT", message: "" },
          },
          emitted_at: "",
        },
      });
    });
}

const FAILED_SERVER: MyServer = {
  server_id: "srv_failed",
  name: "新加坡 1 · DigitalOcean",
  region: "sgp1",
  plan: "s-1vcpu-1gb",
  state: "error",
  created_at: new Date(0).toISOString(),
  ip: "45.76.20.100",
  port: 8388,
  node_id: null,
  local_node_id: null,
  hourly_usd: 0.007,
  monthly_usd: 5,
  daily_price_cents: 30,
  paid_until: null,
  billing_state: "pending",
  grace_ends_at: null,
  transfer_gib: 1000,
  failure: {
    stage: "verifying",
    code: "install_failed",
    message: "服务端安装失败",
    retryable: true,
  },
};

/** 打开一台失败服务器，返回「AI 定位」按钮。 */
async function openFailedServer() {
  vi.spyOn(bridge, "myServerAccount").mockResolvedValue({
    logged_in: true,
    email: "me@example.com",
    account_id: "acct_1",
    device_id: "dev_1",
    account_kind: "email",
  });
  vi.spyOn(bridge, "myServerList").mockResolvedValue({
    servers: [FAILED_SERVER],
  });
  vi.spyOn(bridge, "myServerGet").mockResolvedValue(FAILED_SERVER);

  fireEvent.click(await screen.findByRole("button", { name: /我的服务器/ }));
  const rail = await screen.findByRole("complementary", { name: "服务器列表" });
  fireEvent.click(await within(rail).findByRole("button", { name: /新加坡 1/ }));
  return screen.findByRole("button", { name: "AI 定位" });
}

describe("AI 入口双向闸门", () => {
  it("让 AI 检查：未配置弹告警、不发消息", async () => {
    seedSkipped();
    render(<App />);
    await waitForShell();
    fireEvent.click(screen.getByRole("button", { name: "收起助手" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy(),
    );
    const button = await failConnection();

    fireEvent.click(button);
    expect(
      await screen.findByRole("dialog", { name: "还没有配置 AI 服务" }),
    ).toBeTruthy();
    expect(vi.mocked(bridge.sendMessage)).not.toHaveBeenCalled();
    // 被拦后右栏仍是收起的 tab。
    expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy();
  }, 15_000);

  it("让 AI 检查：已配置发出诊断消息", async () => {
    seedSkipped();
    aiConfigured = true;
    render(<App />);
    await waitForShell();
    const button = await failConnection();

    fireEvent.click(button);
    await waitFor(() =>
      expect(vi.mocked(bridge.sendMessage)).toHaveBeenCalledTimes(1),
    );
    const call = vi.mocked(bridge.sendMessage).mock.calls[0];
    expect(call[1]).toContain("连接失败了");
    expect(
      screen.queryByRole("dialog", { name: "还没有配置 AI 服务" }),
    ).toBeNull();
  }, 15_000);

  it("测不通问 AI：未配置弹告警、不发消息", async () => {
    seedSkipped();
    const emitUnreachable = useOwnedUnreachable();
    render(<App />);
    await waitForShell();
    fireEvent.click(screen.getByRole("button", { name: "收起助手" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy(),
    );
    await waitFor(() => expect(bridge.nodeProbeAll).toHaveBeenCalled());
    emitUnreachable();
    const button = await screen.findByRole("button", {
      name: "就东京 01测不通咨询 AI",
    });

    fireEvent.click(button);
    expect(
      await screen.findByRole("dialog", { name: "还没有配置 AI 服务" }),
    ).toBeTruthy();
    expect(vi.mocked(bridge.sendMessage)).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy();
  }, 15_000);

  it("测不通问 AI：已配置发出节点消息", async () => {
    seedSkipped();
    aiConfigured = true;
    const emitUnreachable = useOwnedUnreachable();
    render(<App />);
    await waitForShell();
    await waitFor(() => expect(bridge.nodeProbeAll).toHaveBeenCalled());
    emitUnreachable();
    const button = await screen.findByRole("button", {
      name: "就东京 01测不通咨询 AI",
    });

    fireEvent.click(button);
    await waitFor(() =>
      expect(vi.mocked(bridge.sendMessage)).toHaveBeenCalledTimes(1),
    );
    const call = vi.mocked(bridge.sendMessage).mock.calls[0];
    expect(call[1]).toContain("节点「东京 01」这次测不通");
  }, 15_000);

  it("咨询 AI：已配置进入并排咨询并发出咨询消息", async () => {
    seedSkipped();
    aiConfigured = true;
    render(<App />);
    await waitForShell();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog", { name: "设置" });
    fireEvent.click(screen.getByRole("button", { name: "咨询 AI" }));

    await waitFor(() =>
      expect(document.querySelector(".settings-assistant")).toBeTruthy(),
    );
    await waitFor(() =>
      expect(vi.mocked(bridge.sendMessage)).toHaveBeenCalledTimes(1),
    );
    const call = vi.mocked(bridge.sendMessage).mock.calls[0];
    expect(call[1]).toContain("我在 Veyl 的设置页");
  }, 15_000);

  it("AI 定位：已配置发出定位消息、面板展开", async () => {
    seedSkipped();
    aiConfigured = true;
    render(<App />);
    await waitForShell();
    // 先收起，证明这一步是被入口展开的。
    fireEvent.click(screen.getByRole("button", { name: "收起助手" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "展开助手" })).toBeTruthy(),
    );
    const button = await openFailedServer();

    fireEvent.click(button);
    await waitFor(() =>
      expect(vi.mocked(bridge.sendMessage)).toHaveBeenCalledTimes(1),
    );
    const call = vi.mocked(bridge.sendMessage).mock.calls[0];
    expect(call[1]).toContain("这台服务器创建失败了");
    expect(call[2]).toMatchObject({ hidden: true });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "展开助手" })).toBeNull(),
    );
  }, 15_000);
});
