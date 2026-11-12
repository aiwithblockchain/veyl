/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ConfigDetail,
  HealthSnapshot,
  Layout,
  RuntimeView,
} from "../agent/protocol";
import { CONTRACT_VERSION } from "../agent/protocol";
import { emptyRuntimeView } from "../agent/bridge";
import { DNS_NOTE_TEXT } from "../ui/middleArea";
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
    layout_revision: null,
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
  extra: {
    seedUpdate?: boolean;
    proxyPort?: number;
    region?: string | null;
    onImportNodes?: () => void;
  } = {},
): HTMLElement {
  const { container } = render(
    <Console
      config={config}
      onStart={noop}
      onStop={noop}
      onReconnect={noop}
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
      onImportNodes={extra.onImportNodes}
      seedUpdate={extra.seedUpdate ?? false}
      proxyPort={extra.proxyPort}
      region={extra.region}
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

function textButton(root: HTMLElement, label: string): Element {
  const button = Array.from(root.querySelectorAll("button")).find(
    (el) => (el.textContent ?? "").trim() === label,
  );
  if (!button) throw new Error(`找不到按钮：${label}`);
  return button;
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

  it("3 未连接代理用户：显示设置端口，不可复制", () => {
    const root = renderConsole(
      makeConfig({ routing_mode: "proxy_selected", listen_port: 9999 }),
      makeRuntime(),
      true,
      false,
      { proxyPort: 8080 },
    );
    const card = body(root).querySelector(".card--proxy");
    expect(text(card)).toContain("连上后，这里会给你一个代理地址");
    expect(text(body(root).querySelector(".proxy__addr"))).toBe("127.0.0.1:8080");
    expect(text(body(root))).not.toContain("9999");
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

  it("4b 端口被占用降级：说明里两个数字都来自字段", () => {
    const root = renderConsole(
      makeConfig({ routing_mode: "proxy_selected" }),
      makeRuntime({
        state: "running",
        mixed_port: 8081,
        port_fallback: { requested: 8080, actual: 8081, reason: "occupied" },
      }),
      true,
      false,
      { proxyPort: 8080 },
    );
    const card = body(root).querySelector(".card--proxy");
    expect(text(body(root).querySelector(".proxy__addr"))).toBe("127.0.0.1:8081");
    expect(text(card)).toContain(
      "你设置的 8080 被别的软件占用了，这次用的是 8081。",
    );
  });

  it("4d 低端口不可用：按权限原因说，不冒充被占用", () => {
    const root = renderConsole(
      makeConfig({ routing_mode: "proxy_selected" }),
      makeRuntime({
        state: "running",
        mixed_port: 7890,
        port_fallback: { requested: 80, actual: 7890, reason: "unavailable" },
      }),
      true,
      false,
      { proxyPort: 80 },
    );
    const card = body(root).querySelector(".card--proxy");
    expect(text(card)).toContain(
      "你设置的 80 用不了（需要管理员权限），这次用的是 7890。",
    );
    expect(text(card)).not.toContain("被别的软件占用了");
  });

  it("4c 正常连接：代理卡不出现顺延说明", () => {
    const root = renderConsole(
      makeConfig({ routing_mode: "proxy_selected" }),
      makeRuntime({ state: "running", mixed_port: 7890 }),
      true,
      false,
      { proxyPort: 7890 },
    );
    expect(text(body(root))).not.toContain("被别的软件占用了");
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
    const note = body(root).querySelector(".note");
    expect(text(note)).toContain("所有软件现在都能用了。");
    // 默认地区未知：直连口径如实说所有网站都走 VPN。
    expect(text(note?.querySelector(".note__detail"))).toBe(
      "没识别出你在哪个地区，所有网站都走 VPN",
    );
  });

  it("6b 已连接 + 本地直连 + cn：显示国内网站直连", () => {
    const root = renderConsole(
      makeConfig({ connect_mode: "tun", routing_mode: "direct" }),
      makeRuntime({ state: "running", route_region: "cn" }),
      true,
      false,
      { region: "cn" },
    );
    expect(text(body(root).querySelector(".note__detail"))).toBe(
      "国内网站直连，其他走 VPN",
    );
  });

  it("6d 已连接用 route_region：实时地区是 jp 也显示国内直连", () => {
    const root = renderConsole(
      makeConfig({ connect_mode: "tun", routing_mode: "direct" }),
      makeRuntime({ state: "running", route_region: "cn" }),
      true,
      false,
      { region: "jp" },
    );
    expect(text(body(root).querySelector(".note__detail"))).toBe(
      "国内网站直连，其他走 VPN",
    );
  });

  it("6e 已连接 route_region = null、实时地区 cn：仍显示未知那句", () => {
    const root = renderConsole(
      makeConfig({ connect_mode: "tun", routing_mode: "direct" }),
      makeRuntime({ state: "running", route_region: null }),
      true,
      false,
      { region: "cn" },
    );
    expect(text(body(root).querySelector(".note__detail"))).toBe(
      "没识别出你在哪个地区，所有网站都走 VPN",
    );
  });

  it("6c 切到全部走 VPN：直连口径那行消失", () => {
    const root = renderConsole(
      makeConfig({ connect_mode: "tun", routing_mode: "proxy_all" }),
      makeRuntime({ state: "running" }),
      true,
      false,
      { region: "cn" },
    );
    expect(body(root).querySelector(".note__detail")).toBeNull();
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

  it("13 布局里的 empty_hint：按布局渲染", () => {
    const root = renderConsole(
      makeConfig({ layout: { version: 1, blocks: [{ type: "empty_hint" }] } }),
      makeRuntime(),
    );
    expect(text(body(root).querySelector(".note"))).toBe(
      "点上面的「启动 VPN」，浏览器就能用了。",
    );
  });

  it("13b 布局里只有不认识的块：退回本地兜底", () => {
    const root = renderConsole(
      makeConfig({
        layout: {
          version: 1,
          blocks: [{ type: "banner" } as unknown as Layout["blocks"][number]],
        },
      }),
      makeRuntime(),
    );
    expect(text(body(root).querySelector(".note"))).toBe(
      "点上面的「启动 VPN」，浏览器就能用了。",
    );
  });

  it("13c 布局里只有 issue_card：跳过并退回本地兜底，不出两张卡", () => {
    const root = renderConsole(
      makeConfig({ layout: { version: 1, blocks: [{ type: "issue_card" }] } }),
      makeRuntime(),
    );
    expect(body(root).querySelector(".card")).toBeNull();
    expect(text(body(root).querySelector(".note"))).toBe(
      "点上面的「启动 VPN」，浏览器就能用了。",
    );
  });

  it("13d 不认识的块跳过，认识的块照常渲染", () => {
    const root = renderConsole(
      makeConfig({
        layout: {
          version: 1,
          blocks: [
            { type: "banner" } as unknown as Layout["blocks"][number],
            { type: "empty_hint" },
          ],
        },
      }),
      makeRuntime(),
    );
    expect(text(body(root).querySelector(".note"))).toBe(
      "点上面的「启动 VPN」，浏览器就能用了。",
    );
    expect(body(root).querySelector(".card")).toBeNull();
  });

  it("13i 失败时故障卡是叠加层：布局有内容也照常出现且排第一", () => {
    const root = renderConsole(
      makeConfig({ layout: { version: 1, blocks: [{ type: "empty_hint" }] } }),
      failedRuntime("RUNTIME_EXITED"),
    );
    const oneThing = body(root).querySelector(".one-thing") as HTMLElement;
    expect(oneThing.firstElementChild?.className).toContain("card");
    expect(text(body(root).querySelector(".note"))).toBe(
      "点上面的「启动 VPN」，浏览器就能用了。",
    );
  });

  it("13j 空白布局也不盖住故障卡", () => {
    const root = renderConsole(
      makeConfig({ layout: { version: 1, blocks: [] } }),
      failedRuntime("RUNTIME_EXITED"),
    );
    expect(text(body(root).querySelector(".card--err .card__lead"))).toBe(
      "节点一直没有响应。",
    );
  });

  it("13k TUN 配置的 proxy_card 跳过：不出现代理卡，也没有可复制地址", () => {
    const root = renderConsole(
      makeConfig({
        connect_mode: "tun",
        layout: {
          version: 1,
          blocks: [{ type: "proxy_card" }, { type: "empty_hint" }],
        },
      }),
      makeRuntime({ state: "running", mixed_port: 7890 }),
    );
    expect(root.querySelector(".card--proxy")).toBeNull();
    expect(root.querySelector(".proxy__addr")).toBeNull();
    expect(root.querySelector(".card--proxy .copy-btn")).toBeNull();
    expect(root.textContent).not.toContain("127.0.0.1:7890");
    expect(text(body(root).querySelector(".note"))).toContain("所有软件现在都能用了。");
  });

  it("13e source_choice：没有节点时给两个选项", () => {
    const root = renderConsole(
      makeConfig({
        nodes: [],
        node_count: 0,
        layout: { version: 1, blocks: [{ type: "source_choice" }] },
      }),
      makeRuntime(),
    );
    const options = Array.from(root.querySelectorAll(".choice__option")).map((el) =>
      text(el),
    );
    expect(options[0]).toContain("Veyl 免费节点");
    expect(options[1]).toContain("用我自己的节点");
    expect(body(root).querySelector(".note")).toBeNull();
  });

  it("13f source_choice 在已有节点时跳过；只剩它时退回本地兜底", () => {
    const root = renderConsole(
      makeConfig({ layout: { version: 1, blocks: [{ type: "source_choice" }] } }),
      makeRuntime(),
    );
    expect(root.querySelector(".choice")).toBeNull();
    expect(text(body(root).querySelector(".note"))).toBe(
      "点上面的「启动 VPN」，浏览器就能用了。",
    );
  });

  it("13g reachability：没有探测数据时只标待确认，不下结论", () => {
    const root = renderConsole(
      makeConfig({
        layout: {
          version: 1,
          blocks: [{ type: "reachability", props: { targets: ["ChatGPT", "Claude Code"] } }],
        },
      }),
      makeRuntime({ state: "running", mixed_port: 7890 }),
    );
    expect(
      Array.from(root.querySelectorAll(".reach__row > span:first-child")).map((el) =>
        text(el),
      ),
    ).toEqual(["ChatGPT", "Claude Code"]);
    expect(
      Array.from(root.querySelectorAll(".reach__status")).map((el) => text(el)),
    ).toEqual(["待确认", "待确认"]);
    expect(text(root.querySelector(".card--reach .card__title"))).toBe(
      "这些服务还没确认",
    );
    const cardText = text(root.querySelector(".card--reach"));
    expect(cardText).not.toMatch(/✓|可用|可达|已确认|打不开/);
  });

  it("13g2 未连接时 reachability 说明是连上后才检查", () => {
    const root = renderConsole(
      makeConfig({
        layout: {
          version: 1,
          blocks: [{ type: "reachability", props: { targets: ["ChatGPT"] } }],
        },
      }),
      makeRuntime(),
    );
    expect(text(root.querySelector(".card--reach .card__title"))).toBe(
      "连上后会确认这些能不能打开",
    );
  });

  it("13h update_hint：有新版本才出现，稍后提醒可收起", () => {
    const config = makeConfig({ layout: { version: 1, blocks: [{ type: "update_hint" }] } });
    const without = renderConsole(config, makeRuntime());
    expect(without.querySelector(".card--hint")).toBeNull();
    cleanup();

    const root = renderConsole(config, makeRuntime(), true, false, {
      seedUpdate: true,
    });
    expect(text(root.querySelector(".card--hint .card__title"))).toBe(
      "默认节点包有新版本。",
    );
    fireEvent.click(textButton(root, "稍后提醒"));
    expect(root.querySelector(".card--hint")).toBeNull();
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

  it("15 DNS 没接管：没配 AI 也出现一行，读屏也播报", () => {
    const root = renderConsole(
      makeConfig({ connect_mode: "tun" }),
      makeRuntime({ state: "running", system_dns: "unchanged" }),
      false,
    );
    expect(text(body(root).querySelector(".note.note--warn"))).toBe(DNS_NOTE_TEXT);
    expect(text(root.querySelector('[role="status"]'))).toContain(
      "这次没能给国外网站提速",
    );
  });

  it("15b 接管成功或正在断开：不出现", () => {
    const ok = renderConsole(
      makeConfig({ connect_mode: "tun" }),
      makeRuntime({ state: "running", system_dns: "tunnel" }),
    );
    expect(ok.querySelector(".note--warn")).toBeNull();
    cleanup();

    const unknown = renderConsole(
      makeConfig({ connect_mode: "tun" }),
      makeRuntime({ state: "running", system_dns: null }),
    );
    expect(unknown.querySelector(".note--warn")).toBeNull();
    cleanup();

    const stopping = renderConsole(
      makeConfig({ connect_mode: "tun" }),
      makeRuntime({ state: "stopping", system_dns: "unchanged" }),
    );
    expect(stopping.querySelector(".note--warn")).toBeNull();
  });

  it("15c 有 AI 布局时仍在，排在布局块前", () => {
    const config = makeConfig({
      connect_mode: "tun",
      layout: { version: 1, blocks: [{ type: "update_hint" }] },
    });
    const root = renderConsole(
      config,
      makeRuntime({ state: "running", system_dns: "unchanged" }),
      true,
      false,
      { seedUpdate: true },
    );
    const one = body(root).querySelector(".one-thing") as HTMLElement;
    expect(one.firstElementChild?.classList.contains("note--warn")).toBe(true);
    expect(one.querySelector(".card--hint")).not.toBeNull();
  });

  it("15d 布局里写了 dns_note：整份丢弃，只留系统叠加的那份", () => {
    const config = makeConfig({
      connect_mode: "tun",
      layout: {
        version: 1,
        blocks: [
          { type: "dns_note" },
          { type: "reachability", props: { targets: ["ChatGPT"] } },
        ],
      } as unknown as ConfigDetail["layout"],
    });
    const root = renderConsole(
      config,
      makeRuntime({ state: "running", system_dns: "unchanged" }),
    );
    expect(root.querySelectorAll(".note--warn")).toHaveLength(1);
    expect(root.querySelector(".card--reach")).toBeNull();
  });
});
