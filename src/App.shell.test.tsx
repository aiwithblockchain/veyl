/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import { AGENT_EVENTS, CONTRACT_VERSION } from "./agent/protocol";

const bridge = getAgentBridge();

beforeAll(async () => {
  await bridge.saveDeepSeekKey("sk-" + "abcdefghijklmnopqrstuvwxyz0123");
});

afterAll(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  cleanup();
  // mock 运行时是单例：每个用例都从断开状态开始，免得上一条连接影响下一条。
  await bridge.runtimeStop().catch(() => undefined);
  localStorage.clear();
  vi.restoreAllMocks();
});

async function renderApp(): Promise<HTMLElement> {
  const { container } = render(<App />);
  await waitFor(() => expect(container.querySelector(".app")).not.toBeNull());
  await waitFor(() => expect(screen.queryByText("从哪里开始？")).toBeTruthy());
  return container;
}

function seedCardConfig() {
  const config = {
    config_id: "cfg_stage",
    name: "免费节点",
    connect_mode: "tun",
    routing_mode: "direct",
    node_count: 2,
    listen_port: null,
    is_active: true,
    current_node_id: "n1",
    created_at: 0,
    updated_at: 0,
    last_used_at: null,
    nodes: [
      {
        node_id: "n1",
        name: "东京 01",
        server: "203.0.113.1",
        port: 8388,
        method: "aes-256-gcm",
        protocol: "shadowsocks",
        source: "seed",
        created_at: 0,
      },
      {
        node_id: "n2",
        name: "新加坡 01",
        server: "203.0.113.2",
        port: 8388,
        method: "aes-256-gcm",
        protocol: "shadowsocks",
        source: "seed",
        created_at: 0,
      },
    ],
    dns: { mode: "auto", local: [], remote: [] },
    tun_excludes: [],
    layout: {
      version: 1,
      blocks: [
        {
          type: "action_card",
          props: {
            id: "first_step",
            title: "先做这一步",
            actions: [{ id: "go_on", label: "继续", kind: "primary" }],
          },
        },
      ],
    },
    layout_revision: 1,
  };
  localStorage.setItem(
    "veyl.configs.mock.v1",
    JSON.stringify({ configs: [config], activeId: config.config_id }),
  );
  return config;
}

describe("三区外壳与连接舞台", () => {
  it("没有节点时停在两选一：没有列表列，也没有节点组入口", async () => {
    const container = await renderApp();

    expect(screen.getByRole("button", { name: /新建节点/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /先试用免费节点/ })).toBeTruthy();
    expect(container.querySelector(".rail")).toBeNull();

    expect(screen.getByRole("button", { name: "连接" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "我的服务器" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "节点组" })).toBeNull();
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "账户" })).toBeTruthy();
  });

  it("先试用免费节点：三步按顺序落地，结束收成一句摘要", async () => {
    await renderApp();
    const probe = vi.spyOn(bridge, "nodeProbe");
    const batchProbe = vi.spyOn(bridge, "nodeProbeAll");

    fireEvent.click(screen.getByRole("button", { name: /先试用免费节点/ }));

    // 步骤流：拉取、加入、测速都在舞台上，进行中不消失。
    await waitFor(() =>
      expect(screen.getByText("拉取预置配置")).toBeTruthy(),
    );
    expect(screen.getByText("加入免费节点")).toBeTruthy();
    expect(screen.getByText("逐个测速")).toBeTruthy();

    // 先落配置：唯一一条、tun + 智能、两个免费节点。
    await waitFor(() => {
      const stored = JSON.parse(
        localStorage.getItem("veyl.configs.mock.v1") ?? "{}",
      ) as {
        configs: Array<{
          config_id: string;
          connect_mode: string;
          routing_mode: string;
          nodes: Array<{ node_id: string; name: string }>;
        }>;
      };
      expect(stored.configs).toHaveLength(1);
      expect(stored.configs[0].connect_mode).toBe("tun");
      expect(stored.configs[0].routing_mode).toBe("direct");
      expect(stored.configs[0].nodes.map((node) => node.name)).toEqual([
        "东京 01",
        "新加坡 01",
      ]);
    });

    // 测速是逐个真实调用，两个节点各一次。
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    });
    expect(probe.mock.calls.map((call) => call[0]).sort()).toEqual([
      "mock_free_singapore_01",
      "mock_free_tokyo_01",
    ]);
    expect(batchProbe).not.toHaveBeenCalled();

    await waitFor(
      () => expect(screen.getAllByText(/已连接/).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
    expect(
      screen.getByText("已加入 2 个免费节点，最快 42ms"),
    ).toBeTruthy();
  }, 15_000);

  it("测速全部失败：停在测速那步给原因，可以先连接", async () => {
    await renderApp();
    vi.spyOn(bridge, "nodeProbe").mockRejectedValue({
      code: "NETWORK",
      message: "测速没完成。",
      retryable: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /先试用免费节点/ }));

    await waitFor(
      () => expect(screen.getByText("免费节点没加完")).toBeTruthy(),
      { timeout: 5000 },
    );
    const probeRow = screen.getByText("逐个测速").closest(".stage-step");
    expect(probeRow?.className).toContain("is-failed");
    expect(
      screen.getByText("两个节点都没测速成功，可以重试，或先连接。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "先连接，不测速" }));
    await waitFor(
      () => expect(screen.getAllByText(/已连接/).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
  }, 15_000);

  it("拉取免费节点失败：停在失败的步骤并说明原因，不落配置", async () => {
    Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
    try {
      vi.spyOn(bridge, "getDeepSeekKey").mockResolvedValue({
        masked: "sk-****abcd",
        verified: true,
        validation: "ok",
      });
      vi.spyOn(bridge, "trialStatus").mockResolvedValue({
        state: "available",
        started_at: null,
        expires_at: null,
        remaining_ms: null,
        seed_node_count: 0,
      });
      vi.spyOn(bridge, "configList").mockResolvedValue({
        configs: [],
        active_config_id: null,
      });
      vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
      vi.spyOn(bridge, "defaultProfileStatus").mockRejectedValue({
        code: "NETWORK",
        message: "连不上节点源。",
        retryable: true,
      });

      render(<App />);
      await waitFor(() => expect(screen.getByText("从哪里开始？")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: /先试用免费节点/ }));

      await waitFor(() => expect(screen.getByText("免费节点没加完")).toBeTruthy(), {
        timeout: 5000,
      });
      expect(screen.getByText(/连不上节点源/)).toBeTruthy();
      const fetchRow = screen.getByText("拉取预置配置").closest(".stage-step");
      expect(fetchRow?.className).toContain("is-failed");
      expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
      expect(localStorage.getItem("veyl.configs.mock.v1")).toBeNull();
    } finally {
      Object.defineProperty(bridge, "mode", { value: "mock", configurable: true });
    }
  }, 15_000);

  it("试用到期只留「新建节点」，不再出现免费节点入口", async () => {
    localStorage.setItem("veyl.mock.trial", "expired");
    render(<App />);

    await waitFor(() => expect(screen.getByText("试用已到期")).toBeTruthy());
    expect(screen.getByText("免费节点已从节点池移除。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建节点" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /先试用免费节点/ })).toBeNull();
  });

  it("收到 trial-expired 后切到到期屏", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("从哪里开始？")).toBeTruthy());

    act(() => {
      (bridge as unknown as { expireTrialDemo: () => void }).expireTrialDemo();
    });

    await waitFor(() => expect(screen.getByText("试用已到期")).toBeTruthy());
  });

  it("重复点试用不会多建配置", async () => {
    await renderApp();

    const button = screen.getByRole("button", { name: /先试用免费节点/ });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(
      () => expect(screen.getAllByText(/已连接/).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
    const stored = JSON.parse(
      localStorage.getItem("veyl.configs.mock.v1") ?? "{}",
    ) as { configs: unknown[] };
    expect(stored.configs).toHaveLength(1);
  }, 15_000);

  it("新建节点进入 new_node 舞台", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: /新建节点/ }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "新建节点" })).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "创建" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "让 AI 帮我选" })).toBeTruthy();
  });

  it("切换 destination 不重置连接", async () => {
    const container = await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /先试用免费节点/ }));
    await waitFor(
      () => expect(screen.getAllByText(/已连接/).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "我的服务器" }));
    await waitFor(() => expect(container.querySelector(".app")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    await waitFor(
      () => expect(screen.getAllByText(/已连接/).length).toBeGreaterThan(0),
    );
    expect(container.querySelector(".app--solo")).not.toBeNull();
  }, 15_000);

  it("action_card 按钮只上报 context，不执行命令", async () => {
    seedCardConfig();
    const send = vi.spyOn(bridge, "sendMessage").mockResolvedValue({
      requestId: "req_card",
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("先做这一步")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const call = send.mock.calls[0];
    expect(call[1]).toBeUndefined();
    expect(call[2]).toMatchObject({
      hidden: true,
      context: {
        screen: "client",
        last_action: { id: "go_on" },
      },
    });
    const ids = (call[2] as { context: { controls: Array<{ id: string }> } })
      .context.controls.map((item) => item.id);
    expect(ids).toContain("client.primary");
    expect(ids).toContain("go_on");
  });

  it("last_action 发送后清零，下一条消息为 null", async () => {
    seedCardConfig();
    const send = vi.spyOn(bridge, "sendMessage").mockResolvedValue({
      requestId: "req_1",
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("先做这一步")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    act(() => {
      (
        bridge as unknown as {
          emit: (event: unknown) => void;
        }
      ).emit({
        name: AGENT_EVENTS.requestEnd,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_1",
          assistant_message_id: "a_1",
          result: "success",
          final_text: null,
          error: null,
          usage: null,
          duration_ms: 1,
          emitted_at: "",
        },
      });
    });

    const textarea = await waitFor(() => {
      const node = document.querySelector(".composer textarea");
      expect(node).not.toBeNull();
      expect((node as HTMLTextAreaElement).disabled).toBe(false);
      return node as HTMLTextAreaElement;
    });
    fireEvent.change(textarea, { target: { value: "然后呢" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const second = send.mock.calls[1];
    expect(
      (second[2] as { context: { last_action: unknown } }).context.last_action,
    ).toBeNull();
  });

  it("日常操作不弹登录框：连接、断开、换节点、设置、试用", async () => {
    seedCardConfig();
    render(<App />);
    await waitFor(() =>
      expect(document.querySelector(".stage-primary")).not.toBeNull(),
    );
    const noLogin = () =>
      expect(
        document.querySelector('[role="dialog"][aria-label="登录我的服务器"]'),
      ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "连接节点" }));
    await waitFor(() => expect(screen.getAllByText(/已连接/).length).toBeGreaterThan(0), {
      timeout: 5000,
    });
    noLogin();

    fireEvent.click(await screen.findByRole("button", { name: "断开连接" }));
    await waitFor(
      () => expect(screen.getAllByText("未连接").length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
    noLogin();

    fireEvent.click(screen.getByRole("option", { name: /新加坡 01/ }));
    noLogin();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog", { name: "设置" });
    noLogin();
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    noLogin();
  }, 15_000);

  it("新建节点入口：无节点屏进入舞台，且不叠加我的服务器外壳", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /新建节点/ }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "新建节点" })).toBeTruthy(),
    );
    // 复用向导，但不渲染服务器页外壳与列表列。
    expect(document.querySelector(".rail")).toBeNull();
    expect(document.querySelector(".myservers")).toBeNull();
    // 地区按大洲分组，类型三档，主按钮与次级入口都在。
    expect(screen.getByText("亚洲")).toBeTruthy();
    expect(screen.getByText("北美洲")).toBeTruthy();
    expect(screen.getAllByRole("radio", { name: /1 核/ }).length).toBe(3);
    expect(screen.getByRole("button", { name: "创建" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "让 AI 帮我选" })).toBeTruthy();
  }, 15_000);

  it("试用到期屏也能进入新建节点舞台", async () => {
    localStorage.setItem("veyl.mock.trial", "expired");
    render(<App />);
    await screen.findByText("试用已到期");
    fireEvent.click(screen.getByRole("button", { name: "新建节点" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "新建节点" })).toBeTruthy(),
    );
  }, 15_000);

  it("新建节点返回原处，再进来保留已选", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /新建节点/ }));
    await screen.findByRole("heading", { name: "新建节点" });

    fireEvent.click(screen.getByRole("radio", { name: "班加罗尔 1" }));
    const plan = screen.getByRole("radio", { name: /1 核 · 2 GB/ });
    fireEvent.click(plan);
    expect(
      screen
        .getByRole("radio", { name: "班加罗尔 1" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(plan.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await waitFor(() => expect(screen.getByText("从哪里开始？")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /新建节点/ }));
    await screen.findByRole("heading", { name: "新建节点" });
    expect(
      screen
        .getByRole("radio", { name: "班加罗尔 1" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: /1 核 · 2 GB/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  }, 15_000);

  it("新建节点返回后，从到期屏进入也回到到期屏", async () => {
    localStorage.setItem("veyl.mock.trial", "expired");
    render(<App />);
    await screen.findByText("试用已到期");
    fireEvent.click(screen.getByRole("button", { name: "新建节点" }));
    await screen.findByRole("heading", { name: "新建节点" });
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await waitFor(() => expect(screen.getByText("试用已到期")).toBeTruthy());
  }, 15_000);

  it("创建前余额不足：就地给去充值，不发起下单", async () => {
    await renderApp();
    const create = vi.spyOn(bridge, "myServerCreate");
    vi.spyOn(bridge, "myServerWallet").mockResolvedValue({
      balance_cents: 10,
      currency: "USD",
      denominations_cents: [1000],
      updated_at: new Date(0).toISOString(),
    });
    fireEvent.click(screen.getByRole("button", { name: /新建节点/ }));
    await screen.findByRole("heading", { name: "新建节点" });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText(/余额不足，还差/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "去充值" }));
    expect(await screen.findByRole("dialog", { name: "充值" })).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  }, 15_000);

  it("查看账单先拉起登录，登录后回到账户页", async () => {
    localStorage.setItem(
      "veyl.mock.account",
      JSON.stringify({ logged_in: true, email: "buyer@example.com" }),
    );
    vi.spyOn(bridge, "myServerWallet").mockRejectedValue({
      code: "AUTH",
      message: "登录已过期。",
      retryable: false,
      details: { reason: "auth_required" },
    });

    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog", { name: "设置" });
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看账单" }));

    expect(
      await screen.findByRole("dialog", { name: "登录我的服务器" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "buyer@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    fireEvent.change(await screen.findByLabelText("验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy(),
    );
    expect(await screen.findByText(/账单明细下一版接入/)).toBeTruthy();
  }, 15_000);

  it("让 AI 帮我选只发消息，不建机", async () => {
    await renderApp();
    const send = vi.spyOn(bridge, "sendMessage").mockResolvedValue({
      requestId: "req_ai_pick",
    });
    const create = vi.spyOn(bridge, "myServerCreate");
    fireEvent.click(screen.getByRole("button", { name: /新建节点/ }));
    await screen.findByRole("heading", { name: "新建节点" });

    fireEvent.click(screen.getByRole("button", { name: "让 AI 帮我选" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const call = send.mock.calls[0];
    expect(call[1]).toBe("帮我选一个地区和规格。");
    expect(
      (call[2] as { context: { screen: string; last_action: { id: string } } })
        .context,
    ).toMatchObject({ screen: "new_node", last_action: { id: "new_node.ask_ai" } });
    expect(create).not.toHaveBeenCalled();
    expect(localStorage.getItem("veyl.configs.mock.v1")).toBeNull();
  }, 15_000);

  it("stage-select：舞台没开忽略；开了只覆盖非 null 字段并压过手动选择", async () => {
    await renderApp();
    const emitSelect = (region: string | null, plan: string | null) => {
      act(() => {
        (
          bridge as unknown as {
            emit: (event: unknown) => void;
          }
        ).emit({
          name: AGENT_EVENTS.stageSelect,
          payload: {
            contract_version: CONTRACT_VERSION,
            screen: "new_node",
            region,
            plan,
            emitted_at: new Date().toISOString(),
          },
        });
      });
    };
    const checked = (name: string | RegExp) =>
      screen.getByRole("radio", { name }).getAttribute("aria-checked");

    // 舞台没开：事件被忽略。
    emitSelect("fra1", "s-1vcpu-512mb-10gb");
    fireEvent.click(screen.getByRole("button", { name: /新建节点/ }));
    await screen.findByRole("heading", { name: "新建节点" });
    expect(checked("新加坡 1")).toBe("true");
    expect(checked("法兰克福 1")).toBe("false");

    // 只请求规格：地区不动。
    emitSelect(null, "s-1vcpu-512mb-10gb");
    await waitFor(() => expect(checked(/1 核 · 512 MB/)).toBe("true"));
    expect(checked("新加坡 1")).toBe("true");

    // 手动改地区后，以事件为准覆盖。
    fireEvent.click(screen.getByRole("radio", { name: "法兰克福 1" }));
    emitSelect("sgp1", null);
    await waitFor(() => expect(checked("新加坡 1")).toBe("true"));
  }, 15_000);
});
