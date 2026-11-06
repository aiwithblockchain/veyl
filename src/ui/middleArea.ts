/**
 * 中间区域本地兜底：layout 为 null 时的三态 × 块矩阵。
 *
 * 规则来源 `docs/middle-area-local-rules.md`。纯函数：同样的 runtime + config + aiReady
 * 必须得到同样的块与文案，不读时间、不猜国家、不调 AI。
 */
import type { ConfigDetail, Layout, RuntimeView } from "../agent/protocol";

export type MiddleLevel = "idle" | "running" | "degraded" | "failed" | "transition";

export interface FailureStep {
  label: string;
  detail: string;
}

export type MiddleBlock =
  | { kind: "empty_hint"; text: string; tone: "idle" | "ok" }
  | {
      kind: "proxy_card";
      /** 已连接（含降级）才有实际端口，未连接只给预计端口。 */
      connected: boolean;
      address: string | null;
      systemProxyEnabled: boolean;
    }
  | {
      kind: "issue_card";
      tone: "failed" | "degraded";
      reason: string;
      steps: FailureStep[];
      /** 降级卡的一句话行动；失败卡用 steps。 */
      next: string | null;
    }
  | { kind: "source_choice" }
  | { kind: "reachability"; targets: string[]; connected: boolean }
  | { kind: "update_hint" };

/** 三态以 runtime.state 归并；过渡态单独一档，中间不渲染任何块。 */
export function middleLevel(state: RuntimeView["state"]): MiddleLevel {
  switch (state) {
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "degraded":
      return "degraded";
    case "starting":
    case "restarting":
    case "stopping":
      return "transition";
    case "idle":
      return "idle";
    // 后端将来加了新状态时宁可不说话，也不要按「未连接」去教用户点按钮。
    default:
      return "transition";
  }
}

/**
 * 只有「本机代理 + 指定服务走节点」这一种配置形态能证明用户要手动填代理地址。
 * 已知缺口：三级用户选了「全部走节点」时配置与一级完全相同，本地分不出来，
 * 按一级处理；他们仍能在底部技术详情里找到本机代理地址。
 * 修复需要配置里有一个显式的「是否要手动填代理」标记（Phase 2）。
 */
export function isProxyUser(config: ConfigDetail): boolean {
  return (
    config.connect_mode === "system_proxy" && config.routing_mode === "proxy_selected"
  );
}

/** §4.1。没有节点时统一换成指路的一句，覆盖未连接 / 已连接两种状态。 */
export function emptyHintText(config: ConfigDetail, connected: boolean): string {
  if (config.nodes.length === 0) {
    return "这套配置还没有节点。";
  }
  if (connected) {
    return config.connect_mode === "tun"
      ? "所有软件现在都能用了。"
      : "浏览器现在能用了。";
  }
  if (config.connect_mode === "tun") {
    return "点上面的「启动 VPN」，所有软件都会自动走节点。";
  }
  if (config.routing_mode === "proxy_all") {
    return "点上面的「启动 VPN」，浏览器就能用了。所有流量都会从节点出去。";
  }
  return "点上面的「启动 VPN」，浏览器就能用了。";
}

export function emptyHintBlock(config: ConfigDetail, connected: boolean): MiddleBlock {
  return {
    kind: "empty_hint",
    text: emptyHintText(config, connected),
    tone: connected ? "ok" : "idle",
  };
}

const TIMEOUT_CODES: ReadonlyArray<string> = [
  "RUNTIME_START_TIMEOUT",
  "RUNTIME_HEALTH_FAILED",
  "RUNTIME_CRASH_LOOP",
  "RUNTIME_EXITED",
  "TIMEOUT",
];

const CONFIG_CODES: ReadonlyArray<string> = [
  "RUNTIME_CONFIG_INVALID",
  "INVALID_ARGUMENT",
  "PRECONDITION_FAILED",
  "UNSUPPORTED",
];

const UPSTREAM_CODES: ReadonlyArray<string> = ["UPSTREAM_ERROR", "RATE_LIMITED"];

/**
 * §4.3.2 九级判定，命中即停。
 * 只读 last_error.code——message 多为英文技术句，普通用户读不懂。
 */
export function failureReason(runtime: RuntimeView): string {
  const code = runtime.last_error?.code ?? null;
  if (code === "PERMISSION_DENIED") return "系统没有允许 Veyl 接管网络。";
  if (code === "RUNTIME_PORT_UNAVAILABLE") {
    return "本机用来做代理的端口被别的软件占用了。";
  }
  if (code !== null && TIMEOUT_CODES.includes(code)) return "节点一直没有响应。";
  if (code !== null && CONFIG_CODES.includes(code)) {
    return "这套配置没法用，启动被拒绝了。";
  }
  if (code !== null && UPSTREAM_CODES.includes(code)) {
    return "节点服务暂时不可用。";
  }

  const { health } = runtime;
  if (!health.process) return "Veyl 的网络组件没有启动起来。";
  if (!health.clash_api) return "网络组件在，但控制接口没有响应。";
  // 不看 exit_ip：进终态时后端会把 exit_ip 清空，看它会把「从来没连上」误判成「连上了但没流量」。
  if (!health.data_plane) return "已经连上节点，但流量没有真正出去。";
  return "具体原因还没确认。";
}

/** §4.3.4。「现在做什么」拆成卡片里的 01/02/03，卡里不放按钮。 */
export function failureSteps(config: ConfigDetail, aiReady: boolean): FailureStep[] {
  const steps: FailureStep[] = [
    { label: "重新连接", detail: "先点上面的「重新连接」。" },
  ];
  if (config.nodes.length >= 2) {
    steps.push({ label: "换一个节点", detail: "用下面节点卡里的「更换」。" });
  }
  steps.push(
    aiReady
      ? { label: "让助手定位", detail: "在右侧说「帮我看看为什么连不上」。" }
      : { label: "新建一套配置", detail: "还是不行，就新建一套配置再试。" },
  );
  return steps;
}

/** §4.3.3。 */
export function degradedReason(runtime: RuntimeView): string {
  if (!runtime.health.data_plane) return "流量没有真正出去。";
  if (runtime.health.consecutive_failures > 0) return "最近的网络检查没有通过。";
  return "网络检查没有通过。";
}

export function proxyBlock(
  runtime: RuntimeView,
  config: ConfigDetail,
  connected: boolean,
): MiddleBlock {
  // 已连接只认 runtime.mixed_port，不回退到配置里的预计端口。
  // 老后端可能不带 listen_port，宽松比较把 undefined 也当作没有。
  const port = connected ? runtime.mixed_port : config.listen_port;
  return {
    kind: "proxy_card",
    connected,
    address: port == null ? null : `127.0.0.1:${port}`,
    systemProxyEnabled: connected && runtime.system_proxy_enabled,
  };
}

/**
 * 失败是不是「本来连着，突然断了」。
 * 不能用 runtime.connected_since 判断：进终态时后端会把它清空，
 * 失败快照里永远是 null，只能看这次状态迁移是从哪来的。
 */
export function isDisconnectFailure(
  from: RuntimeView["state"],
  to: RuntimeView["state"],
): boolean {
  return to === "failed" && (from === "running" || from === "degraded");
}

/** 失败时 H1 下面那行小字：区分「没连上」与「连接断了」。只有这一处。 */
export function failureHeadline(wasConnected: boolean): string {
  return wasConnected ? "连接断了。" : "没有连上节点。";
}

/** §3 状态 × 块矩阵，最多两块，issue_card 永远排第一。 */
export function middleBlocks(
  runtime: RuntimeView,
  config: ConfigDetail,
  aiReady: boolean,
): MiddleBlock[] {
  const level = middleLevel(runtime.state);

  if (level === "transition") return [];

  if (level === "failed") {
    return [
      {
        kind: "issue_card",
        tone: "failed",
        reason: failureReason(runtime),
        steps: failureSteps(config, aiReady),
        next: null,
      },
    ];
  }

  if (level === "degraded") {
    const blocks: MiddleBlock[] = [
      {
        kind: "issue_card",
        tone: "degraded",
        reason: degradedReason(runtime),
        steps: [],
        next: "能继续用就先不动；网页打不开时，点上面的「断开 VPN」再重新连接。",
      },
    ];
    if (isProxyUser(config)) blocks.push(proxyBlock(runtime, config, true));
    return blocks;
  }

  if (isProxyUser(config)) {
    return [proxyBlock(runtime, config, level === "running")];
  }

  return [emptyHintBlock(config, level === "running")];
}

export interface LayoutRenderContext {
  /** 种子包确实有新版本时才放 update_hint。 */
  hasSeedUpdate: boolean;
}

/** 只有模型能填的 props 是 targets；其它一律从本地事实生成。 */
function readTargets(props: Record<string, unknown> | undefined): string[] {
  const raw = props?.targets;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    targets.push(value);
    if (targets.length === 6) break;
  }
  return targets;
}

function skipBlock(reason: string): void {
  console.warn(`[layout] ${reason}`);
}

/**
 * 按 AI 布局生成块。不认识的块跳过；数据条件不成立的块也跳过。
 * 回退到本地兜底由调用方判断（一块都没生成且 blocks 非空时）。
 */
export function resolveLayoutBlocks(
  layout: Layout | null | undefined,
  runtime: RuntimeView,
  config: ConfigDetail,
  context: LayoutRenderContext,
): MiddleBlock[] {
  if (!layout || !Array.isArray(layout.blocks)) return [];
  const level = middleLevel(runtime.state);
  const connected = level === "running" || level === "degraded";
  const blocks: MiddleBlock[] = [];

  for (const block of layout.blocks) {
    const type = (block as { type?: unknown } | null)?.type;
    switch (type) {
      case "empty_hint":
        blocks.push(emptyHintBlock(config, connected));
        break;
      case "proxy_card":
        // TUN 配置没有 mixed 入站，连接后 runtime.mixed_port 仍会给值；
        // 照渲染会得到一个没人监听的地址，所以非代理用户直接跳过。
        if (isProxyUser(config)) blocks.push(proxyBlock(runtime, config, connected));
        else skipBlock("proxy_card 只用于本机代理配置，已跳过");
        break;
      case "source_choice":
        if (config.nodes.length === 0) blocks.push({ kind: "source_choice" });
        break;
      case "reachability": {
        const props = (block as { props?: Record<string, unknown> } | null)?.props;
        const targets = readTargets(props);
        if (targets.length > 0) {
          blocks.push({ kind: "reachability", targets, connected });
        }
        break;
      }
      case "update_hint":
        if (context.hasSeedUpdate) blocks.push({ kind: "update_hint" });
        break;
      case "issue_card":
        // 故障卡是本地叠加层，布局里的这份不能渲染，否则会出两张。
        skipBlock("issue_card 不进布局，已跳过");
        break;
      default:
        skipBlock(`不认识的块类型：${typeof type === "string" ? type : "(缺失)"}`);
    }
  }

  return blocks;
}
