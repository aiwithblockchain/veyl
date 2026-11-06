/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigDetail, HealthSnapshot, RuntimeView } from "../agent/protocol";
import { CONTRACT_VERSION } from "../agent/protocol";
import { emptyRuntimeView } from "../agent/bridge";
import { Console } from "./Console";

afterEach(cleanup);

const HEALTHY: HealthSnapshot = {
  contract_version: CONTRACT_VERSION,
  process: true,
  clash_api: true,
  data_plane: true,
  exit_ip: "203.0.113.9",
  consecutive_failures: 0,
  checked_at: "2026-11-05T10:00:00Z",
};

const NODES: ConfigDetail["nodes"] = [
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

function makeConfig(over: Partial<ConfigDetail> = {}): ConfigDetail {
  return {
    config_id: "cfg-1",
    name: "测试配置",
    connect_mode: "system_proxy",
    routing_mode: "direct",
    node_count: NODES.length,
    listen_port: 2080,
    is_active: true,
    current_node_id: "n-tokyo",
    created_at: 0,
    updated_at: 0,
    last_used_at: null,
    nodes: NODES,
    dns: { mode: "auto", local: [], remote: [] },
    tun_excludes: [],
    layout: null,
    ...over,
  } as ConfigDetail;
}

function makeRuntime(over: Partial<RuntimeView> = {}): RuntimeView {
  return { ...emptyRuntimeView(), health: { ...HEALTHY }, ...over };
}

function failedRuntime(code: string, over: Partial<RuntimeView> = {}): RuntimeView {
  return makeRuntime({
    state: "failed",
    last_error: {
      contract_version: CONTRACT_VERSION,
      code: code as never,
      message: "RUNTIME_PORT_UNAVAILABLE: listen 127.0.0.1:7890",
      retryable: false,
      details: null,
      request_id: "r1",
    },
    ...over,
  });
}

const noop = () => {};
const never = async () => ({ ok: false, latencyMs: null, unreachable: false });
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

function renderConsole(
  config: ConfigDetail,
  runtime: RuntimeView,
  aiReady = true,
  failedAfterConnected = false,
): HTMLElement {
  const { container } = render(
    <Console
      config={config}
      onStart={noop}
      onStop={noop}
      onSwitchNode={async () => ({ ok: true })}
      onProbe={never}
      nodeProbes={emptyProbes}
      nodeProbeAvailable={false}
      aiReady={aiReady}
      justOnboarded={false}
      zeroConfigSettled
      hasConfigs
      onAskAi={noop}
      onNewConfig={noop}
      runtime={runtime}
      failedAfterConnected={failedAfterConnected}
    />,
  );
  return container;
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function body(root: HTMLElement): HTMLElement {
  return root.querySelector(".console__body") as HTMLElement;
}

describe("中间区验收用例", () => {
  it("1 未连接 tun：一句话说明所有软件都会走节点", () => {
    const root = renderConsole(makeConfig({ connect_mode: "tun" }), makeRuntime());
    expect(text(body(root).querySelector(".note"))).toBe(
      "点上面的「启动 VPN」，所有软件都会自动走节点。",
    );
    expect(body(root).querySelector(".card")).toBeNull();
    expect(body(root).querySelector(".state-word")?.textContent).toBe("未连接");
  });

  it("2 未连接 system_proxy + proxy_all", () => {
    const root = renderConsole(makeConfig({ routing_mode: "proxy_all" }), makeRuntime());
    expect(text(body(root).querySelector(".note"))).toBe(
      "点上面的「启动 VPN」，浏览器就能用了。所有流量都会从节点出去。",
    );
  });

  it("3 未连接代理用户：预计地址，不可复制", () => {
    const root = renderConsole(
      makeConfig({ routing_mode: "proxy_selected", listen_port: 7890 }),
      makeRuntime(),
    );
    const card = body(root).querySelector(".card--proxy");
    expect(text(card)).toContain("连上后，这里会给你一个代理地址");
    expect(text(body(root).querySelector(".proxy__addr"))).toBe("127.0.0.1:7890");
    expect(body(root).querySelector(".copy-btn")).toBeNull();
    expect(text(card)).toContain("实际端口连上后确认；被占用会自动换。");
  });

  it("4 已连接代理用户：实际端口可复制，不再说浏览器能用了", () => {
    const root = renderConsole(
      makeConfig({ routing_mode: "proxy_selected", listen_port: 7890 }),
      makeRuntime({ state: "running", mixed_port: 7891 }),
    );
    const card = body(root).querySelector(".card--proxy");
    expect(text(card)).toContain("代理已经开好");
    expect(text(body(root).querySelector(".proxy__addr"))).toBe("127.0.0.1:7891");
    expect(text(body(root))).not.toContain("127.0.0.1:7890");
    expect(body(root).querySelector(".copy-btn")).not.toBeNull();
    expect(body(root).querySelector(".copy-btn [aria-live='polite']")).not.toBeNull();
    expect(text(body(root))).not.toContain("浏览器现在能用了");
  });

  it("5 已连接 system_proxy + proxy_all：浏览器现在能用了", () => {
    const root = renderConsole(
      makeConfig({ routing_mode: "proxy_all" }),
      makeRuntime({ state: "running", mixed_port: 7891 }),
    );
    expect(text(body(root).querySelector(".note"))).toBe("浏览器现在能用了。");
  });

  it("6 已连接 tun：所有软件现在都能用了", () => {
    const root = renderConsole(
      makeConfig({ connect_mode: "tun" }),
      makeRuntime({ state: "running", mixed_port: 7891 }),
    );
    expect(text(body(root).querySelector(".note"))).toBe("所有软件现在都能用了。");
  });

  it("7 失败：H1 连接失败 + 原因 + 三步自救，卡里没有按钮", () => {
    const root = renderConsole(makeConfig(), failedRuntime("RUNTIME_PORT_UNAVAILABLE"));
    expect(text(body(root).querySelector(".state-word"))).toBe("连接失败");
    expect(text(body(root).querySelector(".hero__caption"))).toBe("没有连上节点。");
    const card = body(root).querySelector(".card--err");
    expect(text(card?.querySelector(".card__lead"))).toBe(
      "本机用来做代理的端口被别的软件占用了。",
    );
    const steps = Array.from(card?.querySelectorAll(".recovery__row") ?? []).map((row) =>
      text(row.querySelector("strong")),
    );
    expect(steps).toEqual(["重新连接", "换一个节点", "让助手定位"]);
    expect(card?.querySelector("button")).toBeNull();
    expect(text(body(root))).not.toContain("RUNTIME_PORT_UNAVAILABLE");
    expect(text(body(root).querySelector(".hero .btn"))).toBe("重新连接");
  });

  it("8 失败无错误码、流量没出去、单节点、AI 可用：第一步与助手指路", () => {
    const root = renderConsole(
      makeConfig({ nodes: [NODES[0]] }),
      makeRuntime({ state: "failed", health: { ...HEALTHY, data_plane: false } }),
    );
    const card = body(root).querySelector(".card--err");
    expect(text(card?.querySelector(".card__lead"))).toBe(
      "已经连上节点，但流量没有真正出去。",
    );
    const steps = Array.from(card?.querySelectorAll(".recovery__row") ?? []).map((row) =>
      text(row.querySelector("strong")),
    );
    expect(steps).toEqual(["重新连接", "让助手定位"]);
  });

  it("9 降级：H1 连接不稳定，提示卡在代理卡前面", () => {
    const root = renderConsole(
      makeConfig({ routing_mode: "proxy_selected" }),
      makeRuntime({
        state: "degraded",
        mixed_port: 7891,
        health: { ...HEALTHY, consecutive_failures: 2 },
      }),
    );
    expect(text(body(root).querySelector(".state-line__label"))).toBe("连接不稳定");
    const cards = Array.from(body(root).querySelectorAll(".card"));
    expect(cards).toHaveLength(2);
    expect(cards[0].className).toContain("card--warn");
    expect(cards[1].className).toContain("card--proxy");
    expect(text(cards[0].querySelector(".card__lead"))).toBe(
      "最近的网络检查没有通过。",
    );
  });

  it("9b 降级速率条转琥珀", () => {
    const root = renderConsole(
      makeConfig(),
      makeRuntime({
        state: "degraded",
        health: { ...HEALTHY, consecutive_failures: 2 },
      }),
    );
    expect(body(root).querySelector(".strip--warn")).not.toBeNull();
  });

  it("10 过渡态：中间没有块，也没有读数行", () => {
    const root = renderConsole(makeConfig({ connect_mode: "tun" }), makeRuntime({ state: "starting" }));
    expect(body(root).querySelector(".card")).toBeNull();
    expect(body(root).querySelector(".note")).toBeNull();
    expect(body(root).querySelector(".ledger")).toBeNull();
  });

  it("11 layout.blocks 为空：本地规则不覆盖，保持空白", () => {
    const root = renderConsole(
      makeConfig({ layout: { version: 1, blocks: [] } }),
      makeRuntime({ state: "running", mixed_port: 7891 }),
    );
    expect(body(root).querySelector(".card")).toBeNull();
    expect(body(root).querySelector(".note")).toBeNull();
  });

  it("12 没有节点：一句原因，动作留给助手", () => {
    const root = renderConsole(makeConfig({ nodes: [], node_count: 0 }), makeRuntime());
    expect(text(body(root).querySelector(".note"))).toBe("这套配置还没有节点。");
    expect(body(root).querySelector(".ledger")).toBeNull();
    expect(root.querySelector(".node-card__empty")?.textContent).toBe("还没有节点");
  });

  it("12b 节点卡只有一个入口：整行打开列表，动作只剩测这个节点", () => {
    const root = renderConsole(makeConfig(), makeRuntime());
    const actions = Array.from(root.querySelectorAll(".node-card__actions button"));
    expect(actions.map((button) => button.textContent)).toEqual(["测这个节点"]);
    // 视觉上不能变成主按钮：同屏唯一主按钮仍是顶部连接。
    expect(actions[0].className).toContain("btn--ghost");
    expect(actions[0].className).not.toContain("btn--primary");
    expect(
      Array.from(root.querySelectorAll("button")).some(
        (button) => button.textContent === "选择节点",
      ),
    ).toBe(false);
    const trigger = root.querySelector(".node-card__select");
    expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger as Element);
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
  });

  it("13 layout.blocks 非空：不在本次范围，不硬塞本地块", () => {
    const root = renderConsole(
      makeConfig({ layout: { version: 1, blocks: [{ type: "empty_hint" }] } }),
      makeRuntime(),
    );
    expect(body(root).querySelector(".card")).toBeNull();
    expect(body(root).querySelector(".note")).toBeNull();
  });

  it("14 老后端不带 layout 字段：仍按未编排处理", () => {
    const root = renderConsole(
      makeConfig({ layout: undefined as unknown as ConfigDetail["layout"] }),
      makeRuntime(),
    );
    expect(text(body(root).querySelector(".note"))).toBe(
      "点上面的「启动 VPN」，浏览器就能用了。",
    );
  });

  it("7b 从已连接态掉下来：副标题写连接断了", () => {
    const root = renderConsole(makeConfig(), failedRuntime("RUNTIME_EXITED"), true, true);
    expect(text(body(root).querySelector(".hero__caption"))).toBe("连接断了。");
  });

  it("7c 从来没连上：副标题写没有连上节点", () => {
    const root = renderConsole(makeConfig(), failedRuntime("RUNTIME_EXITED"), true, false);
    expect(text(body(root).querySelector(".hero__caption"))).toBe("没有连上节点。");
  });
});
