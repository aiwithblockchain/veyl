/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import { AGENT_EVENTS, CONTRACT_VERSION } from "./agent/protocol";
import type { AgentEvent } from "./agent/protocol";

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
    expect(screen.getByRole("button", { name: /账户/ })).toBeTruthy();
  });

  it("先试用免费节点：三步按顺序落地，结束停在未连接，行内延迟与摘要一致", async () => {
    await renderApp();
    const probe = vi.spyOn(bridge, "nodeProbe");
    const batchProbe = vi.spyOn(bridge, "nodeProbeAll");
    const start = vi.spyOn(bridge, "runtimeStart");

    fireEvent.click(screen.getByRole("button", { name: /先试用免费节点/ }));

    // 步骤流：拉取、加入、测速都在舞台上，进行中不消失。
    await waitFor(() =>
      expect(screen.getByText("拉取预置配置")).toBeTruthy(),
    );
    expect(screen.getByText("加入免费节点")).toBeTruthy();
    expect(screen.getByText("逐个测速")).toBeTruthy();

    // 先落配置：唯一一条、Proxy + 智能、两个免费节点。
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
      expect(stored.configs[0].connect_mode).toBe("system_proxy");
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

    // 步骤流结束停在未连接：不自动 start，等用户自己点连接。
    await waitFor(
      () => expect(screen.getByText("已加入 2 个免费节点，最快 42ms")).toBeTruthy(),
      { timeout: 5000 },
    );
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryAllByText(/已连接/)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "连接节点" })).toBeTruthy();

    // 节点行与摘要用同一份测速结果，数字一致。
    const values = [...document.querySelectorAll(".stage-node__ms")].map(
      (node) => node.textContent,
    );
    expect(values).toEqual(["42 毫秒", "42 毫秒"]);

    // 步骤流完成时一次性预选最快；并列取列表靠前的东京。
    await waitFor(() => {
      const rows = screen.getAllByRole("option");
      expect(rows[0].getAttribute("aria-selected")).toBe("true");
      expect(rows[0].querySelector(".stage-node__fastest")).not.toBeNull();
    });
    const stageRows = screen.getAllByRole("option");
    expect(stageRows[1].querySelector(".stage-node__fastest")).toBeNull();
  }, 15_000);

  it("试用测速：untested 与 unreachable 都不参与最快选择", async () => {
    await renderApp();
    vi.spyOn(bridge, "nodeProbe").mockImplementation(async (nodeId: string) => {
      if (nodeId.includes("tokyo")) {
        return {
          node_id: nodeId,
          status: "ok" as const,
          reachable: true,
          latency_ms: 88,
          probe_method: "clash_delay" as const,
          checked_at: Date.now(),
          error: null,
        };
      }
      if (nodeId.includes("singapore")) {
        return {
          node_id: nodeId,
          status: "untested" as const,
          reachable: null,
          latency_ms: null,
          probe_method: "none" as const,
          checked_at: Date.now(),
          error: null,
        };
      }
      return {
        node_id: nodeId,
        status: "unreachable" as const,
        reachable: false,
        latency_ms: null,
        probe_method: "clash_delay" as const,
        checked_at: Date.now(),
        error: { code: "PROBE_TIMEOUT", message: "" },
      };
    });

    fireEvent.click(screen.getByRole("button", { name: /先试用免费节点/ }));

    await waitFor(
      () => expect(screen.getByText("已加入 2 个免费节点，最快 88ms")).toBeTruthy(),
      { timeout: 5000 },
    );
    // 只有 status=ok 的东京被选中并标「最快」；未测的新加坡不参与。
    await waitFor(() => {
      const rows = screen.getAllByRole("option");
      expect(rows[0].getAttribute("aria-selected")).toBe("true");
      expect(rows[0].querySelector(".stage-node__fastest")).not.toBeNull();
      expect(rows[1].querySelector(".stage-node__fastest")).toBeNull();
    });
    const values = [...document.querySelectorAll(".stage-node__ms")].map(
      (node) => node.textContent,
    );
    expect(values).toEqual(["88 毫秒", "未测"]);
  }, 15_000);

  it("试用测速全都没测成：文案说「没测成」，不暗示节点坏了", async () => {
    await renderApp();
    vi.spyOn(bridge, "nodeProbe").mockImplementation(async (nodeId: string) => ({
      node_id: nodeId,
      status: "untested" as const,
      reachable: null,
      latency_ms: null,
      probe_method: "none" as const,
      checked_at: Date.now(),
      error: null,
    }));

    fireEvent.click(screen.getByRole("button", { name: /先试用免费节点/ }));

    expect(
      await screen.findByText(/两个节点都没测成/, undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.queryByText(/两个节点都没测通/)).toBeNull();
  }, 15_000);

  it("试用测速全都连不上：文案说「没测通」，不说没测成", async () => {
    await renderApp();
    vi.spyOn(bridge, "nodeProbe").mockImplementation(async (nodeId: string) => ({
      node_id: nodeId,
      status: "unreachable" as const,
      reachable: false,
      latency_ms: null,
      probe_method: "clash_delay" as const,
      checked_at: Date.now(),
      error: { code: "PROBE_TIMEOUT", message: "" },
    }));

    fireEvent.click(screen.getByRole("button", { name: /先试用免费节点/ }));

    expect(
      await screen.findByText(/两个节点都没测通/, undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.queryByText(/两个节点都没测成/)).toBeNull();
  }, 15_000);

  it("试用测速一条没测成一条连不上：文案写「没测出可用结果」", async () => {
    await renderApp();
    vi.spyOn(bridge, "nodeProbe").mockImplementation(async (nodeId: string) => {
      if (nodeId.includes("tokyo")) {
        return {
          node_id: nodeId,
          status: "untested" as const,
          reachable: null,
          latency_ms: null,
          probe_method: "none" as const,
          checked_at: Date.now(),
          error: null,
        };
      }
      return {
        node_id: nodeId,
        status: "unreachable" as const,
        reachable: false,
        latency_ms: null,
        probe_method: "clash_delay" as const,
        checked_at: Date.now(),
        error: { code: "PROBE_TIMEOUT", message: "" },
      };
    });

    fireEvent.click(screen.getByRole("button", { name: /先试用免费节点/ }));

    expect(
      await screen.findByText(/两个节点都没测出可用结果/, undefined, {
        timeout: 5000,
      }),
    ).toBeTruthy();
  }, 15_000);

  it("试用预选切 destination 往返后不二次应用", async () => {
    await renderApp();
    vi.spyOn(bridge, "nodeProbe").mockImplementation(async (nodeId: string) => ({
      node_id: nodeId,
      status: "ok",
      reachable: true,
      latency_ms: nodeId.includes("singapore") ? 42 : 90,
      probe_method: "clash_delay",
      checked_at: Date.now(),
      error: null,
    }));

    fireEvent.click(screen.getByRole("button", { name: /先试用免费节点/ }));
    await waitFor(
      () => expect(screen.getByText("已加入 2 个免费节点，最快 42ms")).toBeTruthy(),
      { timeout: 5000 },
    );
    // 完成时预选最快的新加坡。
    await waitFor(() => {
      const rows = screen.getAllByRole("option");
      expect(rows[1].getAttribute("aria-selected")).toBe("true");
      expect(rows[1].querySelector(".stage-node__fastest")).not.toBeNull();
    });

    // 切走再回来：本地预选已消费，不再盖到新舞台；当前节点是东京。
    fireEvent.click(screen.getByRole("button", { name: "我的服务器" }));
    expect(
      await screen.findByRole("complementary", { name: "服务器列表" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await waitFor(() =>
      expect(screen.getAllByRole("option").length).toBe(2),
    );
    const rowsAfter = screen.getAllByRole("option");
    // 生产契约：seed 新建 current_node_id 留空，返回后没有选中。
    expect(rowsAfter.every((row) => row.getAttribute("aria-selected") === "false")).toBe(
      true,
    );
    expect(document.querySelectorAll(".stage-node__fastest").length).toBe(0);

    // 点连接先切到目标节点（第一个）再连接。
    const runtimeStart = vi.spyOn(bridge, "runtimeStart");
    fireEvent.click(screen.getByRole("button", { name: "连接节点" }));
    await waitFor(() => {
      const stored = JSON.parse(
        localStorage.getItem("veyl.configs.mock.v1") ?? "{}",
      ) as {
        configs: Array<{
          current_node_id: string | null;
          nodes: Array<{ node_id: string }>;
        }>;
      };
      expect(stored.configs[0].current_node_id).toBe(
        stored.configs[0].nodes[0].node_id,
      );
    });
    await waitFor(() => expect(runtimeStart).toHaveBeenCalled());
    // 等连接真正落地再结束，避免把在途启动留给下一条用例。
    await waitFor(
      () => expect(screen.getAllByText(/已连接/).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
  }, 15_000);

  it("重启后没有本会话步骤流：不显示收尾句", async () => {
    seedCardConfig();
    vi.spyOn(bridge, "nodeProbeSnapshot").mockResolvedValue({
      configId: "cfg_stage",
      results: [
        {
          node_id: "n1",
          status: "ok",
          reachable: true,
          latency_ms: 42,
          probe_method: "clash_delay",
          checked_at: Date.now(),
          error: null,
        },
        {
          node_id: "n2",
          status: "ok",
          reachable: true,
          latency_ms: 90,
          probe_method: "clash_delay",
          checked_at: Date.now(),
          error: null,
        },
      ],
      run: null,
    } as never);

    // 这条用例只看重启后的缓存与收尾句：把自动批次挡掉，
    // 否则「测速中」会先把缓存值盖住（自动测速的渲染由下面的用例覆盖）。
    vi.spyOn(bridge, "nodeProbeAll").mockRejectedValue({
      code: "NOT_FOUND",
      message: "unknown command node_probe_all",
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("先做这一步")).toBeTruthy());
    expect(await screen.findByText("42 毫秒")).toBeTruthy();
    expect(screen.queryByText(/已加入/)).toBeNull();
  }, 15_000);

  it("自动测速包含当前选中节点：该行与其它行一样显示延迟", async () => {
    seedCardConfig();
    // 空缓存：结果只能来自本次自动批次，不靠快照兜底。
    vi.spyOn(bridge, "nodeProbeSnapshot").mockResolvedValue({
      configId: "cfg_stage",
      results: [],
      run: null,
    } as never);
    const runId = "run_autoprobe_sel";
    const batchProbe = vi.spyOn(bridge, "nodeProbeAll").mockResolvedValue({
      runId,
      configId: "cfg_stage",
      total: 2,
      concurrency: 6,
      ignoredNodeIds: [],
    } as never);
    const emit = (bridge as unknown as { emit(event: AgentEvent): void }).emit.bind(
      bridge,
    );
    const progress = (nodeId: string, done: number, latency: number) =>
      emit({
        name: AGENT_EVENTS.nodeProbeProgress,
        payload: {
          contract_version: CONTRACT_VERSION,
          run_id: runId,
          config_id: "cfg_stage",
          phase: "probing",
          method: "clash",
          done,
          total: 2,
          result: {
            node_id: nodeId,
            status: "ok",
            reachable: true,
            latency_ms: latency,
            probe_method: "clash_delay",
            checked_at: Date.now(),
            error: null,
          },
          emitted_at: "",
        },
      } as never);

    render(<App />);
    await waitFor(() => expect(screen.getByText("先做这一步")).toBeTruthy());

    await waitFor(() => expect(batchProbe).toHaveBeenCalled(), { timeout: 5000 });
    expect(batchProbe.mock.calls[0][1]).toEqual(["n1", "n2"]);

    const msOf = (row: Element | undefined) =>
      row?.querySelector(".stage-node__ms")?.textContent;

    act(() => progress("n1", 1, 42));
    await waitFor(() =>
      expect(msOf(screen.getAllByRole("option")[0])).toBe("42 毫秒"),
    );
    act(() => progress("n2", 2, 78));
    await waitFor(() => {
      const rows = screen.getAllByRole("option");
      expect(rows[0].getAttribute("aria-selected")).toBe("true");
      expect(msOf(rows[0])).toBe("42 毫秒");
      expect(msOf(rows[1])).toBe("78 毫秒");
    });
  }, 15_000);

  it("测速全部失败：停在测速那步给原因，跳过测速后停在未连接", async () => {
    await renderApp();
    const start = vi.spyOn(bridge, "runtimeStart");
    const configDelete = vi.spyOn(bridge, "configDelete");
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
      screen.getByText("两个节点都没测出可用结果，可以重试，或跳过测速后自己点连接。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "跳过测速" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "连接节点" })).toBeTruthy(),
    );
    expect(start).not.toHaveBeenCalled();
    // 全局配置不能删：试用失败只报错，不动池子。
    expect(configDelete).not.toHaveBeenCalled();
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
      const configDelete = vi.spyOn(bridge, "configDelete");
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
      expect(configDelete).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(bridge, "mode", { value: "mock", configurable: true });
    }
  }, 15_000);

  it("试用到期只留「新建节点」，不再出现免费节点入口", async () => {
    localStorage.setItem("veyl.mock.trial", "expired");
    render(<App />);

    await screen.findByRole("main", { name: "试用已到期" });
    expect(screen.getByText("免费节点已从节点池移除。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建节点" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /先试用免费节点/ })).toBeNull();
    // 到期屏没有节点可选、也没有连接动作。
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "连接节点" })).toBeNull();
  });

  it("试用到期但已有自建节点：照常进连接舞台，不看到期屏", async () => {
    localStorage.setItem("veyl.mock.trial", "expired");
    localStorage.setItem(
      "veyl.configs.mock.v1",
      JSON.stringify({
        configs: [
          {
            config_id: "cfg_own",
            name: "我的节点",
            connect_mode: "tun",
            routing_mode: "direct",
            node_count: 1,
            listen_port: null,
            is_active: true,
            current_node_id: "n_own",
            created_at: 0,
            updated_at: 0,
            last_used_at: null,
            nodes: [
              {
                node_id: "n_own",
                name: "家里 01",
                server: "203.0.113.9",
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
        activeId: "cfg_own",
      }),
    );

    render(<App />);

    expect(
      await screen.findByRole("button", { name: "连接节点" }),
    ).toBeTruthy();
    expect(screen.queryByText("试用已到期")).toBeNull();
  });

  it("收到 trial-expired 后切到到期屏", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("从哪里开始？")).toBeTruthy());

    act(() => {
      (bridge as unknown as { expireTrialDemo: () => void }).expireTrialDemo();
    });

    await screen.findByRole("main", { name: "试用已到期" });
    expect(screen.queryByText("从哪里开始？")).toBeNull();
    expect(screen.getByRole("button", { name: "新建节点" })).toBeTruthy();
  });

  it("重复点试用不会多建配置", async () => {
    await renderApp();

    const button = screen.getByRole("button", { name: /先试用免费节点/ });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(
      () => expect(screen.getByText("已加入 2 个免费节点，最快 42ms")).toBeTruthy(),
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
      () => expect(screen.getByText("已加入 2 个免费节点，最快 42ms")).toBeTruthy(),
      { timeout: 5000 },
    );
    // 步骤流结束不自动连接：用户自己点。
    fireEvent.click(screen.getByRole("button", { name: "连接节点" }));
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

  it("client 宿主：导航高亮仍在连接，Esc 与返回相同", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /新建节点/ }));
    await screen.findByRole("heading", { name: "新建节点" });

    expect(
      screen.getByRole("button", { name: "连接" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.querySelector(".rail")).toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitFor(() => expect(screen.getByText("从哪里开始？")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "新建节点" })).toBeNull();
  }, 15_000);

  it("试用到期屏也能进入新建节点舞台", async () => {
    localStorage.setItem("veyl.mock.trial", "expired");
    render(<App />);
    await screen.findByRole("main", { name: "试用已到期" });
    fireEvent.click(screen.getByRole("button", { name: "新建节点" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "新建节点" })).toBeTruthy(),
    );
    expect(screen.queryByRole("main", { name: "试用已到期" })).toBeNull();
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
    await screen.findByRole("main", { name: "试用已到期" });
    fireEvent.click(screen.getByRole("button", { name: "新建节点" }));
    await screen.findByRole("heading", { name: "新建节点" });
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await screen.findByRole("main", { name: "试用已到期" });
    expect(screen.queryByRole("heading", { name: "新建节点" })).toBeNull();
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

  it("控件文案与舞台一致：node_pick 用国家 + 序号", async () => {
    const config = seedCardConfig();
    config.nodes[0].name = "meshflux69 [美国]";
    localStorage.setItem(
      "veyl.configs.mock.v1",
      JSON.stringify({ configs: [config], activeId: config.config_id }),
    );
    const send = vi.spyOn(bridge, "sendMessage").mockResolvedValue({
      requestId: "req_label",
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("先做这一步")).toBeTruthy());
    expect(screen.getByText("美国 01")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const controls = (
      send.mock.calls[0][2] as {
        context: { controls: Array<{ id: string; label: string }> };
      }
    ).context.controls;
    expect(controls.find((item) => item.id === "client.node_pick")?.label).toBe(
      "美国 01",
    );
  });

  it("手动测速进 context：client.probe 在 controls 且 last_action 上报", async () => {
    seedCardConfig();
    const send = vi.spyOn(bridge, "sendMessage").mockResolvedValue({
      requestId: "req_probe",
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("先做这一步")).toBeTruthy());
    // 进入连接屏的自动测速先跑完（每个配置只自动跑一次），再手动测。
    await waitFor(
      () => {
        const values = [...document.querySelectorAll(".stage-node__ms")].map(
          (node) => node.textContent,
        );
        expect(values.some((value) => value?.includes("毫秒"))).toBe(true);
      },
      { timeout: 5000 },
    );
    await waitFor(() => {
      const probe = document.querySelector(".stage-probe");
      expect(probe).not.toBeNull();
      expect((probe as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(document.querySelector(".stage-probe") as HTMLElement);
    // 等这一轮结束、入口恢复为「测速」且可点，再发消息。
    await waitFor(
      () => {
        const probe = document.querySelector(".stage-probe") as HTMLButtonElement | null;
        expect(probe?.disabled).toBe(false);
        expect(probe?.textContent).toBe("测速");
      },
      { timeout: 5000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "展开助手" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "连上了，但网页打不开" }),
    );
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const context = (
      send.mock.calls[0][2] as {
        context: {
          controls: Array<{ id: string }>;
          last_action: { id: string } | null;
        };
      }
    ).context;
    expect(context.controls.some((item) => item.id === "client.probe")).toBe(true);
    expect(context.last_action).toEqual({ id: "client.probe" });
  }, 15_000);

  it("空态预制问题：点击按普通消息发送并带 context，发送后消失", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "展开助手" }));
    const send = vi.spyOn(bridge, "sendMessage").mockResolvedValue({
      requestId: "req_preset",
    });
    const group = await screen.findByRole("group", { name: "可以这样问" });
    expect(
      [...group.querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual([
      "连上了，但网页打不开",
      "怎么换成更快的节点",
      "为什么有的软件没走 VPN",
      "为什么个别网站还是打不开",
      "终端里的命令也想走 VPN",
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "连上了，但网页打不开" }),
    );
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const call = send.mock.calls[0];
    expect(call[1]).toBe("连上了，但网页打不开");
    expect(
      (call[2] as { context: { screen: string } }).context.screen,
    ).toBe("no_nodes");
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "可以这样问" }),
      ).toBeNull(),
    );
  }, 15_000);

  it("导航账户图标打开账号菜单，不跳转我的服务器", async () => {
    localStorage.setItem(
      "veyl.mock.account",
      JSON.stringify({ logged_in: true, email: "buyer@example.com" }),
    );
    vi.spyOn(bridge, "myServerAccount").mockResolvedValue({
      logged_in: true,
      email: "buyer@example.com",
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "email",
    });
    vi.spyOn(bridge, "myServerWallet").mockResolvedValue({
      balance_cents: 1230,
      currency: "USD",
      denominations_cents: [1000],
      updated_at: new Date(0).toISOString(),
    });
    vi.spyOn(bridge, "myServerList").mockResolvedValue({ servers: [] });

    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /账户/ }));
    expect(
      await screen.findByRole("dialog", { name: "账户菜单" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "充值" })).toBeTruthy();
    expect(screen.getByText("$12.30")).toBeTruthy();
    // 账户是浮层，不切 destination。
    expect(
      screen.queryByRole("complementary", { name: "服务器列表" }),
    ).toBeNull();
    expect(screen.getByText("从哪里开始？")).toBeTruthy();
  }, 15_000);

  it("主动退出只提示已退出登录，不误报登录过期", async () => {
    localStorage.setItem(
      "veyl.mock.account",
      JSON.stringify({ logged_in: true, email: "buyer@example.com" }),
    );
    vi.spyOn(bridge, "myServerAccount").mockResolvedValue({
      logged_in: true,
      email: "buyer@example.com",
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "email",
    });
    vi.spyOn(bridge, "myServerWallet").mockResolvedValue({
      balance_cents: 1230,
      currency: "USD",
      denominations_cents: [1000],
      updated_at: new Date(0).toISOString(),
    });
    vi.spyOn(bridge, "myServerList").mockResolvedValue({ servers: [] });
    vi.spyOn(bridge, "myServerLogout").mockResolvedValue({
      logged_in: false,
      email: null,
      account_id: null,
      device_id: "dev_1",
      account_kind: "device",
    });

    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /账户/ }));
    await screen.findByRole("dialog", { name: "账户菜单" });
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(await screen.findByText("已退出登录")).toBeTruthy();
    expect(screen.queryByText("登录已过期，请重新登录。")).toBeNull();
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

describe("无节点时连接屏的登录提示", () => {
  it("未登录：说明行补一句建自己的服务器要先登录", async () => {
    await renderApp();

    expect(
      await screen.findByText(
        "免费节点不保证稳定，试用 7 天；建自己的服务器要先登录。",
      ),
    ).toBeTruthy();
  }, 15_000);

  it("已登录：说明行只留免费节点那句", async () => {
    localStorage.setItem(
      "veyl.mock.account",
      JSON.stringify({ logged_in: true, email: "buyer@example.com" }),
    );
    vi.spyOn(bridge, "myServerAccount").mockResolvedValue({
      logged_in: true,
      email: "buyer@example.com",
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "email",
    });

    await renderApp();

    expect(
      await screen.findByText("免费节点不保证稳定，试用 7 天。"),
    ).toBeTruthy();
    expect(screen.queryByText(/建自己的服务器要先登录/)).toBeNull();
  }, 15_000);

  it("账户读取失败：不回落到「要先登录」那句", async () => {
    vi.spyOn(bridge, "myServerAccount").mockRejectedValue({
      code: "NETWORK",
      message: "连不上。",
      retryable: true,
    });

    const container = await renderApp();
    // 账户错误已经落到界面（账户入口的红点），说明读取结束了。
    await waitFor(() =>
      expect(container.querySelector(".activity__dot")).not.toBeNull(),
    );

    expect(screen.getByText("免费节点不保证稳定，试用 7 天。")).toBeTruthy();
    expect(screen.queryByText(/建自己的服务器要先登录/)).toBeNull();
  }, 15_000);
});

describe("提问与发起屏幕绑定", () => {
  it("离开连接页折叠成一行，回来恢复；别处不能提交答案", async () => {
    seedCardConfig();
    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: "展开助手" }));
    const send = vi.spyOn(bridge, "sendMessage").mockResolvedValue({
      requestId: "req_q",
    });
    const reply = vi
      .spyOn(bridge, "replyUserQuestion")
      .mockResolvedValue(undefined);

    fireEvent.click(
      await screen.findByRole("button", { name: "连上了，但网页打不开" }),
    );
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sessionId = send.mock.calls[0][0] as string;

    act(() => {
      (
        bridge as unknown as { emit: (event: unknown) => void }
      ).emit({
        name: AGENT_EVENTS.askUserQuestion,
        payload: {
          contract_version: CONTRACT_VERSION,
          session_id: sessionId,
          request_id: "req_q",
          question_id: "q_away",
          question: "你主要用它做什么？",
          options: ["浏览网页", "桌面软件"],
          created_at: Date.now(),
          expires_at: Date.now() + 900_000,
          emitted_at: new Date().toISOString(),
        },
      });
    });

    expect(await screen.findByRole("button", { name: "浏览网页" })).toBeTruthy();

    // 切到服务器页：卡片折叠成一行只读提示，选项不再渲染。
    fireEvent.click(screen.getByRole("button", { name: "我的服务器" }));
    expect(
      await screen.findByRole("button", {
        name: "有一个问题在连接页等你回答",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "浏览网页" })).toBeNull();

    // 这一屏输入/回车不会变成答案。
    const textarea = document.querySelector(
      ".composer textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "在服务器页输入" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await act(async () => {});
    expect(reply).not.toHaveBeenCalled();

    // 点折叠行回到连接页，卡片恢复。
    fireEvent.click(
      screen.getByRole("button", { name: "有一个问题在连接页等你回答" }),
    );
    const option = await screen.findByRole("button", { name: "浏览网页" });
    expect(
      screen.queryByRole("button", { name: "有一个问题在连接页等你回答" }),
    ).toBeNull();

    fireEvent.click(option);
    await waitFor(() =>
      expect(reply).toHaveBeenCalledWith(sessionId, "q_away", "浏览网页"),
    );
  }, 15_000);

  it("确认弹窗开着时切屏，仍能作答并收起", async () => {
    seedCardConfig();
    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: "展开助手" }));
    const send = vi.spyOn(bridge, "sendMessage").mockResolvedValue({
      requestId: "req_confirm",
    });
    const reply = vi
      .spyOn(bridge, "replyUserQuestion")
      .mockResolvedValue(undefined);

    fireEvent.click(
      await screen.findByRole("button", { name: "连上了，但网页打不开" }),
    );
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sessionId = send.mock.calls[0][0] as string;

    act(() => {
      (
        bridge as unknown as { emit: (event: unknown) => void }
      ).emit({
        name: AGENT_EVENTS.askUserQuestion,
        payload: {
          contract_version: CONTRACT_VERSION,
          session_id: sessionId,
          request_id: "req_confirm",
          question_id: "q_confirm",
          question: "要更新后台运行库吗？",
          options: ["升级", "取消"],
          kind: "core_upgrade_confirm",
          details: {
            current_version: "1.0.0",
            target_version: "1.1.0",
            size: 1024,
            restart_required: false,
          },
          created_at: Date.now(),
          expires_at: Date.now() + 900_000,
          emitted_at: new Date().toISOString(),
        },
      });
    });

    await screen.findByRole("dialog", { name: "更新后台运行库" });
    // 模态打开期间切到服务器页：确认卡不参与屏幕绑定，不能被卡在提交中。
    fireEvent.click(screen.getByRole("button", { name: "我的服务器" }));
    fireEvent.click(screen.getByRole("button", { name: "升级" }));

    await waitFor(() =>
      expect(reply).toHaveBeenCalledWith(sessionId, "q_confirm", "升级"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "更新后台运行库" })).toBeNull(),
    );
  }, 15_000);
});
