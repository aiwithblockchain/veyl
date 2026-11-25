import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { t } from "../i18n";
import type { MessageKey } from "../i18n";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentBridge,
  AppLanguage,
  AppLanguageState,
  ChatHistory,
  ConfigActivateResult,
  ConfigCreateInput,
  ConfigUpdateInput,
  ConfigDeleteData,
  ConfigListData,
  ConfigSetModeData,
  ConfigSetModeInput,
  QuitDecisionAction,
  SendMessageOptions,
  TrialStatusData,
  CoreCheckUpdatesResult,
  CoreInfo,
  DeepSeekKeyState,
  DefaultProfileStatus,
  ImportSeedResult,
  IssueReportPreference,
  LlmProvider,
  LlmProviderInput,
  LlmProviderTestResult,
  MobileClientId,
  MobileClientQrEntry,
  MobileClientsQrData,
  MobileExportData,
  MobileExportFormat,
  MobileSaveFileData,
  MyServer,
  MyServerAccount,
  MyServerCatalog,
  MyServerCreateInput,
  MyServerCredentialNode,
  NodeRotateCredentialsResult,
  MyServerDeviceIdentity,
  MyServerEvent,
  MyServerEventCode,
  MyServerEvents,
  MyServerFailure,
  MyServerIdentity,
  MyServerLoginTicket,
  MyServerOrder,
  MyServerOrderState,
  MyServerPlan,
  MyServerRebuildResult,
  MyServerRegion,
  MyServerSshCredentials,
  MyServerState,
  MyServerTopup,
  MyServerWallet,
  NetRepairAction,
  NetRepairResult,
  NetworkForceResetResult,
  NetworkForceResetStep,
  NetworkResetStepStatus,
  NodeProbeAllData,
  NodeProbeResult,
  NodeProbeRun,
  NodeProbeSnapshotData,
  NodeReachabilityReport,
  NodeSwitchResult,
  PendingQuestion,
  ReportActionData,
  ProxyPortSaveResult,
  ProxyPortSettings,
  ProxyRecoveryReportData,
  RenamedSession,
  RuntimeStartResult,
  ServerSyncChanged,
  ServerSyncData,
  ServerSyncFailure,
  StoredChatMessage,
  StoredSessionSummary,
  SyncIntervalMinutes,
  TunHelperInfo,
  TunHelperRestartResult,
  TunHelperState,
  TunProbeData,
} from "./bridge";
import { DEFAULT_PROXY_PORT, readQuestionDetail } from "./bridge";
import { BridgeError, toBridgeError } from "./errors";
import { createListenerManager } from "./listeners";
import { AGENT_EVENTS, APP_EVENT_NAMES, AI_EVENT_NAMES } from "./protocol";
import type {
  AgentEvent,
  Category,
  ConfigDetail,
  ConfigRouteMode,
  NodeCreateInput,
  NodeAttachInput,
  NodeAttachResult,
  NodeForgetInput,
  NodeForgetResult,
  NodeRemoveInput,
  NodeRemoveResult,
  NodeUpdateInput,
  NodeUpdateResult,
  NodeImportResult,
  NodeImportSkipped,
  NodeSummary,
  RouteSetModeData,
  RouteState,
  RuntimeSnapshot,
  SystemRegion,
} from "./protocol";

const EVENT_NAMES = [...AI_EVENT_NAMES, ...APP_EVENT_NAMES];

/** 契约已定、Host 还没接线：按未实现报错，不改调用方的接口形状。 */
function notWired<T>(what: MessageKey): Promise<T> {
  return Promise.reject({
    code: "INTERNAL",
    message: t("bridge.notWired", { what: t(what) }),
  });
}

interface RawPendingQuestion {  question_id?: string;
  session_id?: string;
  request_id?: string;
  question?: string;
  options?: string[];
  created_at?: number;
  expires_at?: number;
  [key: string]: unknown;
}

interface RawDefaultProfile {
  package_id?: string | null;
  version?: string | null;
  applied_at?: string | number | null;
  new_version_available?: boolean;
  node_count?: number;
  checked_at?: string | number | null;
  source?: string | null;
  changed?: boolean;
  reason?: string | null;
  added?: number | null;
  removed?: number | null;
}

/** 契约里的时间是 Unix 毫秒，界面统一用 ISO 8601；字符串原样保留。 */
function toIsoString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function countOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizePortFallback(
  raw: unknown,
): { requested: number; actual: number; reason: "occupied" | "unavailable" } | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { requested?: unknown; actual?: unknown; reason?: unknown };
  if (
    typeof value.requested !== "number" ||
    !Number.isFinite(value.requested) ||
    typeof value.actual !== "number" ||
    !Number.isFinite(value.actual)
  ) {
    return null;
  }
  // 认不出原因就不显示这句说明：说错（占用 vs 权限）比不说更糟。
  if (value.reason !== "occupied" && value.reason !== "unavailable") return null;
  return { requested: value.requested, actual: value.actual, reason: value.reason };
}

function normalizeSystemDns(value: unknown): "tunnel" | "unchanged" | null {
  return value === "tunnel" || value === "unchanged" ? value : null;
}

function readPort(value: unknown, fallbackPort: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535
    ? value
    : fallbackPort;
}

function normalizeProxyPortSettings(
  raw: { port?: unknown; default_port?: unknown } | null | undefined,
): ProxyPortSettings {
  return {
    port: readPort(raw?.port, DEFAULT_PROXY_PORT),
    defaultPort: readPort(raw?.default_port, DEFAULT_PROXY_PORT),
  };
}

function normalizeProxyPortSave(
  raw: { port?: unknown; availability?: unknown } | null | undefined,
  fallbackPort: number,
): ProxyPortSaveResult {
  const availability =
    raw?.availability === "occupied" || raw?.availability === "unavailable"
      ? raw.availability
      : "free";
  return { port: readPort(raw?.port, fallbackPort), availability };
}

/** 只兜形状：非法 selected 按 system 处理，系统语言的解析仍在 Rust 一处做。 */
function normalizeAppLanguageState(raw: unknown): AppLanguageState {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const selected: AppLanguage =
    value.selected === "zh" || value.selected === "en" || value.selected === "system"
      ? value.selected
      : "system";
  return { selected, resolved: value.resolved === "en" ? "en" : "zh" };
}

function normalizeConfigDetail(raw: ConfigDetail & { layout_revision?: unknown }): ConfigDetail {
  return {
    ...raw,
    layout: raw.layout ?? null,
    // 老后端不带 revision：按「还没编排过」处理，别拿 undefined 去比大小。
    layout_revision:
      typeof raw.layout_revision === "number" && Number.isFinite(raw.layout_revision)
        ? raw.layout_revision
        : null,
  };
}

function normalizeConfigSetMode(
  raw: Record<string, unknown>,
  input: ConfigSetModeInput,
): ConfigSetModeData {
  const mode =
    raw.mode === "tun" || raw.mode === "system_proxy" ? raw.mode : input.mode;
  const previous =
    raw.previous_mode === "tun" || raw.previous_mode === "system_proxy"
      ? raw.previous_mode
      : mode;
  return {
    config_id:
      typeof raw.config_id === "string" ? raw.config_id : input.configId ?? "",
    mode,
    previous_mode: previous,
    changed: raw.changed === true,
    connected: raw.connected === true,
    restored: raw.restored === true,
    confirmation: raw.confirmation === "accepted" ? "accepted" : "not_needed",
  };
}

function normalizeDefaultProfile(raw: RawDefaultProfile): DefaultProfileStatus {
  return {
    packageId: raw.package_id ?? null,
    version: raw.version ?? null,
    appliedAt: toIsoString(raw.applied_at),
    newVersionAvailable: raw.new_version_available === true,
    nodeCount: raw.node_count ?? 0,
    checkedAt: toIsoString(raw.checked_at),
    source:
      raw.source === "network" || raw.source === "cache" ? raw.source : null,
    changed: raw.changed === true,
    reason:
      raw.reason === "offline" ||
      raw.reason === "invalid_content" ||
      raw.reason === "local_write"
        ? raw.reason
        : null,
    added: countOrZero(raw.added),
    removed: countOrZero(raw.removed),
  };
}

interface RawCoreInfo {
  bundled_version?: string | null;
  active_version?: string | null;
  active_source?: string | null;
  restart_required?: boolean;
}

function normalizeCoreInfo(raw: RawCoreInfo): CoreInfo {
  return {
    bundledVersion: raw.bundled_version ?? "",
    activeVersion: raw.active_version ?? raw.bundled_version ?? "",
    // 未知来源按随包处理：没有明确说「已安装」就不显示回退入口。
    activeSource: raw.active_source === "installed" ? "installed" : "bundled",
    restartRequired: raw.restart_required === true,
  };
}

function normalizeCoreCheck(raw: {
  network?: string;
  candidates?: Array<{ version?: string; size?: number }>;
  cached?: boolean;
  message?: string | null;
}): CoreCheckUpdatesResult {
  const network =
    raw.network === "unreachable" || raw.network === "source_error" ? raw.network : "ok";
  return {
    network,
    candidates: (raw.candidates ?? [])
      .filter((item) => typeof item.version === "string" && item.version.length > 0)
      .map((item) => ({ version: item.version as string, size: item.size ?? 0 })),
    cached: raw.cached === true,
    message: raw.message ?? undefined,
  };
}

interface RawNodeProbeRun {
  run_id?: string;
  done?: number;
  total?: number;
  started_at?: number;
  phase?: string;
  method?: string;
}

function normalizeProbeRun(raw: RawNodeProbeRun | null | undefined): NodeProbeRun | null {
  if (!raw || typeof raw.run_id !== "string" || raw.run_id.length === 0) return null;
  return {
    runId: raw.run_id,
    done: typeof raw.done === "number" ? raw.done : 0,
    total: typeof raw.total === "number" ? raw.total : 0,
    startedAt: typeof raw.started_at === "number" ? raw.started_at : 0,
    phase: raw.phase === "preparing" ? "preparing" : "probing",
    // 只有 clash 是真实探测；其余（含旧版的 tcp）都按「没测成」处理。
    method: raw.method === "clash" ? "clash" : "none",
  };
}

function normalizeProbeResult(raw: unknown): NodeProbeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as {
    node_id?: unknown;
    status?: unknown;
    reachable?: unknown;
    latency_ms?: unknown;
    probe_method?: unknown;
    checked_at?: unknown;
    error?: unknown;
  };
  if (typeof value.node_id !== "string" || value.node_id.length === 0) return null;
  // status 是三态的权威字段：reachable 永远由它推导，避免 ok+false 这类矛盾。
  // 旧载荷没有 status 时才回退到 reachable（null 仍是 untested）。
  const hasStatus =
    value.status === "ok" ||
    value.status === "unreachable" ||
    value.status === "untested";
  const status = hasStatus
    ? (value.status as "ok" | "unreachable" | "untested")
    : value.reachable === true
      ? "ok"
      : value.reachable === false
        ? "unreachable"
        : "untested";
  const reachable =
    status === "ok" ? true : status === "unreachable" ? false : null;
  const error =
    value.error && typeof value.error === "object"
      ? (() => {
          const reason = (value.error as { reason?: unknown }).reason;
          return {
            code:
              typeof (value.error as { code?: unknown }).code === "string"
                ? ((value.error as { code: string }).code)
                : "",
            message:
              typeof (value.error as { message?: unknown }).message === "string"
                ? ((value.error as { message: string }).message)
                : "",
            // 只有真的带原因时才加字段，旧结果的精确比较不受影响。
            ...(typeof reason === "string" && reason !== ""
              ? { reason }
              : {}),
          };
        })()
      : null;
  return {
    node_id: value.node_id,
    status,
    reachable,
    latency_ms:
      typeof value.latency_ms === "number" && Number.isFinite(value.latency_ms)
        ? value.latency_ms
        : null,
    // 不再把未知方式补成 tcp：只有 clash_delay 是真实探测。
    probe_method: value.probe_method === "clash_delay" ? "clash_delay" : "none",
    checked_at: typeof value.checked_at === "number" ? value.checked_at : 0,
    error,
  };
}

/**
 * `node-probe-progress` 的阶段事件可能不带结果；带了就与快照走同一套归一化，
 * 归一失败（没有有效 node_id）时按阶段事件处理，不伪造节点。
 */
function normalizeProbeProgressPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const raw = payload as { result?: unknown };
  if (raw.result === null || raw.result === undefined) return payload;
  return { ...raw, result: normalizeProbeResult(raw.result) };
}

function normalizeNodeSummary(raw: unknown): NodeSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.node_id !== "string" || value.node_id.length === 0) return null;
  const source =
    value.source === "seed" || value.source === "url" ? value.source : "manual";
  return {
    node_id: value.node_id,
    name: typeof value.name === "string" ? value.name : "",
    server: typeof value.server === "string" ? value.server : "",
    port: typeof value.port === "number" ? value.port : 0,
    method: typeof value.method === "string" ? value.method : "",
    protocol: "shadowsocks",
    source,
    created_at: typeof value.created_at === "number" ? value.created_at : Date.now(),
  };
}

const IMPORT_SKIP_REASONS = [
  "unsupported_scheme",
  "unsupported_method",
  "malformed",
  "duplicate",
  "subscription_empty",
] as const;

function normalizeNodeAttach(raw: unknown): NodeAttachResult {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const readIds = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    config_id: typeof record.config_id === "string" ? record.config_id : "",
    created_config: record.created_config === true,
    attached_node_ids: readIds(record.attached_node_ids),
    skipped_node_ids: readIds(record.skipped_node_ids),
    node_count: typeof record.node_count === "number" ? record.node_count : 0,
    current_node_id:
      typeof record.current_node_id === "string" ? record.current_node_id : null,
  };
}

function normalizeNodeForget(raw: unknown): NodeForgetResult {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { forgotten: record.forgotten === true };
}

function normalizeNodeRemove(raw: unknown): NodeRemoveResult {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    removed: record.removed === true,
    wasCurrent: record.was_current === true,
  };
}

function normalizeNodeUpdate(raw: unknown): NodeUpdateResult {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    updated: record.updated === true,
    wasCurrent: record.was_current === true,
    disconnected: record.disconnected === true,
    paramsChanged: record.params_changed === true,
    rebuilt: record.rebuilt === true,
    rebuildStatus:
      typeof record.rebuild_status === "string" ? record.rebuild_status : null,
    message: typeof record.message === "string" ? record.message : null,
  };
}

function normalizeNodeImport(raw: {
  imported?: unknown;
  skipped?: unknown;
  nodes?: unknown;
}): NodeImportResult {
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes
        .map(normalizeNodeSummary)
        .filter((node): node is NodeSummary => node !== null)
    : [];
  const skipped: NodeImportSkipped[] = Array.isArray(raw.skipped)
    ? raw.skipped.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const value = item as { name?: unknown; reason?: unknown };
        const reason = IMPORT_SKIP_REASONS.find((known) => known === value.reason) ?? "malformed";
        return [
          {
            name: typeof value.name === "string" ? value.name : null,
            reason,
          },
        ];
      })
    : [];
  return {
    imported: typeof raw.imported === "number" ? raw.imported : nodes.length,
    skipped,
    nodes,
  };
}

const REPORT_ACTION_METHODS = ["reveal", "mail_client", "copy_only"] as const;

/** 历史消息可能带 `{ tool }`（或裸工具名）；读不出来就当没有。 */
function readStoredTool(raw: unknown): { tool: string } | null {
  if (typeof raw === "string") return raw ? { tool: raw } : null;
  if (!raw || typeof raw !== "object") return null;
  const name = (raw as { tool?: unknown }).tool;
  return typeof name === "string" && name ? { tool: name } : null;
}

function normalizeReportAction(
  raw: Partial<ReportActionData>,
  fallback: ReportActionData["method"],
): ReportActionData {
  const method = REPORT_ACTION_METHODS.find((item) => item === raw.method) ?? fallback;
  return {
    opened: raw.opened === true,
    method,
    report_dir: typeof raw.report_dir === "string" ? raw.report_dir : "",
    body_chars: typeof raw.body_chars === "number" ? raw.body_chars : 0,
    body: typeof raw.body === "string" ? raw.body : null,
  };
}

function normalizeRouteMode(value: unknown): ConfigRouteMode {
  return value === "direct" || value === "proxy_selected" ? value : "proxy_all";
}

function normalizeRegion(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeRouteState(raw: Record<string, unknown>): RouteState {
  const mode = normalizeRouteMode(raw.routing_mode);
  const appliedRaw = raw.applied_mode;
  return {
    config_id: typeof raw.config_id === "string" ? raw.config_id : "",
    routing_mode: mode,
    applied_mode:
      appliedRaw === "direct" || appliedRaw === "proxy_all" || appliedRaw === "proxy_selected"
        ? appliedRaw
        : null,
    targets: Array.isArray(raw.targets)
      ? raw.targets.filter((item): item is string => typeof item === "string")
      : [],
    custom_rules: Array.isArray(raw.custom_rules)
      ? raw.custom_rules.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
        )
      : [],
    route_revision: typeof raw.route_revision === "number" ? raw.route_revision : 0,
    applied_revision: typeof raw.applied_revision === "number" ? raw.applied_revision : null,
    effective: raw.effective === "current_connection" ? "current_connection" : "next_connection",
    reconnect_required: raw.reconnect_required === true,
    local_direct_basis:
      raw.local_direct_basis === "domain_and_ip" || raw.local_direct_basis === "ip_only"
        ? raw.local_direct_basis
        : "none",
    detected_region: normalizeRegion(raw.detected_region),
    applied_region: normalizeRegion(raw.applied_region),
  };
}

function normalizeCategory(raw: unknown): Category | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  return {
    id: value.id,
    name_zh: typeof value.name_zh === "string" ? value.name_zh : value.id,
    name_en: typeof value.name_en === "string" ? value.name_en : "",
    description: typeof value.description === "string" ? value.description : "",
    item_count: typeof value.item_count === "number" ? value.item_count : 0,
    rule_sets: Array.isArray(value.rule_sets)
      ? value.rule_sets.filter((item): item is string => typeof item === "string")
      : [],
    dns_classifiable: value.dns_classifiable === true,
  };
}

const HELPER_STATES: TunHelperState[] = [
  "running",
  "not_running",
  "stale",
  "start_failed",
  "file_invalid",
];

function normalizeHelperInfo(raw: {
  running_build?: unknown;
  helper_version?: unknown;
  expected_build?: unknown;
  stale?: unknown;
  state?: unknown;
  needs_admin_restart?: unknown;
}): TunHelperInfo {
  const state = HELPER_STATES.find((item) => item === raw.state) ?? "unknown";
  return {
    runningBuild: typeof raw.running_build === "string" && raw.running_build ? raw.running_build : null,
    helperVersion:
      typeof raw.helper_version === "string" && raw.helper_version ? raw.helper_version : null,
    expectedBuild:
      typeof raw.expected_build === "string" && raw.expected_build ? raw.expected_build : null,
    stale: raw.stale === true,
    state,
    needsAdminRestart: raw.needs_admin_restart === true,
  };
}

interface RawLlmProvider {
  provider_id?: string;
  name?: string;
  protocol?: string;
  base_url?: string;
  model?: string;
  has_key?: boolean;
  is_active?: boolean;
  is_builtin?: boolean;
}

function normalizeProvider(raw: RawLlmProvider): LlmProvider {
  return {
    providerId: raw.provider_id ?? "",
    name: raw.name ?? t("bridge.untitled"),
    protocol: raw.protocol === "anthropic" ? "anthropic" : "openai",
    baseUrl: raw.base_url ?? "",
    model: raw.model ?? "",
    hasKey: raw.has_key === true,
    isActive: raw.is_active === true,
    isBuiltin: raw.is_builtin === true,
  };
}

function normalizeResetStep(raw: {
  id?: string;
  ok?: boolean;
  detail?: string | null;
  status?: string;
}): NetworkForceResetStep {
  const status: NetworkResetStepStatus =
    raw.status === "ok" || raw.status === "failed" || raw.status === "skipped"
      ? raw.status
      : raw.ok === true
        ? "ok"
        : "failed";
  return {
    id: raw.id ?? "",
    ok: raw.ok === true,
    detail: raw.detail ?? "",
    status,
  };
}

const MY_SERVER_CONTINENTS = new Set<MyServerRegion["continent"]>([
  "asia",
  "europe",
  "north_america",
  "south_america",
  "oceania",
  "africa",
]);

/** 控制面目录已经是强类型；这里只防「未来字段形状漂移」把界面打崩。 */
function normalizeMyServerCatalog(raw: {
  currency?: unknown;
  updated_at?: unknown;
  regions?: unknown;
  plans?: unknown;
}): MyServerCatalog {
  const regions = Array.isArray(raw.regions)
    ? raw.regions
        .map((value): MyServerRegion | null => {
          if (!value || typeof value !== "object") return null;
          const region = value as Record<string, unknown>;
          const continent = region.continent;
          if (
            typeof region.id !== "string" ||
            region.id.trim() === "" ||
            typeof region.name !== "string" ||
            typeof continent !== "string" ||
            !MY_SERVER_CONTINENTS.has(continent as MyServerRegion["continent"])
          ) {
            return null;
          }
          return {
            id: region.id,
            name: region.name,
            continent: continent as MyServerRegion["continent"],
          };
        })
        .filter((region): region is MyServerRegion => region !== null)
    : [];

  const plans = Array.isArray(raw.plans)
    ? raw.plans
        .map((value): MyServerPlan | null => {
          if (!value || typeof value !== "object") return null;
          const plan = value as Record<string, unknown>;
          const hourly = Number(plan.hourly_usd);
          const monthly = Number(plan.monthly_usd);
          const daily = plan.daily_price_cents;
          const transfer = plan.transfer_gib;
          if (
            typeof plan.id !== "string" ||
            plan.id.trim() === "" ||
            typeof plan.label !== "string" ||
            !Number.isFinite(hourly) ||
            !Number.isFinite(monthly) ||
            hourly < 0 ||
            monthly < 0 ||
            !Number.isInteger(daily as number) ||
            (daily as number) < 0 ||
            !Number.isInteger(transfer as number) ||
            (transfer as number) < 0
          ) {
            return null;
          }
          return {
            id: plan.id,
            label: plan.label,
            hourly_usd: hourly,
            monthly_usd: monthly,
            daily_price_cents: daily as number,
            transfer_gib: transfer as number,
            regions: Array.isArray(plan.regions)
              ? plan.regions.filter((id): id is string => typeof id === "string")
              : undefined,
          };
        })
        .filter((plan): plan is MyServerPlan => plan !== null)
    : [];

  return {
    currency: typeof raw.currency === "string" ? raw.currency : "",
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
    regions,
    plans,
  };
}

const MY_SERVER_STATES = new Set<MyServerState>([
  "creating",
  "booting",
  "installing",
  "verifying",
  "healthy",
  "active",
  "error",
  "destroying",
  "destroyed",
  "gone",
]);

const MY_SERVER_ORDER_STATES = new Set<MyServerOrderState>([
  "pending_payment",
  "paid",
  "provisioning",
  "ready",
  "cancelled",
  "failed",
]);

/** 服务器数据形状不对时直接报错，不在前端猜一个值。 */
function serverDataError(): never {
  throw { code: "UPSTREAM_ERROR", message: t("bridge.badServerData") };
}

function normalizeMyServerFailure(value: unknown): MyServerFailure | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const stage =
    typeof raw.stage === "string" && MY_SERVER_STATES.has(raw.stage as MyServerState)
      ? (raw.stage as MyServerState)
      : null;
  if (!stage || typeof raw.code !== "string" || typeof raw.message !== "string") {
    return null;
  }
  return {
    stage,
    code: raw.code,
    message: raw.message,
    retryable: raw.retryable === true,
  };
}

const SYNC_INTERVALS = new Set<number>([0, 30, 60, 240, 480, 1440]);

const MY_SERVER_EVENT_CODES = new Set<MyServerEventCode>([
  "order.confirmed",
  "machine.created",
  "install.started",
  "verify.started",
  "activated",
  "create.failed",
  "install.failed",
  "check.failed",
  "settle.failed",
  "destroyed",
  "port.changed",
  "agent.rejoined",
  "refunded",
  "refund.pending",
]);

/** 单条事件逐字段校验；形状不对的条目丢弃，不猜默认值。 */
function normalizeMyServerEvent(value: unknown): MyServerEvent | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.at !== "number" ||
    !Number.isFinite(raw.at) ||
    typeof raw.code !== "string" ||
    !MY_SERVER_EVENT_CODES.has(raw.code as MyServerEventCode)
  ) {
    return null;
  }
  const event: MyServerEvent = { at: raw.at, code: raw.code as MyServerEventCode };
  if (
    typeof raw.count === "number" &&
    Number.isInteger(raw.count) &&
    raw.count > 1
  ) {
    event.count = raw.count;
  }
  if (typeof raw.version === "string" && raw.version !== "") {
    event.version = raw.version;
  }
  if (
    typeof raw.amount_cents === "number" &&
    Number.isInteger(raw.amount_cents) &&
    raw.amount_cents >= 0
  ) {
    event.amount_cents = raw.amount_cents;
  }
  if (typeof raw.reason === "string" && raw.reason !== "") {
    event.reason = raw.reason;
  }
  return event;
}
function normalizeSyncInterval(value: unknown): SyncIntervalMinutes | null {
  return typeof value === "number" && SYNC_INTERVALS.has(value)
    ? (value as SyncIntervalMinutes)
    : null;
}

/** 变化条目逐字段校验；形状不对的条目丢弃，不猜默认值。 */
function normalizeServerSyncChanged(value: unknown): ServerSyncChanged[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ServerSyncChanged[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.server_id !== "string" ||
      raw.server_id === "" ||
      typeof raw.node_id !== "string" ||
      raw.node_id === "" ||
      typeof raw.name !== "string" ||
      typeof raw.port_changed !== "boolean" ||
      typeof raw.password_changed !== "boolean"
    ) {
      return [];
    }
    return [
      {
        server_id: raw.server_id,
        node_id: raw.node_id,
        name: raw.name,
        port_changed: raw.port_changed,
        password_changed: raw.password_changed,
      },
    ];
  });
}

/** 失败条目逐字段校验；形状不对的条目丢弃。 */
function normalizeServerSyncFailures(value: unknown): ServerSyncFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ServerSyncFailure[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.server_id !== "string" ||
      raw.server_id === "" ||
      typeof raw.code !== "string" ||
      raw.code === ""
    ) {
      return [];
    }
    return [{ server_id: raw.server_id, code: raw.code }];
  });
}

function normalizeMyServer(raw: unknown): MyServer | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const serverId = typeof value.server_id === "string" ? value.server_id : "";
  const state =
    typeof value.state === "string" && MY_SERVER_STATES.has(value.state as MyServerState)
      ? (value.state as MyServerState)
      : null;
  const daily = value.daily_price_cents;
  const paidUntil =
    typeof value.paid_until === "string" && value.paid_until !== ""
      ? value.paid_until
      : null;
  const billingState =
    value.billing_state === "pending" ||
    value.billing_state === "active" ||
    value.billing_state === "past_due" ||
    value.billing_state === "expired"
      ? value.billing_state
      : null;
  const grace = value.grace_ends_at;
  const transfer = value.transfer_gib;
  if (
    !serverId ||
    !state ||
    !Number.isInteger(daily as number) ||
    (daily as number) < 0 ||
    // 待开通时还没扣费，paid_until 为空；其余状态必须有值。
    (billingState !== "pending" && paidUntil === null) ||
    !billingState ||
    !(grace === null || typeof grace === "string") ||
    !Number.isInteger(transfer as number) ||
    (transfer as number) < 0
  ) {
    return null;
  }

  return {
    server_id: serverId,
    order_id: typeof value.order_id === "string" ? value.order_id : undefined,
    name: typeof value.name === "string" ? value.name : "",
    region: typeof value.region === "string" ? value.region : "",
    plan: typeof value.plan === "string" ? value.plan : "",
    state,
    created_at: typeof value.created_at === "string" ? value.created_at : "",
    ip: typeof value.ip === "string" ? value.ip : null,
    port: typeof value.port === "number" ? value.port : null,
    node_id: typeof value.node_id === "string" ? value.node_id : null,
    local_node_id:
      typeof value.local_node_id === "string" ? value.local_node_id : null,
    hourly_usd:
      typeof value.hourly_usd === "number" && Number.isFinite(value.hourly_usd)
        ? value.hourly_usd
        : 0,
    monthly_usd:
      typeof value.monthly_usd === "number" && Number.isFinite(value.monthly_usd)
        ? value.monthly_usd
        : 0,
    daily_price_cents: daily as number,
    ready_at: typeof value.ready_at === "string" ? value.ready_at : null,
    installing_at:
      typeof value.installing_at === "string" ? value.installing_at : null,
    verifying_at:
      typeof value.verifying_at === "string" ? value.verifying_at : null,
    singbox_version:
      typeof value.singbox_version === "string" ? value.singbox_version : null,
    paid_until: paidUntil,
    billing_state: billingState,
    grace_ends_at: grace as string | null,
    transfer_gib: transfer as number,
    charged_cents: readCents(value.charged_cents) ?? undefined,
    refunded_cents: readCents(value.refunded_cents) ?? undefined,
    failure: normalizeMyServerFailure(value.failure),
  };
}

function normalizeMyServerOrder(raw: unknown): MyServerOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const orderId = typeof value.order_id === "string" ? value.order_id : "";
  const state =
    typeof value.state === "string" &&
    MY_SERVER_ORDER_STATES.has(value.state as MyServerOrderState)
      ? (value.state as MyServerOrderState)
      : null;
  if (!orderId || !state) return null;

  const failure =
    value.failure && typeof value.failure === "object"
      ? (value.failure as Record<string, unknown>)
      : null;
  return {
    order_id: orderId,
    state,
    region: typeof value.region === "string" ? value.region : "",
    plan: typeof value.plan === "string" ? value.plan : "",
    amount_usd:
      typeof value.amount_usd === "number" && Number.isFinite(value.amount_usd)
        ? value.amount_usd
        : 0,
    created_at: typeof value.created_at === "string" ? value.created_at : "",
    expires_at: typeof value.expires_at === "string" ? value.expires_at : null,
    server_id: typeof value.server_id === "string" ? value.server_id : null,
    failure:
      failure && typeof failure.code === "string" && typeof failure.message === "string"
        ? {
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable === true,
          }
        : null,
  };
}

function readCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function normalizeMyServerAccount(raw: unknown): MyServerAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.logged_in !== "boolean") return null;
  const kind =
    value.account_kind === "device" || value.account_kind === "email"
      ? value.account_kind
      : null;
  return {
    logged_in: value.logged_in,
    email: typeof value.email === "string" ? value.email : null,
    account_id: typeof value.account_id === "string" ? value.account_id : null,
    device_id: typeof value.device_id === "string" ? value.device_id : null,
    account_kind: kind,
    session_expires_at:
      typeof value.session_expires_at === "string"
        ? value.session_expires_at
        : null,
  };
}

function normalizeMyServerLoginTicket(raw: unknown): MyServerLoginTicket | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.sent !== "boolean") return null;
  const cooldown =
    typeof value.cooldown_seconds === "number" && Number.isFinite(value.cooldown_seconds)
      ? Math.trunc(value.cooldown_seconds)
      : 60;
  const retry =
    typeof value.retry_after_seconds === "number" &&
    Number.isFinite(value.retry_after_seconds)
      ? Math.trunc(value.retry_after_seconds)
      : undefined;
  return {
    sent: value.sent,
    cooldown_seconds: Math.max(0, cooldown),
    ...(retry === undefined ? {} : { retry_after_seconds: Math.max(0, retry) }),
  };
}

function normalizeMyServerWallet(raw: unknown): MyServerWallet | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const balance = readCents(value.balance_cents);
  if (balance === null || !Array.isArray(value.denominations_cents)) return null;
  const denominations = value.denominations_cents
    .map((item) => readCents(item))
    .filter((item): item is number => item !== null && item > 0)
    .sort((a, b) => a - b);
  return {
    balance_cents: balance,
    currency: typeof value.currency === "string" ? value.currency : "USD",
    denominations_cents: denominations,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : "",
  };
}

function normalizeMyServerTopup(raw: unknown): MyServerTopup | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const cents = readCents(value.denomination_cents);
  if (typeof value.topup_id !== "string" || cents === null) return null;
  return {
    topup_id: value.topup_id,
    checkout_url:
      typeof value.checkout_url === "string" && value.checkout_url.length > 0
        ? value.checkout_url
        : null,
    denomination_cents: cents,
  };
}

function normalizeMobileExportFormat(
  raw: unknown,
): MobileExportFormat | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.url !== "string") return null;
  if (
    value.format === "singbox" ||
    value.format === "clash" ||
    value.format === "ss" ||
    value.format === "shadowrocket"
  ) {
    if (typeof value.qr_data_url !== "string") return null;
    return {
      format: value.format,
      url: value.url,
      qr_data_url: value.qr_data_url,
    };
  }
  return null;
}

function normalizeMobileExport(raw: unknown): MobileExportData {
  if (!raw || typeof raw !== "object") serverDataError();
  const value = raw as Record<string, unknown>;
  if (value.state === "login_required") return { state: "login_required" };
  if (value.state === "no_ready_server") return { state: "no_ready_server" };
  if (value.state === "ok" && Array.isArray(value.formats)) {
    return {
      state: "ok",
      node_count: typeof value.node_count === "number" ? value.node_count : 0,
      created_at: typeof value.created_at === "number" ? value.created_at : 0,
      formats: value.formats
        .map(normalizeMobileExportFormat)
        .filter((format): format is MobileExportFormat => format !== null),
    };
  }
  serverDataError();
}

function normalizeMobileClientsQr(raw: unknown): MobileClientsQrData {
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).platforms)) {
    const platforms = ((raw as Record<string, unknown>).platforms as unknown[])
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const value = entry as Record<string, unknown>;
        if (value.platform !== "ios" && value.platform !== "android") return null;
        if (typeof value.url !== "string" || typeof value.qr_data_url !== "string") {
          return null;
        }
        return {
          platform: value.platform,
          url: value.url,
          qr_data_url: value.qr_data_url,
        };
      })
      .filter((entry): entry is MobileClientQrEntry => entry !== null);
    if (platforms.length > 0) return { platforms };
  }
  serverDataError();
}

function normalizeMobileSaveFile(raw: unknown): MobileSaveFileData {
  if (!raw || typeof raw !== "object") serverDataError();
  const value = raw as Record<string, unknown>;
  if (value.state === "login_required") return { state: "login_required" };
  if (value.state === "no_ready_server") return { state: "no_ready_server" };
  if (value.state === "saved" && typeof value.path === "string") {
    return {
      state: "saved",
      path: value.path,
      node_count: typeof value.node_count === "number" ? value.node_count : 0,
    };
  }
  serverDataError();
}

/** 统一的 invoke 包装：失败一律抛 `BridgeError`，调用方只需要看 code / message。 */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toBridgeError(error);
  }
}

/**
 * Host 侧 Tauri 通道。命令名与事件名以 `docs/contracts/events.md` 为准（已冻结）；
 * 监听器生命周期与错误归一化的写法对齐 TweetPilot 的 `services/ai/tauri.ts`。
 */
export class TauriAgentBridge implements AgentBridge {
  readonly mode = "tauri" as const;

  private listeners = new Set<(event: AgentEvent) => void>();
  private manager = createListenerManager();
  private bootstrapped = false;

  constructor() {
    void this.bootstrap();
  }

  private async bootstrap() {
    if (this.bootstrapped) return;
    this.bootstrapped = true;

    for (const name of EVENT_NAMES) {
      await this.manager.listen(
        name,
        listen<unknown>(name, (event) => {
          const payload = (
            name === AGENT_EVENTS.nodeProbeProgress
              ? normalizeProbeProgressPayload(event.payload)
              : event.payload
          ) as AgentEvent["payload"];
          for (const listener of this.listeners) {
            listener({ name, payload } as AgentEvent);
          }
        }),
      );
    }
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getRuntimeSnapshot(): Promise<RuntimeSnapshot | null> {
    try {
      const raw = await call<RuntimeSnapshot & { port_fallback?: unknown; system_dns?: unknown }>(
        "runtime_status",
      );
      return {
        ...raw,
        system_dns: normalizeSystemDns(raw.system_dns),
        port_fallback: normalizePortFallback(raw.port_fallback),
      };
    } catch {
      // 状态面板拿不到快照时保持 idle，不打断对话。
      return null;
    }
  }

  async getAppVersion(): Promise<string> {
    return getVersion();
  }

  async appLanguageGet(): Promise<AppLanguageState> {
    return normalizeAppLanguageState(await call<unknown>("app_language_get"));
  }

  async appLanguageSet(lang: AppLanguage): Promise<AppLanguageState> {
    return normalizeAppLanguageState(
      await call<unknown>("app_language_set", { language: lang }),
    );
  }

  async runtimeStart(configId?: string): Promise<RuntimeStartResult> {
    return call<RuntimeStartResult>(
      "runtime_start",
      configId ? { configId } : undefined,
    );
  }

  async runtimeStop(): Promise<void> {
    await call("runtime_stop");
  }

  async quitDecision(action: QuitDecisionAction): Promise<void> {
    await call("quit_decision", { action });
  }

  async trialStatus(): Promise<TrialStatusData> {
    return call<TrialStatusData>("trial_status");
  }

  async configList(): Promise<ConfigListData> {
    const raw = await call<Partial<ConfigListData>>("config_list");
    return {
      configs: raw.configs ?? [],
      active_config_id: raw.active_config_id ?? null,
    };
  }

  async configDetail(configId: string): Promise<ConfigDetail> {
    return normalizeConfigDetail(
      await call<ConfigDetail & { layout_revision?: unknown }>("config_detail", {
        configId,
      }),
    );
  }

  async configCreate(input: ConfigCreateInput): Promise<ConfigDetail> {
    return normalizeConfigDetail(
      await call<ConfigDetail & { layout_revision?: unknown }>("config_create", {
        ...input,
      } as unknown as Record<string, unknown>),
    );
  }

  async configUpdate(input: ConfigUpdateInput): Promise<ConfigDetail> {
    return normalizeConfigDetail(
      await call<ConfigDetail & { layout_revision?: unknown }>("config_update", {
        ...input,
      } as unknown as Record<string, unknown>),
    );
  }

  async configDelete(configId: string): Promise<ConfigDeleteData> {
    return call<ConfigDeleteData>("config_delete", { configId });
  }

  async configActivate(configId: string): Promise<ConfigActivateResult> {
    return call<ConfigActivateResult>("config_activate", { configId });
  }

  async configSetMode(input: ConfigSetModeInput): Promise<ConfigSetModeData> {
    const raw = await call<Record<string, unknown>>("config_set_mode", {
      ...(input.configId ? { configId: input.configId } : {}),
      mode: input.mode,
    });
    return normalizeConfigSetMode(raw ?? {}, input);
  }

  async nodeSwitch(configId: string, nodeId: string): Promise<NodeSwitchResult> {
    return call<NodeSwitchResult>("node_switch", { configId, nodeId });
  }

  async nodeProbe(nodeId: string): Promise<NodeProbeResult> {
    const raw = await call<unknown>("node_probe", { nodeId });
    const result = normalizeProbeResult(raw);
    if (!result) {
      throw new BridgeError(
        "PROBE_RESULT_INVALID",
        t("bridge.badProbeResult"),
      );
    }
    return result;
  }

  async nodeProbeReachability(
    serverIp: string,
    controlPort: number,
  ): Promise<NodeReachabilityReport> {
    const raw = await call<{
      icmp?: { ok?: unknown; rtt_ms?: unknown; loss?: unknown; error?: unknown };
      tcp?: { ok?: unknown; ms?: unknown; error?: unknown };
    }>("node_probe_reachability", { serverIp, controlPort });
    if (typeof raw?.icmp?.ok !== "boolean" || typeof raw?.tcp?.ok !== "boolean") {
      throw new BridgeError(
        "PROBE_RESULT_INVALID",
        t("bridge.badProbeResult"),
      );
    }
    return {
      icmp: {
        ok: raw.icmp.ok,
        rtt_ms: typeof raw.icmp.rtt_ms === "number" ? raw.icmp.rtt_ms : null,
        loss: typeof raw.icmp.loss === "number" ? raw.icmp.loss : 0,
        error: typeof raw.icmp.error === "string" ? raw.icmp.error : null,
      },
      tcp: {
        ok: raw.tcp.ok,
        ms: typeof raw.tcp.ms === "number" ? raw.tcp.ms : null,
        error: typeof raw.tcp.error === "string" ? raw.tcp.error : null,
      },
    };
  }

  async nodeProbeAll(configId?: string, nodeIds?: string[]): Promise<NodeProbeAllData> {
    const args: Record<string, unknown> = {};
    if (configId) args.configId = configId;
    // 不传 nodeIds 才是「全部」；传一个全量数组会让未知 id 语义混在一起。
    if (nodeIds) args.nodeIds = nodeIds;
    const raw = await call<{
      run_id?: string;
      config_id?: string;
      total?: number;
      concurrency?: number;
      ignored_node_ids?: unknown[];
    }>("node_probe_all", Object.keys(args).length > 0 ? args : undefined);
    return {
      runId: raw.run_id ?? "",
      configId: raw.config_id ?? configId ?? "",
      total: raw.total ?? 0,
      concurrency: raw.concurrency ?? 0,
      ignoredNodeIds: (raw.ignored_node_ids ?? []).filter(
        (item): item is string => typeof item === "string",
      ),
    };
  }

  async nodeProbeCancel(runId: string): Promise<{ cancelled: boolean }> {
    const raw = await call<{ cancelled?: boolean }>("node_probe_cancel", { runId });
    return { cancelled: raw.cancelled === true };
  }

  async nodeProbeSnapshot(configId?: string): Promise<NodeProbeSnapshotData> {
    const raw = await call<{
      config_id?: string;
      results?: unknown[];
      run?: RawNodeProbeRun | null;
    }>("node_probe_snapshot", configId ? { configId } : undefined);
    return {
      configId: raw.config_id ?? configId ?? "",
      results: (raw.results ?? [])
        .map(normalizeProbeResult)
        .filter((item): item is NodeProbeResult => item !== null),
      run: normalizeProbeRun(raw.run),
    };
  }

  async nodeCreate(input: NodeCreateInput): Promise<NodeSummary> {
    const raw = await call<unknown>("node_create", {
      name: input.name,
      server: input.server,
      port: input.port,
      method: input.method,
      password: input.password,
      ...(input.configId ? { configId: input.configId } : {}),
    });
    const node = normalizeNodeSummary(raw);
    if (!node) {
      throw {
        code: "INTERNAL",
        message: t("bridge.missingNodeId"),
        details: null,
      };
    }
    return node;
  }

  async nodeAttach(input: NodeAttachInput): Promise<NodeAttachResult> {
    return normalizeNodeAttach(
      await call<unknown>("node_attach", {
        ...(input.source ? { source: input.source } : {}),
        ...(input.nodeIds ? { nodeIds: input.nodeIds } : {}),
        ...(input.configId ? { configId: input.configId } : {}),
      }),
    );
  }

  async nodeForget(input: NodeForgetInput): Promise<NodeForgetResult> {
    return normalizeNodeForget(
      await call<unknown>("node_forget", { nodeId: input.nodeId }),
    );
  }

  async nodeRemove(input: NodeRemoveInput): Promise<NodeRemoveResult> {
    return normalizeNodeRemove(
      await call<unknown>("node_remove", { nodeId: input.nodeId }),
    );
  }

  async nodeUpdate(input: NodeUpdateInput): Promise<NodeUpdateResult> {
    const args: Record<string, unknown> = {
      nodeId: input.nodeId,
      name: input.name,
    };
    if (input.server !== undefined) args.server = input.server;
    if (input.port !== undefined) args.port = input.port;
    if (input.method !== undefined) args.method = input.method;
    if (input.password !== undefined) args.password = input.password;
    return normalizeNodeUpdate(await call<unknown>("node_update", args));
  }

  async nodeImportUrl(url: string, configId?: string): Promise<NodeImportResult> {
    return normalizeNodeImport(
      await call<{ imported?: unknown; skipped?: unknown; nodes?: unknown }>(
        "node_import_url",
        configId ? { url, configId } : { url },
      ),
    );
  }

  async nodeImportText(text: string, configId?: string): Promise<NodeImportResult> {
    return normalizeNodeImport(
      await call<{ imported?: unknown; skipped?: unknown; nodes?: unknown }>(
        "node_import_text",
        configId ? { text, configId } : { text },
      ),
    );
  }

  async nodeImportFile(path: string, configId?: string): Promise<NodeImportResult> {
    return normalizeNodeImport(
      await call<{ imported?: unknown; skipped?: unknown; nodes?: unknown }>(
        "node_import_file",
        configId ? { path, configId } : { path },
      ),
    );
  }

  async pickNodeFile(): Promise<string | null> {
    const path = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: t("bridge.nodeFileFilter"), extensions: ["txt", "json"] }],
    });
    return typeof path === "string" && path.trim() ? path : null;
  }

  async categoryList(
    query?: string,
    limit?: number,
  ): Promise<{ categories: Category[]; total: number }> {
    const raw = await call<{ categories?: unknown; total?: unknown }>("category_list", {
      ...(query ? { query } : {}),
      ...(limit ? { limit } : {}),
    });
    const categories = Array.isArray(raw.categories)
      ? raw.categories
          .map(normalizeCategory)
          .filter((item): item is Category => item !== null)
      : [];
    return {
      categories,
      total: typeof raw.total === "number" ? raw.total : categories.length,
    };
  }

  async systemRegion(): Promise<SystemRegion> {
    const raw = await call<{ region?: unknown; source?: unknown }>("system_region");
    return {
      region: normalizeRegion(raw.region),
      source: raw.source === "ai" ? "ai" : "system",
    };
  }

  async routeGet(configId?: string): Promise<RouteState> {
    const raw = await call<Record<string, unknown>>(
      "route_get",
      configId ? { configId } : {},
    );
    return normalizeRouteState(raw ?? {});
  }

  async routeSetMode(
    mode: "direct" | "proxy_all",
    configId?: string,
  ): Promise<RouteSetModeData> {
    const raw = await call<Record<string, unknown>>("route_set_mode", {
      ...(configId ? { configId } : {}),
      mode,
    });
    const reconnect =
      raw.reconnect === "reconnected" || raw.reconnect === "reconnect_failed"
        ? raw.reconnect
        : "not_running";
    return {
      ...normalizeRouteState(raw ?? {}),
      hot_switched: raw.hot_switched === true,
      reconnect,
    };
  }

  async defaultProfileStatus(): Promise<DefaultProfileStatus> {
    const raw = await call<RawDefaultProfile>("default_profile_status");
    return normalizeDefaultProfile(raw);
  }

  async defaultProfileRefresh(): Promise<DefaultProfileStatus> {
    const raw = await call<RawDefaultProfile>("default_profile_refresh");
    return normalizeDefaultProfile(raw);
  }

  async proxyPortGet(): Promise<ProxyPortSettings> {
    return normalizeProxyPortSettings(
      await call<{ port?: unknown; default_port?: unknown }>("proxy_port_get"),
    );
  }

  async proxyPortSet(port: number): Promise<ProxyPortSaveResult> {
    return normalizeProxyPortSave(
      await call<{ port?: unknown; availability?: unknown }>("proxy_port_set", {
        port,
      }),
      port,
    );
  }

  async proxyRecoveryReport(): Promise<ProxyRecoveryReportData | null> {
    return call<ProxyRecoveryReportData | null>("proxy_recovery_report");
  }

  async myServerCatalog(fresh = false): Promise<MyServerCatalog> {
    return normalizeMyServerCatalog(
      await call<{
        currency?: unknown;
        updated_at?: unknown;
        regions?: unknown;
        plans?: unknown;
      }>("my_server_catalog", fresh ? { fresh: true } : undefined),
    );
  }

  async myServerList(): Promise<{ servers: MyServer[] }> {
    const raw = await call<{ servers?: unknown }>("my_server_list");
    if (!Array.isArray(raw?.servers)) serverDataError();
    const servers = raw.servers
      .map((value) => normalizeMyServer(value))
      .filter((server): server is MyServer => server !== null);
    return { servers };
  }

  async myServerSync(): Promise<ServerSyncData> {
    const raw = await call<{
      servers?: unknown;
      changed?: unknown;
      failed?: unknown;
    }>("my_server_sync");
    if (!Array.isArray(raw?.servers)) serverDataError();
    const servers = raw.servers
      .map((value) => normalizeMyServer(value))
      .filter((server): server is MyServer => server !== null);
    return {
      servers,
      changed: normalizeServerSyncChanged(raw.changed),
      failed: normalizeServerSyncFailures(raw.failed),
    };
  }

  async serverSyncIntervalGet(): Promise<{ minutes: SyncIntervalMinutes }> {
    const raw = await call<{ minutes?: unknown }>("server_sync_interval_get");
    const minutes = normalizeSyncInterval(raw?.minutes);
    if (minutes === null) serverDataError();
    return { minutes };
  }

  async serverSyncIntervalSet(
    minutes: SyncIntervalMinutes,
  ): Promise<{ minutes: SyncIntervalMinutes }> {
    const raw = await call<{ minutes?: unknown }>("server_sync_interval_set", {
      minutes,
    });
    const saved = normalizeSyncInterval(raw?.minutes);
    if (saved === null) serverDataError();
    return { minutes: saved };
  }

  async myServerGet(serverId: string): Promise<MyServer> {
    const server = normalizeMyServer(
      await call<unknown>("my_server_get", { serverId }),
    );
    if (!server) serverDataError();
    return server;
  }

  async myServerEvents(serverId: string): Promise<MyServerEvents> {
    const raw = await call<{ events?: unknown; has_more?: unknown }>(
      "my_server_events",
      { serverId },
    );
    if (!raw || !Array.isArray(raw.events)) serverDataError();
    return {
      events: raw.events.flatMap((item): MyServerEvent[] => {
        const event = normalizeMyServerEvent(item);
        return event ? [event] : [];
      }),
      has_more: raw.has_more === true,
    };
  }

  async myServerRename(serverId: string, name: string): Promise<MyServer> {
    const server = normalizeMyServer(
      await call<unknown>("my_server_rename", { serverId, name }),
    );
    if (!server) serverDataError();
    return server;
  }

  async myServerCreate(input: MyServerCreateInput): Promise<MyServerOrder> {
    const order = normalizeMyServerOrder(
      await call<unknown>("my_server_create", {
        region: input.region,
        plan: input.plan,
        idempotencyKey: input.idempotencyKey,
      }),
    );
    if (!order) serverDataError();
    return order;
  }

  async myServerCheckout(orderId: string): Promise<MyServerOrder> {
    // 2.39.0 起返回订单：server_id 写在订单上，不再有 charged_cents。
    const order = normalizeMyServerOrder(
      await call<unknown>("my_server_checkout", { orderId }),
    );
    if (!order) serverDataError();
    return order;
  }

  async myServerCancelOrder(orderId: string): Promise<MyServerOrder> {
    const order = normalizeMyServerOrder(
      await call<unknown>("my_server_cancel_order", { orderId }),
    );
    if (!order) serverDataError();
    return order;
  }

  async myServerOrderGet(orderId: string): Promise<MyServerOrder> {
    const order = normalizeMyServerOrder(
      await call<unknown>("my_server_order_get", { orderId }),
    );
    if (!order) serverDataError();
    return order;
  }

  async myServerRebuild(
    serverId: string,
    confirm: boolean,
  ): Promise<MyServerRebuildResult> {
    const raw = await call<{ newServerId?: unknown; state?: unknown }>(
      "my_server_rebuild",
      { serverId, confirm },
    );
    const newServerId =
      typeof raw?.newServerId === "string" ? raw.newServerId : "";
    const state =
      typeof raw?.state === "string" &&
      MY_SERVER_STATES.has(raw.state as MyServerState)
        ? (raw.state as MyServerState)
        : null;
    if (!newServerId || !state) serverDataError();
    return { newServerId, state };
  }

  async myServerDestroy(serverId: string, confirm: boolean): Promise<MyServer> {
    const server = normalizeMyServer(
      await call<unknown>("my_server_destroy", { serverId, confirm }),
    );
    if (!server) serverDataError();
    return server;
  }

  async myServerCredentials(serverId: string): Promise<MyServerCredentialNode> {
    const raw = await call<{
      server_id?: unknown;
      node_id?: unknown;
      name?: unknown;
      host?: unknown;
      port?: unknown;
      method?: unknown;
    }>("my_server_credentials", { serverId });
    if (
      typeof raw?.server_id !== "string" ||
      typeof raw?.node_id !== "string" ||
      raw.node_id.length === 0 ||
      typeof raw?.name !== "string" ||
      typeof raw?.host !== "string" ||
      typeof raw?.port !== "number" ||
      typeof raw?.method !== "string"
    ) {
      serverDataError();
    }
    return {
      server_id: raw.server_id,
      node_id: raw.node_id,
      name: raw.name,
      host: raw.host,
      port: raw.port,
      method: raw.method,
    };
  }

  /** 智能修复：命令结果原样透传；失败信封由 call 归一化，reason 不改写。 */
  async nodeRotateCredentials(
    serverId: string,
  ): Promise<NodeRotateCredentialsResult> {
    return call<NodeRotateCredentialsResult>("node_rotate_credentials", {
      serverId,
    });
  }

  async myServerRegisterDevice(): Promise<MyServerDeviceIdentity> {
    const raw = await call<{ account_id?: unknown; device_id?: unknown }>(
      "my_server_register_device",
    );
    if (typeof raw?.account_id !== "string" || typeof raw?.device_id !== "string") {
      serverDataError();
    }
    return { account_id: raw.account_id, device_id: raw.device_id };
  }

  async myServerIdentity(): Promise<MyServerIdentity> {
    const raw = await call<{ has_identity?: unknown; account_id?: unknown }>(
      "my_server_identity",
    );
    if (typeof raw?.has_identity !== "boolean") serverDataError();
    const accountId =
      typeof raw.account_id === "string" && raw.account_id.length > 0
        ? raw.account_id
        : null;
    return { has_identity: raw.has_identity, account_id: accountId };
  }

  async myServerLoginStart(email: string): Promise<MyServerLoginTicket> {
    const ticket = normalizeMyServerLoginTicket(
      await call<unknown>("my_server_login_start", { email }),
    );
    if (!ticket) serverDataError();
    return ticket;
  }

  async myServerLoginVerify(email: string, code: string): Promise<MyServerAccount> {
    const account = normalizeMyServerAccount(
      await call<unknown>("my_server_login_verify", { email, code }),
    );
    if (!account) serverDataError();
    return account;
  }

  async myServerAccount(): Promise<MyServerAccount> {
    const account = normalizeMyServerAccount(
      await call<unknown>("my_server_account"),
    );
    if (!account) serverDataError();
    return account;
  }

  async myServerLogout(): Promise<MyServerAccount> {
    const account = normalizeMyServerAccount(
      await call<unknown>("my_server_logout"),
    );
    if (!account) serverDataError();
    return account;
  }

  async myServerWallet(): Promise<MyServerWallet> {
    const wallet = normalizeMyServerWallet(
      await call<unknown>("my_server_wallet"),
    );
    if (!wallet) serverDataError();
    return wallet;
  }

  async myServerTopup(denominationCents: number): Promise<MyServerTopup> {
    const topup = normalizeMyServerTopup(
      await call<unknown>("my_server_topup", { denomination: denominationCents }),
    );
    if (!topup) serverDataError();
    return topup;
  }

  async mobileExportGet(): Promise<MobileExportData> {
    return normalizeMobileExport(await call<unknown>("mobile_export_get"));
  }

  async mobileExportRotate(): Promise<MobileExportData> {
    return normalizeMobileExport(
      await call<unknown>("mobile_export_rotate", { confirm: true }),
    );
  }

  async mobileClientsQr(client: MobileClientId): Promise<MobileClientsQrData> {
    return normalizeMobileClientsQr(
      await call<unknown>("mobile_clients_qr", { client }),
    );
  }

  async pickProfileSavePath(): Promise<string | null> {
    const path = await saveDialog({
      defaultPath: "veyl-profile.json",
      filters: [{ name: t("bridge.profileFileFilter"), extensions: ["json"] }],
    });
    return typeof path === "string" && path.trim() ? path : null;
  }

  async mobileExportSaveFile(path: string): Promise<MobileSaveFileData> {
    return normalizeMobileSaveFile(
      await call<unknown>("mobile_export_save_file", { path }),
    );
  }

  async myServerSshCredentials(
    _serverId: string,
  ): Promise<MyServerSshCredentials> {
    return notWired("activity.servers");
  }

  async netRepair(action: NetRepairAction): Promise<NetRepairResult> {
    const raw = await call<{
      ok?: boolean;
      detail?: string;
      exit_ip?: string | null;
      verified?: boolean;
    }>("net_repair", { action });
    return {
      ok: raw.ok === true,
      action,
      detail: raw.detail ?? "",
      exitIp: raw.exit_ip ?? null,
      verified: raw.verified === true,
    };
  }

  async networkForceReset(): Promise<NetworkForceResetResult> {
    const raw = await call<{
      ok?: boolean;
      verified?: boolean;
      exit_ip?: string | null;
      steps?: Array<{
        id?: string;
        ok?: boolean;
        detail?: string | null;
        status?: string;
      }>;
    }>("network_force_reset");
    return {
      ok: raw.ok === true,
      verified: raw.verified === true,
      exitIp: raw.exit_ip ?? null,
      steps: (raw.steps ?? []).map(normalizeResetStep),
    };
  }

  async coreInfo(): Promise<CoreInfo> {
    return normalizeCoreInfo(await call<RawCoreInfo>("core_info"));
  }

  async coreCheckUpdates(): Promise<CoreCheckUpdatesResult> {
    return normalizeCoreCheck(await call("core_check_updates"));
  }

  async coreUpgrade(version: string): Promise<{ jobId: string }> {
    const raw = await call<{ job_id?: string }>("core_upgrade", { version });
    return { jobId: raw.job_id ?? "" };
  }

  async coreCancelUpgrade(jobId: string): Promise<{ cancelled: boolean }> {
    const raw = await call<{ cancelled?: boolean }>("core_cancel_upgrade", { jobId });
    return { cancelled: raw.cancelled === true };
  }

  async coreRollback(): Promise<void> {
    await call("core_rollback");
  }

  async tunProbe(): Promise<TunProbeData> {
    const raw = await call<{
      conclusion?: string;
      report_path?: string;
      utun?: string[];
      node?: string;
      dns?: string;
      https?: string;
      process?: string;
    }>("tun_probe");
    return {
      conclusion: raw.conclusion ?? "",
      reportPath: raw.report_path ?? "",
      utun: raw.utun ?? [],
      node: raw.node ?? "",
      dns: raw.dns ?? "",
      https: raw.https ?? "",
      process: raw.process ?? "",
    };
  }

  async tunHelperInfo(): Promise<TunHelperInfo> {
    return normalizeHelperInfo(
      await call<{
        running_build?: unknown;
        helper_version?: unknown;
        expected_build?: unknown;
        stale?: unknown;
        state?: unknown;
        needs_admin_restart?: unknown;
      }>("tun_helper_info"),
    );
  }

  async tunHelperRestart(): Promise<TunHelperRestartResult> {
    const raw = await call<{
      ok?: boolean;
      restarted?: boolean;
      needs_admin_restart?: boolean;
    }>("tun_helper_restart");
    return {
      ok: raw.ok === true,
      restarted: raw.restarted === true,
      needsAdminRestart: raw.needs_admin_restart === true,
    };
  }

  async tunHelperOpenSettings(): Promise<void> {
    await call("tun_helper_open_settings");
  }

  async openLogDir(): Promise<void> {
    await call("open_log_dir");
  }

  async issueReportReveal(reportId: string): Promise<ReportActionData> {
    const raw = await call<Partial<ReportActionData>>("issue_report_reveal", { reportId });
    return normalizeReportAction(raw, "reveal");
  }

  async issueReportMail(reportId: string): Promise<ReportActionData> {
    const raw = await call<Partial<ReportActionData>>("issue_report_mail", { reportId });
    return normalizeReportAction(raw, "mail_client");
  }

  async issueReportPreference(includeDomains?: boolean): Promise<IssueReportPreference> {
    const raw = await call<{ includeDomains?: unknown }>(
      "issue_report_preference",
      includeDomains === undefined ? {} : { includeDomains },
    );
    return { includeDomains: raw?.includeDomains === true };
  }

  async openExternal(url: string): Promise<void> {
    // Host 已接 opener；命令本身只允许 DeepSeek 平台域名，前端不做白名单判断。
    await call("open_external", { url });
  }

  async sendMessage(
    sessionId: string,
    text: string | undefined,
    options?: SendMessageOptions,
  ): Promise<{ requestId: string }> {
    const response = await call<{ request_id: string }>("ai_send_message", {
      sessionId,
      ...(text === undefined ? {} : { text }),
      ...(options?.hidden ? { hidden: true } : {}),
      ...(options?.context ? { context: options.context } : {}),
    });
    return { requestId: response.request_id };
  }

  async cancel(requestId: string): Promise<boolean> {
    const raw = await call<{ cancelled?: unknown }>("ai_cancel", { requestId });
    return raw?.cancelled === true;
  }

  /** 首启开场提示词；命令缺失或返回空文本都交给调用方降级（只开面板）。 */
  async aiSessionKickoff(): Promise<{ text: string }> {
    const raw = await call<{ text?: unknown }>("ai_session_kickoff");
    return { text: typeof raw?.text === "string" ? raw.text : "" };
  }

  async getChatHistory(sessionId?: string): Promise<ChatHistory> {
    try {
      const raw = await call<{
        sessions: StoredSessionSummary[];
        active_session_id: string | null;
        messages: StoredChatMessage[];
      }>("chat_history", sessionId ? { sessionId } : undefined);

      return {
        sessions: raw.sessions ?? [],
        activeSessionId: raw.active_session_id ?? null,
        messages: (raw.messages ?? []).map((message) => ({
          ...message,
          tool: readStoredTool((message as { tool?: unknown }).tool),
        })),
      };
    } catch {
      // 读历史失败不该拦住应用启动，降级成「没有历史」。
      return { sessions: [], activeSessionId: null, messages: [] };
    }
  }

  async renameSession(sessionId: string, title: string): Promise<RenamedSession> {    const raw = await call<{ id: string; title: string; created_at: string }>("rename_session", {
      sessionId,
      title,
    });
    const parsed = Date.parse(raw.created_at);
    return {
      id: raw.id,
      title: raw.title,
      createdAt: Number.isFinite(parsed) ? parsed : Date.now(),
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await call("chat_delete", { sessionId });
  }

  async importSeedFile(path: string): Promise<ImportSeedResult> {
    const raw = await call<ImportSeedResult>("import_seed_file", { path });
    return {
      imported: raw.imported ?? 0,
      skipped: raw.skipped ?? [],
      nodes: raw.nodes ?? [],
    };
  }

  async getDeepSeekKey(): Promise<DeepSeekKeyState> {
    try {
      const raw = await call<{ configured: boolean; masked: string | null }>(
        "deepseek_key_status",
      );
      return {
        masked: raw.configured ? raw.masked ?? null : null,
        // 本机存着只能说明「配置过」，是否仍然有效要再验一次才知道。
        verified: false,
        validation: "unverified",
      };
    } catch {
      return { masked: null, verified: false, validation: "unverified" };
    }
  }

  async saveDeepSeekKey(key: string): Promise<DeepSeekKeyState> {
    const raw = await call<{ masked?: string; verified?: boolean }>("deepseek_save_key", { key });
    const verified = raw.verified === true;
    // 只用后端给的 masked，不在前端拼 Key。
    return {
      masked: raw.masked ?? null,
      verified,
      validation: verified ? "ok" : "unverified",
    };
  }

  async clearDeepSeekKey(): Promise<void> {
    await call("deepseek_clear_key");
  }

  async replyUserQuestion(
    sessionId: string,
    questionId: string,
    answer: string,
  ): Promise<void> {
    await call("reply_user_question", { sessionId, questionId, answer });
  }

  async listPendingQuestions(sessionId: string): Promise<PendingQuestion[]> {
    const raw = await call<{ questions?: RawPendingQuestion[] }>("list_pending_questions", {
      sessionId,
    });
    return (raw.questions ?? [])
      .map((item) => {
        const detail = readQuestionDetail(item);
        return {
          questionId: item.question_id ?? "",
          sessionId: item.session_id ?? sessionId,
          requestId: item.request_id ?? "",
          question: item.question ?? "",
          options: item.options ?? [],
          createdAt: item.created_at ?? 0,
          expiresAt: item.expires_at ?? item.created_at ?? 0,
          kind: detail.kind,
          defaultIndex: detail.defaultIndex,
          upgradeConfirm: detail.upgradeConfirm,
          configSetModeConfirm: detail.configSetModeConfirm,
          issueSubmitConfirm: detail.issueSubmitConfirm,
        };
      })
      .filter((item) => item.questionId.length > 0);
  }

  async llmProviderList(): Promise<{
    providers: LlmProvider[];
    activeProviderId: string | null;
  }> {
    const raw = await call<{
      providers?: RawLlmProvider[];
      active_provider_id?: string | null;
    }>("llm_provider_list");
    return {
      providers: (raw.providers ?? []).map(normalizeProvider),
      activeProviderId: raw.active_provider_id ?? null,
    };
  }

  async llmProviderSave(input: LlmProviderInput): Promise<LlmProvider> {
    // 扁平 camelCase 参数：Tauri 会转成 Rust 的 snake_case 形参；嵌套对象不转。
    const args: Record<string, unknown> = {
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      model: input.model,
    };
    if (input.providerId) args.providerId = input.providerId;
    // 空 Key 表示「沿用已存的」：省略而不是传空串，避免覆盖。
    if (input.apiKey.trim()) args.apiKey = input.apiKey;
    const raw = await call<RawLlmProvider>("llm_provider_save", args);
    return normalizeProvider(raw);
  }

  async llmProviderDelete(providerId: string): Promise<void> {
    await call("llm_provider_delete", { providerId });
  }

  async llmProviderActivate(providerId: string): Promise<void> {
    await call("llm_provider_activate", { providerId });
  }

  async llmProviderTest(input: LlmProviderInput): Promise<LlmProviderTestResult> {
    const args: Record<string, unknown> = {
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      model: input.model,
    };
    if (input.providerId) args.providerId = input.providerId;
    if (input.apiKey.trim()) args.apiKey = input.apiKey;
    const raw = await call<{
      ok?: boolean;
      latency_ms?: number | null;
      error?: string | null;
    }>("llm_provider_test", args);
    return {
      ok: raw.ok === true,
      latencyMs: raw.latency_ms ?? null,
      error: raw.error ?? undefined,
    };
  }

  dispose(): void {
    this.manager.dispose();
    this.listeners.clear();
  }
}

/** 供调试面板展示：当前订阅的事件名。 */
export const SUBSCRIBED_EVENTS = EVENT_NAMES;
export { AGENT_EVENTS };
