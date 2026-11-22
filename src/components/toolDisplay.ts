/**
 * 工具调用的用户语言映射。
 *
 * 完成后按本表渲染，不读后端 `display.text`（events.md 2.23.0）；
 * `call.tool` / `call.action` 永远不出现在用户界面里，技术细节除外。
 * 工具名集合必须与 `docs/contracts/tools.md` §3 完全一致（测试有集合断言）。
 */
import { getLanguage, t } from "../i18n";
import type { MessageKey } from "../i18n";

export type ChangedState = "none" | "restored" | "unknown";

export interface ToolFact {
  label: string;
  value: string;
}

/** events.md 2.11.0 的两个动作；未识别的 kind 直接丢弃。 */
export type DisplayActionKind = "reveal_report_dir" | "compose_report_mail";

export interface ToolDisplayAction {
  kind: DisplayActionKind;
  reportId: string;
}

export interface ToolDisplayInfo {
  text: string | null;
  facts: ToolFact[];
  changed: ChangedState | null;
  actions?: ToolDisplayAction[];
}

export interface ToolCopy {
  /** 进行中的一句话。 */
  running: string;
  /** 完成后的通用句；界面不读后端 `display.text`。 */
  done: string;
  /** 失败时的一行标题。 */
  failed: string;
  /** 没有 next_actions 时「现在能做什么」。 */
  advice: string;
  /** 只读工具失败时固定「没有改动」。 */
  readOnly: boolean;
}

/** 表里存 key，取用时按当前语言翻译；测试在中文下看到的仍是原句。 */
export interface ToolCopyKeys {
  running: MessageKey;
  done: MessageKey;
  failed: MessageKey;
  advice: MessageKey;
  readOnly: boolean;
}

export const FALLBACK_COPY: ToolCopy = {
  running: "正在处理…",
  done: "已完成",
  failed: "没成功",
  advice: "可以再试一次；还是不行就告诉我。",
  readOnly: false,
};

const FALLBACK_KEYS: ToolCopyKeys = {
  running: "tool.fallback.running",
  done: "tool.fallback.done",
  failed: "tool.fallback.failed",
  advice: "tool.fallback.advice",
  readOnly: false,
};

function entry(
  running: MessageKey,
  done: MessageKey,
  failed: MessageKey,
  advice: MessageKey,
  readOnly: boolean,
): ToolCopyKeys {
  return { running, done, failed, advice, readOnly };
}

export const TOOL_COPY: Record<string, ToolCopyKeys> = {
  RuntimeStatus: entry(
    "tool.RuntimeStatus.running",
    "tool.RuntimeStatus.done",
    "tool.RuntimeStatus.failed",
    "tool.advice.retryLater",
    true,
  ),
  RuntimeStart: entry(
    "tool.RuntimeStart.running",
    "tool.RuntimeStart.done",
    "tool.RuntimeStart.failed",
    "tool.advice.retry",
    false,
  ),
  RuntimeStop: entry(
    "tool.RuntimeStop.running",
    "tool.RuntimeStop.done",
    "tool.RuntimeStop.failed",
    "tool.advice.retry",
    false,
  ),
  RuntimeRestart: entry(
    "tool.RuntimeRestart.running",
    "tool.RuntimeRestart.done",
    "tool.RuntimeRestart.failed",
    "tool.advice.retry",
    false,
  ),
  RuntimeLogs: entry(
    "tool.RuntimeLogs.running",
    "tool.RuntimeLogs.done",
    "tool.RuntimeLogs.failed",
    "tool.advice.unaffected",
    true,
  ),
  CoreListVersions: entry(
    "tool.CoreListVersions.running",
    "tool.CoreListVersions.done",
    "tool.CoreListVersions.failed",
    "tool.advice.manualCheck",
    true,
  ),
  CoreUpgrade: entry(
    "tool.CoreUpgrade.running",
    "tool.CoreUpgrade.done",
    "tool.CoreUpgrade.failed",
    "tool.advice.manualCheckUpdate",
    false,
  ),
  CatalogSearch: entry(
    "tool.CatalogSearch.running",
    "tool.CatalogSearch.done",
    "tool.CatalogSearch.failed",
    "tool.advice.network",
    true,
  ),
  ConfigDetail: entry(
    "tool.ConfigDetail.running",
    "tool.ConfigDetail.done",
    "tool.ConfigDetail.failed",
    "tool.advice.otherConfig",
    true,
  ),
  ConfigUpdate: entry(
    "tool.ConfigUpdate.running",
    "tool.ConfigUpdate.done",
    "tool.ConfigUpdate.failed",
    "tool.advice.unchangedRetry",
    false,
  ),
  NodeImportUrl: entry(
    "tool.NodeImportUrl.running",
    "tool.NodeImportUrl.done",
    "tool.NodeImportUrl.failed",
    "tool.advice.subscription",
    false,
  ),
  NodeImportText: entry(
    "tool.NodeImportText.running",
    "tool.NodeImportText.done",
    "tool.NodeImportText.failed",
    "tool.advice.pasted",
    false,
  ),
  NodeCreate: entry(
    "tool.NodeCreate.running",
    "tool.NodeCreate.done",
    "tool.NodeCreate.failed",
    "tool.advice.address",
    false,
  ),
  NodeSwitch: entry(
    "tool.NodeSwitch.running",
    "tool.NodeSwitch.done",
    "tool.NodeSwitch.failed",
    "tool.advice.stillOldNode",
    false,
  ),
  NodeProbe: entry(
    "tool.NodeProbe.running",
    "tool.NodeProbe.done",
    "tool.NodeProbe.failed",
    "tool.advice.probeTimeout",
    true,
  ),
  VpnConnect: entry(
    "tool.VpnConnect.running",
    "tool.VpnConnect.done",
    "tool.VpnConnect.failed",
    "tool.advice.otherNode",
    false,
  ),
  VpnDisconnect: entry(
    "tool.VpnDisconnect.running",
    "tool.VpnDisconnect.done",
    "tool.VpnDisconnect.failed",
    "tool.advice.stillConnected",
    false,
  ),
  DiagRun: entry(
    "tool.DiagRun.running",
    "tool.DiagRun.done",
    "tool.DiagRun.failed",
    "tool.advice.retry",
    true,
  ),
  DeepseekSetupKey: entry(
    "tool.DeepseekSetupKey.running",
    "tool.DeepseekSetupKey.done",
    "tool.DeepseekSetupKey.failed",
    "tool.advice.retry",
    true,
  ),
  DeepseekSaveKey: entry(
    "tool.DeepseekSaveKey.running",
    "tool.DeepseekSaveKey.done",
    "tool.DeepseekSaveKey.failed",
    "tool.advice.keyCheck",
    false,
  ),
  JobGet: entry(
    "tool.JobGet.running",
    "tool.JobGet.done",
    "tool.JobGet.failed",
    "tool.advice.jobEnded",
    true,
  ),
  AskUserQuestion: entry(
    "tool.AskUserQuestion.running",
    "tool.AskUserQuestion.done",
    "tool.AskUserQuestion.failed",
    "tool.advice.askAgain",
    true,
  ),
  NetConfigGet: entry(
    "tool.NetConfigGet.running",
    "tool.NetConfigGet.done",
    "tool.NetConfigGet.failed",
    "tool.advice.retryLater",
    true,
  ),
  NetRepair: entry(
    "tool.NetRepair.running",
    "tool.NetRepair.done",
    "tool.NetRepair.failed",
    "tool.advice.retry",
    false,
  ),
  CatalogRefresh: entry(
    "tool.CatalogRefresh.running",
    "tool.CatalogRefresh.done",
    "tool.CatalogRefresh.failed",
    "tool.advice.oldKept",
    false,
  ),
  DefaultProfileStatus: entry(
    "tool.DefaultProfileStatus.running",
    "tool.DefaultProfileStatus.done",
    "tool.DefaultProfileStatus.failed",
    "tool.advice.retryLater",
    true,
  ),
  RouteGet: entry(
    "tool.RouteGet.running",
    "tool.RouteGet.done",
    "tool.RouteGet.failed",
    "tool.advice.retryLater",
    true,
  ),
  ConfigSetMode: entry(
    "tool.ConfigSetMode.running",
    "tool.ConfigSetMode.done",
    "tool.ConfigSetMode.failed",
    "tool.advice.briefInterruption",
    false,
  ),
  RouteSetMode: entry(
    "tool.RouteSetMode.running",
    "tool.RouteSetMode.done",
    "tool.RouteSetMode.failed",
    "tool.advice.oldRoute",
    false,
  ),
  RouteTargetsSet: entry(
    "tool.RouteTargetsSet.running",
    "tool.RouteTargetsSet.done",
    "tool.RouteTargetsSet.failed",
    "tool.advice.retry",
    false,
  ),
  CategoryList: entry(
    "tool.CategoryList.running",
    "tool.CategoryList.done",
    "tool.CategoryList.failed",
    "tool.advice.retryLater",
    true,
  ),
  RulesStatus: entry(
    "tool.RulesStatus.running",
    "tool.RulesStatus.done",
    "tool.RulesStatus.failed",
    "tool.advice.retryLater",
    true,
  ),
  IssueReport: entry(
    "tool.IssueReport.running",
    "tool.IssueReport.done",
    "tool.IssueReport.failed",
    "tool.advice.keepLogs",
    false,
  ),
  SetUserRegion: entry(
    "tool.SetUserRegion.running",
    "tool.SetUserRegion.done",
    "tool.SetUserRegion.failed",
    "tool.advice.sayRegion",
    false,
  ),
  MyServers: entry(
    "tool.MyServers.running",
    "tool.MyServers.done",
    "tool.MyServers.failed",
    "tool.advice.nodesUnaffected",
    true,
  ),
  MyServerFailure: entry(
    "tool.MyServerFailure.running",
    "tool.MyServerFailure.done",
    "tool.MyServerFailure.failed",
    "tool.advice.retryCreate",
    true,
  ),
  NodeRotateCredentials: entry(
    "tool.NodeRotateCredentials.running",
    "tool.NodeRotateCredentials.done",
    "tool.NodeRotateCredentials.failed",
    "tool.advice.rotateRetry",
    false,
  ),
  CatalogOptions: entry(
    "tool.CatalogOptions.running",
    "tool.CatalogOptions.done",
    "tool.CatalogOptions.failed",
    "tool.advice.chooseOnStage",
    true,
  ),
  StageSelect: entry(
    "tool.StageSelect.running",
    "tool.StageSelect.done",
    "tool.StageSelect.failed",
    "tool.advice.chooseOnStage",
    false,
  ),
  OpenSettings: entry(
    "tool.OpenSettings.running",
    "tool.OpenSettings.done",
    "tool.OpenSettings.failed",
    "tool.advice.settingsIcon",
    true,
  ),
  HttpCheck: entry(
    "tool.HttpCheck.running",
    "tool.HttpCheck.done",
    "tool.HttpCheck.failed",
    "tool.advice.otherAddress",
    true,
  ),
};

export const TOOL_NAMES = Object.keys(TOOL_COPY);

const warnedTools = new Set<string>();

function localizeCopy(keys: ToolCopyKeys): ToolCopy {
  return {
    running: t(keys.running),
    done: t(keys.done),
    failed: t(keys.failed),
    advice: t(keys.advice),
    readOnly: keys.readOnly,
  };
}

export function toolCopy(tool: string): ToolCopy {
  const copy = TOOL_COPY[tool];
  if (copy) return localizeCopy(copy);
  // 开发构建只提醒一次；原始工具名不是合法的兜底文案。
  if (import.meta.env.DEV && !warnedTools.has(tool)) {
    warnedTools.add(tool);
    console.warn(`[toolDisplay] 未映射的工具：${tool}`);
  }
  // 中文下返回原对象（测试对兜底对象做恒等断言）；英文现翻。
  return getLanguage() === "zh" ? FALLBACK_COPY : localizeCopy(FALLBACK_KEYS);
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function readChanged(value: unknown): ChangedState | null {
  if (value === true) return "unknown";
  if (value === false) return "none";
  if (typeof value !== "string") return null;
  switch (value.toLowerCase()) {
    case "none":
    case "no":
    case "unchanged":
    case "not_changed":
    case "false":
      return "none";
    case "restored":
    case "reverted":
    case "recovered":
    case "rolled_back":
      return "restored";
    case "unknown":
    case "maybe":
    case "unsure":
    case "true":
      return "unknown";
    default:
      return null;
  }
}

function readFact(raw: unknown): ToolFact | null {
  if (typeof raw === "string") {
    const value = raw.trim();
    return value ? { label: "", value } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const value =
    readText(record.value) ?? readText(record.text) ?? readText(record.body) ?? null;
  if (!value) return null;
  const label =
    readText(record.label) ?? readText(record.title) ?? readText(record.name) ?? "";
  return { label, value };
}

function readDisplayAction(raw: unknown): ToolDisplayAction | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  const reportId = readText(record.report_id);
  if (kind !== "reveal_report_dir" && kind !== "compose_report_mail") return null;
  if (!reportId) return null;
  return { kind, reportId };
}

/** 后端 `display` 缺失或字段不全时返回 null，界面静默回落到静态表。 */
export function readToolDisplay(raw: unknown): ToolDisplayInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const facts = Array.isArray(record.facts)
    ? record.facts
        .map(readFact)
        .filter((fact): fact is ToolFact => fact !== null)
        .slice(0, 4)
    : [];
  const actions = Array.isArray(record.actions)
    ? record.actions
        .map(readDisplayAction)
        .filter((action): action is ToolDisplayAction => action !== null)
        .slice(0, 2)
    : [];
  const text = readText(record.text);
  const changed = readChanged(record.changed);
  if (!text && facts.length === 0 && !changed && actions.length === 0) return null;
  return { text, facts, changed, actions };
}

const FACT_KEYS: Array<{
  pattern: RegExp;
  label: MessageKey;
  format?: (value: string) => string;
}> = [
  { pattern: /^(config|configuration)_name$/, label: "tool.fact.config" },
  { pattern: /^node_name$/, label: "tool.fact.node" },
  { pattern: /^(exit_ip|public_ip)$/, label: "tool.fact.exit" },
  {
    pattern: /^(latency_ms|delay_ms|node_latency_ms)$/,
    label: "tool.fact.latency",
    format: (value) => t("tool.time.ms", { value }),
  },
];

/** 只从参数里取名称与结果事实，绝不取 `config_id` / `node_id`。 */
export function factsFromArgs(
  args: Record<string, unknown> | undefined,
): ToolFact[] {
  if (!args) return [];
  const facts: ToolFact[] = [];
  for (const [key, raw] of Object.entries(args)) {
    const spec = FACT_KEYS.find((item) => item.pattern.test(key));
    if (!spec) continue;
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const text = String(raw).trim();
    if (!text) continue;
    facts.push({
      label: t(spec.label),
      value: spec.format ? spec.format(text) : text,
    });
    if (facts.length >= 4) break;
  }
  return facts;
}

export function changedLabel(changed: ChangedState | null, readOnly: boolean): string {
  if (changed === "none") return t("tool.changed.none");
  if (changed === "restored") return t("tool.changed.restored");
  if (changed === "unknown") return t("tool.changed.unknown");
  return t(readOnly ? "tool.changed.none" : "tool.changed.unknown");
}

/** 默认行只在 ≥3 秒时出现。 */
export function shortDuration(ms: number): string {
  return t("tool.time.seconds", { value: (ms / 1000).toFixed(1) });
}

/** 展开里始终显示精确值。 */
export function exactDuration(ms: number): string {
  if (ms < 1000) return t("tool.time.ms", { value: Math.round(ms) });
  return t("tool.time.seconds", { value: (ms / 1000).toFixed(1) });
}

export const DURATION_THRESHOLD_MS = 3000;
