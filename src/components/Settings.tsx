import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type {
  AgentBridge,
  AppLanguage,
  AppLanguageState,
  DefaultProfileStatus,
  ProxyPortAvailability,
  LlmProtocol,
  LlmProvider,
  LlmProviderInput,
  MyServerAccount,
  MyServerWallet,
  NetworkForceResetResult,
  NetworkForceResetStep,
  SyncIntervalMinutes,
} from "../agent/bridge";
import { DEFAULT_PROXY_PORT, isHttpUrl, isLocalEndpoint } from "../agent/bridge";
import type {
  ConfigConnectMode,
  ConfigRouteMode,
  RuntimeView,
} from "../agent/protocol";
import { toBridgeError } from "../agent/errors";
import { getLanguage, setLanguage, t as translate, useLanguage, useT } from "../i18n";
import { errorText } from "../i18n/errorText";
import type { MessageKey } from "../i18n";
import { formatUsdCents } from "../myservers/labels";
import { isSignedIn } from "../myservers/useMyServers";
import type { WalletTrigger } from "../myservers/useMyServers";
import { settingsConsultPrompt } from "../ai/settingsConsult";
import { useFocusTrap } from "../ui/focus";
import { isComposingEvent } from "../ui/ime";
import { copyText } from "../ui/clipboard";
import { IconClose } from "./icons";
import { BillingLedgerDialog } from "./BillingLedgerDialog";
import { RuntimeUpgradeRow, useRuntimeUpgrade } from "./RuntimeUpgrade";
import { TunDiagnosticsRow } from "./TunDiagnostics";
import { TunHelperRow, useTunHelper } from "./TunHelper";

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
  /** 当前配置 id；接管方式切换与连接设置用它。 */
  configId?: string | null;
  onClose: () => void;
  onRestartOnboarding: () => void;
  onOpenLogs: () => void;
  onRestoreNetwork: () => void;
  /** AI 已配置时才由 App 传入：生成问题报告并打开右栏。 */
  onReportProblem?: () => void;
  /** 正在开会话发开场：期间禁用入口，防止连点。 */
  reportBusy?: boolean;
  /** 行内「问 AI」已删除；保留签名等 App 侧一并清理。 */
  onAskAi: (text: string, section: SectionId) => void;
  /** 从导入入口进来时直接落到「网络」；默认「账号与 AI」。 */
  initialSection?: SectionId;
  /** 当前配置的流量范围；null = 未知，开关按智能显示。 */
  routingMode?: ConfigRouteMode | null;
  /** 切换流量范围；热切换不断流。 */
  onSetRoutingMode?: (
    mode: "direct" | "proxy_all",
  ) => Promise<{ ok: boolean; message?: string }>;
  /** 接管方式切换成功后让 App 重读配置。 */
  onConnectModeChanged?: (mode: ConfigConnectMode) => void;
  /** 接管方式切换：与舞台快捷切换共用同一个处理函数与命令。 */
  onSetConnectMode?: (
    mode: ConfigConnectMode,
  ) => Promise<{ ok: boolean; message?: string }>;
  /** 咨询 AI：设置缩左、右侧并排助手；App 据此隐藏原来的右栏。 */
  assistant?: ReactNode;
  onConsultingChange?: (consulting: boolean) => void;
  /** 从关闭态打开咨询时，带着当前设置总览去发一条消息；false = 被拦下，不切换布局。 */
  onConsultAi?: (prompt: string) => boolean;
  /** 切 tab 时通知 App，重新打开设置能落回原处。 */
  onSectionChange?: (section: SectionId) => void;
  /** AI 指路：section 内的 row 高亮 2 秒；row=null 只切段。 */
  point?: { section: SectionId; row: string | null; nonce: number } | null;
  account?: MyServerAccount | null;
  /** 设置 › 账户与账号入口共用同一份 wallet 状态；未接线时按「—」显示。 */
  wallet?: MyServerWallet | null;
  walletLoading?: boolean;
  /** 已有值时的刷新在途：余额行入口写「刷新中」，旧值不动。 */
  walletRefreshing?: boolean;
  walletError?: string | null;
  /** 刷新失败但手上还有旧值：显示旧值并注明「显示的是上次的余额」。 */
  walletStale?: boolean;
  /** 余额读取失败时的重试 / 打开账户段时的刷新：走 30 秒门禁。 */
  onRefreshWallet?: (trigger: WalletTrigger) => void;
  /** 设置里的「刷新」文字链接：强制刷新，不受 30 秒门禁限制。 */
  onForceRefresh?: () => void;
  onLogin?: () => void;
  onTopUp?: () => void;
  /** 设备/账户的永久状态：在账户页顶部给明确出路，不说「稍后再试」。 */
  identityProblem?: "lost" | "device_revoked" | "account_blocked" | null;
  /** 重新注册设备；返回是否恢复成功。 */
  onReRegister?: () => Promise<boolean>;
  /** 账户停用：换一个账户（重新注册设备后再登录）。 */
  onSwitchAccount?: () => Promise<boolean>;
  /** 退出登录：成功后关闭设置，由 App 给 toast。 */
  onLogout?: () => Promise<{ ok: boolean; message?: string }>;
  /** 更上层的全局弹层（如 AI 告警）开着：设置让出焦点陷阱，免得两层互抢 Tab。 */
  trapPaused?: boolean;
  /** 节点配置同步：间隔档位与手动触发都由 App 持有并落库。 */
  syncInterval?: SyncIntervalMinutes;
  onSyncIntervalChange?: (minutes: SyncIntervalMinutes) => void;
  onSyncNow?: () => void;
  syncBusy?: boolean;
  /** 最近一次真正跑完的同步结果；换号后 App 会清空。 */
  syncResult?: "ok" | "error" | null;
  syncResultAt?: number | null;
  /** 间隔写库失败：在行内标一句「未保存」，不拦交互。 */
  syncIntervalUnsaved?: boolean;
  /** 最近一次成功同步的时刻（Unix 毫秒）；null = 尚未同步。 */
  lastSyncedAt?: number | null;
}

type SectionId = "ai" | "network" | "account" | "advanced";

/** 咨询提示词里用的分区名，与页签同一套文案。 */
const SECTION_NAMES: Record<SectionId, MessageKey> = {
  ai: "controls.ai",
  network: "settings.tab.connection",
  account: "controls.account",
  advanced: "controls.advanced",
};

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

/** 后端预算 15 秒，前端留 3 秒余量；到点就不再等，界面转入可关闭的结果态。 */
const RESET_TIMEOUT_MS = 18_000;
const RESET_TIMEOUT_SECONDS = RESET_TIMEOUT_MS / 1000;

type ResetErrorState = {
  /** notStarted = 命令直接失败；timeout = 18 秒没回结果，后台可能还在跑。 */
  kind: "notStarted" | "timeout";
  text: string;
};

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

const RESET_STEP_LABELS: Record<ResetStepKey, MessageKey> = {
  stop_runtime: "settings.reset.step.stopRuntime",
  stop_tun: "settings.reset.step.stopTun",
  sweep_processes: "settings.reset.step.sweep",
  clear_routes: "settings.reset.step.routes",
  flush_dns: "settings.reset.step.dns",
  restore_proxy: "settings.reset.step.proxy",
  clear_plaintext: "settings.reset.step.temp",
  verify: "settings.reset.step.verify",
};

const RESET_STEP_NEXT: Record<ResetStepKey, MessageKey> = {
  stop_runtime: "settings.reset.next.stopRuntime",
  stop_tun: "settings.reset.next.stopTun",
  sweep_processes: "settings.reset.next.sweep",
  clear_routes: "settings.reset.next.routes",
  flush_dns: "settings.reset.next.dns",
  restore_proxy: "settings.reset.next.proxy",
  clear_plaintext: "settings.reset.next.temp",
  verify: "settings.reset.next.verify",
};

/** 成功行用设计文档的固定说明；后端 detail 可能带内部路径，不适合直接展示。 */
const RESET_STEP_DONE: Record<ResetStepKey, MessageKey> = {
  stop_runtime: "settings.reset.done.stopRuntime",
  stop_tun: "settings.reset.done.stopTun",
  sweep_processes: "settings.reset.done.sweep",
  clear_routes: "settings.reset.done.routes",
  flush_dns: "settings.reset.done.dns",
  restore_proxy: "settings.reset.done.proxy",
  clear_plaintext: "settings.reset.done.temp",
  verify: "settings.reset.done.verify",
};

const RESET_STEP_FAILED: Record<ResetStepKey, MessageKey> = {
  stop_runtime: "settings.reset.failed.stopRuntime",
  stop_tun: "settings.reset.failed.stopTun",
  sweep_processes: "settings.reset.failed.sweep",
  clear_routes: "settings.reset.failed.routes",
  flush_dns: "settings.reset.failed.dns",
  restore_proxy: "settings.reset.failed.proxy",
  clear_plaintext: "settings.reset.failed.temp",
  verify: "settings.reset.failed.verify",
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
  return key ? translate(RESET_STEP_LABELS[key]) : translate("settings.reset.otherCheck");
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
  return key ? translate(RESET_STEP_NEXT[key]) : null;
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
    title: (() => {
      const count = Math.max(unfinished.length, 1);
      return translate(
        count === 1
          ? "settings.reset.partialTitleOne"
          : "settings.reset.partialTitle",
        { count },
      );
    })(),
    sub: translate("settings.reset.partialSub"),
  };

  if (unfinished.length === 0) {
    if (result.ok && result.verified) {
      return {
        kind: "success",
        title: translate("settings.reset.successTitle"),
        sub: "",
      };
    }
    // 没有逐项结果时不能凭空说「有 n 项没完成」；下面也没有对应的失败行。
    if (result.steps.length === 0) {
      return {
        kind: "unverified",
        title: translate("settings.reset.unverifiedTitle"),
        sub: translate("settings.reset.unverifiedSub"),
      };
    }
    return {
      kind: "unverified",
      title: translate("settings.reset.verifyFailedTitle"),
      sub: translate("settings.reset.verifyFailedSub"),
    };
  }

  const critical = unfinished.some((step) => {
    const key = canonicalResetStep(step.id);
    return key === null || RESET_CRITICAL.has(key);
  });
  if (!critical) return partial;

  return {
    kind: "failed",
    title: translate("settings.reset.failedTitle"),
    sub: translate("settings.reset.failedSub"),
  };
}

export function resetTimeLabel(at: number, now = Date.now()): string {
  if (now - at < 60_000) return translate("settings.reset.justNow");
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return translate("settings.reset.today", { time: `${hh}:${mm}` });
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
  if (at === null) return translate("settings.seed.never");
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return translate("settings.seed.justNow");
  if (diff < 3_600_000) {
    return translate("settings.seed.minutesAgo", {
      count: Math.floor(diff / 60_000),
    });
  }
  if (diff < 86_400_000) {
    return translate("settings.seed.hoursAgo", {
      count: Math.floor(diff / 3_600_000),
    });
  }
  return translate("settings.seed.daysAgo", {
    count: Math.floor(diff / 86_400_000),
  });
}

function seedCheckedAt(info: SeedRefreshInfo | null): number | null {
  if (!info) return null;
  return seedTimestamp(info.checkedAt) ?? seedTimestamp(info.appliedAt);
}

export function seedSummary(info: SeedRefreshInfo | null): string {
  if (!info) return translate("settings.seed.noNodesNever");
  const head =
    info.nodeCount > 0
      ? translate(
          info.nodeCount === 1 ? "settings.seed.nodesOne" : "settings.seed.nodes",
          { count: info.nodeCount },
        )
      : translate("settings.seed.noNodes");
  const checkedAt = seedCheckedAt(info);
  const checked =
    checkedAt === null
      ? translate("settings.seed.neverChecked")
      : translate("settings.seed.checked", { age: seedAgeLabel(checkedAt) });
  return `${head} · ${checked}`;
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
      return translate("settings.seed.checking");
    case "latest":
      return translate("settings.seed.latest");
    case "updated": {
      const text =
        phase.added !== null && phase.added > 0
          ? translate("settings.seed.updatedAdded", {
              added: phase.added,
              total: phase.total,
            })
          : translate("settings.seed.updated", { total: phase.total });
      return connected ? `${text}${translate("settings.seed.nextConnect")}` : text;
    }
    case "offline":
      return nodeCount > 0
        ? translate("settings.seed.offlineCount", { count: nodeCount })
        : translate("settings.seed.offline");
    case "invalid":
      return translate("settings.seed.invalid");
    case "local_write":
      return translate("settings.seed.localWrite");
    case "failed":
      return translate("settings.seed.failed");
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
  const t = useT();
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
        <div className="settings-row__label">{t("settings.seed.rowLabel")}</div>
        <div className="settings-row__value">{withMonoDigits(seedSummary(info))}</div>
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
              ? `${t("settings.seed.replaced", {
                  from: removedNotice.from,
                  to: removedNotice.to,
                })}${connected ? t("settings.seed.replacedNext") : ""}`
              : t("settings.seed.removedNoNodes", { from: removedNotice.from })}
          </p>
        ) : null}
        {phase.kind === "invalid" ? (
          <button
            type="button"
            className="seed-refresh__copy"
            onClick={() => void copyDiagnostics(phase)}
          >
            {copyState === "ok"
              ? t("chat.copy.copied")
              : copyState === "error"
                ? t("chat.copy.failed")
                : t("settings.advanced.copyDiagnostics")}
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
          {checking ? t("settings.seed.checkingShort") : t("settings.seed.check")}
        </button>
      </div>
    </div>
  );
}

const SECTIONS: Array<{ id: SectionId; label: MessageKey }> = [
  { id: "ai", label: "controls.ai" },
  { id: "network", label: "settings.tab.connection" },
  { id: "account", label: "controls.account" },
  { id: "advanced", label: "controls.advanced" },
];

const PRESETS: Array<{
  id: string;
  label: string;
  labelKey?: MessageKey;
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
    model: "deepseek-flash",
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
    label: "Ollama",
    labelKey: "settings.preset.ollamaLocal",
    name: "Ollama",
    protocol: "openai",
    baseUrl: "http://localhost:11434",
    model: "llama3.2",
  },
];

function protocolLabel(protocol: LlmProtocol): string {
  return translate(
    protocol === "anthropic" ? "settings.protocol.anthropic" : "settings.protocol.openai",
  );
}



/** 只把数字送进 mono；中文和单位保持正文。 */
function withMonoDigits(text: string) {
  return text
    .split(/(\d+)/)
    .filter(Boolean)
    .map((part, index) =>
      /^\d+$/.test(part) ? (
        <span key={index} className="num">
          {part}
        </span>
      ) : (
        <span key={index}>{part}</span>
      ),
    );
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
  configId = null,
  onClose,
  onRestartOnboarding,
  onOpenLogs,
  onRestoreNetwork,
  onReportProblem,
  reportBusy = false,
  initialSection = "ai",
  routingMode = null,
  onSetRoutingMode,
  onConnectModeChanged,
  onSetConnectMode,
  assistant,
  onConsultingChange,
  onConsultAi,
  onSectionChange,
  point = null,
  account = null,
  wallet = null,
  walletLoading = false,
  walletRefreshing = false,
  walletError = null,
  walletStale = false,
  onRefreshWallet,
  onForceRefresh,
  onLogin,
  onTopUp,
  identityProblem = null,
  onReRegister,
  onSwitchAccount,
  onLogout,
  trapPaused = false,
  syncInterval = 30,
  onSyncIntervalChange,
  onSyncNow,
  syncBusy = false,
  syncResult = null,
  syncResultAt = null,
  syncIntervalUnsaved = false,
  lastSyncedAt = null,
}: Props) {
  const t = useT();
  const language = useLanguage();
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
  // 打开设置›账户：触发一次刷新（30 秒节流在 refreshWallet 里）。
  const refreshWalletRef = useRef(onRefreshWallet);
  refreshWalletRef.current = onRefreshWallet;
  useEffect(() => {
    // 未登录不发：登出时停在这页也不会打余额接口。
    if (!open || section !== "account" || account?.logged_in !== true) return;
    refreshWalletRef.current?.("open_settings");
  }, [open, section, account?.logged_in]);
  /** 咨询 AI：设置缩左、助手并排。 */
  const [consulting, setConsulting] = useState(false);
  /** AI 指路高亮的行 id；2 秒后自动清掉。 */
  const [pointedRow, setPointedRow] = useState<string | null>(null);
  const pointTimerRef = useRef<number | null>(null);
  /** 已连接时切换接管方式：等就地确认。 */
  const [pendingMode, setPendingMode] = useState<ConfigConnectMode | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  // 节点配置同步：未登录不发账户命令（§11）；手动同步的失败要留在行内。
  // 账户还没读回来（null）不算未登录：按钮禁用、状态保持「尚未同步」。
  const syncSignedOut = account !== null && !isSignedIn(account);
  const syncAccountUnknown = account === null;
  // 「刚刚同步」满一分钟后要自己变回时间：成功后按拍重算，分钟过了就不再排。
  const [syncClock, setSyncClock] = useState(() => Date.now());
  const [seedInfo, setSeedInfo] = useState<SeedRefreshInfo | null>(defaultProfile);
  const coreUpgrade = useRuntimeUpgrade({
    bridge,
    enabled: open && section === "advanced",
    connected,
  });
  const tunHelper = useTunHelper({ bridge, enabled: open && section === "advanced" });
  // 刚同步成功的一分钟内显示「刚刚同步」，之后退回准确时间。
  useEffect(() => {
    if (lastSyncedAt === null || syncClock - lastSyncedAt >= 60_000) return;
    const timer = window.setTimeout(() => setSyncClock(Date.now()), 15_000);
    return () => window.clearTimeout(timer);
  }, [lastSyncedAt, syncClock]);
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
  const [appVersion, setAppVersion] = useState<string | null>(null);
  /** 语言选择；读不到时保持 null（不猜一个档位），写成功才更新。 */
  const [appLanguage, setAppLanguage] = useState<AppLanguageState | null>(null);
  const [languageBusy, setLanguageBusy] = useState(false);
  const [languageError, setLanguageError] = useState<string | null>(null);
  /** 读取代次：点选写入成功后递增；之前发出的 GET 结果据此丢弃，别把新值覆盖回旧的。 */
  const languageReadEpochRef = useRef(0);
  const [includeDomains, setIncludeDomains] = useState(false);
  const [domainBusy, setDomainBusy] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [resetPhase, setResetPhase] = useState<ResetPhase>("idle");
  const [resetResult, setResetResult] = useState<NetworkForceResetResult | null>(null);
  const [resetError, setResetError] = useState<ResetErrorState | null>(null);
  const [resetElapsed, setResetElapsed] = useState(0);
  /** 每次重置的编号；关闭弹层或重新发起后加一，晚到的结果据此丢弃。 */
  const resetRunRef = useRef(0);
  const [billsOpen, setBillsOpen] = useState(false);
  const billsTriggerRef = useRef<HTMLButtonElement>(null);
  const returnBillsFocusRef = useRef(false);
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const resetDialogRef = useRef<HTMLDivElement>(null);
  const resetTriggerRef = useRef<HTMLButtonElement>(null);
  const resetCancelRef = useRef<HTMLButtonElement>(null);
  const resetCloseRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);
  const copyTimerRef = useRef<number | null>(null);

  // 运行中每秒更新已用时间：用户看得到等待在往前走，不是一句静止的「正在重置…」。
  useEffect(() => {
    if (resetPhase !== "running") return;
    const started = Date.now();
    setResetElapsed(0);
    const timer = window.setInterval(
      () => setResetElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [resetPhase]);

  useFocusTrap(
    open &&
      !consulting &&
      resetPhase === "idle" &&
      !billsOpen &&
      !trapPaused,
    dialogRef,
  );
  // 咨询 AI 时助手是设置卡的兄弟节点：焦点陷阱改挂遮罩，Tab 能进助手。
  useFocusTrap(
    open && consulting && resetPhase === "idle" && !billsOpen && !trapPaused,
    backdropRef,
  );
  useFocusTrap(resetPhase !== "idle", resetDialogRef);

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
      setPortError(t("settings.port.invalid"));
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
        pendingNext ? null : connected ? t("settings.port.savedNext") : t("settings.port.saved"),
      );
      returnPortFocusRef.current = true;
      setPortEditing(false);
      onProxyPortSaved?.(result.port);
    } catch (error) {
      setPortError(errorText(error, t("settings.port.saveFailed")));
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
    resetRunRef.current += 1;
    setResetPhase("idle");
    setBillsOpen(false);
    returnBillsFocusRef.current = false;
    setResetElapsed(0);
    setResetResult(null);
    setResetError(null);
    setLastReset(null);
    setResetCopy("idle");
    setRouteCopy("idle");
    setProxyCopy("idle");
    setLanguageError(null);
    setBillsOpen(false);
    setLogoutError(null);
    setRecoverError(null);
    void refreshProviders();
  }, [open, refreshProviders, initialSection]);

  useEffect(() => {
    setSeedInfo(defaultProfile);
  }, [defaultProfile]);

  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [reRegistering, setReRegistering] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [recoverError, setRecoverError] = useState<string | null>(null);

  const closeReset = useCallback(() => {
    // 18 秒后即使命令还没回来也放行：在途结果按编号丢弃，别把用户锁死在弹层里。
    if (resetPhase === "running" && resetElapsed < RESET_TIMEOUT_SECONDS) return;
    resetRunRef.current += 1;
    returnFocusRef.current = true;
    setResetPhase("idle");
    setResetElapsed(0);
    setResetResult(null);
    setResetError(null);
    setResetCopy("idle");
    setRouteCopy("idle");
  }, [resetPhase, resetElapsed]);

  const closeBills = useCallback(() => {
    returnBillsFocusRef.current = true;
    setBillsOpen(false);
  }, []);

  // 关闭账单弹层后焦点回到「查看账单」，键盘用户不用从头 Tab。
  useEffect(() => {
    if (billsOpen || !returnBillsFocusRef.current) return;
    returnBillsFocusRef.current = false;
    billsTriggerRef.current?.focus();
  }, [billsOpen]);

  const closeSettings = useCallback(() => {
    setConsulting(false);
    setPendingMode(null);
    onConsultingChange?.(false);
    onClose();
  }, [onClose, onConsultingChange]);

  const blockedIdentity =
    identityProblem === "device_revoked" || identityProblem === "account_blocked";
  const recovery =
    identityProblem === "lost"
      ? {
          kind: "register" as const,
          text: t("account.identity.lost"),
          label: t("account.identity.lostLabel"),
        }
      : identityProblem === "device_revoked"
        ? {
            kind: "logout" as const,
            text: t("account.identity.revoked"),
            label: t("account.identity.revokedLabel"),
          }
        : identityProblem === "account_blocked"
          ? {
              kind: "switch" as const,
              text: t("account.identity.blocked"),
              label: t("account.identity.blockedLabel"),
            }
          : null;
  // 换账户、重新注册、退出三件事互斥：任一件在途，另一件的按钮也不能点。
  const identityBusy = loggingOut || switching || reRegistering;

  const logout = async () => {
    if (loggingOut || !onLogout) return;
    setLoggingOut(true);
    setLogoutError(null);
    const result = await onLogout();
    setLoggingOut(false);
    if (result.ok) {
      closeSettings();
      return;
    }
    setLogoutError(result.message ?? t("account.logoutFailed"));
  };

  const recoverIdentity = async () => {
    if (!recovery || identityBusy) return;
    if (recovery.kind === "logout") {
      await logout();
      return;
    }
    const run = recovery.kind === "switch" ? onSwitchAccount : onReRegister;
    if (!run) return;
    const setBusy = recovery.kind === "switch" ? setSwitching : setReRegistering;
    setBusy(true);
    setRecoverError(null);
    const ok = await run();
    setBusy(false);
    if (!ok) setRecoverError(t("account.recoverFailed"));
  };

  const selectSection = (next: SectionId) => {
    setSection(next);
    onSectionChange?.(next);
  };

  // 契约 row id ↔ 界面行的唯一挂点；AI 指路靠它滚动与高亮。
  const pointAttrs = (row: string) => ({
    "data-point": row,
    "data-pointed": pointedRow === row ? "true" : undefined,
  });

  // 咨询 AI 的分区事实：只读现有 props / state，取不到的项直接不写。
  // 日志目录没有可读路径（界面只给「打开日志目录」），按取不到处理。
  const consultFacts = (sectionId: SectionId): string => {
    const parts: string[] = [];
    if (sectionId === "ai") {
      const active =
        providers.find((provider) => provider.providerId === activeProviderId) ??
        providers.find((provider) => provider.isActive);
      if (!active) {
        parts.push(translate("settings.consult.fact.noProvider"));
      } else {
        parts.push(translate("settings.consult.fact.provider", { name: active.name }));
        parts.push(
          translate("settings.consult.fact.protocol", {
            protocol: protocolLabel(active.protocol),
          }),
        );
        parts.push(translate("settings.consult.fact.model", { model: active.model }));
        // Key 本身永不进提示词；未配置时只留一句状态。
        if (!active.hasKey) parts.push(translate("settings.consult.fact.noKey"));
      }
    } else if (sectionId === "network") {
      if (connectMode === "system_proxy") {
        parts.push(
          translate("settings.consult.fact.mode", { mode: translate("stage.mode.proxy") }),
        );
      } else if (connectMode === "tun") {
        parts.push(
          translate("settings.consult.fact.mode", { mode: translate("stage.mode.tun") }),
        );
      }
      if (routingMode !== null) {
        // 三值各有事实；智能只是界面芯片的两态词汇，不能拿来兜底。
        const scope =
          routingMode === "proxy_all"
            ? translate("stage.scope.global")
            : routingMode === "direct"
              ? translate("stage.scope.smart")
              : null;
        if (scope !== null) {
          parts.push(translate("settings.consult.fact.scope", { scope }));
        }
      }
      // 端口这一行只在 Proxy 模式下出现在界面上；Tun 下也带上，
      // 但要说明当前模式用不到，避免 AI 讲一个用户看不到的值。
      parts.push(
        translate(
          connectMode === "system_proxy"
            ? "settings.consult.fact.port"
            : "settings.consult.fact.portUnused",
          { port: proxyPort },
        ),
      );
      parts.push(
        translate("settings.consult.fact.sync", {
          interval:
            syncInterval === 0
              ? translate("settings.sync.manual")
              : syncInterval < 60
                ? translate("settings.sync.minutes", { count: syncInterval })
                : translate("settings.sync.hours", { count: syncInterval / 60 }),
        }),
      );
    } else if (sectionId === "account") {
      if (!account?.logged_in) {
        parts.push(translate("settings.consult.fact.signedOut"));
      } else {
        const identity =
          account.email ??
          (account.account_kind === "device"
            ? translate("settings.consult.fact.identityDevice")
            : translate("settings.account.signedIn"));
        parts.push(translate("settings.consult.fact.identity", { identity }));
        if (wallet) {
          parts.push(
            translate("settings.consult.fact.balance", {
              amount: formatUsdCents(wallet.balance_cents),
            }),
          );
        }
      }
    } else {
      parts.push(translate("settings.consult.fact.seed", { summary: seedSummary(seedInfo) }));
      if (runtime.upstream_version) {
        parts.push(
          translate("settings.consult.fact.runtime", { version: runtime.upstream_version }),
        );
      }
    }
    return parts.join(getLanguage() === "en" ? "; " : "；");
  };

  const toggleConsulting = () => {
    if (consulting) {
      setConsulting(false);
      onConsultingChange?.(false);
      return;
    }
    // 打开即带着当前分区的事实；被拦下（未配置 AI）时不要切到并排布局。
    const allowed = onConsultAi?.(
      settingsConsultPrompt(t(SECTION_NAMES[section]), consultFacts(section)),
    );
    if (allowed === false) return;
    setConsulting(true);
    onConsultingChange?.(true);
  };

  const commitConnectMode = useCallback(
    async (next: ConfigConnectMode) => {
      if (!configId) return;
      setModeBusy(true);
      setModeError(null);
      setPendingMode(null);
      try {
        if (onSetConnectMode) {
          // 共享处理函数自己会重读配置，成功后再通知会多 reload 一次。
          const result = await onSetConnectMode(next);
          if (!result.ok) {
            setModeError(
              result.message || t("settings.error.modeSwitch"),
            );
            return;
          }
        } else {
          await bridge.configSetMode({ configId, mode: next });
          onConnectModeChanged?.(next);
        }
      } catch (error) {
        setModeError(errorText(error, t("settings.error.modeSwitch")));
      } finally {
        setModeBusy(false);
      }
    },
    [bridge, configId, onConnectModeChanged, onSetConnectMode],
  );

  const requestConnectMode = (next: ConfigConnectMode) => {
    if (!configId || modeBusy || next === connectMode) return;
    setModeError(null);
    // 已连接：就地确认，切换会短暂断开。
    if (connected) {
      setPendingMode(next);
      return;
    }
    void commitConnectMode(next);
  };

  const changeScope = async (mode: "direct" | "proxy_all") => {
    if (!onSetRoutingMode) return;
    setScopeError(null);
    const result = await onSetRoutingMode(mode);
    if (!result.ok) {
      setScopeError(result.message ?? t("stage.scopeFail"));
    }
  };

  const changeLanguage = async (lang: AppLanguage) => {
    if (languageBusy || lang === appLanguage?.selected) return;
    setLanguageBusy(true);
    setLanguageError(null);
    try {
      const saved = await bridge.appLanguageSet(lang);
      setAppLanguage(saved);
      // 批次 2：让界面当场换语言；其余设置文案仍按原语言，逐批迁移。
      setLanguage(saved.resolved);
      // 写入成功后的选中态是新的：之前发出的读取结果已经过时。
      languageReadEpochRef.current += 1;
    } catch {
      // 后端错误码 → 文案的映射（批次 4）未就绪前，统一用这一句。
      setLanguageError(t("settings.language.error"));
    } finally {
      setLanguageBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setConsulting(false);
    onConsultingChange?.(false);
    setPendingMode(null);
    setModeError(null);
    setScopeError(null);
  }, [open, onConsultingChange]);

  // AI 指路：切到目标段后把 row 滚到可见并高亮 2 秒；row=null 只切段。
  useEffect(() => {
    if (!open || !point?.row || section !== point.section) return;
    const row = point.row;
    const target =
      dialogRef.current?.querySelector<HTMLElement>(`[data-point="${row}"]`) ?? null;
    if (!target) return;
    // 高级里的行可能在收起的折叠块里：先展开再滚。
    const fold = target.closest("details");
    if (fold && !fold.open) fold.open = true;
    target.scrollIntoView?.({ block: "center" });
    setPointedRow(row);
    if (pointTimerRef.current) window.clearTimeout(pointTimerRef.current);
    pointTimerRef.current = window.setTimeout(() => {
      pointTimerRef.current = null;
      setPointedRow(null);
    }, 2000);
  }, [open, section, point?.nonce, point?.row, point?.section]);

  useEffect(
    () => () => {
      if (pointTimerRef.current) window.clearTimeout(pointTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // 更上层弹层（AI 告警）的 Esc 归它自己：别连带关设置。
      if (trapPaused) return;
      // 输入法取消组合的 Esc 不能冒到关窗逻辑：否则刚填的内容全丢。
      if (isComposingEvent(event)) return;
      if (event.key !== "Escape") return;
      // 重置弹层在上层：先关它。18 秒内运行中是否放行由 closeReset 自己判断。
      if (resetPhase !== "idle") {
        closeReset();
        return;
      }
      // 账单弹层次之：Esc 只关它，不关设置。
      if (billsOpen) {
        closeBills();
        return;
      }
      // 端口编辑态先拦下 Esc：只退编辑，不关设置。
      if (portEditing) {
        cancelProxyPortEdit();
        return;
      }
      closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closeSettings, resetPhase, closeReset, portEditing, cancelProxyPortEdit, trapPaused, billsOpen, closeBills]);
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
    if (!model) return t("settings.provider.modelRequired");

    const baseUrl = form.baseUrl.trim();
    if (!isHttpUrl(baseUrl)) return t("settings.provider.baseUrlScheme");
    if (baseUrl.toLowerCase().startsWith("http://") && !isLocalEndpoint(baseUrl)) {
      return t("settings.provider.httpLocalOnly");
    }

    const apiKey = form.apiKey.trim();
    if (!form.hasKey && !apiKey && !isLocalEndpoint(baseUrl)) {
      return t("settings.provider.apiKeyRequired");
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
        text: hadActive ? t("settings.provider.saved") : t("settings.provider.savedActive"),
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
      setProviderError(t("settings.provider.modelRequired"));
      return;
    }

    setProviderError(null);
    setProviderTest({ state: "running", text: t("settings.provider.testing") });
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
              text: `${t("settings.provider.testOk")}${
                result.latencyMs !== null ? ` · ${result.latencyMs} ms` : ""
              }`,
            }
          : { state: "error", text: result.error || t("settings.provider.testFailed") },
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
      text: t("settings.provider.testing"),
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
          ? `${t("settings.provider.testOk")}${
              result.latencyMs !== null ? ` · ${result.latencyMs} ms` : ""
            }`
          : result.error || t("settings.provider.testFailed"),
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
      setProviderNotice({
        kind: "ok",
        text: t("settings.provider.switchedTo", { name: provider.name }),
      });
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
          ? t("settings.provider.deletedNoActive")
          : t("settings.provider.deleted"),
      });
      await refreshProviders();
    } catch (error) {
      setPendingDelete(null);
      setProviderNotice({ kind: "error", text: describeProviderError(error) });
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
    selectSection(SECTIONS[next].id);
    tabRefs.current[next]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    let alive = true;
    bridge
      .getAppVersion()
      .then((version) => {
        if (alive) setAppVersion(version);
      })
      .catch(() => {
        if (alive) setAppVersion(null);
      });
    return () => {
      alive = false;
    };
  }, [open, bridge]);

  // 语言选择：每次打开设置读一次；读失败保留已有选中态，首次没有值才保持 null。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const epoch = languageReadEpochRef.current;
    // 后端命令还没落地时也别打断设置页：同步抛错也走 catch。
    Promise.resolve()
      .then(() => bridge.appLanguageGet())
      .then(
        (state) => {
          // 等结果期间用户点过档位并写成功了：这次读取已经过时，丢弃。
          if (alive && epoch === languageReadEpochRef.current) {
            setAppLanguage(state);
          }
        },
        () => {
          // 读不到不清空：用户刚选中的那一档不能被一次失败的读取抹掉。
        },
      );
    return () => {
      alive = false;
    };
  }, [open, bridge]);

  // 报告偏好：进设置时读一次。放宽域名只能由用户在这里点，任何会话流程都不自动打开。
  const reportEntryEnabled = Boolean(onReportProblem);
  useEffect(() => {
    if (!open || !reportEntryEnabled) return;
    let alive = true;
    bridge.issueReportPreference().then(
      (preference) => {
        if (alive) setIncludeDomains(preference.includeDomains);
      },
      () => {
        if (alive) setDomainError(t("settings.report.prefReadFailed"));
      },
    );
    return () => {
      alive = false;
    };
  }, [open, bridge, reportEntryEnabled]);

  const toggleIncludeDomains = async () => {
    if (domainBusy) return;
    const next = !includeDomains;
    setIncludeDomains(next);
    setDomainError(null);
    setDomainBusy(true);
    try {
      const preference = await bridge.issueReportPreference(next);
      setIncludeDomains(preference.includeDomains);
    } catch {
      // 写入失败回滚勾选，不能只改界面骗人。
      setIncludeDomains(!next);
      setDomainError(t("settings.report.saveFailed"));
    } finally {
      setDomainBusy(false);
    }
  };

  const copyDiagnostics = async () => {
    const payload = {
      app: appVersion,
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
      setDiagnosticNotice(t("settings.report.copied"));
    } catch {
      setDiagnosticNotice(t("settings.report.copyFailed"));
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
          portFallback.reason === "unavailable"
            ? t("settings.port.admin")
            : t("settings.port.occupied");
        portNote = t("settings.port.fallbackShort", {
          actual: portFallback.actual,
          requested: portFallback.requested,
          reason: short,
          saved: proxyPort,
        });
      } else {
        const why =
          portFallback.reason === "unavailable"
            ? t("settings.port.adminLong")
            : t("settings.port.occupiedLong");
        portNote = t("settings.port.fallbackLong", {
          requested: portFallback.requested,
          actual: portFallback.actual,
          reason: why,
        });
      }
    } else if (connected && runtime.system_proxy_enabled) {
      portNote = t("settings.port.browserReady");
    } else {
      portNote = t("settings.port.others");
    }
  }

  const copyProxyAddress = async () => {
    const ok = await copyText(`127.0.0.1:${displayPort}`);
    flashCopy(setProxyCopy, ok ? "ok" : "error");
  };

  const runNetworkReset = async () => {
    if (resetPhase === "running") return;
    const runId = ++resetRunRef.current;
    setResetResult(null);
    setResetError(null);
    setResetCopy("idle");
    setRouteCopy("idle");
    setResetPhase("running");
    let timer: number | null = null;
    // 后端自己按 15 秒兜底；这里只兜「命令永远不回」，到点转成可关闭的结果态。
    const timedOut = new Promise<null>((resolve) => {
      timer = window.setTimeout(() => resolve(null), RESET_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([bridge.networkForceReset(), timedOut]);
      // 弹层已被关闭或已重新发起：这次的结果在后台丢弃，不再碰界面。
      if (resetRunRef.current !== runId) return;
      if (result === null) {
        setResetError({ kind: "timeout", text: t("settings.reset.timeoutSub") });
      } else {
        setResetResult(result);
        setLastReset({
          at: Date.now(),
          total: result.steps.length,
          failed: result.steps.filter((step) => resetStepStatus(step) !== "ok").length,
        });
      }
    } catch (error) {
      if (resetRunRef.current !== runId) return;
      setResetError({ kind: "notStarted", text: describeResetError(error) });
    } finally {
      if (timer !== null) window.clearTimeout(timer);
      if (resetRunRef.current === runId) setResetPhase("result");
    }
  };

  const copyResetReport = async () => {
    const payload = {
      app: appVersion,
      eventSource: bridge.mode,
      runtimeState: runtime.state,
      reset: resetResult
        ? {
            ok: resetResult.ok,
            verified: resetResult.verified,
            exitIp: resetResult.exitIp,
            steps: resetResult.steps,
          }
        : { error: resetError?.text ?? null },
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
      await navigator.clipboard.writeText(t("settings.reset.sudoTemplate"));
      flashCopy(setRouteCopy, "ok");
    } catch {
      flashCopy(setRouteCopy, "error");
    }
  };

  const outcome = resetError
    ? {
        kind: "failed" as const,
        title: t(
          resetError.kind === "timeout"
            ? "settings.reset.timeoutTitle"
            : "settings.reset.notStarted",
        ),
        sub: resetError.text,
      }
    : resetResult
      ? resetOutcome(resetResult)
      : null;
  const resetTitle =
    resetPhase === "confirm"
      ? t("settings.reset.titleQuestion")
      : resetPhase === "running"
        ? t("settings.reset.running")
        : t("settings.reset.title");

  const resetStepItems = resetResult
    ? resetResult.steps.map((step, index) => {
        const status = resetStepStatus(step);
        const key = canonicalResetStep(step.id);
        const next = status === "failed" ? resetStepNext(step.id) : null;
        const detail =
          status === "skipped"
            ? t("settings.reset.skipped")
            : status === "ok"
              ? key
                ? t(RESET_STEP_DONE[key])
                : ""
              : key
                ? t(RESET_STEP_FAILED[key])
                : t("settings.reset.stepFailed");
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
              {status === "ok"
                ? t("settings.reset.doneShort")
                : status === "failed"
                  ? t("settings.reset.notDone")
                  : t("settings.reset.notRun")}
            </span>
          </li>
        );
      })
    : null;

  const startServerSync = () => {
    if (!onSyncNow || syncSignedOut || syncAccountUnknown) return;
    onSyncNow();
  };

  const syncFresh = lastSyncedAt !== null && syncClock - lastSyncedAt < 60_000;
  // 进行中不改值槽：只有按钮写「同步中…」，值槽仍显示上一次成功的时间。
  const syncStatusText = syncSignedOut
    ? t("settings.sync.needLogin")
    : lastSyncedAt === null
      ? t("settings.sync.never")
      : syncFresh
        ? t("settings.sync.justNow")
        : t("settings.sync.lastSynced", {
            time: new Date(lastSyncedAt).toLocaleTimeString(
              getLanguage() === "en" ? "en-US" : "zh-CN",
              { hour: "2-digit", minute: "2-digit" },
            ),
          });

  if (!open) return null;

  return (
    <>
      <div
        ref={backdropRef}
        className={`modal-backdrop settings-backdrop ${consulting ? "is-consulting" : ""}`}
        onMouseDown={closeSettings}
      >
        <div
          ref={dialogRef}
          className="modal modal--settings"
          role="dialog"
          aria-modal={consulting ? undefined : true}
          aria-labelledby="settings-title"
          aria-hidden={resetPhase !== "idle" || billsOpen ? true : undefined}
          inert={resetPhase !== "idle" || billsOpen}
          onMouseDown={(event) => event.stopPropagation()}
        >
        <header className="modal__head settings-head">
          <h2 id="settings-title" className="modal__title">
            {t("settings.nav.title")}
          </h2>
          <div className="settings-head__actions">
            <button
              type="button"
              className="settings-consult"
              aria-pressed={consulting}
              onClick={toggleConsulting}
            >
              {t("settings.consult.button")}
            </button>
            <button
              type="button"
              className="modal__close"
              onClick={closeSettings}
              aria-label={t("settings.nav.closeAria")}
            >
              <IconClose size={14} />
            </button>
          </div>
        </header>

        <div className="settings-body">
        <div className="settings-nav" role="tablist" aria-label={t("settings.nav.aria")}>
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
                onClick={() => selectSection(item.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                {t(item.label)}
              </button>
            );
          })}
        </div>

        <div className="settings-pane">
        {section === "ai" ? (
          <section
            className="settings-section"
            role="tabpanel"
            id="settings-panel-ai"
            aria-labelledby="settings-tab-ai"
          >
            <div className="settings-providers">
              <div className="settings-row" {...pointAttrs("ai.provider")}>
                <div>
                  <div className="settings-row__label">{t("settings.ai.title")}</div>
                  <div className="settings-row__value">
                    {t("settings.ai.subtitle")}
                  </div>
                </div>
              </div>
                <p className="settings-risk">{t("settings.ai.risk")}</p>
                <p className="settings-note">
                  {t("settings.ai.switchNote")}
                </p>

                {providersLoading ? (
                  <p className="settings-muted">{t("settings.ai.reading")}</p>
                ) : providers.length === 0 ? (
                  <p className="settings-muted">{t("settings.ai.empty")}</p>
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
                            {isActive ? <span className="provider-item__badge">{t("settings.ai.current")}</span> : null}
                            {provider.isBuiltin ? (
                              <span className="provider-item__tag">{t("settings.ai.builtin")}</span>
                            ) : null}
                          </div>
                          <div className="provider-item__meta">
                            {protocolLabel(provider.protocol)} · {provider.model}
                            {provider.hasKey ? "" : t("settings.provider.noKey")}
                          </div>
                          <code className="provider-item__url">
                            {provider.baseUrl || t("settings.provider.officialDefault")}
                          </code>
                          <div className="provider-item__actions">
                            {!isActive ? (
                              <button
                                type="button"
                                className="btn btn--ghost provider-item__btn"
                                onClick={() => void activateProvider(provider)}
                                disabled={!canActivate}
                                title={canActivate ? undefined : t("settings.provider.editFirst")}
                              >
                                {t("settings.provider.setActive")}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn btn--ghost provider-item__btn"
                              onClick={() => void testExistingProvider(provider)}
                              disabled={!canActivate || listTest?.state === "running"}
                              title={canActivate ? undefined : t("settings.provider.editFirst")}
                            >
                              {listTest?.providerId === provider.providerId &&
                              listTest.state === "running"
                                ? t("settings.provider.testingShort")
                                : t("settings.provider.test")}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost provider-item__btn"
                              onClick={() => openEditProvider(provider)}
                            >
                              {t("settings.common.edit")}
                            </button>
                            <button
                              type="button"
                              className="btn provider-item__btn provider-item__btn--danger"
                              onClick={() => setPendingDelete(provider)}
                              disabled={provider.isBuiltin}
                              title={provider.isBuiltin ? t("settings.provider.builtinNoDelete") : undefined}
                            >
                              {t("settings.common.delete")}
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
                              <p>
                                {t("settings.provider.deleteBody", {
                                  name: provider.name,
                                })}
                              </p>
                              <div className="settings-actions">
                                <button
                                  type="button"
                                  className="btn btn--ghost"
                                  onClick={() => setPendingDelete(null)}
                                >
                                  {t("common.cancel")}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--danger-ghost"
                                  onClick={() => void deleteProvider(provider)}
                                >
                                  {t("settings.provider.confirmDelete")}
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="settings-actions" {...pointAttrs("ai.other")}>
                  <button type="button" className="btn btn--ghost" onClick={openNewProvider}>
                    {t("settings.provider.titleAdd")}
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
                    onKeyDown={(event) => {
                      // 组合期间不让表单隐式提交（WebKit 会把组合态回车当提交）。
                      if (isComposingEvent(event)) event.preventDefault();
                    }}
                  >
                    <h4 className="provider-form__title">
                      {providerForm.providerId
                        ? t("settings.provider.titleEdit")
                        : t("settings.provider.titleAdd")}
                    </h4>

                    <div className="provider-form__presets">
                      {PRESETS.map((preset) => (
                        <button
                          type="button"
                          key={preset.id}
                          className="chip chip--small"
                          onClick={() => applyPreset(preset)}
                        >
                          {preset.labelKey ? t(preset.labelKey) : preset.label}
                        </button>
                      ))}
                    </div>

                    <label className="provider-field">
                      <span>{t("settings.provider.name")}</span>
                      <input
                        value={providerForm.name}
                        onChange={(event) =>
                          setProviderForm({ ...providerForm, name: event.target.value })
                        }
                        placeholder={t("settings.provider.namePlaceholder")}
                      />
                    </label>

                    <div className="provider-field">
                      <span className="provider-field__label">{t("settings.provider.apiType")}</span>
                      <select
                        value={providerForm.protocol}
                        onChange={(event) =>
                          setProviderForm({
                            ...providerForm,
                            protocol: event.target.value as LlmProtocol,
                          })
                        }
                      >
                        <option value="openai">{t("settings.provider.protocolOpenai")}</option>
                        <option value="anthropic">{t("settings.provider.protocolAnthropic")}</option>
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
                        ? t("settings.provider.anthropicPathHint")
                        : t("settings.provider.openaiPathHint")}
                    </p>

                    <div className="provider-field">
                      <span className="provider-field__label">{t("settings.provider.modelLabel")}</span>
                      <input
                        value={providerForm.model}
                        onChange={(event) =>
                          setProviderForm({ ...providerForm, model: event.target.value })
                        }
                        placeholder="deepseek-flash"
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
                        placeholder={
                          providerForm.hasKey
                            ? t("settings.provider.keySavedPlaceholder")
                            : "sk-..."
                        }
                      />
                    </label>
                    <p className="provider-form__hint">
                      {t("settings.provider.localHint")}
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
                        {providerSaving ? t("settings.provider.saving") : t("settings.provider.save")}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => void testProvider()}
                        disabled={providerTest.state === "running"}
                      >
                        {providerTest.state === "running"
                          ? t("settings.provider.testingShort")
                          : t("settings.provider.testConnection")}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => setProviderForm(null)}
                      >
                        {t("common.cancel")}
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
            <div className="settings-row settings-row--stack" {...pointAttrs("connection.mode")}>
              <div className="settings-row__main">
                <div className="settings-row__label">{t("stage.modeAria")}</div>
                <p className="settings-note">
                  {t("settings.connection.modeNote")}
                </p>
                {modeError ? (
                  <p className="settings-feedback settings-feedback--error" role="alert">
                    {modeError}
                  </p>
                ) : null}
              </div>
              <div className="settings-seg" role="group" aria-label={t("stage.modeAria")}>
                <button
                  type="button"
                  className={connectMode === "system_proxy" ? "is-selected" : ""}
                  aria-pressed={connectMode === "system_proxy"}
                  disabled={!configId || modeBusy}
                  onClick={() => requestConnectMode("system_proxy")}
                >
                  {t("stage.mode.proxy")}
                </button>
                <button
                  type="button"
                  className={connectMode === "tun" ? "is-selected" : ""}
                  aria-pressed={connectMode === "tun"}
                  disabled={!configId || modeBusy}
                  onClick={() => requestConnectMode("tun")}
                >
                  {t("stage.mode.tun")}
                </button>
              </div>
            </div>

            {pendingMode ? (
              <div className="settings-confirm">
                <p className="settings-confirm__text">{t("settings.connection.modeConfirm")}</p>
                <div className="settings-confirm__actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setPendingMode(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void commitConnectMode(pendingMode)}
                  >
                    {t("settings.connection.switch")}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="settings-row settings-row--stack" {...pointAttrs("connection.scope")}>
              <div className="settings-row__main">
                <div className="settings-row__label">{t("stage.scopeAria")}</div>
                <p className="settings-note">
                  {t("settings.connection.scopeNote")}
                </p>
                {scopeError ? (
                  <p className="settings-feedback settings-feedback--error" role="alert">
                    {scopeError}
                  </p>
                ) : null}
              </div>
              <div className="settings-seg" role="group" aria-label={t("stage.scopeAria")}>
                <button
                  type="button"
                  className={routingMode === "proxy_all" ? "" : "is-selected"}
                  aria-pressed={routingMode !== "proxy_all"}
                  disabled={!onSetRoutingMode}
                  onClick={() => void changeScope("direct")}
                >
                  {t("stage.scope.smart")}
                </button>
                <button
                  type="button"
                  className={routingMode === "proxy_all" ? "is-selected" : ""}
                  aria-pressed={routingMode === "proxy_all"}
                  disabled={!onSetRoutingMode}
                  onClick={() => void changeScope("proxy_all")}
                >
                  {t("stage.scope.global")}
                </button>
              </div>
            </div>

            {!configId ? (
              <p className="settings-note">{t("settings.connection.noConfig")}</p>
            ) : null}

            <div className="settings-row" {...pointAttrs("connection.sync")}>
              <div>
                <div className="settings-row__label">{t("settings.sync.rowLabel")}</div>
                {syncIntervalUnsaved ? (
                  <div className="settings-row__value">
                    {t("settings.sync.unsaved")}
                  </div>
                ) : null}
                {syncResult === "error" &&
                syncResultAt !== null &&
                !syncSignedOut &&
                !syncBusy ? (
                  <p className="settings-feedback settings-feedback--error" role="alert">
                    {t("settings.sync.failed")}
                  </p>
                ) : null}
              </div>
              <div className="settings-row__aside">
                <span className="settings-row__value" aria-live="polite">
                  {syncStatusText}
                </span>
                <select
                  className="settings-sync__select"
                  aria-label={t("settings.sync.interval")}
                  value={syncInterval}
                  disabled={!onSyncIntervalChange}
                  onChange={(event) =>
                    onSyncIntervalChange?.(
                      Number(event.target.value) as SyncIntervalMinutes,
                    )
                  }
                >
                  <option value={0}>{t("settings.sync.manual")}</option>
                  <option value={30}>
                    {t("settings.sync.minutes", { count: 30 })}
                  </option>
                  {([1, 4, 8, 24] as const).map((hours) => (
                    <option key={hours} value={hours * 60}>
                      {t("settings.sync.hours", { count: hours })}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={syncBusy || !onSyncNow || syncSignedOut || syncAccountUnknown}
                  aria-busy={syncBusy || undefined}
                  onClick={startServerSync}
                >
                  {syncBusy ? t("settings.sync.busy") : t("settings.sync.now")}
                </button>
              </div>
            </div>

            {connectMode === "system_proxy" ? (
              portEditing ? (
              <div className="settings-row" {...pointAttrs("connection.port")}>
                <div>
                  <label
                    className="settings-row__label"
                    htmlFor="settings-proxy-port"
                  >
                    {t("settings.port.askAiField")}
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
                        if (isComposingEvent(event)) return;
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
                      {t("settings.port.lowHint")}
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
                    {portSaving ? t("settings.provider.saving") : t("settings.provider.save")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={cancelProxyPortEdit}
                    disabled={portSaving}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="settings-row" {...pointAttrs("connection.port")}>
                <div>
                  <div className="settings-row__label">{t("settings.port.askAiField")}</div>
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
                      {t("settings.port.occupiedHint")}
                    </p>
                  ) : null}
                  {!portFallback && portAvailability === "unavailable" ? (
                    <p className="settings-feedback settings-feedback--warn">
                      {t("settings.port.unavailableHint")}
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
                      ? t("chat.copy.copied")
                      : proxyCopy === "error"
                        ? t("chat.copy.failed")
                        : t("detail.copy")}
                  </button>
                  <button
                    ref={portEditButtonRef}
                    type="button"
                    className="btn btn--ghost"
                    onClick={beginProxyPortEdit}
                  >
                    {t("settings.common.edit")}
                  </button>
                </div>
              </div>
              )
            ) : null}

            {connectMode ? (
              <SeedRefreshRow
                bridge={bridge}
                info={seedInfo}
                onInfo={setSeedInfo}
                connected={connected}
                open={open}
              />
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
            <div className="settings-row settings-row--stack">
              <div className="settings-row__main">
                <div className="settings-row__label">{t("settings.language.label")}</div>
                <p className="settings-note">{t("settings.language.note")}</p>
                {languageError ? (
                  <p className="settings-feedback settings-feedback--error" role="alert">
                    {languageError}
                  </p>
                ) : null}
              </div>
              <div
                className="settings-seg settings-seg--language"
                role="group"
                aria-label={t("settings.language.label")}
              >
                <button
                  type="button"
                  className={appLanguage?.selected === "system" ? "is-selected" : ""}
                  aria-pressed={appLanguage?.selected === "system"}
                  disabled={languageBusy}
                  onClick={() => void changeLanguage("system")}
                >
                  {t("settings.language.followSystem")}
                </button>
                <button
                  type="button"
                  className={appLanguage?.selected === "zh" ? "is-selected" : ""}
                  aria-pressed={appLanguage?.selected === "zh"}
                  disabled={languageBusy}
                  onClick={() => void changeLanguage("zh")}
                >
                  {t("settings.language.zh")}
                </button>
                <button
                  type="button"
                  className={appLanguage?.selected === "en" ? "is-selected" : ""}
                  aria-pressed={appLanguage?.selected === "en"}
                  disabled={languageBusy}
                  onClick={() => void changeLanguage("en")}
                >
                  {t("settings.language.en")}
                </button>
              </div>
            </div>

            <div className="settings-subhead">{t("settings.advanced.repair")}</div>

            <p className="settings-note">
              {t("settings.advanced.intro")}
            </p>

            {showCleanupProxy ? (
              <div className="settings-row">
                <div>
                  <div className="settings-row__label">{t("settings.advanced.cleanupProxy")}</div>
                  <div className="settings-row__value">
                    {t("settings.advanced.cleanupProxyValue")}
                  </div>
                  <p className="settings-note">{t("settings.advanced.cleanupProxyNote")}</p>
                </div>
                <button type="button" className="btn btn--ghost" onClick={onRestoreNetwork}>
                  {t("settings.advanced.cleanupProxy")}
                </button>
              </div>
            ) : null}

            {onReportProblem ? (
              <>
                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">{t("settings.advanced.report")}</div>
                    <div className="settings-row__value">
                      {t("settings.advanced.reportValue")}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost settings-row__btn--wide"
                    disabled={reportBusy}
                    onClick={onReportProblem}
                  >
                    {t("settings.advanced.report")}
                  </button>
                </div>

                <div className="settings-row">
                  <div>
                    <label
                      className="settings-row__label"
                      htmlFor="report-include-domains"
                    >
                      {t("settings.advanced.reportDomains")}
                    </label>
                    <p className="settings-hint">
                      {t("settings.advanced.reportDomainsHint")}
                    </p>
                    {domainError ? (
                      <p className="settings-note settings-feedback settings-feedback--error">
                        {domainError}
                      </p>
                    ) : null}
                  </div>
                  <input
                    id="report-include-domains"
                    type="checkbox"
                    className="settings-checkbox"
                    checked={includeDomains}
                    disabled={domainBusy}
                    onChange={() => void toggleIncludeDomains()}
                  />
                </div>
              </>
            ) : null}

            <div className="danger-zone" {...pointAttrs("advanced.reset")}>
              <div className="danger-zone__body">
                <div className="danger-zone__title">{t("settings.advanced.resetTitle")}</div>
                <p className="settings-row__value">
                  {t("settings.advanced.resetValue")}
                </p>
                <p className="settings-note">{t("settings.advanced.resetNote")}</p>
                {lastReset ? (
                  <p
                    className={`settings-note ${
                      lastReset.failed > 0 ? "reset-last--warn" : ""
                    }`}
                  >
                    {lastReset.failed > 0
                      ? t("settings.reset.lastPartial", {
                          time: resetTimeLabel(lastReset.at),
                          count: lastReset.failed,
                        })
                      : t("settings.reset.lastDone", {
                          time: resetTimeLabel(lastReset.at),
                          count: lastReset.total,
                        })}
                  </p>
                ) : null}
              </div>
              <button
                ref={resetTriggerRef}
                type="button"
                className="btn btn--danger-ghost"
                onClick={() => setResetPhase("confirm")}
              >
                {t("settings.advanced.resetTitle")}
              </button>
            </div>

            <details className="settings-fold">
              <summary className="settings-fold__summary">{t("settings.advanced.fold")}</summary>
              <div className="settings-fold__body">
                <div {...pointAttrs("advanced.core")}>
                  <RuntimeUpgradeRow controller={coreUpgrade} />
                </div>
                <div {...pointAttrs("advanced.helper")}>
                  <TunHelperRow controller={tunHelper} activeConnection={connected} />
                </div>

                <div className="settings-row" {...pointAttrs("advanced.logs")}>
                  <div>
                    <div className="settings-row__label">{t("settings.advanced.openLogs")}</div>
                    <div className="settings-row__value">
                      {t("settings.advanced.logsValue")}
                    </div>
                  </div>
                  <button type="button" className="btn btn--ghost" onClick={onOpenLogs}>
                    {t("settings.advanced.openLogsDir")}
                  </button>
                </div>

                <div className="settings-row">
                  <div>
                    <div className="settings-row__label">{t("settings.advanced.copyDiagnostics")}</div>
                    <div className="settings-row__value">
                      {t("settings.advanced.diagValue")}
                    </div>
                  </div>
                  <div className="settings-row__aside">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => void copyDiagnostics()}
                    >
                      {t("settings.advanced.copyDiagnostics")}
                    </button>
                  </div>
                </div>
                {diagnosticNotice ? (
                  <p className="settings-feedback settings-feedback--ok">{diagnosticNotice}</p>
                ) : null}

                {/* tun_probe is registered only in debug builds; the entry is hidden in release too. */}
                {import.meta.env.DEV ? <TunDiagnosticsRow bridge={bridge} /> : null}

                {import.meta.env.DEV ? (
                  <div className="settings-row">
                    <div>
                      <div className="settings-row__label">{t("settings.advanced.restartOnboarding")}</div>
                      <div className="settings-row__value">
                        {t("settings.advanced.restartNote")}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={onRestartOnboarding}
                    >
                      {t("settings.advanced.rerun")}
                    </button>
                  </div>
                ) : null}
              </div>
            </details>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">{t("settings.advanced.version")}</div>
                <div className="settings-row__value num">v{appVersion ?? "—"}</div>
              </div>
            </div>

            <p className="settings-note">
              {t("settings.about.aiNote")}
            </p>
          </section>
        ) : null}

        {section === "account" ? (
          <section
            className="settings-section"
            role="tabpanel"
            id="settings-panel-account"
            aria-labelledby="settings-tab-account"
          >
            {recovery ? (
                  <div className="settings-row settings-row--stack">
                    <p className="settings-note">{recovery.text}</p>
                    {recoverError ? (
                      <p className="settings-feedback settings-feedback--error" role="alert">
                        {recoverError}
                      </p>
                    ) : null}
                    {logoutError && recovery.kind !== "register" ? (
                      <p className="settings-feedback settings-feedback--error" role="alert">
                        {logoutError}{" "}
                        <button
                          type="button"
                          className="settings-link"
                          disabled={loggingOut}
                          onClick={() => void logout()}
                        >
                          {t("account.retry")}
                        </button>
                      </p>
                    ) : null}
                    <div className="settings-actions">
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={identityBusy || !(recovery.kind === "logout" ? onLogout : recovery.kind === "switch" ? onSwitchAccount : onReRegister)}
                        aria-busy={
                          (recovery.kind === "logout"
                            ? loggingOut
                            : recovery.kind === "switch"
                              ? switching
                              : reRegistering) || undefined
                        }
                        onClick={() => void recoverIdentity()}
                      >
                        {recovery.kind === "logout"
                          ? loggingOut
                            ? t("account.loggingOut")
                            : recovery.label
                          : recovery.kind === "switch"
                            ? switching
                              ? t("account.switching")
                              : recovery.label
                            : reRegistering
                              ? t("account.working")
                              : recovery.label}
                      </button>
                      {recovery.kind === "switch" ? (
                        <button
                          type="button"
                          className="btn btn--danger-ghost"
                          disabled={identityBusy || !onLogout}
                          aria-busy={loggingOut || undefined}
                          onClick={() => void logout()}
                        >
                          {loggingOut ? t("account.loggingOut") : t("account.logoutDevice")}
                        </button>
                      ) : null}
                    </div>
                  </div>
            ) : null}

            {account?.logged_in ? (
              <>
                <div className="settings-row" {...pointAttrs("account.login")}>
                  <div className="settings-account__identity">
                    <div className="settings-row__label">{t("settings.account.email")}</div>
                    <div
                      className="settings-account__email"
                      title={account.email ?? undefined}
                    >
                      {account.email ?? t("settings.account.signedIn")}
                    </div>
                  </div>
                </div>

                {blockedIdentity ? null : (
                <div className="settings-row" {...pointAttrs("account.balance")}>
                    <div>
                      <div className="settings-row__label">{t("settings.account.balance")}</div>
                      {walletError ? (
                        <p className="settings-account__error">
                          {t("account.walletError")}
                          <button
                            type="button"
                            className="settings-link"
                            onClick={() => onRefreshWallet?.("retry")}
                            disabled={!onRefreshWallet}
                          >
                            {t("account.retry")}
                          </button>
                        </p>
                      ) : (
                        <div className="settings-account__amount num">
                          {walletLoading
                            ? t("settings.account.loading")
                            : wallet
                              ? formatUsdCents(wallet.balance_cents)
                              : "—"}
                        </div>
                      )}
                      <p className="settings-note">
                        {t("settings.account.billingNote")}
                      </p>
                      {walletStale && wallet && !walletError ? (
                        <p className="settings-note">
                          {t("account.stale")}
                        </p>
                      ) : null}
                    </div>
                    <div className="settings-row__aside">
                      {walletError ? null : (
                        <button
                          type="button"
                          className="settings-link"
                          onClick={onForceRefresh}
                          disabled={!onForceRefresh || walletRefreshing}
                        >
                          {walletRefreshing ? t("settings.account.refreshing") : t("settings.account.refresh")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={onTopUp}
                        disabled={!onTopUp}
                      >
                        {t("account.topUp")}
                      </button>
                    </div>
                  </div>
                )}

                {blockedIdentity ? null : (
                <div
                  className="settings-row settings-row--stack"
                  {...pointAttrs("account.bills")}
                >
                  <div className="settings-row__main">
                    <div className="settings-row__label">
                      {t("settings.account.bills")}
                    </div>
                  </div>
                  <div className="settings-row__aside">
                    <button
                      ref={billsTriggerRef}
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setBillsOpen(true)}
                    >
                      {t("settings.account.viewBills")}
                    </button>
                  </div>
                </div>
                )}

                {blockedIdentity ? null : (
                <div className="settings-row settings-row--stack">
                    <div className="settings-row__main">
                      {logoutError ? (
                        <p
                          className="settings-feedback settings-feedback--error"
                          role="alert"
                        >
                          {logoutError}{" "}
                          <button
                            type="button"
                            className="settings-link"
                            disabled={loggingOut}
                            onClick={() => void logout()}
                          >
                            {t("account.retry")}
                          </button>
                        </p>
                      ) : null}
                    </div>
                    <div className="settings-row__aside">
                      <button
                        type="button"
                        className="btn btn--danger-ghost"
                        disabled={loggingOut || !onLogout}
                        aria-busy={loggingOut || undefined}
                        onClick={() => void logout()}
                      >
                        {loggingOut ? t("account.loggingOut") : t("account.logout")}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="settings-row" {...pointAttrs("account.login")}>
                <div>
                  <div className="settings-row__label">{t("settings.account.signedOut")}</div>
                  <p className="settings-note">{t("settings.account.signedOutNote")}</p>
                </div>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={onLogin}
                  disabled={!onLogin}
                >
                  {t("serversPage.login")}
                </button>
              </div>
            )}
          </section>
        ) : null}
        </div>
        </div>
      </div>

      {consulting && assistant ? (
        <div
          className="settings-assistant"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {assistant}
        </div>
      ) : null}
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
                aria-label={t("common.close")}
                disabled={resetPhase === "running"}
              >
                <IconClose size={14} />
              </button>
            </header>

            {resetPhase === "confirm" ? (
              <div className="reset-confirm">
                <p className="reset-confirm__warning">
                  {t("settings.reset.confirmBody")}
                </p>
                <p className="reset-confirm__text">{t("settings.reset.confirmNote")}</p>
                <div className="settings-actions">
                  <button
                    ref={resetCancelRef}
                    type="button"
                    className="btn btn--ghost"
                    onClick={closeReset}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger-ghost"
                    onClick={() => void runNetworkReset()}
                  >
                    {t("settings.advanced.resetTitle")}
                  </button>
                </div>
              </div>
            ) : null}

            {resetPhase === "running" ? (
              <div className="reset-running">
                <p className="reset-running__text" role="status" aria-live="polite">
                  {t("settings.reset.runningNote")}
                </p>
                {/* 每秒计时的行不进 live region：否则读屏每秒念一遍。 */}
                <p className="reset-running__text" aria-hidden="true">
                  {t("settings.reset.runningElapsed", { seconds: resetElapsed })}
                </p>
                <div
                  className="reset-progress"
                  role="progressbar"
                  aria-label={t("settings.reset.ariaProgress")}
                />
                <div className="settings-actions">
                  <button type="button" className="btn btn--ghost" disabled>
                    {t("settings.reset.runningShort")}
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
                    {t("settings.reset.failedRetry")}
                  </p>
                ) : null}

                {resetResult && resetResult.steps.length > 0 ? (
                  outcome.kind === "success" ? (
                    <details className="reset-route-help">
                      <summary>{t("settings.reset.details")}</summary>
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
                    <summary>{t("settings.reset.manualRoutes")}</summary>
                    <ol>
                      <li>
                        {t("settings.reset.gatewayCheck")} <code>route -n get default</code>
                      </li>
                      <li>
                        {t("settings.reset.deleteOne")}
                        <span className="reset-route-help__code">
                          <code>{t("settings.reset.sudoTemplate")}</code>
                          <button
                            type="button"
                            className="btn btn--ghost reset-route-help__copy"
                            onClick={() => void copyRouteCommand()}
                          >
                            {t("settings.reset.copyTemplate")}
                          </button>
                        </span>
                        {t("settings.reset.gatewayNote")}
                      </li>
                      <li>{t("settings.reset.manualWarn")}</li>
                      <li>{t("settings.reset.manualAfter")}</li>
                      <li>
                        {t("settings.reset.windowsNote")}
                      </li>
                    </ol>
                    {routeCopy !== "idle" ? (
                      <p className="settings-feedback settings-feedback--ok">
                        {routeCopy === "ok" ? t("chat.copy.copied") : t("chat.copy.failed")}
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
                      {t("settings.reset.tryAgain")}
                    </button>
                  ) : null}
                  <button
                    ref={resetCloseRef}
                    type="button"
                    className="btn btn--ghost"
                    onClick={closeReset}
                  >
                    {t("common.close")}
                  </button>
                  {outcome.kind !== "success" ? (
                    <button
                      type="button"
                      className="btn btn--link"
                      onClick={() => void copyResetReport()}
                    >
                      {t("settings.advanced.copyDiagnostics")}
                    </button>
                  ) : null}
                </div>
                {resetCopy !== "idle" ? (
                  <p className="settings-feedback settings-feedback--ok">
                    {resetCopy === "ok" ? t("chat.copy.copied") : t("chat.copy.failed")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {billsOpen ? (
        <BillingLedgerDialog
          bridge={bridge}
          language={language}
          onClose={closeBills}
        />
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
    return translate("settings.error.resetUnsupported");
  }
  // 原始错误可能带路径或英文命令，只进「复制诊断信息」。
  return translate("settings.error.resetFailed");
}

export function describeProviderError(error: unknown): string {
  const bridgeError = toBridgeError(error);
  if (/not found|unknown command/i.test(bridgeError.message)) {
    return translate("settings.error.providerUnsupported");
  }
  if (bridgeError.code === "NOT_FOUND") {
    return translate("settings.error.providerGone");
  }
  if (bridgeError.code === "PRECONDITION_FAILED") {
    const reason = bridgeError.details?.reason;
    if (reason === "builtin_provider") {
      return translate("settings.error.builtinCannotDelete");
    }
    if (reason === "no_active_provider") {
      return translate("settings.error.noActiveProvider");
    }
    return errorText(error, translate("settings.error.actionUnavailable"));
  }
  return errorText(error, translate("settings.error.generic"));
}

export function describeKeyError(error: unknown): string {
  const problem = toBridgeError(error);
  const reason =
    typeof problem.details?.reason === "string" ? problem.details.reason : "";
  // 2.55.0 起 DeepSeek 鉴权失败并入 INVALID_ARGUMENT / provider_key_invalid。
  if (reason === "provider_key_invalid") return translate("settings.key.authFailed");

  switch (problem.code) {
    case "INVALID_ARGUMENT":
      return translate("settings.key.invalidFormat");
    case "INVALID_KEY":
      return translate("settings.key.authFailed");
    case "SECRET_STORE":
      return translate("settings.key.storeFailed");
    case "NETWORK":
    case "TIMEOUT":
      return translate("settings.key.network");
    default:
      break;
  }

  return errorText(error, translate("settings.key.saveFailed"));
}

export function describeImportError(error: unknown): string {
  const bridgeError = toBridgeError(error);
  const reason = bridgeError.details?.reason;

  switch (reason) {
    case "not_json_file":
      return translate("settings.import.notJson");
    case "file_too_large":
      return translate("settings.import.tooLarge");
    case "file_unreadable":
      return translate("settings.import.unreadable");
    case "invalid_json":
      return translate("settings.import.invalidJson");
    case "no_importable_nodes": {
      const skipped = bridgeError.details?.skipped;
      return typeof skipped === "number"
        ? translate("settings.import.allSkipped", { count: skipped })
        : translate("settings.import.noSupported");
    }
    default:
      break;
  }

  if (bridgeError.code === "UNSUPPORTED") {
    const method = bridgeError.details?.method;
    return typeof method === "string"
      ? translate("settings.import.methodUnsupportedWith", { method })
      : translate("settings.import.methodUnsupported");
  }

  if (bridgeError.code === "SECRET_STORE") {
    return translate("settings.import.secretStore");
  }

  return errorText(error, translate("settings.import.failed"));
}
