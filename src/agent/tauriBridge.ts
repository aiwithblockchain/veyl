import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentBridge,
  ChatHistory,
  ConfigActivateResult,
  ConfigCreateInput,
  ConfigDeleteData,
  ConfigListData,
  CoreCheckUpdatesResult,
  CoreInfo,
  DeepSeekKeyState,
  DefaultProfileStatus,
  ImportSeedResult,
  IssueReportPreference,
  LlmProvider,
  LlmProviderInput,
  LlmProviderTestResult,
  NetRepairAction,
  NetRepairResult,
  NetworkForceResetResult,
  NetworkForceResetStep,
  NetworkResetStepStatus,
  NodeProbeAllData,
  NodeProbeResult,
  NodeProbeRun,
  NodeProbeSnapshotData,
  NodeSwitchResult,
  PendingQuestion,
  ReportActionData,
  ProxyPortSaveResult,
  ProxyPortSettings,
  RenamedSession,
  StoredChatMessage,
  StoredSessionSummary,
  TunHelperInfo,
  TunHelperRestartResult,
  TunHelperState,
  TunProbeData,
} from "./bridge";
import { DEFAULT_PROXY_PORT, readQuestionDetail } from "./bridge";
import { toBridgeError } from "./errors";
import { createListenerManager } from "./listeners";
import { AGENT_EVENTS, APP_EVENT_NAMES, AI_EVENT_NAMES } from "./protocol";
import type {
  AgentEvent,
  Category,
  ConfigDetail,
  ConfigRouteMode,
  NodeCreateInput,
  NodeImportResult,
  NodeImportSkipped,
  NodeSummary,
  RouteSetModeData,
  RouteState,
  RuntimeSnapshot,
  SystemRegion,
} from "./protocol";

const EVENT_NAMES = [...AI_EVENT_NAMES, ...APP_EVENT_NAMES];

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
    // 未知方式按 tcp：只有在明确 clash 时才允许写「可用」。
    method: raw.method === "clash" ? "clash" : "tcp",
  };
}

function normalizeProbeResult(raw: unknown): NodeProbeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as {
    node_id?: unknown;
    reachable?: unknown;
    latency_ms?: unknown;
    probe_method?: unknown;
    checked_at?: unknown;
    error?: unknown;
  };
  if (typeof value.node_id !== "string" || value.node_id.length === 0) return null;
  const error =
    value.error && typeof value.error === "object"
      ? {
          code:
            typeof (value.error as { code?: unknown }).code === "string"
              ? ((value.error as { code: string }).code)
              : "",
          message:
            typeof (value.error as { message?: unknown }).message === "string"
              ? ((value.error as { message: string }).message)
              : "",
        }
      : null;
  return {
    node_id: value.node_id,
    reachable: value.reachable === true,
    latency_ms:
      typeof value.latency_ms === "number" && Number.isFinite(value.latency_ms)
        ? value.latency_ms
        : null,
    // 未知探测方式按 TCP 处理：界面只用来区分「真实可用性」，不展示方式。
    probe_method: value.probe_method === "clash_delay" ? "clash_delay" : "tcp",
    checked_at: typeof value.checked_at === "number" ? value.checked_at : 0,
    error,
  };
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
    name: raw.name ?? "未命名",
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
          const payload = event.payload as AgentEvent["payload"];
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

  async runtimeStart(configId?: string): Promise<void> {
    await call("runtime_start", configId ? { configId } : undefined);
  }

  async runtimeStop(): Promise<void> {
    await call("runtime_stop");
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

  async configDelete(configId: string): Promise<ConfigDeleteData> {
    return call<ConfigDeleteData>("config_delete", { configId });
  }

  async configActivate(
    configId: string,
    confirmDisconnect = false,
  ): Promise<ConfigActivateResult> {
    return call<ConfigActivateResult>("config_activate", {
      configId,
      ...(confirmDisconnect ? { confirmDisconnect: true } : {}),
    });
  }

  async nodeSwitch(configId: string, nodeId: string): Promise<NodeSwitchResult> {
    return call<NodeSwitchResult>("node_switch", { configId, nodeId });
  }

  async nodeProbe(nodeId: string): Promise<NodeProbeResult> {
    return call<NodeProbeResult>("node_probe", { nodeId });
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
      throw { code: "INTERNAL", message: "后端返回的节点缺少标识", details: null };
    }
    return node;
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
      filters: [{ name: "节点文件", extensions: ["txt", "json"] }],
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
    text: string,
    options?: { hidden?: boolean },
  ): Promise<{ requestId: string }> {
    const response = await call<{ request_id: string }>("ai_send_message", {
      sessionId,
      text,
      ...(options?.hidden ? { hidden: true } : {}),
    });
    return { requestId: response.request_id };
  }

  async cancel(requestId: string): Promise<boolean> {
    const raw = await call<{ cancelled?: unknown }>("ai_cancel", { requestId });
    return raw?.cancelled === true;
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
          upgradeConfirm: detail.upgradeConfirm,
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
