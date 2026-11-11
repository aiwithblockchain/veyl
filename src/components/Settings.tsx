import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  AgentBridge,
  DefaultProfileStatus,
  ProxyPortAvailability,
  LlmProtocol,
  LlmProvider,
  LlmProviderInput,
  NetworkForceResetResult,
  NetworkForceResetStep,
} from "../agent/bridge";
import { DEFAULT_PROXY_PORT, isHttpUrl, isLocalEndpoint } from "../agent/bridge";
import type {
  ConfigConnectMode,
  ConfigRouteMode,
  NodeImportResult,
  NodeImportSkipped,
  RuntimeView,
} from "../agent/protocol";
import { toBridgeError } from "../agent/errors";
import { advancedPrompt, ADVANCED_FIELDS } from "../ai/advancedPrompts";
import { useFocusTrap } from "../ui/focus";
import { copyText } from "../ui/clipboard";
import { IconClose } from "./icons";
import { RuntimeUpgradeRow, useRuntimeUpgrade } from "./RuntimeUpgrade";
import { TunDiagnosticsRow } from "./TunDiagnostics";
import { TunHelperRow, useTunHelper } from "./TunHelper";

const APP_VERSION = "0.1.0";
/** 待产品给出最终仓库地址；没有 URL 就不摆空链接。 */
const OPEN_SOURCE_URL: string | null = null;

interface Props {
  open: boolean;
  bridge: AgentBridge;
  runtime: RuntimeView;
  defaultProfile: DefaultProfileStatus | null;
  /** 本地代理端口；由 App 持有，设置页保存后回写同一份状态。 */
  proxyPort?: number;
  onProxyPortSaved?: (port: number) => void;
  /** 当前配置的连接方式；只用于展示，不参与任何命令。 */
  connectMode?: ConfigConnectMode | null;
  /** 当前配置的路由方式；只用于把连接方式说准确。 */
  routingMode?: ConfigRouteMode | null;
  /** 当前配置 id；节点导入必须落到这套配置，而不仅是节点池。 */
  configId?: string | null;
  /** 新建一套配置（会先关闭设置）。 */
  onNewConfig?: () => void;
  onClose: () => void;
  onRestartOnboarding: () => void;
  onOpenLogs: () => void;
  onRestoreNetwork: () => void;
  /** 带着当前 tab 一起回到 App，重新打开设置时落回原处。 */
  onAskAi: (text: string, section: SectionId) => void;
  /** 从导入入口进来时直接落到「网络」；默认「账号与 AI」。 */
  initialSection?: SectionId;
}

type SectionId = "ai" | "network" | "advanced" | "about";

interface ProviderForm {
  providerId?: string;
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  hasKey: boolean;
}

type TestState = { state: "idle" | "running" | "ok" | "error"; text: string };

type ResetPhase = "idle" | "confirm" | "running" | "result";

type ResetStepKey =
  | "stop_runtime"
  | "stop_tun"
  | "sweep_processes"
  | "clear_routes"
  | "flush_dns"
  | "restore_proxy"
  | "clear_plaintext"
  | "verify";

/** 后端 id 与设计文档 id 并存，界面只认归一后的中文名。 */
const RESET_STEP_ALIASES: Record<string, ResetStepKey> = {
  stop_runtime: "stop_runtime",
  stop_tun: "stop_tun",
  sweep_processes: "sweep_processes",
  clean_leftovers: "sweep_processes",
  clear_routes: "clear_routes",
  restore_routes: "clear_routes",
  flush_dns: "flush_dns",
  restore_dns: "flush_dns",
  restore_proxy: "restore_proxy",
  clear_plaintext: "clear_plaintext",
  remove_temp_config: "clear_plaintext",
  verify: "verify",
};

const RESET_STEP_LABELS: Record<ResetStepKey, string> = {
  stop_runtime: "停止连接程序",
  stop_tun: "关闭接管",
  sweep_processes: "清理残留组件",
  clear_routes: "恢复系统路由",
  flush_dns: "恢复 DNS",
  restore_proxy: "撤销系统代理",
  clear_plaintext: "删除临时配置",
  verify: "复查网络状态",
};

const RESET_STEP_NEXT: Record<ResetStepKey, string> = {
  stop_runtime: "退出其它 VPN 后点「再试一次」；仍失败就重启电脑。",
  stop_tun: "点「再试一次」；仍失败就重启电脑。",
  sweep_processes: "退出其它 VPN 或安全软件后点「再试一次」。",
  clear_routes: "重启电脑后再试一次；仍然不行，展开「手动清理路由」。",
  flush_dns: "点「再试一次」；仍失败就在系统设置里把 DNS 改回自动。",
  restore_proxy: "点「再试一次」；仍失败就重启电脑后再试。",
  clear_plaintext: "点「再试一次」；这不影响上网。",
  verify: "点「再试一次」；仍失败就复制诊断信息发给助手。",
};

/** 成功行用设计文档的固定说明；后端 detail 可能带内部路径，不适合直接展示。 */
const RESET_STEP_DONE: Record<ResetStepKey, string> = {
  stop_runtime: "连接程序已停止。",
  stop_tun: "接管已关闭。",
  sweep_processes: "没有遗留的 Veyl 网络组件。",
  clear_routes: "系统路由已恢复。",
  flush_dns: "DNS 已恢复为系统默认。",
  restore_proxy: "系统代理已恢复到连接前的设置。",
  clear_plaintext: "临时配置文件已删除。",
  verify: "代理、路由、DNS 和组件都符合预期。",
};

const RESET_STEP_FAILED: Record<ResetStepKey, string> = {
  stop_runtime: "还有连接程序没停下来。",
  stop_tun: "接管没有关闭。",
  sweep_processes: "还有残留组件。",
  clear_routes: "系统路由还有残留。",
  flush_dns: "DNS 没有恢复。",
  restore_proxy: "系统代理没有恢复。",
  clear_plaintext: "临时配置没有删掉。",
  verify: "复查没有通过。",
};

/** 前五步失败说明网络还处于半接管状态；后三步只影响完整性。 */
const RESET_CRITICAL: ReadonlySet<ResetStepKey> = new Set([
  "stop_runtime",
  "stop_tun",
  "sweep_processes",
  "clear_routes",
  "restore_proxy",
]);

export function canonicalResetStep(id: string): ResetStepKey | null {
  return RESET_STEP_ALIASES[id] ?? null;
}

export function resetStepLabel(id: string): string {
  const key = canonicalResetStep(id);
  return key ? RESET_STEP_LABELS[key] : "其它检查";
}

export function resetStepStatus(
  step: NetworkForceResetStep,
): "ok" | "failed" | "skipped" {
  if (step.status === "skipped") return "skipped";
  if (step.status === "ok" || step.status === "failed") return step.status;
  return step.ok ? "ok" : "failed";
}

export function resetStepNext(id: string): string | null {
  const key = canonicalResetStep(id);
  return key ? RESET_STEP_NEXT[key] : null;
}

export interface ResetOutcome {
  kind: "success" | "partial" | "failed" | "unverified";
  title: string;
  sub: string;
}

export function resetOutcome(result: NetworkForceResetResult): ResetOutcome {
  const unfinished = result.steps.filter((step) => resetStepStatus(step) !== "ok");
  const partial: ResetOutcome = {
    kind: "partial",
    title: `网络已重置，但有 ${Math.max(unfinished.length, 1)} 项没完成`,
    sub: "其它检查已经通过；按下面的提示处理没完成的项。",
  };

  if (unfinished.length === 0) {
    if (result.ok && result.verified) {
      return {
        kind: "success",
        title: "网络已恢复。可以重新连接了。",
        sub: "",
      };
    }
    // 没有逐项结果时不能凭空说「有 n 项没完成」；下面也没有对应的失败行。
    if (result.steps.length === 0) {
      return {
        kind: "unverified",
        title: "没拿到逐项结果",
        sub: "请复制诊断信息发给助手，或再试一次。",
      };
    }
    return {
      kind: "unverified",
      title: "网络已重置，但复查没有通过",
      sub: "每一步都执行了，但复查没有通过。请复制诊断信息发给助手，或再试一次。",
    };
  }

  const critical = unfinished.some((step) => {
    const key = canonicalResetStep(step.id);
    return key === null || RESET_CRITICAL.has(key);
  });
  if (!critical) return partial;

  return {
    kind: "failed",
    title: "重置没有完成",
    sub: "中途有步骤失败，网络可能还没有恢复。按下面的提示处理后再试。",
  };
}

export function resetTimeLabel(at: number, now = Date.now()): string {
  if (now - at < 60_000) return "刚刚";
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `今天 ${hh}:${mm}`;
}

/**
 * 桥接层已提供 checkedAt / source / changed / reason / added / removed；
 * 下架节点名暂时没有正式字段，读到才显示，字段到位即生效。
 */
type SeedRefreshInfo = DefaultProfileStatus & {
  removedNodeName?: string | null;
  replacementNodeName?: string | null;
};

type SeedPhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "updated"; added: number | null; total: number }
  | { kind: "offline"; at: number | null }
  | { kind: "invalid"; reason: string | null; message: string | null }
  | { kind: "local_write" }
  | { kind: "failed"; message: string };

export function seedTimestamp(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

export function seedAgeLabel(at: number | null, now = Date.now()): string {
  if (at === null) return "从未";
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function seedCheckedAt(info: SeedRefreshInfo | null): number | null {
  if (!info) return null;
  return seedTimestamp(info.checkedAt) ?? seedTimestamp(info.appliedAt);
}

export function seedSummary(info: SeedRefreshInfo | null): string {
  if (!info) return "还没有试用节点 · 从未检查过";
  const head = info.nodeCount > 0 ? `${info.nodeCount} 个节点` : "还没有试用节点";
  const age = seedAgeLabel(seedCheckedAt(info));
  return `${head} · ${age === "从未" ? "从未检查过" : `${age}检查过`}`;
}

function seedChanged(before: SeedRefreshInfo | null, next: SeedRefreshInfo): boolean {
  if (typeof next.changed === "boolean") return next.changed;
  if (!before) return next.nodeCount > 0 || next.version !== null;
  return (
    before.version !== next.version ||
    before.nodeCount !== next.nodeCount ||
    before.appliedAt !== next.appliedAt
  );
}

function seedStatusText(phase: SeedPhase, connected: boolean, nodeCount: number): string | null {
  switch (phase.kind) {
    case "checking":
      return "正在检查…";
    case "latest":
      return "刚刚检查过，已经是最新。";
    case "updated": {
      const text =
        phase.added !== null && phase.added > 0
          ? `已更新 ${phase.added} 个节点，共 ${phase.total} 个。`
          : `已更新，共 ${phase.total} 个节点。`;
      return connected ? `${text}下次连接生效。` : text;
    }
    case "offline":
      return nodeCount > 0
        ? `暂时连不上，继续用上次的 ${nodeCount} 个节点。`
        : "暂时连不上，继续用上次的节点。";
    case "invalid":
      return "新内容有问题，保留了原来的节点。";
    case "local_write":
      return "没能保存到本机，检查磁盘空间后重试。";
    case "failed":
      return "拿不到试用节点，请检查网络。";
    default:
      return null;
  }
}

function seedStatusTone(phase: SeedPhase): string {
  switch (phase.kind) {
    case "checking":
      return "is-muted";
    case "latest":
    case "updated":
      return "is-ok";
    case "offline":
      return "is-warn";
    case "invalid":
    case "local_write":
    case "failed":
      return "is-error";
    default:
      return "";
  }
}

function SeedRefreshRow({
  bridge,
  info,
  onInfo,
  connected,
  open,
}: {
  bridge: AgentBridge;
  info: SeedRefreshInfo | null;
  onInfo: (next: SeedRefreshInfo) => void;
  connected: boolean;
  open: boolean;
}) {
  const [phase, setPhase] = useState<SeedPhase>({ kind: "idle" });
  const [removedNotice, setRemovedNotice] = useState<{
    from: string;
    to: string | null;
  } | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "error">("idle");
  const copyTimer = useRef<number | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (open) return;
    setPhase({ kind: "idle" });
    setRemovedNotice(null);
    setCopyState("idle");
  }, [open]);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const refresh = async () => {
    if (busy.current) return;
    busy.current = true;
    const before = info;
    setPhase({ kind: "checking" });
    setRemovedNotice(null);
    setCopyState("idle");
    try {
      const next = (await bridge.defaultProfileRefresh()) as SeedRefreshInfo;
      onInfo(next);
      if (next.removedNodeName) {
        setRemovedNotice({
          from: next.removedNodeName,
          to: next.replacementNodeName ?? null,
        });
      }
      if (next.reason === "invalid_content") {
        setPhase({ kind: "invalid", reason: next.reason, message: null });
      } else if (next.reason === "local_write") {
        setPhase({ kind: "local_write" });
      } else if (next.source === "cache" || next.reason === "offline") {
        setPhase({ kind: "offline", at: seedCheckedAt(next) });
      } else if (seedChanged(before, next)) {
        setPhase({ kind: "updated", added: next.added ?? null, total: next.nodeCount });
      } else {
        setPhase({ kind: "latest" });
      }
    } catch (failure) {
      setPhase({ kind: "failed", message: toBridgeError(failure).message });
    } finally {
      busy.current = false;
    }
  };

  const copyDiagnostics = async (phase: Extract<SeedPhase, { kind: "invalid" }>) => {
    const text = JSON.stringify(
      {
        at: new Date().toISOString(),
        version: info?.version ?? null,
        node_count: info?.nodeCount ?? 0,
        reason: phase.reason,
        message: phase.message,
      },
      null,
      2,
    );
    const ok = await copyText(text);
    setCopyState(ok ? "ok" : "error");
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState("idle"), 2000);
  };

  const status = seedStatusText(phase, connected, info?.nodeCount ?? 0);
  const checking = phase.kind === "checking";

  return (
    <div className="settings-row seed-refresh">
      <div className="seed-refresh__main">
        <div className="settings-row__label">更新试用节点</div>
        <div className="settings-row__value num">{seedSummary(info)}</div>
        {status ? (
          <p
            className={`seed-refresh__status ${seedStatusTone(phase)}`}
            role="status"
            aria-live="polite"
            title={phase.kind === "failed" ? phase.message : undefined}
          >
            {status}
          </p>
        ) : null}
        {removedNotice ? (
          <p className="seed-refresh__note">
            {removedNotice.to
              ? `原来的「${removedNotice.from}」已下架，已切换到「${removedNotice.to}」${
                  connected ? "，下次连接生效" : ""
                }`
              : `原来的「${removedNotice.from}」已下架，这套配置现在没有节点`}
          </p>
        ) : null}
        {phase.kind === "invalid" ? (
          <button
            type="button"
            className="seed-refresh__copy"
            onClick={() => void copyDiagnostics(phase)}
          >
            {copyState === "ok" ? "已复制" : copyState === "error" ? "复制失败" : "复制诊断信息"}
          </button>
        ) : null}
      </div>

      <div className="settings-row__aside seed-refresh__actions">
        <button
          type="button"
          className="btn btn--ghost"
          disabled={checking}
          onClick={() => void refresh()}
        >
          {checking ? "检查中…" : "检查更新"}
        </button>
      </div>
    </div>
  );
}

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: "ai", label: "AI 服务" },
  { id: "network", label: "连接" },
  { id: "advanced", label: "遇到问题" },
  { id: "about", label: "关于" },
];

const PRESETS: Array<{
  id: string;
  label: string;
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
}> = [
  {
    id: "deepseek",
    label: "DeepSeek",
    name: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
  {
    id: "openai",
    label: "OpenAI",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com",
    model: "gpt-4o-mini",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
  },
  {
    id: "moonshot",
    label: "Moonshot",
    name: "Moonshot",
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn",
    model: "moonshot-v1-8k",
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    name: "Ollama",
    protocol: "openai",
    baseUrl: "http://localhost:11434",
    model: "llama3.2",
  },
];

function protocolLabel(protocol: LlmProtocol): string {
  return protocol === "anthropic" ? "anthropic 兼容" : "openai 兼容";
}

/** 连接方式与左栏、主界面用同一套词；设置里只读。 */
function connectModeText(
  mode: ConfigConnectMode | null,
  routing: ConfigRouteMode | null,
): string {
  if (mode === "tun") return "全部软件走 VPN";
  if (mode === "system_proxy" && routing === "proxy_selected") {
    return "只有填了地址的软件走 VPN";
  }
  if (mode === "system_proxy") return "浏览器走 VPN";
  return "还没有配置";
}

const IMPORT_SKIP_REASONS: Record<NodeImportSkipped["reason"], string> = {
  duplicate: "已有同名节点",
  unsupported_scheme: "不是 ss:// 链接",
  unsupported_method: "加密方式不支持",
  malformed: "内容不完整",
  subscription_empty: "订阅里没有节点",
};

function importSkipReason(reason: string): string {
  return IMPORT_SKIP_REASONS[reason as NodeImportSkipped["reason"]] ?? "没法导入";
}

function emptyForm(): ProviderForm {
  return { name: "", protocol: "openai", baseUrl: "", model: "", apiKey: "", hasKey: false };
}

export function Settings({
  open,
  bridge,
  runtime,
  defaultProfile,
  proxyPort = DEFAULT_PROXY_PORT,
  onProxyPortSaved,
  connectMode = null,
  routingMode = null,
  configId = null,
  onNewConfig,
  onClose,
  onRestartOnboarding,
  onOpenLogs,
  onRestoreNetwork,
  onAskAi,
  initialSection = "ai",
}: Props) {
  const connected = runtime.state === "running" || runtime.state === "degraded";
  const runtimeActive =
    runtime.state === "running" ||
    runtime.state === "degraded" ||
    runtime.state === "starting" ||
    runtime.state === "restarting" ||
    runtime.state === "stopping";
  const showCleanupProxy =
    !runtimeActive && (connectMode === "system_proxy" || runtime.system_proxy_enabled);
  const [section, setSection] = useState<SectionId>("ai");
  const [seedInfo, setSeedInfo] = useState<SeedRefreshInfo | null>(defaultProfile);
  const coreUpgrade = useRuntimeUpgrade({
    bridge,
    enabled: open && section === "advanced",
    connected,
  });
  const tunHelper = useTunHelper({ bridge, enabled: open && section === "advanced" });
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerNotice, setProviderNotice] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderForm | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerTest, setProviderTest] = useState<TestState>({ state: "idle", text: "" });
  const [listTest, setListTest] = useState<{
    providerId: string;
    state: "running" | "ok" | "error";
    text: string;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LlmProvider | null>(null);
  const [diagnosticNotice, setDiagnosticNotice] = useState<string | null>(null);
  const [resetPhase, setResetPhase] = useState<ResetPhase>("idle");
  const [resetResult, setResetResult] = useState<NetworkForceResetResult | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [lastReset, setLastReset] = useState<{
    at: number;
    total: number;
    failed: number;
  } | null>(null);
  const [resetCopy, setResetCopy] = useState<"idle" | "ok" | "error">("idle");
  const [routeCopy, setRouteCopy] = useState<"idle" | "ok" | "error">("idle");
  const [proxyCopy, setProxyCopy] = useState<"idle" | "ok" | "error">("idle");
  const [portEditing, setPortEditing] = useState(false);
  const [portInput, setPortInput] = useState(String(proxyPort));
  const [portSaving, setPortSaving] = useState(false);
  const [portFeedback, setPortFeedback] = useState<string | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const [portAvailability, setPortAvailability] =
    useState<ProxyPortAvailability>("free");
  const lastSavedPort = useRef(proxyPort);
  const portSavingRef = useRef(false);
  const portInputRef = useRef<HTMLInputElement>(null);
  const portEditButtonRef = useRef<HTMLButtonElement>(null);
  const returnPortFocusRef = useRef(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<NodeImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const importDialogRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const resetDialogRef = useRef<HTMLDivElement>(null);
  const resetTriggerRef = useRef<HTMLButtonElement>(null);
  const resetCancelRef = useRef<HTMLButtonElement>(null);
  const resetCloseRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);
  const copyTimerRef = useRef<number | null>(null);
  useFocusTrap(open && resetPhase === "idle" && !importOpen, dialogRef);
  useFocusTrap(resetPhase !== "idle", resetDialogRef);
  useFocusTrap(importOpen, importDialogRef);

  // App 层的端口变了（初次读取或别处保存），输入框跟着走；编辑中不打断输入。
  useEffect(() => {
    lastSavedPort.current = proxyPort;
    if (!portEditing) setPortInput(String(proxyPort));
  }, [proxyPort, portEditing]);

  // 进入编辑态：自动聚焦并全选端口号。
  useEffect(() => {
    if (!portEditing) return;
    const input = portInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [portEditing]);

  // 保存成功 / 取消 / Esc 退出编辑后，焦点回到「编辑」，键盘用户不用从头 Tab。
  useEffect(() => {
    if (portEditing || !returnPortFocusRef.current) return;
    returnPortFocusRef.current = false;
    portEditButtonRef.current?.focus();
  }, [portEditing]);

  const portLow = Number(portInput) < 1024 && Number(portInput) > 0;
  const portDescribedBy =
    [
      portLow ? "settings-proxy-port-low" : null,
      portError ? "settings-proxy-port-error" : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  // 关闭设置或离开这个 tab：放弃未保存的改动与本次的探测提示。
  useEffect(() => {
    if (open && section === "network") return;
    setPortEditing(false);
    setPortError(null);
    setPortFeedback(null);
    if (!open) setPortAvailability("free");
    setPortInput(String(lastSavedPort.current));
  }, [open, section]);

  const beginProxyPortEdit = () => {
    setPortInput(String(lastSavedPort.current));
    setPortError(null);
    setPortFeedback(null);
    setPortEditing(true);
  };

  const cancelProxyPortEdit = useCallback(() => {
    if (portSavingRef.current) return;
    returnPortFocusRef.current = true;
    setPortEditing(false);
    setPortInput(String(lastSavedPort.current));
    setPortError(null);
  }, []);

  const saveProxyPort = async () => {
    const raw = portInput.trim();
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 65535
    ) {
      setPortError("端口要填 1–65535 之间的整数。");
      setPortFeedback(null);
      return;
    }
    if (value === lastSavedPort.current) {
      setPortError(null);
      returnPortFocusRef.current = true;
      setPortEditing(false);
      return;
    }
    // 失焦与点「保存」会连着触发：只发一次命令。
    if (portSavingRef.current) return;
    portSavingRef.current = true;
    setPortSaving(true);
    setPortError(null);
    setPortFeedback(null);
    try {
      const result = await bridge.proxyPortSet(value);
      lastSavedPort.current = result.port;
      setPortInput(String(result.port));
      setPortAvailability(result.availability);
      // 顺延说明已经带「保存的是 X，下次连接生效」，不再叠一句。
      const pendingNext =
        connected &&
        runtime.port_fallback !== null &&
        result.port !== runtime.port_fallback.requested;
      setPortFeedback(
        pendingNext ? null : connected ? "已保存，下次连接生效" : "已保存",
      );
      returnPortFocusRef.current = true;
      setPortEditing(false);
      onProxyPortSaved?.(result.port);
    } catch (error) {
      const message = toBridgeError(error).message;
      // toBridgeError 对没有 message 的错误会补「操作失败」，那不是后端原话。
      setPortError(
        message && message !== "操作失败"
          ? message
          : "没有保存，端口还是原来的。再试一次。",
      );
    } finally {
      portSavingRef.current = false;
      setPortSaving(false);
    }
  };

  const refreshProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const data = await bridge.llmProviderList();
      setProviders(data.providers);
      setActiveProviderId(data.activeProviderId);
    } catch {
      // 旧后端没有列表命令时保持空列表。
    } finally {
      setProvidersLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (!open) return;
    setSection(initialSection);
    setProviderForm(null);
    setProviderNotice(null);
    setProviderError(null);
    setProviderTest({ state: "idle", text: "" });
    setListTest(null);
    setPendingDelete(null);
    setDiagnosticNotice(null);
    setResetPhase("idle");
    setResetResult(null);
    setResetError(null);
    setLastReset(null);
    setResetCopy("idle");
    setRouteCopy("idle");
    setProxyCopy("idle");
    setImportOpen(false);
    setImportText("");
    setImportBusy(false);
    setImportResult(null);
    setImportError(null);
    void refreshProviders();
  }, [open, refreshProviders, initialSection]);

  useEffect(() => {
    setSeedInfo(defaultProfile);
  }, [defaultProfile]);

  const closeReset = useCallback(() => {
    if (resetPhase === "running") return;
    returnFocusRef.current = true;
    setResetPhase("idle");
    setResetResult(null);
    setResetError(null);
    setResetCopy("idle");
    setRouteCopy("idle");
  }, [resetPhase]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 导入弹层在设置之上：先关它。
      if (importOpen) {
        setImportOpen(false);
        return;
      }
      // 重置弹层在上层：先关它，运行中则完全忽略。
      if (resetPhase !== "idle") {
        if (resetPhase !== "running") closeReset();
        return;
      }
      // 端口编辑态先拦下 Esc：只退编辑，不关设置。
      if (portEditing) {
        cancelProxyPortEdit();
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, resetPhase, closeReset, importOpen, portEditing, cancelProxyPortEdit]);

  useEffect(() => {
    if (resetPhase === "confirm") resetCancelRef.current?.focus();
    if (resetPhase === "result") resetCloseRef.current?.focus();
    if (resetPhase === "idle" && returnFocusRef.current) {
      returnFocusRef.current = false;
      resetTriggerRef.current?.focus();
    }
  }, [resetPhase]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const openNewProvider = () => {
    setProviderForm(emptyForm());
    setProviderError(null);
    setProviderTest({ state: "idle", text: "" });
    setPendingDelete(null);
  };

  const openEditProvider = (provider: LlmProvider) => {
    setProviderForm({
      providerId: provider.providerId,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: "",
      hasKey: provider.hasKey,
    });
    setProviderError(null);
    setProviderTest({ state: "idle", text: "" });
    setPendingDelete(null);
  };

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setProviderForm((current) => ({
      ...(current ?? emptyForm()),
      name: preset.name,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: preset.model,
    }));
    setProviderError(null);
    setProviderTest({ state: "idle", text: "" });
  };

  const buildProviderInput = (form: ProviderForm): LlmProviderInput | string => {
    const model = form.model.trim();
    if (!model) return "模型不能为空";

    const baseUrl = form.baseUrl.trim();
    if (!isHttpUrl(baseUrl)) return "Base URL 必须以 http:// 或 https:// 开头";
    if (baseUrl.toLowerCase().startsWith("http://") && !isLocalEndpoint(baseUrl)) {
      return "http 只允许本机地址（localhost / 127.0.0.1）；其他端点请用 https";
    }

    const apiKey = form.apiKey.trim();
    if (!form.hasKey && !apiKey && !isLocalEndpoint(baseUrl)) {
      return "请填写 API Key；只有本机端点可以免 Key";
    }

    return {
      providerId: form.providerId,
      name: form.name.trim() || model,
      protocol: form.protocol,
      baseUrl,
      model,
      apiKey,
    };
  };

  const saveProvider = async () => {
    if (!providerForm || providerSaving) return;
    const input = buildProviderInput(providerForm);
    if (typeof input === "string") {
      setProviderError(input);
      return;
    }

    setProviderSaving(true);
    setProviderError(null);
    const hadActive =
      activeProviderId !== null || providers.some((provider) => provider.isActive);
    try {
      await bridge.llmProviderSave(input);
      setProviderForm(null);
      setProviderNotice({
        kind: "ok",
        text: hadActive ? "已保存。" : "已保存，并设为当前。",
      });
      await refreshProviders();
    } catch (error) {
      setProviderError(describeProviderError(error));
    } finally {
      setProviderSaving(false);
    }
  };

  const testProvider = async () => {
    if (!providerForm || providerTest.state === "running") return;
    const model = providerForm.model.trim();
    if (!model) {
      setProviderError("模型不能为空");
      return;
    }

    setProviderError(null);
    setProviderTest({ state: "running", text: "正在发送最小请求…" });
    try {
      const result = await bridge.llmProviderTest({
        providerId: providerForm.providerId,
        name: providerForm.name.trim() || model,
        protocol: providerForm.protocol,
        baseUrl: providerForm.baseUrl.trim(),
        model,
        apiKey: providerForm.apiKey.trim(),
      });
      setProviderTest(
        result.ok
          ? {
              state: "ok",
              text: `连接成功${result.latencyMs !== null ? ` · ${result.latencyMs} ms` : ""}`,
            }
          : { state: "error", text: result.error || "测试失败，请检查端点和 Key" },
      );
    } catch (error) {
      setProviderTest({ state: "error", text: describeProviderError(error) });
    }
  };

  const testExistingProvider = async (provider: LlmProvider) => {
    if (listTest?.state === "running") return;
    setListTest({
      providerId: provider.providerId,
      state: "running",
      text: "正在发送最小请求…",
    });
    try {
      const result = await bridge.llmProviderTest({
        providerId: provider.providerId,
        name: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        model: provider.model,
        apiKey: "",
      });
      setListTest({
        providerId: provider.providerId,
        state: result.ok ? "ok" : "error",
        text: result.ok
          ? `连接成功${result.latencyMs !== null ? ` · ${result.latencyMs} ms` : ""}`
          : result.error || "测试失败，请检查端点和 Key",
      });
    } catch (error) {
      setListTest({
        providerId: provider.providerId,
        state: "error",
        text: describeProviderError(error),
      });
    }
  };

  const activateProvider = async (provider: LlmProvider) => {
    try {
      await bridge.llmProviderActivate(provider.providerId);
      setProviderNotice({ kind: "ok", text: `已切换到「${provider.name}」。` });
      await refreshProviders();
    } catch (error) {
      setProviderNotice({ kind: "error", text: describeProviderError(error) });
    }
  };

  const deleteProvider = async (provider: LlmProvider) => {
    const wasActive = provider.isActive || provider.providerId === activeProviderId;
    try {
      await bridge.llmProviderDelete(provider.providerId);
      setPendingDelete(null);
      setProviderNotice({
        kind: "ok",
        text: wasActive
          ? "已删除，同时清除了它的 Key。没有当前服务，请选择一个。"
          : "已删除，同时清除了它的 Key。",
      });
      await refreshProviders();
    } catch (error) {
      setPendingDelete(null);
      setProviderNotice({ kind: "error", text: describeProviderError(error) });
    }
  };

  const askAi = (field: string, value: string) => {
    onAskAi(advancedPrompt(field, value), section);
  };

  const importFirstLine =
    importText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const importIsUrl = /^https:\/\//i.test(importFirstLine);

  const submitImport = async () => {
    const text = importText.trim();
    if (!text || importBusy) return;
    setImportError(null);
    setImportResult(null);
    if (/^http:\/\//i.test(importFirstLine)) {
      setImportError("订阅地址要用 https，不能是 http。");
      return;
    }
    if (!configId) {
      setImportError("先在左侧选一套配置，再添加节点。");
      return;
    }
    setImportBusy(true);
    try {
      const result = importIsUrl
        ? await bridge.nodeImportUrl(importFirstLine, configId)
        : await bridge.nodeImportText(text, configId);
      setImportResult(result);
      if (result.imported > 0) setImportText("");
    } catch (error) {
      const message = toBridgeError(error).message;
      setImportError(
        message && message !== "操作失败"
          ? message
          : "没有添加成功，检查地址后再试。",
      );
    } finally {
      setImportBusy(false);
    }
  };

  const onTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let next: number | null = null;
    if (event.key === "ArrowRight") {
      next = (index + 1) % SECTIONS.length;
    } else if (event.key === "ArrowLeft") {
      next = (index - 1 + SECTIONS.length) % SECTIONS.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = SECTIONS.length - 1;
    }
    if (next === null) return;
    event.preventDefault();
    setSection(SECTIONS[next].id);
    tabRefs.current[next]?.focus();
  };

  const copyDiagnostics = async () => {
    const payload = {
      app: APP_VERSION,
      eventSource: bridge.mode,
      runtimeState: runtime.state,
      singBox: runtime.upstream_version,
      mixedPort: runtime.mixed_port,
      pid: runtime.pid,
      configId: runtime.config_id,
      configHash: runtime.config_hash,
      latencyMs: runtime.latency_ms,
      lastError: runtime.last_error?.code ?? null,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setDiagnosticNotice("诊断信息已复制，可直接粘贴给支持人员。");
    } catch {
      setDiagnosticNotice("复制失败，请检查系统剪贴板权限。");
    }
  };

  const flashCopy = (
    setState: (state: "idle" | "ok" | "error") => void,
    next: "ok" | "error",
  ) => {
    setState(next);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setState("idle"), 2000);
  };

  // 地址行显示哪个端口，复制就复制哪个：已连接代理模式用实际端口，其余用设置值。
  const displayPort =
    connected && connectMode === "system_proxy"
      ? runtime.mixed_port ?? proxyPort
      : proxyPort;

  // 顺延只看 runtime.port_fallback；同一时刻只显示一句。
  const portFallback =
    connected && connectMode === "system_proxy" ? runtime.port_fallback : null;
  let portNote: string | null = null;
  if (connectMode === "system_proxy") {
    if (portFallback) {
      if (proxyPort !== portFallback.requested) {
        const short =
          portFallback.reason === "unavailable" ? "需要管理员权限" : "被占用";
        portNote = `这次连接用的是 ${portFallback.actual}（${portFallback.requested} ${short}）；保存的是 ${proxyPort}，下次连接生效。`;
      } else {
        const why =
          portFallback.reason === "unavailable"
            ? "这个端口需要管理员权限"
            : "被别的软件占用了";
        portNote = `保存的是 ${portFallback.requested}；现在用的是 ${portFallback.actual}，${why}。`;
      }
    } else if (connected && runtime.system_proxy_enabled) {
      portNote = "浏览器已经设好了；其它软件填这个地址。";
    } else {
      portNote = "别的软件要填代理地址时，填这个。";
    }
  }

  const copyProxyAddress = async () => {
    const ok = await copyText(`127.0.0.1:${displayPort}`);
    flashCopy(setProxyCopy, ok ? "ok" : "error");
  };

  const runNetworkReset = async () => {
    if (resetPhase === "running") return;
    setResetResult(null);
    setResetError(null);
    setResetCopy("idle");
    setRouteCopy("idle");
    setResetPhase("running");
    try {
      const result = await bridge.networkForceReset();
      setResetResult(result);
      setLastReset({
        at: Date.now(),
        total: result.steps.length,
        failed: result.steps.filter((step) => resetStepStatus(step) !== "ok").length,
      });
    } catch (error) {
      setResetError(describeResetError(error));
    } finally {
      setResetPhase("result");
    }
  };

  const copyResetReport = async () => {
    const payload = {
      app: APP_VERSION,
      eventSource: bridge.mode,
      runtimeState: runtime.state,
      reset: resetResult
        ? {
            ok: resetResult.ok,
            verified: resetResult.verified,
            exitIp: resetResult.exitIp,
            steps: resetResult.steps,
          }
        : { error: resetError },
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      flashCopy(setResetCopy, "ok");
    } catch {
      flashCopy(setResetCopy, "error");
    }
  };

  const copyRouteCommand = async () => {
    try {
      await navigator.clipboard.writeText("sudo route -n delete -net <残留网段>");
      flashCopy(setRouteCopy, "ok");
    } catch {
      flashCopy(setRouteCopy, "error");
    }
  };

  const outcome = resetError
    ? { kind: "failed" as const, title: "重置没有开始", sub: resetError }
    : resetResult
      ? resetOutcome(resetResult)
      : null;
  const resetTitle =
    resetPhase === "confirm"
      ? "重置网络？"
      : resetPhase === "running"
        ? "正在重置网络"
        : "重置网络";

  const resetStepItems = resetResult
    ? resetResult.steps.map((step, index) => {
        const status = resetStepStatus(step);
        const key = canonicalResetStep(step.id);
        const next = status === "failed" ? resetStepNext(step.id) : null;
        const detail =
          status === "skipped"
            ? "前面一步没有完成，已跳过。"
            : status === "ok"
              ? key
                ? RESET_STEP_DONE[key]
                : ""
              : key
                ? RESET_STEP_FAILED[key]
                : "这一步没有完成。";
        return (
          <li key={`${step.id}-${index}`} className={`reset-step is-${status}`}>
            <span className="reset-step__icon" aria-hidden="true">
              <ResetStepIcon status={status} />
            </span>
            <div className="reset-step__body">
              <span className="reset-step__label">{resetStepLabel(step.id)}</span>
              {detail ? <span className="reset-step__detail">{detail}</span> : null}
              {next ? <span className="reset-step__next">{next}</span> : null}
            </div>
            <span className="reset-step__status">
              {status === "ok" ? "已完成" : status === "failed" ? "未完成" : "未执行"}
            </span>
          </li>
        );
      })
    : null;

  if (!open) return null;

  return (
    <>
      <div className="modal-backdrop" onMouseDown={onClose}>
        <div
          ref={dialogRef}
          className="modal modal--settings"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          aria-hidden={resetPhase !== "idle" ? true : undefined}
          inert={resetPhase !== "idle"}
          onMouseDown={(event) => event.stopPropagation()}
        >
        <header className="modal__head">
          <h2 id="settings-title" className="modal__title">
            设置
          </h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="关闭设置">
            <IconClose size={14} />
          </button>
        </header>

        <div className="settings-nav" role="tablist" aria-label="设置分区">
          {SECTIONS.map((item, index) => {
            const selected = section === item.id;
            return (
              <button
                key={item.id}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${item.id}`}
                aria-selected={selected}
                aria-controls={`settings-panel-${item.id}`}
                tabIndex={selected ? 0 : -1}
                className={selected ? "is-active" : ""}
                onClick={() => setSection(item.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {section === "ai" ? (
          <section
            className="settings-section"
            role="tabpanel"
            id="settings-panel-ai"
            aria-labelledby="settings-tab-ai"
          >
            <div className="settings-providers">
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">用哪个 AI 服务</div>
                  <div className="settings-row__value">
                    AI 助手用这里的服务回答你；换服务或换模型都在这里。
                  </div>
                </div>
              </div>
                <p className="settings-risk">请求会发往你填写的端点，请确认你信任它。</p>
                <p className="settings-note">
                  切换当前使用的服务会开始一个新会话，之前对话的上下文不会带过去。
                </p>

                {providersLoading ? (
                  <p className="settings-muted">读取服务…</p>
                ) : providers.length === 0 ? (
                  <p className="settings-muted">还没有服务。可以从下面的预设一键添加。</p>
                ) : (
                  <ul className="provider-list">
                    {providers.map((provider) => {
                      const isActive =
                        provider.providerId === activeProviderId || provider.isActive;
                      const canActivate =
                        provider.hasKey || isLocalEndpoint(provider.baseUrl);

                      return (
                        <li
                          key={provider.providerId}
                          className={`provider-item ${isActive ? "is-active" : ""}`}
                        >
                          <div className="provider-item__head">
                            <span className="provider-item__name">{provider.name}</span>
                            {isActive ? <span className="provider-item__badge">当前</span> : null}
                            {provider.isBuiltin ? (
                              <span className="provider-item__tag">内置</span>
                            ) : null}
                          </div>
                          <div className="provider-item__meta">
                            {protocolLabel(provider.protocol)} · {provider.model}
                            {provider.hasKey ? "" : " · 无 Key"}
                          </div>
                          <code className="provider-item__url">
                            {provider.baseUrl || "官方默认地址"}
                          </code>
                          <div className="provider-item__actions">
                            {!isActive ? (
                              <button
                                type="button"
                                className="btn btn--ghost provider-item__btn"
                                onClick={() => void activateProvider(provider)}
                                disabled={!canActivate}
                                title={canActivate ? undefined : "先编辑并保存 API Key"}
                              >
                                设为当前
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn btn--ghost provider-item__btn"
                              onClick={() => void testExistingProvider(provider)}
                              disabled={!canActivate || listTest?.state === "running"}
                              title={canActivate ? undefined : "先编辑并保存 API Key"}
                            >
                              {listTest?.providerId === provider.providerId &&
                              listTest.state === "running"
                                ? "测试中…"
                                : "测试"}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost provider-item__btn"
                              onClick={() => openEditProvider(provider)}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="btn btn--danger-ghost provider-item__btn"
                              onClick={() => setPendingDelete(provider)}
                              disabled={provider.isBuiltin}
                              title={provider.isBuiltin ? "内置服务不可删除" : undefined}
                            >
                              删除
                            </button>
                          </div>

                          {listTest?.providerId === provider.providerId ? (
                            <p
                              className={`settings-feedback settings-feedback--${
                                listTest.state === "ok"
                                  ? "ok"
                                  : listTest.state === "error"
                                    ? "error"
                                    : "warn"
                              }`}
                            >
                              {listTest.text}
                            </p>
                          ) : null}

                          {pendingDelete?.providerId === provider.providerId ? (
                            <div className="provider-item__confirm">
                              <p>删除「{provider.name}」会同时删除它的 Key，无法恢复。</p>
                              <div className="settings-actions">
                                <button
                                  type="button"
                                  className="btn btn--ghost"
                                  onClick={() => setPendingDelete(null)}
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--danger-ghost"
                                  onClick={() => void deleteProvider(provider)}
                                >
                                  确认删除
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="settings-actions">
                  <button type="button" className="btn btn--ghost" onClick={openNewProvider}>
                    添加 AI 服务
                  </button>
                </div>

                {providerNotice ? (
                  <p className={`settings-feedback settings-feedback--${providerNotice.kind}`}>
                    {providerNotice.text}
                  </p>
                ) : null}

                {providerForm ? (
                  <form
                    className="provider-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveProvider();
                    }}
                  >
                    <h4 className="provider-form__title">
                      {providerForm.providerId ? "编辑 AI 服务" : "添加 AI 服务"}
                    </h4>

                    <div className="provider-form__presets">
                      {PRESETS.map((preset) => (
                        <button
                          type="button"
                          key={preset.id}
                          className="chip chip--small"
                          onClick={() => applyPreset(preset)}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>

                    <label className="provider-field">
                      <span>名称</span>
                      <input
                        value={providerForm.name}
                        onChange={(event) =>
                          setProviderForm({ ...providerForm, name: event.target.value })
                        }
                        placeholder="例如 我的 DeepSeek"
                      />
                    </label>

                    <div className="provider-field">
                      <span className="provider-field__label">
                        API 类型
                        <button
                          type="button"
                          className="ask-ai"
                          onClick={() =>
                            askAi(
                              ADVANCED_FIELDS.apiProtocol,
                              `${providerForm.protocol === "anthropic" ? "anthropic 兼容" : "openai 兼容"} / ${providerForm.baseUrl || "官方地址"}`,
                            )
                          }
                        >
                          问 AI
                        </button>
                      </span>
                      <select
                        value={providerForm.protocol}
                        onChange={(event) =>
                          setProviderForm({
                            ...providerForm,
                            protocol: event.target.value as LlmProtocol,
                          })
                        }
                      >
                        <option value="openai">OpenAI 兼容</option>
                        <option value="anthropic">Anthropic 兼容</option>
                      </select>
                    </div>

                    <label className="provider-field">
                      <span>Base URL</span>
                      <input
                        value={providerForm.baseUrl}
                        onChange={(event) =>
                          setProviderForm({ ...providerForm, baseUrl: event.target.value })
                        }
                        placeholder={
                          providerForm.protocol === "anthropic"
                            ? "https://api.anthropic.com"
                            : "https://api.deepseek.com"
                        }
                      />
                    </label>
                    <p className="provider-form__hint">
                      {providerForm.protocol === "anthropic"
                        ? "需要兼容 /v1/messages；留空则使用官方地址。"
                        : "需要兼容 /v1/chat/completions；留空则使用官方地址。"}
                    </p>

                    <div className="provider-field">
                      <span className="provider-field__label">
                        模型 *
                        <button
                          type="button"
                          className="ask-ai"
                          onClick={() =>
                            askAi(ADVANCED_FIELDS.model, providerForm.model || "（空）")
                          }
                        >
                          问 AI
                        </button>
                      </span>
                      <input
                        value={providerForm.model}
                        onChange={(event) =>
                          setProviderForm({ ...providerForm, model: event.target.value })
                        }
                        placeholder="deepseek-chat"
                      />
                    </div>

                    <label className="provider-field">
                      <span>API Key</span>
                      <input
                        type="password"
                        value={providerForm.apiKey}
                        onChange={(event) =>
                          setProviderForm({ ...providerForm, apiKey: event.target.value })
                        }
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={providerForm.hasKey ? "已保存，留空不修改" : "sk-..."}
                      />
                    </label>
                    <p className="provider-form__hint">
                      本机 Ollama 可免 Key；http 仅允许 localhost / 127.0.0.1。
                    </p>

                    {providerError ? (
                      <p className="settings-feedback settings-feedback--error">{providerError}</p>
                    ) : null}
                    {providerTest.state !== "idle" ? (
                      <p
                        className={`settings-feedback settings-feedback--${
                          providerTest.state === "ok"
                            ? "ok"
                            : providerTest.state === "error"
                              ? "error"
                              : "warn"
                        }`}
                      >
                        {providerTest.text}
                      </p>
                    ) : null}

                    <div className="settings-actions">
                      <button
                        type="submit"
                        className="btn btn--primary"
                        disabled={providerSaving}
                      >
                        {providerSaving ? "保存中…" : "保存"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => void testProvider()}
                        disabled={providerTest.state === "running"}
                      >
                        {providerTest.state === "running" ? "测试中…" : "测试连接"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => setProviderForm(null)}
                      >
                        取消
                      </button>
                    </div>
                  </form>
                ) : null}
            </div>
          </section>
        ) : null}

        {section === "network" ? (
          <section
            className="settings-section"
            role="tabpanel"
            id="settings-panel-network"
            aria-labelledby="settings-tab-network"
          >
            <div className="settings-row">
              <div>
                <div className="settings-row__label">现在怎么连</div>
                <div className="settings-row__value">
                  {connectModeText(connectMode, routingMode)}
                </div>
                {connectMode ? (
                  <p className="settings-note">
                    要换方式：
                    {onNewConfig ? (
                      <button type="button" className="settings-link" onClick={onNewConfig}>
                        新建一套配置
                      </button>
                    ) : (
                      "新建一套配置"
                    )}
                  </p>
                ) : (
                  <p className="settings-note">
                    还没有配置。先在左侧新建一套。
                    {onNewConfig ? (
                      <button type="button" className="settings-link" onClick={onNewConfig}>
                        新建一套配置
                      </button>
                    ) : null}
                  </p>
                )}
              </div>
            </div>

            {connectMode === "system_proxy" ? (
              portEditing ? (
              <div className="settings-row">
                <div>
                  <label
                    className="settings-row__label"
                    htmlFor="settings-proxy-port"
                  >
                    本地代理端口
                  </label>
                  <div className="settings-port-line">
                    <span className="settings-port__prefix">127.0.0.1:</span>
                    <input
                      ref={portInputRef}
                      id="settings-proxy-port"
                      className="settings-port__input num"
                      value={portInput}
                      inputMode="numeric"
                      maxLength={5}
                      readOnly={portSaving}
                      aria-describedby={portDescribedBy}
                      onChange={(event) => {
                        setPortInput(event.target.value);
                        setPortError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void saveProxyPort();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          cancelProxyPortEdit();
                        }
                      }}
                    />
                  </div>
                  {portNote ? (
                    <p className="settings-note">{portNote}</p>
                  ) : null}
                  {portLow ? (
                    <p id="settings-proxy-port-low" className="settings-note">
                      小于 1024 的端口通常要管理员权限，不建议用。
                    </p>
                  ) : null}
                  {portError ? (
                    <p
                      id="settings-proxy-port-error"
                      className="settings-feedback settings-feedback--error"
                      role="alert"
                    >
                      {portError}
                    </p>
                  ) : null}
                </div>
                <div className="settings-row__aside">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void saveProxyPort()}
                    disabled={portSaving}
                  >
                    {portSaving ? "保存中…" : "保存"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={cancelProxyPortEdit}
                    disabled={portSaving}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">
                    本地代理端口{" "}
                    <button
                      type="button"
                      className="ask-ai"
                      onClick={() =>
                        askAi("本地代理端口", `127.0.0.1:${displayPort}`)
                      }
                    >
                      问 AI
                    </button>
                  </div>
                  <div className="settings-port-line">
                    <code className="settings-port-address num">
                      127.0.0.1:{displayPort}
                    </code>
                  </div>
                  {portNote ? (
                    <p className="settings-note">{portNote}</p>
                  ) : null}
                  {portFeedback ? (
                    <p
                      className="settings-feedback settings-feedback--ok"
                      role="status"
                    >
                      {portFeedback}
                    </p>
                  ) : null}
                  {!portFallback && portAvailability === "occupied" ? (
                    <p className="settings-feedback settings-feedback--warn">
                      现在被别的软件占用，连接时会自动顺延。
                    </p>
                  ) : null}
                  {!portFallback && portAvailability === "unavailable" ? (
                    <p className="settings-feedback settings-feedback--warn">
                      这台机器绑不了这个端口（需要管理员权限），连接时会自动顺延。
                    </p>
                  ) : null}
                </div>
                <div className="settings-row__aside">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void copyProxyAddress()}
                  >
                    {proxyCopy === "ok"
                      ? "已复制"
                      : proxyCopy === "error"
                        ? "复制失败"
                        : "复制"}
                  </button>
                  <button
                    ref={portEditButtonRef}
                    type="button"
                    className="btn btn--ghost"
                    onClick={beginProxyPortEdit}
                  >
                    编辑
                  </button>
                </div>
              </div>
              )
            ) : null}

            {connectMode ? (
              <>
                <SeedRefreshRow
                  bridge={bridge}
                  info={seedInfo}
                  onInfo={setSeedInfo}
                  connected={connected}
                  open={open}
                />

                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">添加节点</div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setImportOpen(true)}
                  >
                    添加
                  </button>
                </div>
              </>
            ) : null}

            {importOpen ? (
              <div
                className="modal-backdrop modal-backdrop--nested"
                onMouseDown={() => setImportOpen(false)}
              >
                <div
                  ref={importDialogRef}
                  className="modal modal--confirm"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="import-dialog-title"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <header className="modal__head">
                    <h2 id="import-dialog-title" className="modal__title">
                      添加节点
                    </h2>
                    <button
                      type="button"
                      className="modal__close"
                      onClick={() => setImportOpen(false)}
                      aria-label="关闭"
                    >
                      <IconClose size={14} />
                    </button>
                  </header>

                  <p className="settings-note">
                    支持多行 ss:// 链接或 https 订阅地址；文件里的节点密码不要外传。
                  </p>

                  <div className="settings-input">
                    <textarea
                      aria-label="节点链接或订阅地址"
                      value={importText}
                      rows={4}
                      disabled={importBusy}
                      placeholder={"ss://...\nhttps://..."}
                      onChange={(event) => {
                        setImportText(event.target.value);
                        setImportError(null);
                      }}
                    />
                  </div>

                  {importResult ? (
                    <div className="settings-import">
                      <p
                        className={`settings-feedback ${
                          importResult.imported > 0
                            ? "settings-feedback--ok"
                            : "settings-feedback--warn"
                        }`}
                        role="status"
                      >
                        {importResult.imported > 0
                          ? `已添加 ${importResult.imported} 个节点`
                          : "没有添加节点"}
                      </p>
                      {importResult.skipped.length > 0 ? (
                        <ul className="settings-import__skipped">
                          {importResult.skipped.map((item, index) => (
                            <li key={`${item.name}-${item.reason}-${index}`}>
                              {item.name ? `${item.name}：` : ""}
                              {importSkipReason(item.reason)}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}

                  {importError ? (
                    <p
                      className="settings-feedback settings-feedback--error"
                      role="alert"
                    >
                      {importError}
                    </p>
                  ) : null}

                  <div className="settings-actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setImportOpen(false)}
                      disabled={importBusy}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void submitImport()}
                      disabled={importBusy || importText.trim() === ""}
                    >
                      {importBusy
                        ? importIsUrl
                          ? "正在获取…"
                          : "正在添加…"
                        : "添加"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {section === "advanced" ? (
          <section
            className="settings-section"
            role="tabpanel"
            id="settings-panel-advanced"
            aria-labelledby="settings-tab-advanced"
          >
            <p className="settings-note">
              这里的东西平时不用改。连不上网、打不开网页时再看。
            </p>

            <div className="settings-subhead">修复网络</div>

            {showCleanupProxy ? (
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">清除残留代理</div>
                  <div className="settings-row__value">
                    清除系统里残留的代理设置；已经断开 VPN，但仍上不了网时用。
                  </div>
                  <p className="settings-note">不会影响「全部流量」的接管。</p>
                </div>
                <button type="button" className="btn btn--ghost" onClick={onRestoreNetwork}>
                  清除残留代理
                </button>
              </div>
            ) : null}

            <div className="danger-zone">
              <div className="danger-zone__body">
                <div className="danger-zone__title">重置网络</div>
                <p className="settings-row__value">
                  把网络恢复成没装 VPN 的样子。不会删除配置和节点。
                </p>
                <p className="settings-note">只在连不上网、其它方法都无效时用。</p>
                {lastReset ? (
                  <p
                    className={`settings-note ${
                      lastReset.failed > 0 ? "reset-last--warn" : ""
                    }`}
                  >
                    {lastReset.failed > 0
                      ? `上次重置：${resetTimeLabel(lastReset.at)} · ${lastReset.failed} 项未完成`
                      : `上次重置：${resetTimeLabel(lastReset.at)} · ${lastReset.total} 项全部完成`}
                  </p>
                ) : null}
              </div>
              <button
                ref={resetTriggerRef}
                type="button"
                className="btn btn--danger-ghost"
                onClick={() => setResetPhase("confirm")}
              >
                重置网络
              </button>
            </div>

            <details className="settings-fold">
              <summary className="settings-fold__summary">更新与诊断</summary>
              <div className="settings-fold__body">
                <RuntimeUpgradeRow controller={coreUpgrade} />
                <TunHelperRow controller={tunHelper} activeConnection={connected} />

                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">打开日志</div>
                    <div className="settings-row__value">
                      在文件管理器中定位最近的日志文件。
                    </div>
                  </div>
                  <button type="button" className="btn btn--ghost" onClick={onOpenLogs}>
                    打开日志目录
                  </button>
                </div>

                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">复制诊断信息</div>
                    <div className="settings-row__value">
                      复制当前状态，便于排查问题；不包含 Key。
                    </div>
                  </div>
                  <div className="settings-row__aside">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => void copyDiagnostics()}
                    >
                      复制诊断信息
                    </button>
                  </div>
                </div>
                {diagnosticNotice ? (
                  <p className="settings-feedback settings-feedback--ok">{diagnosticNotice}</p>
                ) : null}

                {/* tun_probe 只在 debug 构建注册，release 里连入口一起隐藏。 */}
                {import.meta.env.DEV ? <TunDiagnosticsRow bridge={bridge} /> : null}

                {import.meta.env.DEV ? (
                  <div className="settings-row">
                    <div>
                      <div className="settings-row__label">重新运行引导</div>
                      <div className="settings-row__value">
                        不会删除已有 Key 或节点。仅开发构建可见。
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={onRestartOnboarding}
                    >
                      重新运行
                    </button>
                  </div>
                ) : null}
              </div>
            </details>
          </section>
        ) : null}

        {section === "about" ? (
          <section
            className="settings-section"
            role="tabpanel"
            id="settings-panel-about"
            aria-labelledby="settings-tab-about"
          >
            <div className="settings-row">
              <div>
                <div className="settings-row__label">版本</div>
                <div className="settings-row__value num">v{APP_VERSION}</div>
              </div>
            </div>

            {OPEN_SOURCE_URL ? (
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">开源与反馈</div>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void bridge.openExternal(OPEN_SOURCE_URL)}
                >
                  打开仓库
                </button>
              </div>
            ) : null}

            <p className="settings-note">
              AI 对话会发给你选的服务；配置、节点和日志都留在本机。
            </p>
          </section>
        ) : null}
      </div>
      </div>

      {resetPhase !== "idle" ? (
        <div
          className="modal-backdrop modal-backdrop--nested"
          onMouseDown={() => {
            if (resetPhase === "confirm") closeReset();
          }}
        >
          <div
            ref={resetDialogRef}
            className="modal modal--confirm reset-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="modal__head">
              <h2 id="reset-dialog-title" className="modal__title">
                {resetTitle}
              </h2>
              <button
                type="button"
                className="modal__close"
                onClick={closeReset}
                aria-label="关闭"
                disabled={resetPhase === "running"}
              >
                <IconClose size={14} />
              </button>
            </header>

            {resetPhase === "confirm" ? (
              <div className="reset-confirm">
                <p className="reset-confirm__warning">
                  会立刻断开当前连接，并撤销 Veyl 对网络的改动。不会删除配置和节点。
                </p>
                <p className="reset-confirm__text">正在开会或下载时，等结束再做。</p>
                <div className="settings-actions">
                  <button
                    ref={resetCancelRef}
                    type="button"
                    className="btn btn--ghost"
                    onClick={closeReset}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger-ghost"
                    onClick={() => void runNetworkReset()}
                  >
                    重置网络
                  </button>
                </div>
              </div>
            ) : null}

            {resetPhase === "running" ? (
              <div className="reset-running" role="status" aria-live="polite">
                <p className="reset-running__text">不要关闭 Veyl。网络会短暂中断。</p>
                <div
                  className="reset-progress"
                  role="progressbar"
                  aria-label="正在重置网络"
                />
                <div className="settings-actions">
                  <button type="button" className="btn btn--ghost" disabled>
                    正在重置…
                  </button>
                </div>
              </div>
            ) : null}

            {resetPhase === "result" && outcome ? (
              <div className="reset-result">
                <div role="status" aria-live="polite">
                  <h3 className={`reset-result__title is-${outcome.kind}`}>
                    {outcome.title}
                  </h3>
                  {outcome.sub ? (
                    <p className="reset-result__sub">{outcome.sub}</p>
                  ) : null}
                </div>

                {resetResult && !resetResult.verified ? (
                  <p className="reset-result__hint">
                    网络状态没有通过复查。先点「再试一次」；仍不通过就复制诊断信息发给助手。
                  </p>
                ) : null}

                {resetResult && resetResult.steps.length > 0 ? (
                  outcome.kind === "success" ? (
                    <details className="reset-route-help">
                      <summary>查看详情</summary>
                      <ul className="reset-steps">{resetStepItems}</ul>
                    </details>
                  ) : (
                    <ul className="reset-steps">{resetStepItems}</ul>
                  )
                ) : null}

                {resetResult?.steps.some(
                  (step) =>
                    resetStepStatus(step) === "failed" &&
                    canonicalResetStep(step.id) === "clear_routes",
                ) ? (
                  <details className="reset-route-help">
                    <summary>手动清理路由（高级）</summary>
                    <ol>
                      <li>
                        先确认当前默认网关：<code>route -n get default</code>
                      </li>
                      <li>
                        只删除诊断信息里标出的那一条残留路由：
                        <span className="reset-route-help__code">
                          <code>sudo route -n delete -net &lt;残留网段&gt;</code>
                          <button
                            type="button"
                            className="btn btn--ghost reset-route-help__copy"
                            onClick={() => void copyRouteCommand()}
                          >
                            复制模板（替换 &lt;网段&gt;）
                          </button>
                        </span>
                        如果命令提示需要网关，按诊断信息里的网关补在末尾；不要删 default。
                      </li>
                      <li>不要删除 default，也不要删除你不认识的路由。</li>
                      <li>删除后重新运行「重置网络」做复查。</li>
                      <li>
                        Windows 用户不要执行上面的命令；请在系统设置里使用「网络重置」，或重启电脑。
                      </li>
                    </ol>
                    {routeCopy !== "idle" ? (
                      <p className="settings-feedback settings-feedback--ok">
                        {routeCopy === "ok" ? "已复制" : "复制失败"}
                      </p>
                    ) : null}
                  </details>
                ) : null}

                <div className="settings-actions">
                  {outcome.kind !== "success" ? (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => void runNetworkReset()}
                    >
                      再试一次
                    </button>
                  ) : null}
                  <button
                    ref={resetCloseRef}
                    type="button"
                    className="btn btn--ghost"
                    onClick={closeReset}
                  >
                    关闭
                  </button>
                  {outcome.kind !== "success" ? (
                    <button
                      type="button"
                      className="btn btn--link"
                      onClick={() => void copyResetReport()}
                    >
                      复制诊断信息
                    </button>
                  ) : null}
                </div>
                {resetCopy !== "idle" ? (
                  <p className="settings-feedback settings-feedback--ok">
                    {resetCopy === "ok" ? "已复制" : "复制失败"}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function ResetStepIcon({ status }: { status: "ok" | "failed" | "skipped" }) {
  if (status === "ok") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M2.5 7.3l2.8 2.8 6.2-6.2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M3.2 3.2l7.6 7.6M10.8 3.2l-7.6 7.6"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function describeResetError(error: unknown): string {
  const bridgeError = toBridgeError(error);
  if (/not found|unknown command/i.test(bridgeError.message)) {
    return "当前版本还没有接入重置网络，请更新应用后再试。";
  }
  // 原始错误可能带路径或英文命令，只进「复制诊断信息」。
  return "重置没有开始，请稍后再试；仍失败就复制诊断信息发给助手。";
}

export function describeProviderError(error: unknown): string {
  const bridgeError = toBridgeError(error);
  if (/not found|unknown command/i.test(bridgeError.message)) {
    return "AI 服务功能还没有接入当前版本，请稍后再试。";
  }
  if (bridgeError.code === "NOT_FOUND") {
    return "这个 provider 已经不存在了。";
  }
  if (bridgeError.code === "PRECONDITION_FAILED") {
    const reason = bridgeError.details?.reason;
    if (reason === "builtin_provider") return "内置服务不可删除";
    if (reason === "no_active_provider") return "没有可用的 AI 服务，请到设置里选择一个";
    return bridgeError.message || "这个操作暂时不可用。";
  }
  return bridgeError.message || "操作失败，请重试";
}

export function describeKeyError(error: unknown): string {
  const code = readCode(error);

  switch (code) {
    case "INVALID_ARGUMENT":
      return "Key 格式不对：应以 sk- 开头，长度至少 20 位。";
    case "INVALID_KEY":
      return "Key 已保存在本机，但 DeepSeek 鉴权失败（可能无效或已被吊销）。请重新输入一个有效的 Key。";
    case "SECRET_STORE":
      return "本地加密凭据文件写入失败（secrets.enc），请检查磁盘权限或空间后重试。";
    case "NETWORK":
    case "TIMEOUT":
      return "网络不通，没能验证 Key。稍后再试一次。";
    default:
      break;
  }

  const message = readMessage(error);
  return message ? `保存失败：${message}` : "保存失败，请稍后重试。";
}

function readCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return "";
}

function readMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "";
}

export function describeImportError(error: unknown): string {
  const bridgeError = toBridgeError(error);
  const reason = bridgeError.details?.reason;

  switch (reason) {
    case "not_json_file":
      return "请选择 .json 文件。";
    case "file_too_large":
      return "文件过大，最大 1 MB。";
    case "file_unreadable":
      return "无法读取这个文件。";
    case "invalid_json":
      return "这个文件不是有效的节点文件。";
    case "no_importable_nodes": {
      const skipped = bridgeError.details?.skipped;
      return typeof skipped === "number"
        ? `已跳过 ${skipped} 个，但没有可导入的节点。`
        : "文件里没有支持的节点。";
    }
    default:
      break;
  }

  if (bridgeError.code === "UNSUPPORTED") {
    const method = bridgeError.details?.method;
    return typeof method === "string"
      ? `不支持加密方式 ${method}，目前只支持 aes-256-gcm。`
      : "不支持这种加密方式，目前只支持 aes-256-gcm。";
  }

  if (bridgeError.code === "SECRET_STORE") {
    return "凭据保存失败，请重试。";
  }

  return bridgeError.message || "导入失败，请重试。";
}
