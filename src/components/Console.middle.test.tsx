/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ConfigDetail,
  HealthSnapshot,
  RuntimeView,
} from "../agent/protocol";
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

function renderConsole(
  config: ConfigDetail,
  runtime: RuntimeView,
  aiReady = true,
  failedAfterConnected = false,
): HTMLElement {
  const connection =
    runtime.state === "running" || runtime.state === "degraded"
      ? "connected"
      : runtime.state === "starting"
        ? "starting"
        : "idle";
  const { container } = render(
    <Console
      config={config}
      connection={connection}
      onStart={noop}
      onStop={noop}
      onSwitchNode={noop}
      onProbe={never}
      nodeSwitchAvailable={false}
      nodeProbeAvailable={false}
      panelOpen={false}
      aiUnread={false}
      onTogglePanel={noop}
      aiReady={aiReady}
      justOnboarded={false}
      zeroConfigSettled
      hasConfigs
      onAskAi={noop}
      onNewConfig={noop}
      loading={false}
      runtime={runtime}
      failedAfterConnected={failedAfterConnected}
    />,
  );
  return container.querySelector(".console-mid") as HTMLElement;
}

function text(el: HTMLElement): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function query(el: HTMLElement, selector: string): HTMLElement | null {
  return el.querySelector(selector);
}

describe("§9 中间区验收用例", () => {
  it("1 未连接 tun：一句话，居中容器", () => {
    const mid = renderConsole(makeConfig({ connect_mode: "tun" }), makeRuntime());
    expect(text(mid)).toBe("点上面的「启动 VPN」，所有软件都会自动走节点。");
    expect(query(mid, ".console-mid__hint")).not.toBeNull();
    expect(query(mid, ".console-hint")).not.toBeNull();
    expect(query(mid, ".console-card")).toBeNull();
    expect(mid.className).not.toContain("console-mid--stacked");
  });

  it("2 未连接 system_proxy + proxy_all", () => {
    const mid = renderConsole(makeConfig({ routing_mode: "proxy_all" }), makeRuntime());
    expect(text(mid)).toBe(
      "点上面的「启动 VPN」，浏览器就能用了。所有流量都会从节点出去。",
    );
  });

  it("3 未连接代理用户：预计地址，不可复制", () => {
    const mid = renderConsole(
      makeConfig({ routing_mode: "proxy_selected", listen_port: 7890 }),
      makeRuntime(),
    );
    expect(text(mid)).toContain("连上后，这里会给你一个代理地址");
    expect(text(mid)).toContain("预计地址");
    expect(text(mid)).toContain("127.0.0.1:7890");
    expect(text(mid)).toContain("实际端口连上后确认；被占用会自动换。");
    expect(query(mid, ".console-card__copy")).toBeNull();
    expect(query(mid, ".console-card--proxy")?.getAttribute("aria-label")).toBe(
      "预计地址",
    );
    expect(mid.className).toContain("console-mid--stacked");
  });

  it("4 已连接代理用户：实际端口可复制，不再说浏览器能用了", () => {
    const mid = renderConsole(
      makeConfig({ routing_mode: "proxy_selected", listen_port: 7890 }),
      makeRuntime({ state: "running", mixed_port: 7891 }),
    );
    expect(text(mid)).toContain("代理已经开好");
    expect(text(mid)).toContain("本机代理地址");
    expect(text(mid)).toContain("127.0.0.1:7891");
    expect(text(mid)).not.toContain("127.0.0.1:7890");
    expect(query(mid, ".console-card__copy")).not.toBeNull();
    expect(text(mid)).not.toContain("浏览器现在能用了");
    expect(query(mid, ".console-card--proxy")?.getAttribute("aria-label")).toBe(
      "本机代理地址",
    );
    expect(query(mid, ".console-card__copy [aria-live='polite']")).not.toBeNull();
  });

  it("5 已连接 system_proxy + proxy_all：浏览器现在能用了", () => {
    const mid = renderConsole(
      makeConfig({ routing_mode: "proxy_all" }),
      makeRuntime({ state: "running", mixed_port: 7891 }),
    );
    expect(text(mid)).toBe("浏览器现在能用了。");
  });

  it("6 已连接 tun：所有软件现在都能用了", () => {
    const mid = renderConsole(
      makeConfig({ connect_mode: "tun" }),
      makeRuntime({ state: "running", mixed_port: 7891 }),
    );
    expect(text(mid)).toBe("所有软件现在都能用了。");
  });

  it("7 失败：本次没连上 / 端口被占 / 换节点", () => {
    const mid = renderConsole(makeConfig(), failedRuntime("RUNTIME_PORT_UNAVAILABLE"));
    const card = query(mid, ".console-card--issue");
    expect(card).not.toBeNull();
    expect(text(card as HTMLElement)).toContain("这次没有连上。");
    expect(text(card as HTMLElement)).toContain(
      "本机用来做代理的端口被别的软件占用了。",
    );
    expect(text(card as HTMLElement)).toContain(
      "先点上面的「重新连接」。还是不行，就换下面的节点再试。",
    );
    expect(text(card as HTMLElement)).not.toContain("RUNTIME_PORT_UNAVAILABLE");
    expect(query(mid, "button")).toBeNull();
    const root = mid.closest(".console") as HTMLElement;
    expect(text(root.querySelector(".console-top__primary") as HTMLElement)).toBe(
      "重新连接",
    );
    expect(mid.className).toContain("console-mid--stacked");
  });

  it("7b 从已连接态掉下来：标题写连接断了", () => {
    const mid = renderConsole(
      makeConfig(),
      failedRuntime("RUNTIME_EXITED"),
      true,
      true,
    );
    expect(text(query(mid, ".console-card--issue") as HTMLElement)).toContain(
      "连接断了。",
    );
  });

  it("7c 从来没连上：标题写这次没有连上", () => {
    const mid = renderConsole(
      makeConfig(),
      failedRuntime("RUNTIME_EXITED"),
      true,
      false,
    );
    expect(text(query(mid, ".console-card--issue") as HTMLElement)).toContain(
      "这次没有连上。",
    );
  });

  it("8 失败无错误码、流量没出去、单节点、AI 可用：指向对话", () => {
    const mid = renderConsole(
      makeConfig({ nodes: [NODES[0]] }),
      makeRuntime({
        state: "failed",
        health: { ...HEALTHY, data_plane: false },
      }),
    );
    const card = text(query(mid, ".console-card--issue") as HTMLElement);
    expect(card).toContain("这次没有连上。");
    expect(card).toContain("已经连上节点，但流量没有真正出去。");
    expect(card).toContain(
      "先点上面的「重新连接」。还是不行，就在右侧对话里说「帮我看看为什么连不上」。",
    );
  });

  it("9 降级：提示卡排第一，原因取连续失败", () => {
    const mid = renderConsole(
      makeConfig(),
      makeRuntime({
        state: "degraded",
        health: { ...HEALTHY, consecutive_failures: 2 },
      }),
    );
    const card = query(mid, ".console-card--issue");
    expect(card).not.toBeNull();
    expect(text(card as HTMLElement)).toContain("连接不太稳定。");
    expect(text(card as HTMLElement)).toContain("最近的网络检查没有通过。");
    expect(text(card as HTMLElement)).toContain(
      "能继续用就先不动；网页打不开时，点上面的「断开 VPN」再重新连接。",
    );
  });

  it("9b 降级 + 代理用户：降级卡在代理卡前面", () => {
    const mid = renderConsole(
      makeConfig({ routing_mode: "proxy_selected" }),
      makeRuntime({
        state: "degraded",
        mixed_port: 7891,
        health: { ...HEALTHY, consecutive_failures: 1 },
      }),
    );
    const cards = Array.from(mid.querySelectorAll(".console-card"));
    expect(cards).toHaveLength(2);
    expect(cards[0].className).toContain("console-card--issue");
    expect(cards[1].className).toContain("console-card--proxy");
  });

  it("10 过渡态：中间没有任何块", () => {
    const mid = renderConsole(
      makeConfig({ connect_mode: "tun" }),
      makeRuntime({ state: "starting" }),
    );
    expect(text(mid)).toBe("");
    expect(query(mid, ".console-card")).toBeNull();
    expect(query(mid, ".console-hint")).toBeNull();
  });

  it("11 layout.blocks 为空：本地规则不覆盖，保持空白", () => {
    const mid = renderConsole(
      makeConfig({ layout: { version: 1, blocks: [] } }),
      makeRuntime({ state: "running", mixed_port: 7891 }),
    );
    expect(text(mid)).toBe("");
    expect(query(mid, ".console-card")).toBeNull();
    expect(query(mid, ".console-hint")).toBeNull();
  });

  it("12 没有节点：一句话指路", () => {
    const mid = renderConsole(
      makeConfig({ nodes: [], node_count: 0 }),
      makeRuntime(),
    );
    expect(text(mid)).toBe("让右侧的助手帮你加一个节点，或者新建一套配置。");
  });

  it("13 layout.blocks 非空：不在本次范围，不硬塞本地块", () => {
    const mid = renderConsole(
      makeConfig({
        layout: { version: 1, blocks: [{ type: "empty_hint" }] },
      }),
      makeRuntime(),
    );
    expect(text(mid)).toBe("");
  });

  it("14 老后端不带 layout 字段：仍按未编排处理", () => {
    const mid = renderConsole(
      makeConfig({ layout: undefined as unknown as ConfigDetail["layout"] }),
      makeRuntime(),
    );
    expect(text(mid)).toBe("点上面的「启动 VPN」，浏览器就能用了。");
  });
});
