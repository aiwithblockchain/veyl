/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ConfigDetail,
  NodeSummary,
  RuntimeView,
} from "../agent/protocol";
import { CONTRACT_VERSION } from "../agent/protocol";
import { emptyRuntimeView } from "../agent/bridge";
import { Console } from "./Console";

afterEach(cleanup);

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

function makeConfig(
  currentNodeId: string | null,
  nodes: NodeSummary[] = NODES,
): ConfigDetail {
  return {
    config_id: "cfg-1",
    name: "测试配置",
    connect_mode: "proxy",
    routing_mode: "rule",
    node_count: nodes.length,
    listen_port: 2080,
    is_active: true,
    current_node_id: currentNodeId,
    created_at: 0,
    updated_at: 0,
    last_used_at: null,
    nodes,
    dns: { mode: "auto", servers: [] },
    tun_excludes: [],
    layout: null,
  } as unknown as ConfigDetail;
}

function makeRuntime(over: Partial<RuntimeView> = {}): RuntimeView {
  return { ...emptyRuntimeView(), ...over };
}

const noop = () => {};
const never = async () => ({ ok: false, latencyMs: null, unreachable: false });

interface RenderOptions {
  connection?: "idle" | "starting" | "connected" | "stopping";
  runtime?: RuntimeView;
  config?: ConfigDetail | null;
  loading?: boolean;
}

function consoleElement(config: ConfigDetail | null, opts: RenderOptions) {
  return (
    <Console
      config={config}
      connection={opts.connection ?? "idle"}
      onStart={noop}
      onStop={noop}
      onSwitchNode={noop}
      onProbe={never}
      nodeSwitchAvailable={false}
      nodeProbeAvailable={false}
      panelOpen={false}
      aiUnread={false}
      onTogglePanel={noop}
      aiReady
      justOnboarded={false}
      zeroConfigSettled
      hasConfigs={Boolean(config)}
      onAskAi={noop}
      onNewConfig={noop}
      loading={opts.loading}
      runtime={opts.runtime ?? makeRuntime()}
    />
  );
}

function renderConsole(opts: RenderOptions) {
  const config = opts.config === undefined ? makeConfig("n-tokyo") : opts.config;
  const utils = render(consoleElement(config, opts));
  const summary = utils.container.querySelector(".console-summary");
  return {
    ...utils,
    summary,
    summaryText: (summary?.textContent ?? "").replace(/\s+/g, " ").trim(),
    cardText: (utils.container.querySelector(".console-node")?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    stats: utils.container.querySelector(".console-node__stats"),
    offline: utils.container.querySelector(".console-node__offline"),
    currentLine: utils.container.querySelector(".console-node__current"),
    tech: utils.container.querySelector(".console-node__tech"),
  };
}

describe("状态矩阵", () => {
  it("1 未连接：无摘要行，卡片显示未连接，可开技术详情", () => {
    const r = renderConsole({ connection: "idle" });
    expect(r.summary).toBeNull();
    expect(r.offline?.textContent).toBe("未连接");
    expect(r.stats).toBeNull();
    expect(r.tech).not.toBeNull();
    expect(r.cardText).not.toContain("已用");
  });

  it("2 连接中：无摘要行，卡片写正在连接", () => {
    const r = renderConsole({ connection: "starting" });
    expect(r.summary).toBeNull();
    expect(r.offline?.textContent).toBe("正在连接");
  });

  it("2b 断开中：无摘要行，卡片写正在断开", () => {
    const r = renderConsole({ connection: "stopping" });
    expect(r.summary).toBeNull();
    expect(r.offline?.textContent).toBe("正在断开");
  });

  it("3 刚连上：四个占位都在", () => {
    const r = renderConsole({
      connection: "connected",
      runtime: makeRuntime({ state: "running" }),
    });
    console.log("[state 3] summary:", r.summaryText);
    expect(r.summaryText).toContain("刚刚");
    expect(r.summaryText).toContain("已用 —");
    expect(r.summaryText).toContain("延迟确认中…");
    expect(r.summaryText).toContain("正在确认出口…");
  });

  it("4 稳定后：四个数都来自 runtime", () => {
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const r = renderConsole({
      connection: "connected",
      runtime: makeRuntime({
        state: "running",
        connected_since: since,
        latency_ms: 42,
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
    console.log("[state 4] summary:", r.summaryText);
    expect(r.summaryText).toContain("5 分钟");
    expect(r.summaryText).toContain("已用 1.0 MB");
    expect(r.summaryText).toContain("延迟 42 毫秒");
    expect(r.summaryText).toContain("203.0.113.9");
    expect(r.summaryText).not.toContain("—");
  });

  it("6 断开瞬间：摘要和统计都清掉", () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const r = renderConsole({
      connection: "idle",
      runtime: makeRuntime({
        connected_since: since,
        traffic: {
          up_bytes: 1000,
          down_bytes: 2000,
          up_rate: 0,
          down_rate: 0,
          sampled_at: new Date().toISOString(),
        },
      }),
    });
    console.log("[state 6] card:", r.cardText);
    expect(r.summary).toBeNull();
    expect(r.stats).toBeNull();
    expect(r.cardText).not.toContain("1 KB");
    expect(r.cardText).not.toContain("已用");
    expect(r.cardText).not.toContain("分钟");
  });

  it("7 流量为 null：三处都不能是 0 B", () => {
    const r = renderConsole({
      connection: "connected",
      runtime: makeRuntime({ state: "running" }),
    });
    expect(r.summaryText).toContain("已用 —");
    expect(r.summaryText).not.toContain("0 B");
    const ds = Array.from(r.stats?.querySelectorAll("dd") ?? []).map(
      (d) => d.textContent,
    );
    console.log("[state 7] stats dd:", ds);
    expect(ds[0]).toBe("—");
    expect(r.cardText).not.toContain("0 B");
  });

  it("5a 选中别的节点：只显示当前线路，选中节点没有流量/延迟", () => {
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const r = renderConsole({
      connection: "connected",
      runtime: makeRuntime({
        state: "running",
        connected_since: since,
        latency_ms: 42,
        traffic: {
          up_bytes: 0,
          down_bytes: 1_048_576,
          up_rate: 0,
          down_rate: 0,
          sampled_at: new Date().toISOString(),
        },
      }),
    });
    fireEvent.click(r.container.querySelector(".console-node__name")!);
    const items = Array.from(
      r.container.querySelectorAll<HTMLButtonElement>(".node-picker__item"),
    );
    fireEvent.click(items.find((el) => el.textContent?.includes("大阪 02"))!);
    const current = r.container.querySelector(".console-node__current");
    const cardText = (
      r.container.querySelector(".console-node")?.textContent ?? ""
    )
      .replace(/\s+/g, " ")
      .trim();
    console.log("[state 5] current:", current?.textContent);
    console.log("[state 5] card:", cardText);
    expect(r.container.querySelector(".console-node__stats")).toBeNull();
    expect(cardText).not.toContain("已用流量");
    expect(cardText).not.toContain("延迟");
    expect(cardText).toContain("当前线路");
    expect(cardText).toContain("东京 01");
    expect(cardText).toContain("5 分钟");
    expect(cardText).toContain("1.0 MB");
  });

  it("8 加载中：骨架出现，真实卡片不出现", () => {
    const r = renderConsole({ loading: true });
    expect(r.container.querySelector(".console-node__skeleton")).not.toBeNull();
    expect(r.tech).toBeNull();
  });

  it("9 选中的节点消失：回退到当前节点", () => {
    const r = renderConsole({});
    fireEvent.click(r.container.querySelector(".console-node__name")!);
    const items = Array.from(
      r.container.querySelectorAll<HTMLButtonElement>(".node-picker__item"),
    );
    fireEvent.click(items.find((el) => el.textContent?.includes("大阪 02"))!);
    expect(r.container.querySelector(".console-node__current")).not.toBeNull();

    r.rerender(consoleElement(makeConfig("n-tokyo", NODES.slice(0, 1)), {}));
    const cardText = (
      r.container.querySelector(".console-node")?.textContent ?? ""
    )
      .replace(/\s+/g, " ")
      .trim();
    expect(cardText).toContain("东京 01");
    expect(cardText).not.toContain("还没有节点");
    expect(r.container.querySelector(".console-node__badge")?.textContent).toBe(
      "当前使用",
    );
  });
});
