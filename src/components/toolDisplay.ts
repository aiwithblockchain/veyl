/**
 * 工具调用的用户语言映射。
 *
 * events.md 2.24.0：`display.facts` 只给 key + params，句子由本表按界面语言组装；
 * `call.tool` / `call.action` 永远不出现在用户界面里，技术细节除外。
 * 工具名集合必须与 `docs/contracts/tools.md` §3 完全一致（测试有集合断言）。
 */
import { getLanguage, t } from "../i18n";
import type { MessageKey } from "../i18n";
import { ERROR_FAILURE_TEXT } from "../i18n/errorText";
import type { ToolFact as ToolFactPayload } from "../agent/protocol";
import { regionLabel } from "../ui/configLabels";

export type ChangedState = "none" | "restored" | "unknown";

export interface ToolFact {
  label: string;
  value: string;
  /** 纯数字值（count / ms / percent / port / code）用等宽字体。 */
  mono?: boolean;
}

/** events.md 2.11.0 的两个动作；未识别的 kind 直接丢弃。 */
export type DisplayActionKind = "reveal_report_dir" | "compose_report_mail";

export interface ToolDisplayAction {
  kind: DisplayActionKind;
  reportId: string;
}

export interface ToolDisplayInfo {
  /** 已按当前语言组装好的事实行；未知 key / 未知枚举值已丢弃。 */
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
  NodeImport: entry(
    "tool.NodeImport.running",
    "tool.NodeImport.done",
    "tool.NodeImport.failed",
    "tool.advice.retryLater",
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
  MyServerWallet: entry(
    "tool.MyServerWallet.running",
    "tool.MyServerWallet.done",
    "tool.MyServerWallet.failed",
    "tool.advice.retryLater",
    true,
  ),
  NodeRotateCredentials: entry(
    "tool.NodeRotateCredentials.running",
    "tool.NodeRotateCredentials.done",
    "tool.NodeRotateCredentials.failed",
    "tool.advice.rotateRetry",
    false,
  ),
  ServerOptions: entry(
    "tool.ServerOptions.running",
    "tool.ServerOptions.done",
    "tool.ServerOptions.failed",
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
  submit_issue_to_public_wall: entry(
    "tool.submit_issue_to_public_wall.running",
    "tool.submit_issue_to_public_wall.done",
    "tool.submit_issue_to_public_wall.failed",
    "tool.advice.localReport",
    false,
  ),
  read_public_issue_wall: entry(
    "tool.read_public_issue_wall.running",
    "tool.read_public_issue_wall.done",
    "tool.read_public_issue_wall.failed",
    "tool.advice.retryLater",
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

function readScalar(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

/** events.md §3.4.1 闭集：静态句。 */
const STATIC_FACTS: Record<string, MessageKey> = {
  "core.no_active": "tool.fact.core.noActive",
  "runtime.connected": "tool.fact.runtime.connected",
  "runtime.disconnected": "tool.fact.runtime.disconnected",
  "runtime.logs_empty": "tool.fact.runtime.logsEmpty",
  "net.free_cache_missing": "tool.fact.net.cacheMissing",
  "node.credential_refresh_failed": "tool.fact.node.credentialRefreshFailed",
  "probe.unreachable": "tool.fact.probe.unreachable",
  "probe.untested": "tool.fact.probe.untested",
  "effect.next_connect": "tool.fact.effect.nextConnect",
  "scope.no_http3": "tool.fact.scope.noHttp3",
  "servers.empty": "tool.fact.servers.empty",
  "server.record_incomplete": "tool.fact.server.recordIncomplete",
  "server.advice_rebuild": "tool.fact.server.adviceRebuild",
  "server.no_record": "tool.fact.server.noRecord",
  "http.captcha_required": "tool.fact.http.captcha",
  "routing.reconnect_failed": "tool.fact.routing.reconnectFailed",
  "effect.reconnect": "tool.fact.effect.reconnect",
};

/** 单参数句；`params` 里缺任何一个都丢弃该行。`mono` = 纯数字事实。 */
const TEXT_FACTS: Record<
  string,
  { text: MessageKey; params: string[]; mono?: boolean }
> = {
  "core.active_version": { text: "tool.fact.core.active", params: ["version"] },
  "core.latest_version": { text: "tool.fact.core.latest", params: ["version"] },
  "core.current_version": { text: "tool.fact.core.currentVersion", params: ["version"] },
  "core.installed_count": { text: "tool.fact.core.installed", params: ["count"], mono: true },
  "runtime.version": { text: "tool.fact.runtime.version", params: ["version"] },
  "runtime.exit_ip": { text: "tool.fact.runtime.exitIp", params: ["ip"] },
  "runtime.logs_recent": { text: "tool.fact.runtime.logsRecent", params: ["count"], mono: true },
  "job.progress": { text: "tool.fact.job.progress", params: ["percent"], mono: true },
  "net.service_count": { text: "tool.fact.net.services", params: ["count"], mono: true },
  "net.default_interface": { text: "tool.fact.net.defaultInterface", params: ["name"] },
  "net.free_node_count": { text: "tool.fact.net.freeNodeCount", params: ["count"], mono: true },
  "config.name": { text: "tool.fact.config.name", params: ["name"] },
  "config.current_node": { text: "tool.fact.config.currentNode", params: ["name"] },
  "config.node_count": { text: "tool.fact.config.nodeCount", params: ["count"], mono: true },
  "node.name": { text: "tool.fact.node.name", params: ["name"] },
  "node.new_port": { text: "tool.fact.node.newPort", params: ["port"], mono: true },
  "probe.latency_ms": { text: "tool.fact.probe.latency", params: ["ms"], mono: true },
  "import.added": { text: "tool.fact.import.added", params: ["count"], mono: true },
  "import.skipped": { text: "tool.fact.import.skipped", params: ["count"], mono: true },
  "report.location": { text: "tool.fact.report.location", params: ["path"] },
  "report.log_count": { text: "tool.fact.report.logCount", params: ["count"], mono: true },
  "report.category_count": { text: "tool.fact.report.categoryCount", params: ["count"], mono: true },
  "http.status_code": { text: "tool.fact.http.statusCode", params: ["code"], mono: true },
  "http.elapsed_ms": { text: "tool.fact.http.elapsed", params: ["ms"], mono: true },
  "http.redirects": { text: "tool.fact.http.redirects", params: ["count"], mono: true },
  "http.server": { text: "tool.fact.http.server", params: ["name"] },
  "region.name": { text: "tool.fact.region", params: ["name"] },
  "plan.label": { text: "tool.fact.plan", params: ["label"] },
  "catalog.node_count": { text: "tool.fact.catalog.nodeCount", params: ["count"], mono: true },
  "catalog.region_count": { text: "tool.fact.catalog.regionCount", params: ["count"], mono: true },
  "catalog.plan_count": { text: "tool.fact.catalog.planCount", params: ["count"], mono: true },
  "routing.category_count": { text: "tool.fact.routing.categoryCount", params: ["count"], mono: true },
  "routing.service_count": { text: "tool.fact.routing.serviceCount", params: ["count"], mono: true },
  "rules.version": { text: "tool.fact.rules.version", params: ["version"] },
};

const JOB_STATES: Record<string, MessageKey> = {
  queued: "tool.fact.job.state.queued",
  running: "tool.fact.job.state.running",
  succeeded: "tool.fact.job.state.succeeded",
  failed: "tool.fact.job.state.failed",
  cancelled: "tool.fact.job.state.cancelled",
  unknown: "tool.fact.job.state.unknown",
};

const CONNECTION_STATES: Record<string, MessageKey> = {
  restored: "tool.fact.connection.restored",
  disconnected: "tool.fact.connection.disconnected",
  unchanged: "tool.fact.connection.unchanged",
  intact: "tool.fact.connection.intact",
};

const SERVER_STAGES: Record<string, MessageKey> = {
  creating: "tool.fact.server.stage.creating",
  booting: "tool.fact.server.stage.booting",
  installing: "tool.fact.server.stage.installing",
  verifying: "tool.fact.server.stage.verifying",
  error: "tool.fact.server.stage.error",
  unknown: "tool.fact.server.stage.unknown",
};

const SERVER_STATES: Record<string, MessageKey> = {
  creating: "myservers.state.creating",
  booting: "myservers.state.booting",
  installing: "myservers.state.installing",
  verifying: "myservers.state.verifying",
  healthy: "myservers.state.healthy",
  active: "myservers.state.active",
  error: "myservers.state.error",
  destroying: "myservers.state.destroying",
  destroyed: "myservers.state.destroyed",
  gone: "myservers.state.gone",
  unknown: "myservers.state.unknown",
};

const HTTP_ERRORS: Record<string, MessageKey> = {
  timeout: "tool.fact.http.error.timeout",
  headers_too_large: "tool.fact.http.error.headersTooLarge",
  network: "tool.fact.http.error.network",
  other: "tool.fact.http.error.other",
};

const MODE_LABELS: Record<string, MessageKey> = {
  tun: "stage.mode.tun",
  proxy: "stage.mode.proxy",
};

const ROUTING_OWNERSHIP: Record<string, MessageKey> = {
  unconfirmed: "tool.fact.routing.ownership.unconfirmed",
  unknown: "tool.fact.routing.ownership.unknown",
};

const DEEPSEEK_VERIFY: Record<string, MessageKey> = {
  ok: "tool.fact.deepseek.verify.ok",
  invalid: "tool.fact.deepseek.verify.invalid",
  unknown: "tool.fact.deepseek.verify.unknown",
};

/** 机器值 → 词表后缀；camel 写法的旧值也认。 */
const ROUTING_MODES: Record<string, MessageKey> = {
  direct: "tool.fact.routing.mode.direct",
  proxy_all: "tool.fact.routing.mode.proxyAll",
  proxyAll: "tool.fact.routing.mode.proxyAll",
  proxy_selected: "tool.fact.routing.mode.proxySelected",
  proxySelected: "tool.fact.routing.mode.proxySelected",
};

const RULES_STATUS: Record<string, MessageKey> = {
  stale: "tool.fact.rules.status.stale",
  current: "tool.fact.rules.status.current",
  empty: "tool.fact.rules.status.empty",
};

function own<T>(table: Record<string, T>, key: string): T | null {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

function paramOf(
  params: Record<string, string | number> | undefined,
  name: string,
): string | number | null {
  return readScalar(params?.[name]);
}

function numParam(
  params: Record<string, string | number> | undefined,
  name: string,
): number | null {
  const value = paramOf(params, name);
  if (value === null) return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function enumFact(
  table: Record<string, MessageKey>,
  value: string | number | null,
): ToolFact | null {
  if (value === null) return null;
  const key = own(table, String(value));
  return key === null ? null : { label: "", value: t(key) };
}

/** 未知 key / 未知枚举值 / 缺参数一律返回 null：整行丢弃，不拼占位符。 */
export function renderFact(fact: ToolFactPayload): ToolFact | null {
  const params = fact.params;
  const staticKey = own(STATIC_FACTS, fact.key);
  if (staticKey !== null) return { label: "", value: t(staticKey) };
  const text = own(TEXT_FACTS, fact.key);
  if (text !== null) {
    const vars: Record<string, string | number> = {};
    for (const name of text.params) {
      const value = paramOf(params, name);
      if (value === null) return null;
      vars[name] = value;
    }
    return {
      label: "",
      value: t(text.text, vars),
      ...(text.mono ? { mono: true } : {}),
    };
  }

  switch (fact.key) {
    case "job.state":
      return enumFact(JOB_STATES, paramOf(params, "state"));
    case "connection.state":
      return enumFact(CONNECTION_STATES, paramOf(params, "state"));
    case "server.stage":
      return enumFact(SERVER_STAGES, paramOf(params, "stage"));
    case "http.error":
      return enumFact(HTTP_ERRORS, paramOf(params, "reason"));
    case "server.retryable": {
      const value = paramOf(params, "value");
      if (value !== "yes" && value !== "no") return null;
      return {
        label: "",
        value: t(value === "yes" ? "tool.fact.server.retry.yes" : "tool.fact.server.retry.no"),
      };
    }
    case "mode.current": {
      const mode = paramOf(params, "mode");
      const label = typeof mode === "string" ? own(MODE_LABELS, mode) : null;
      if (label === null) return null;
      return { label: "", value: t("tool.fact.mode", { mode: t(label) }) };
    }
    case "server.failure_code": {
      const code = paramOf(params, "code");
      if (code === null) return null;
      const known = own(ERROR_FAILURE_TEXT, String(code));
      return {
        label: "",
        value:
          known === null
            ? t("tool.fact.server.failureGeneric")
            : t("tool.fact.server.failureReason", { reason: t(known) }),
      };
    }
    case "routing.ownership":
      return enumFact(ROUTING_OWNERSHIP, paramOf(params, "state"));
    case "deepseek.verify":
      return enumFact(DEEPSEEK_VERIFY, paramOf(params, "result"));
    case "routing.mode":
      return enumFact(ROUTING_MODES, paramOf(params, "mode"));
    case "rules.status":
      return enumFact(RULES_STATUS, paramOf(params, "state"));
    case "diag.result": {
      const failed = numParam(params, "failed");
      const skipped = numParam(params, "skipped");
      if (failed === null || skipped === null) return null;
      const key =
        failed > 0 && skipped > 0
          ? "tool.fact.diag.failedSkipped"
          : failed > 0
            ? "tool.fact.diag.failed"
            : skipped > 0
              ? "tool.fact.diag.skipped"
              : "tool.fact.diag.ok";
      return { label: "", value: t(key, { failed, skipped }) };
    }
    case "core.version_change": {
      const from = paramOf(params, "from");
      const to = paramOf(params, "to");
      if (from === null || to === null) return null;
      return { label: "", value: t("tool.fact.core.versionChange", { from, to }) };
    }
    case "region.code": {
      const code = paramOf(params, "code");
      const label = paramOf(params, "label");
      if (code === null && label === null) return null;
      if (code === null) {
        return { label: "", value: t("tool.fact.region.code", { name: label! }) };
      }
      const text = regionLabel(String(code));
      // 未知 code 时 regionLabel 回大写码本身，这时改用后端给的 label。
      const name =
        text === String(code).toUpperCase() && label !== null ? label : text;
      return { label: "", value: t("tool.fact.region.code", { name }) };
    }
    case "server.row": {
      const name = paramOf(params, "name");
      const region = paramOf(params, "region");
      const state = paramOf(params, "state");
      if (name === null || region === null || typeof state !== "string") return null;
      const stateKey = own(SERVER_STATES, state);
      if (stateKey === null) return null;
      let value = t("tool.fact.server.row", { name, region, state: t(stateKey) });
      const ip = paramOf(params, "ip");
      if (ip !== null) value += ` · ${ip}`;
      const destroyed = paramOf(params, "destroyed");
      if (destroyed === "billing_unpaid") {
        value += ` · ${t("tool.fact.server.destroyed.billingUnpaid")}`;
      } else if (destroyed === "user") {
        value += ` · ${t("tool.fact.server.destroyed.user")}`;
      }
      return { label: "", value };
    }
    default:
      return null;
  }
}

function readFactPayload(raw: unknown): ToolFactPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const key = readText(record.key);
  if (!key) return null;
  const params: Record<string, string | number> = {};
  if (record.params && typeof record.params === "object" && !Array.isArray(record.params)) {
    for (const [name, value] of Object.entries(record.params as Record<string, unknown>)) {
      const scalar = readScalar(value);
      if (scalar !== null) params[name] = scalar;
    }
  }
  return Object.keys(params).length > 0 ? { key, params } : { key };
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
        .map(readFactPayload)
        .map((fact) => (fact === null ? null : renderFact(fact)))
        .filter((fact): fact is ToolFact => fact !== null)
        .slice(0, 4)
    : [];
  const actions = Array.isArray(record.actions)
    ? record.actions
        .map(readDisplayAction)
        .filter((action): action is ToolDisplayAction => action !== null)
        .slice(0, 2)
    : [];
  const changed = readChanged(record.changed);
  if (facts.length === 0 && !changed && actions.length === 0) return null;
  return { facts, changed, actions };
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
