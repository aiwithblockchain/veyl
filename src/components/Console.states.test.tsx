/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigDetail, NodeSummary, RuntimeView } from "../agent/protocol";
import { CONTRACT_VERSION } from "../agent/protocol";
import { emptyRuntimeView } from "../agent/bridge";
import { Console } from "./Console";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NODES: NodeSummary[] = [
  {
    node_id: "n-tokyo",
    name: "东京 01",
    server: "tokyo.example.com",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "seed",
    created_at: 0,
  },
  {
    node_id: "n-osaka",
    name: "大阪 02",
    server: "osaka.example.com",
    port: 8389,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "seed",
    created_at: 0,
  },
];

function makeConfig(currentNodeId: string | null): ConfigDetail {
  return {
    config_id: "cfg-1",
    name: "测试配置",
    connect_mode: "system_proxy",
    routing_mode: "direct",
    node_count: NODES.length,
    listen_port: 2080,
    is_active: true,
    current_node_id: currentNodeId,
    created_at: 0,
    updated_at: 0,
    last_used_at: null,
    nodes: NODES,
    dns: { mode: "auto", local: [], remote: [] },
    tun_excludes: [],
    layout: null,
  } as ConfigDetail;
}

function makeRuntime(over: Partial<RuntimeView> = {}): RuntimeView {
  return { ...emptyRuntimeView(), ...over };
}

const noop = () => {};
const never = async () => ({ ok: false, latencyMs: null, unreachable: false });
const switchNode = vi.fn(async () => ({ ok: true }));
const emptyProbes = {
  results: {},
  run: null,
  probing: new Set<string>(),
  finished: null,
  notice: null,
  available: true,
  loadSnapshot: async () => {},
  start: async () => ({ ok: true }),
  cancel: async () => {},
  clearNotice: () => {},
};

afterEach(() => {
  switchNode.mockClear();
});

interface RenderOptions {
  runtime?: RuntimeView;
  config?: ConfigDetail | null;
  loading?: boolean;
  failedAfterConnected?: boolean;
  helperPreparing?: boolean;
}

function consoleElement(config: ConfigDetail | null, opts: RenderOptions) {
  return (
    <Console
      config={config}
      onStart={noop}
      onStop={noop}
      onSwitchNode={switchNode}
      onProbe={never}
      nodeProbes={emptyProbes}
      nodeProbeAvailable={false}
      aiReady
      justOnboarded={false}
      zeroConfigSettled
      hasConfigs={Boolean(config)}
      onAskAi={noop}
      onNewConfig={noop}
      loading={opts.loading}
      runtime={opts.runtime ?? makeRuntime()}
      failedAfterConnected={opts.failedAfterConnected}
      helperPreparing={opts.helperPreparing}
    />
  );
}

function renderConsole(opts: RenderOptions) {
  const config = opts.config === undefined ? makeConfig("n-tokyo") : opts.config;
  const utils = render(consoleElement(config, opts));
  const text = (selector: string) =>
    (utils.container.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
  const rows = Array.from(utils.container.querySelectorAll(".ledger__row")).map((row) => ({
    label: row.querySelector("dt")?.textContent ?? "",
    value: row.querySelector(".ledger__value")?.textContent ?? "",
    sub: row.querySelector(".ledger__sub")?.textContent ?? "",
  }));
  return {
    ...utils,
    text,
    rows,
    stateWord: utils.container.querySelector(".state-word")?.textContent ?? "",
    timecode: utils.container.querySelector(".timecode")?.textContent ?? null,
    caption: text(".hero__caption"),
    cardText: () => text(".node-card"),
    note: text(".note"),
    card: utils.container.querySelector(".card"),
  };
}

describe("状态矩阵", () => {
  it("1 未连接：H1 未连接，读数行是方式 / 范围 / 节点", () => {
    const r = renderConsole({});
    expect(r.stateWord).toBe("未连接");
    expect(r.timecode).toBeNull();
    expect(r.rows.map((row) => row.label)).toEqual(["方式", "范围", "节点"]);
    expect(r.rows[0].value).toBe("浏览器代理");
    expect(r.rows[2].value).toBe("2 个可选");
    expect(r.text(".hero .btn")).toBe("启动 VPN");
  });

  it("2 连接中：H1 正在连接 + 进度线 + 取消", () => {
    const r = renderConsole({ runtime: makeRuntime({ state: "starting" }) });
    expect(r.stateWord).toBe("正在连接");
    expect(r.container.querySelector(".progress")).not.toBeNull();
    expect(r.text(".hero .btn")).toBe("取消");
    expect(r.container.querySelector(".ledger")).toBeNull();
  });

  it("2b 断开中：H1 正在断开，按钮禁用", () => {
    const r = renderConsole({ runtime: makeRuntime({ state: "stopping" }) });
    expect(r.stateWord).toBe("正在断开");
    const button = r.container.querySelector<HTMLButtonElement>(".hero .btn");
    expect(button?.textContent).toBe("正在断开…");
    expect(button?.disabled).toBe(true);
  });

  it("2c 准备后台组件：先说会请求授权，按钮禁用", () => {
    const r = renderConsole({ helperPreparing: true });
    expect(r.stateWord).toBe("正在准备后台组件");
    expect(r.caption).toBe("系统会请求一次授权。");
    const button = r.container.querySelector<HTMLButtonElement>(".hero .btn");
    expect(button?.textContent).toBe("启动 VPN");
    expect(button?.disabled).toBe(true);
    expect(r.container.querySelector('[role="status"]')?.textContent).toBe(
      "正在准备后台组件，系统会请求一次授权",
    );
  });

  it("3 刚连上：计时器 00:00:00，读数都是占位", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
    const r = renderConsole({
      runtime: makeRuntime({ state: "running", connected_since: new Date().toISOString() }),
    });
    expect(r.timecode).toBe("00:00:00");
    expect(r.rows.map((row) => row.label)).toEqual(["流量", "延迟", "出口"]);
    expect(r.rows[0].value).toBe("—");
    expect(r.rows[1].value).toBe("—");
    expect(r.rows[2].value).toBe("—");
    expect(r.rows[2].sub).toBe("正在确认出口…");
  });

  it("4 稳定后：计时器、流量、延迟、出口都来自 runtime", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
    const since = new Date(Date.now() - 301_000).toISOString();
    const r = renderConsole({
      runtime: makeRuntime({
        state: "running",
        connected_since: since,
        node_latency_ms: 42,
        traffic: {
          up_bytes: 300000,
          down_bytes: 748576,
          up_rate: 0,
          down_rate: 0,
          sampled_at: new Date().toISOString(),
        },
        health: {
          contract_version: CONTRACT_VERSION,
          process: true,
          clash_api: true,
          data_plane: true,
          exit_ip: "203.0.113.9",
          consecutive_failures: 0,
          checked_at: new Date().toISOString(),
        } as RuntimeView["health"],
      }),
    });
    expect(r.timecode).toBe("00:05:01");
    expect(r.rows[0].value).toBe("1.0 MB");
    expect(r.rows[0].sub).toContain("上行 293 KB");
    expect(r.rows[1].value).toBe("42 ms");
    expect(r.rows[1].sub).toBe("刚刚检测");
    expect(r.rows[2].value).toBe("203.0.113.9");
    expect(r.text(".hero .btn")).toBe("断开 VPN");
  });

  it("6 断开瞬间：回到未连接读数行，不残留流量与计时器", () => {
    const r = renderConsole({
      runtime: makeRuntime({
        connected_since: new Date().toISOString(),
        traffic: {
          up_bytes: 1000,
          down_bytes: 2000,
          up_rate: 0,
          down_rate: 0,
          sampled_at: new Date().toISOString(),
        },
      }),
    });
    expect(r.timecode).toBeNull();
    expect(r.rows.map((row) => row.label)).toEqual(["方式", "范围", "节点"]);
    expect(r.text(".console")).not.toContain("上行");
    expect(r.text(".console")).not.toContain("已用");
  });

  it("7 流量为 null：显示破折号，不是 0 B", () => {
    const r = renderConsole({ runtime: makeRuntime({ state: "running" }) });
    expect(r.rows[0].value).toBe("—");
    expect(r.rows[0].sub).toBe("还没开始统计");
    expect(r.text(".console")).not.toContain("0 B");
  });

  it("5a 点节点行打开面板，点一行立即切换且面板不关", async () => {
    vi.useFakeTimers();
    const r = renderConsole({ runtime: makeRuntime({ state: "running" }) });
    fireEvent.click(r.container.querySelector(".node-card__select")!);
    expect(r.container.querySelector("#node-sheet")).not.toBeNull();
    expect(r.text(".node-card__label")).toBe("当前节点");
    expect(r.text(".node-card__select")).toContain("东京 01");
    expect(r.text(".node-card__select")).toContain("2 个节点");

    const rows = Array.from(r.container.querySelectorAll<HTMLElement>(".node-row"));
    fireEvent.click(rows.find((el) => el.textContent?.includes("大阪 02"))!);
    expect(switchNode).toHaveBeenCalledWith("n-osaka");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(r.container.querySelector("#node-sheet")).not.toBeNull();
    expect(r.text(".node-card__label")).toBe("当前节点");
  });

  it("8 加载中：骨架出现，真实卡片不出现", () => {
    const r = renderConsole({ loading: true });
    expect(r.container.querySelector(".skeleton--hero")).not.toBeNull();
    expect(r.container.querySelector(".node-card")).toBeNull();
  });

  it("9 节点变少后回退到当前节点", () => {
    const r = renderConsole({});
    fireEvent.click(r.container.querySelector(".node-card__select")!);
    expect(r.container.querySelectorAll(".node-row")).toHaveLength(2);

    r.rerender(
      consoleElement({ ...makeConfig("n-tokyo"), nodes: NODES.slice(0, 1) }, {}),
    );
    expect(r.container.querySelector("#node-sheet")).toBeNull();
    expect(r.text(".node-card__name")).toBe("东京 01");
    expect(r.cardText()).not.toContain("还没有节点");
  });

  it("10 延迟只显示节点延迟，出口探测耗时不上界面", () => {
    const r = renderConsole({
      runtime: makeRuntime({ state: "running", latency_ms: 999, node_latency_ms: 42 }),
    });
    expect(r.rows[1].value).toBe("42 ms");
    expect(r.text(".console")).not.toContain("999");

    const onlyExit = renderConsole({
      runtime: makeRuntime({ state: "running", latency_ms: 999 }),
    });
    expect(onlyExit.rows[1].value).toBe("—");
    expect(onlyExit.text(".console")).not.toContain("999");
  });
});
