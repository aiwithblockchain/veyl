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
  LlmProvider,
  LlmProviderInput,
  LlmProviderTestResult,
  NetRepairAction,
  NetRepairResult,
  NetworkForceResetResult,
  NodeProbeResult,
  NodeSwitchResult,
  RenamedSession,
  TunHelperInfo,
  TunHelperRestartResult,
  TunHelperState,
  TunProbeData,
} from "./bridge";
import { isLocalEndpoint, maskKey } from "./bridge";
import { AGENT_EVENTS, CONTRACT_VERSION } from "./protocol";
import type {
  AgentEvent,
  AiStatusPhase,
  ConfigDetail,
  NextAction,
  RuntimeSnapshot,
  RuntimeState,
  ToolPermissionLevel,
} from "./protocol";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const CHUNK_INTERVAL = 16;

/** 浏览器演示用的行为开关；Tauri 通道不读这些值。 */
function mockFlag(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

const HELPER_STATES: TunHelperState[] = [
  "running",
  "not_running",
  "stale",
  "start_failed",
  "file_invalid",
];

/** mock 通道固定出口 IP，方便自动化断言。 */
export const MOCK_EXIT_IP = "203.0.113.7";
/** 直连出口：与代理出口不同，面板才能看出代理真的生效。 */
export const MOCK_DIRECT_IP = "198.51.100.9";

function splitForStreaming(text: string): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += 2) out.push(chars.slice(i, i + 2).join(""));
  return out;
}

/**
 * 脚本化事件源：事件名与字段完全按 `docs/contracts/events.md` v1.0.4，
 * Host 接进来后把 bridge 换成 tauriBridge 即可，组件不用改。
 */
interface MockNodeEntry {
  id: string;
  name: string;
  protocol: string;
  region: string | null;
  createdAt: string;
  nodeId: string | null;
}

export class MockAgentBridge implements AgentBridge {
  readonly mode = "mock" as const;

  constructor() {
    // 刷新页面相当于重启 App：上一次装好的版本到这里才真正生效。
    const installed = mockFlag("veyl.mock.core.installed");
    if (installed) {
      this.coreActiveSource = "installed";
      this.coreActiveVersion = installed;
      this.coreRestartRequired = false;
    }
  }

  private listeners = new Set<(event: AgentEvent) => void>();
  private cancelled = new Set<string>();
  private activeRequests = new Set<string>();
  private healthTimer: number | null = null;
  private trafficUp = 0;
  private trafficDown = 0;
  private trafficTick = 0;
  /** mock 的节点目录：让控制台与面板的节点切换可以离线演示。 */
  private profiles: MockNodeEntry[] = [
    {
      id: "prf_1",
      name: "东京 01",
      protocol: "shadowsocks",
      region: "日本",
      createdAt: "2026-11-01T08:00:00.000Z",
      nodeId: null,
    },
    {
      id: "prf_2",
      name: "新加坡 02",
      protocol: "shadowsocks",
      region: "新加坡",
      createdAt: "2026-11-01T09:00:00.000Z",
      nodeId: "seed-sg-02",
    },
  ];
  private coreBundledVersion = "1.14.4";
  private coreActiveVersion = "1.14.4";
  private coreActiveSource: "bundled" | "installed" = "bundled";
  private coreRestartRequired = false;
  private coreJob: { id: string; cancelled: boolean; origin?: "ui" | "agent" | null } | null = null;
  /** 对话发起的升级确认：回答「升级」后才真正开始任务。 */
  private pendingUpgradeQuestion: { id: string; version: string } | null = null;
  /** 演示「检查并更新」成功后，后台组件回到 running。 */
  private helperState: TunHelperState | null = null;
  private runtime: RuntimeSnapshot = {
    contract_version: CONTRACT_VERSION,
    state: "idle",
    mode: "system_proxy",
    pid: null,
    upstream_version: null,
    uptime_seconds: null,
    config_id: null,
    config_name: null,
    node_id: null,
    node_name: null,
    config_hash: null,
    system_proxy_enabled: false,
    health: {
      contract_version: CONTRACT_VERSION,
      process: false,
      clash_api: false,
      data_plane: false,
      exit_ip: null,
      consecutive_failures: 0,
      checked_at: now(),
    },
    traffic: null,
    connections: null,
    restart_count: 0,
    last_error: null,
    last_transition_at: now(),
    mixed_port: null,
    connected_since: null,
    latency_ms: null,
    node_latency_ms: null,
    applied_route_revision: null,
    direct_ip: MOCK_DIRECT_IP,
  };

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getRuntimeSnapshot(): Promise<RuntimeSnapshot | null> {
    return this.runtime;
  }

  async runtimeStart(configId?: string): Promise<void> {
    const profile =
      this.profiles.find((item) => item.id === configId) ??
      this.profiles.find((item) => item.id === this.runtime.config_id) ??
      this.profiles[0];
    if (!profile) {
      throw { code: "PRECONDITION_FAILED", message: "还没有可用的节点" };
    }

    const switching = this.runtime.state === "running" || this.runtime.state === "degraded";
    this.transition(switching ? "restarting" : "starting", switching ? "restart_req" : "start_req", {
      config_id: profile.id,
      config_name: profile.name,
      node_id: profile.id,
      node_name: profile.name,
      connected_since: null,
      latency_ms: null,
    });

    await sleep(switching ? 1400 : 1000);
    this.health({
      process: true,
      clash_api: true,
      data_plane: true,
      exit_ip: MOCK_EXIT_IP,
      consecutive_failures: 0,
    });
    this.transition("running", "process_ready", {
      pid: 48213,
      uptime_seconds: 0,
      config_id: profile.id,
      config_name: profile.name,
      node_id: profile.id,
      node_name: profile.name,
      mixed_port: 2080,
      connected_since: now(),
      latency_ms: profile.id === "prf_2" ? 68 : 42,
      node_latency_ms: profile.id === "prf_2" ? 68 : 42,
      direct_ip: MOCK_DIRECT_IP,
      system_proxy_enabled: true,
      connections: 2,
    });
  }

  async runtimeStop(): Promise<void> {
    if (this.runtime.state === "idle") return;
    this.transition("stopping", "stop_req");
    await sleep(700);
    this.health({ process: false, clash_api: false, data_plane: false, exit_ip: null });
    this.transition("idle", "stopped", {
      pid: null,
      uptime_seconds: null,
      config_id: null,
      config_name: null,
      node_id: null,
      node_name: null,
      mixed_port: null,
      connected_since: null,
      latency_ms: null,
      system_proxy_enabled: false,
      connections: null,
    });
  }

  private defaultProfile: DefaultProfileStatus = {
    packageId: "pkg_demo",
    version: "2026.11.1",
    appliedAt: "2026-11-01T00:00:00.000Z",
    newVersionAvailable: false,
    nodeCount: this.profiles.length,
  };

  async defaultProfileStatus(): Promise<DefaultProfileStatus> {
    return { ...this.defaultProfile, nodeCount: this.profiles.length };
  }

  async defaultProfileRefresh(): Promise<DefaultProfileStatus> {
    await sleep(900);
    const next: DefaultProfileStatus = {
      packageId: "pkg_demo",
      version: "2026.11.2",
      appliedAt: now(),
      // 模拟「刷新拿到新包，但下次连接才生效」。
      newVersionAvailable: this.defaultProfile.version !== "2026.11.2",
      nodeCount: this.profiles.length,
    };
    this.defaultProfile = next;
    return { ...next };
  }

  async netRepair(action: NetRepairAction): Promise<NetRepairResult> {
    await sleep(600);
    if (action === "restore_direct") {
      await this.runtimeStop();
      return {
        ok: true,
        action,
        detail: "已撤销系统代理并停止运行时，网络恢复直连。",
        exitIp: MOCK_DIRECT_IP,
        verified: true,
      };
    }
    return { ok: true, action, detail: "已刷新本地 DNS 缓存。", exitIp: null, verified: true };
  }

  async networkForceReset(): Promise<NetworkForceResetResult> {
    // 真实链路要等 helper 与系统命令，留出一段可见的等待态。
    await sleep(1600);
    await this.runtimeStop();
    const steps = [
      ["stop_tun", "接管未在运行"],
      ["stop_runtime", "代理模式已停止"],
      ["restore_proxy", "系统代理未指向 Veyl"],
      ["sweep_processes", "没有 Veyl 的 sing-box 残留"],
      ["clear_routes", "没有指向已消失 utun 的分流路由"],
      ["flush_dns", "DNS 缓存已刷新，探针域名可解析"],
      ["clear_plaintext", "已清理 0 个明文配置，没有残留的运行记录"],
      ["verify", "代理、路由、DNS 和组件都符合预期"],
    ] as const;
    return {
      ok: true,
      verified: true,
      exitIp: MOCK_DIRECT_IP,
      steps: steps.map(([id, detail]) => ({ id, ok: true, detail, status: "ok" as const })),
    };
  }

  async coreInfo(): Promise<CoreInfo> {
    await sleep(200);
    if (mockFlag("veyl.mock.core.missing") === "1") {
      throw new Error("Command core_info not found");
    }
    return {
      bundledVersion: this.coreBundledVersion,
      activeVersion: this.coreActiveVersion,
      activeSource: this.coreActiveSource,
      restartRequired: this.coreRestartRequired,
    };
  }

  async coreCheckUpdates(): Promise<CoreCheckUpdatesResult> {
    await sleep(mockFlag("veyl.mock.core.slow") === "1" ? 4000 : 900);
    const forced = mockFlag("veyl.mock.core.check");
    if (forced === "unreachable") {
      return { network: "unreachable", candidates: [], cached: false };
    }
    if (forced === "source_error") {
      return { network: "source_error", candidates: [], cached: false };
    }
    if (forced === "cached") {
      // 联网失败但有上次成功验签的缓存：candidates 非空，不能当实时结果。
      return {
        network: "unreachable",
        candidates: [{ version: "1.15.0", size: 12 * 1024 * 1024 }],
        cached: true,
        message: "连不上更新服务器，显示上次检查的结果。",
      };
    }
    if (forced === "none" || mockFlag("veyl.mock.core.installed")) {
      return { network: "ok", candidates: [], cached: false };
    }
    return {
      network: "ok",
      candidates: [{ version: "1.15.0", size: 12 * 1024 * 1024 }],
      cached: false,
    };
  }

  async coreUpgrade(version: string): Promise<{ jobId: string }> {
    const job = { id: `core_${Date.now()}`, cancelled: false, origin: null };
    this.coreJob = job;
    const mode = mockFlag("veyl.mock.core.upgrade");
    void this.runMockUpgrade(job, version, mode, null);
    return { jobId: job.id };
  }

  async coreCancelUpgrade(jobId: string): Promise<{ cancelled: boolean }> {
    const cancelled = this.coreJob?.id === jobId;
    const origin = this.coreJob?.origin ?? null;
    if (cancelled && this.coreJob) {
      this.coreJob.cancelled = true;
      this.coreJob = null;
    }
    await sleep(150);
    // 真机取消也会发一条 ok:false 的结束事件；这里保持同一形状。
    if (cancelled) this.emitCoreFinished(jobId, false, null, null, origin);
    return { cancelled };
  }

  async coreRollback(): Promise<void> {
    await sleep(700);
    try {
      localStorage.removeItem("veyl.mock.core.installed");
    } catch {
      // 浏览器存储不可用时只影响演示。
    }
    this.coreActiveSource = "bundled";
    this.coreActiveVersion = this.coreBundledVersion;
    // 新语义：restart_required 只表示确实需要重启 App；普通生效靠断开重连或下次连接。
    this.coreRestartRequired = mockFlag("veyl.mock.core.restart") === "1";
  }

  async tunProbe(): Promise<TunProbeData> {
    if (this.runtime.state !== "running" && this.runtime.state !== "degraded") {
      throw { code: "PRECONDITION_FAILED", message: "还没有连接，先连接后再执行诊断" };
    }
    // 真实链路要跑路由表与几轮网络探测，留出可见的等待态。
    const mode = mockFlag("veyl.mock.tun.probe");
    await sleep(mode === "slow" ? 6000 : 2200);
    if (mode === "fail") {
      throw { code: "INTERNAL", message: "采集诊断失败：读取路由表超时" };
    }
    const node = this.runtime.node_name ?? "节点";
    const stamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[-:]/g, "")
      .replace("T", "-");
    return {
      conclusion: "隧道与出站均正常",
      reportPath: `~/.veyl/diagnostics/tun-${stamp}.txt`,
      utun: ["utun7 198.18.0.1/16 路由=3 关键段=0/1,128/1,16/4,32/3"],
      node: `${node} 可直连（42ms）`,
      dns: "www.apple.com → 203.0.113.10（18ms）",
      https: "HTTP 200（236ms）",
      process: `pid=${this.runtime.pid ?? 4812} 存活=true since=${this.runtime.connected_since ?? now()}`,
    };
  }

  async tunHelperInfo(): Promise<TunHelperInfo> {
    await sleep(220);
    const mode = mockFlag("veyl.mock.helper");
    if (mode === "missing") {
      throw new Error("Command tun_helper_info not found");
    }
    const active = this.runtime.state === "running" || this.runtime.state === "degraded";
    const forced = HELPER_STATES.find((item) => item === mode) ?? null;
    const state: TunHelperState = this.helperState ?? forced ?? (active ? "running" : "not_running");
    return {
      runningBuild: state === "running" ? "2026.11.1" : state === "stale" ? "2026.10.2" : null,
      expectedBuild: "2026.11.1",
      stale: state === "stale",
      state,
      needsAdminRestart: mockFlag("veyl.mock.helper.admin") === "1",
    };
  }

  async tunHelperRestart(): Promise<TunHelperRestartResult> {
    await sleep(1200);
    const mode = mockFlag("veyl.mock.helper");
    if (mode === "missing") {
      throw new Error("Command tun_helper_restart not found");
    }
    if (mode === "busy") {
      throw {
        code: "PRECONDITION_FAILED",
        retryable: true,
        message: "后台组件正在准备",
        details: { reason: "helper_busy" },
      };
    }
    if (mode === "deny") {
      throw { code: "AUTH_DENIED", message: "用户拒绝管理员授权" };
    }
    if (mode === "fail") {
      throw { code: "HELPER_INSTALL_FAILED", message: "后台组件安装失败" };
    }
    this.helperState = "running";
    return {
      ok: true,
      restarted: true,
      needsAdminRestart: mockFlag("veyl.mock.helper.admin") === "1",
    };
  }

  private async runMockUpgrade(
    job: { id: string; cancelled: boolean },
    version: string,
    mode: string | null,
    origin: "ui" | "agent" | null,
  ) {
    const slow = mockFlag("veyl.mock.core.slow");
    const stepDelay = slow === "2" ? 600 : slow === "1" ? 200 : 80;
    const phaseDelay = slow === "2" ? 5000 : slow === "1" ? 2500 : 700;
    const total = 12 * 1024 * 1024;
    const steps = 24;
    for (let i = 1; i <= steps; i += 1) {
      await sleep(stepDelay);
      if (job.cancelled) return;
      this.emitCoreProgress(job.id, "download", Math.round((total * i) / steps), total, origin);
    }
    if (job.cancelled) return;
    this.emitCoreProgress(job.id, "verify", 0, null, origin);
    await sleep(phaseDelay);
    if (job.cancelled) return;
    if (mode === "fail") {
      this.emitCoreFinished(job.id, false, "CHECKSUM_MISMATCH", null, origin);
      return;
    }
    this.emitCoreProgress(job.id, "install", 0, null, origin);
    await sleep(phaseDelay);
    if (job.cancelled) return;
    try {
      localStorage.setItem("veyl.mock.core.installed", version);
    } catch {
      // 浏览器存储不可用时只影响演示。
    }
    this.coreActiveSource = "installed";
    this.coreActiveVersion = version;
    this.coreRestartRequired = mockFlag("veyl.mock.core.restart") === "1";
    this.emitCoreFinished(job.id, true, null, version, origin);
  }

  private emitCoreProgress(
    jobId: string,
    phase: string,
    received: number,
    total: number | null,
    origin: "ui" | "agent" | null,
  ) {
    this.emit({
      name: AGENT_EVENTS.coreUpgradeProgress,
      payload: {
        contract_version: CONTRACT_VERSION,
        job_id: jobId,
        phase,
        received,
        total,
        origin,
        emitted_at: now(),
      },
    });
  }

  private emitCoreFinished(
    jobId: string,
    ok: boolean,
    code: string | null,
    version: string | null,
    origin: "ui" | "agent" | null,
  ) {
    this.emit({
      name: AGENT_EVENTS.coreUpgradeFinished,
      payload: {
        contract_version: CONTRACT_VERSION,
        job_id: jobId,
        ok,
        code,
        version,
        origin,
        emitted_at: now(),
      },
    });
  }

  async openLogDir(): Promise<void> {
    // 浏览器通道没有文件管理器；mock 里视为成功。
  }

  async openExternal(_url: string): Promise<void> {
    // 浏览器通道没有系统浏览器调用能力；mock 里视为成功。
  }

  private emit(event: AgentEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private transition(
    to: RuntimeState,
    event: "start_req" | "process_ready" | "stop_req" | "stopped" | "restart_req",
    patch: Partial<RuntimeSnapshot> = {},
  ) {
    const from = this.runtime.state;
    this.runtime = { ...this.runtime, ...patch, state: to, last_transition_at: now() };
    this.emit({
      name: AGENT_EVENTS.runtimeStateChanged,
      payload: {
        contract_version: CONTRACT_VERSION,
        from,
        to,
        event,
        pid: this.runtime.pid,
        upstream_version: this.runtime.upstream_version,
        reason: null,
        error: null,
        snapshot: this.runtime,
        emitted_at: now(),
      },
    });

    if (to === "running" || to === "degraded") this.startTrafficTicker();
    else this.stopTrafficTicker();
  }

  private health(patch: Partial<RuntimeSnapshot["health"]>) {
    this.runtime = {
      ...this.runtime,
      health: { ...this.runtime.health, ...patch, checked_at: now() },
    };
    this.emit({
      name: AGENT_EVENTS.runtimeHealthChanged,
      payload: {
        contract_version: CONTRACT_VERSION,
        health: this.runtime.health,
        ...(this.runtime.state === "running" || this.runtime.state === "degraded"
          ? {
              traffic: this.runtime.traffic,
              connections: this.runtime.connections,
              node_latency_ms: this.runtime.node_latency_ms,
            }
          : {}),
        emitted_at: now(),
      },
    });
  }

  /**
   * 浏览器演示用：连接后每 2 秒发一条带流量的健康事件，
   * 让「最近 60 秒」速率条在 mock 环境里也有数据。
   */
  private startTrafficTicker() {
    this.stopTrafficTicker();
    this.trafficUp = 4_200_000;
    this.trafficDown = 38_000_000;
    const tick = () => {
      if (this.runtime.state !== "running" && this.runtime.state !== "degraded") return;
      this.trafficTick += 1;
      const up = 240_000 + Math.round(180_000 * Math.abs(Math.sin(this.trafficTick / 2.6)));
      const down =
        1_800_000 + Math.round(1_500_000 * Math.abs(Math.sin(this.trafficTick / 3.1)));
      this.trafficUp += up * 2;
      this.trafficDown += down * 2;
      this.runtime = {
        ...this.runtime,
        connections: 4,
        traffic: {
          up_bytes: this.trafficUp,
          down_bytes: this.trafficDown,
          up_rate: up,
          down_rate: down,
          sampled_at: now(),
        },
      };
      this.health({});
    };
    tick();
    this.healthTimer = window.setInterval(tick, 2000);
  }

  private stopTrafficTicker() {
    if (this.healthTimer !== null) {
      window.clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async firstRunFlow(
    sessionId: string,
    requestId: string,
    assistantId: string,
  ) {
    this.status(requestId, assistantId, "准备配置", "thinking");
    const question = "先配一条能用的线路。你主要用它做什么？";
    if (!(await this.type(requestId, assistantId, question))) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }
    // 先结束这一轮再提问：前端在 requestEnd 时会把同一 request 的旧问题清掉。
    this.finish(requestId, assistantId, "success", question);
    this.emit({
      name: AGENT_EVENTS.askUserQuestion,
      payload: {
        contract_version: CONTRACT_VERSION,
        session_id: sessionId,
        request_id: requestId,
        question_id: `q_${requestId}`,
        question,
        options: ["只浏览网页", "桌面软件也要用", "我自己会配代理"],
        created_at: Date.now(),
        expires_at: Date.now() + 300_000,
        emitted_at: now(),
      },
    });
  }

  private base(requestId: string, assistantId: string) {
    return {
      contract_version: CONTRACT_VERSION,
      request_id: requestId,
      assistant_message_id: assistantId,
    };
  }

  private async type(requestId: string, assistantId: string, text: string) {
    for (const piece of splitForStreaming(text)) {
      if (this.cancelled.has(requestId)) return false;
      this.emit({
        name: AGENT_EVENTS.messageChunk,
        payload: { ...this.base(requestId, assistantId), chunk: piece, emitted_at: now() },
      });
      await sleep(CHUNK_INTERVAL);
    }
    return true;
  }

  private async think(requestId: string, assistantId: string, text: string) {
    for (const piece of splitForStreaming(text)) {
      if (this.cancelled.has(requestId)) return false;
      this.emit({
        name: AGENT_EVENTS.thinkingChunk,
        payload: { ...this.base(requestId, assistantId), chunk: piece, emitted_at: now() },
      });
      await sleep(CHUNK_INTERVAL);
    }
    return true;
  }

  private status(requestId: string, assistantId: string, text: string, phase: AiStatusPhase) {
    if (this.cancelled.has(requestId)) return false;
    this.emit({
      name: AGENT_EVENTS.status,
      payload: { ...this.base(requestId, assistantId), phase, text, emitted_at: now() },
    });
    return true;
  }

  private async tool(
    requestId: string,
    assistantId: string,
    tool: string,
    action: string,
    durationMs: number,
    result: string,
    options: {
      permissionLevel?: ToolPermissionLevel;
      argsPreview?: Record<string, unknown>;
      nextActions?: NextAction[];
      errorCode?: string | null;
    } = {},
  ) {
    if (this.cancelled.has(requestId)) return false;
    const toolCallId = `call_${tool.toLowerCase()}_${Math.random().toString(36).slice(2, 7)}`;

    this.emit({
      name: AGENT_EVENTS.toolCallStart,
      payload: {
        ...this.base(requestId, assistantId),
        tool_call_id: toolCallId,
        tool,
        action,
        permission_level: options.permissionLevel ?? "read_only",
        source: "agent",
        args_preview: options.argsPreview,
        emitted_at: now(),
      },
    });

    await sleep(durationMs);
    const cancelled = this.cancelled.has(requestId);
    this.emit({
      name: AGENT_EVENTS.toolCallEnd,
      payload: {
        ...this.base(requestId, assistantId),
        tool_call_id: toolCallId,
        tool,
        success: !cancelled && !options.errorCode,
        result: cancelled ? "已取消" : result,
        result_truncated: false,
        error_code: (cancelled ? "CANCELLED" : options.errorCode ?? null) as
          | "CANCELLED"
          | null,
        duration_ms: durationMs,
        next_actions: cancelled ? [] : options.nextActions ?? [],
        emitted_at: now(),
      },
    });
    return !cancelled;
  }

  private finish(
    requestId: string,
    assistantId: string,
    result: "success" | "error" | "cancelled",
    finalText: string | null,
    errorText?: string,
  ) {
    this.activeRequests.delete(requestId);
    this.emit({
      name: AGENT_EVENTS.requestEnd,
      payload: {
        ...this.base(requestId, assistantId),
        result,
        final_text: finalText,
        error:
          result === "error"
            ? {
                contract_version: CONTRACT_VERSION,
                code: "UPSTREAM_ERROR",
                message: errorText ?? "请求失败",
                retryable: true,
                details: null,
                request_id: requestId,
              }
            : null,
        usage:
          result === "success"
            ? {
                input_tokens: 1842,
                output_tokens: 316,
                cache_read_tokens: null,
                cache_write_tokens: null,
              }
            : null,
        duration_ms: 4200,
        emitted_at: now(),
      },
    });
  }

  async sendMessage(
    sessionId: string,
    text: string,
    _options?: { hidden?: boolean },
  ): Promise<{ requestId: string }> {
    // 浏览器 mock 不落历史，hidden 与普通消息没有区别。
    const requestId = `req_${Math.random().toString(36).slice(2, 10)}`;
    const assistantId = `asst_${requestId}`;
    this.cancelled.delete(requestId);
    this.activeRequests.add(requestId);

    void this.run(sessionId, requestId, assistantId, text);
    return { requestId };
  }

  private async run(sessionId: string, requestId: string, assistantId: string, text: string) {
    if (text.includes("第一次用")) return this.firstRunFlow(sessionId, requestId, assistantId);
    if (text.includes("断开")) return this.disconnectFlow(requestId, assistantId);
    if (text.includes("状态")) return this.statusFlow(requestId, assistantId);
    if (
      text.includes("升级运行时") ||
      text.includes("更新运行时") ||
      text.includes("升级后台运行库")
    ) {
      return this.upgradeConfirmFlow(sessionId, requestId, assistantId);
    }
    if (text.includes("安装") || text.includes("版本")) {
      return this.runtimeVersionFlow(requestId, assistantId);
    }
    if (/key/i.test(text)) return this.saveKeyFlow(requestId, assistantId);

    if (!this.status(requestId, assistantId, "正在理解你的意图", "thinking")) return;
    if (
      !(await this.think(
        requestId,
        assistantId,
        "用户想连到日本。先确认本地运行时是否就绪，再查节点目录。",
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }

    this.status(requestId, assistantId, "检查 sing-box 运行时", "preparing_tool");
    if (
      !(await this.tool(
        requestId,
        assistantId,
        "CoreListVersions",
        "查询可用版本",
        640,
        "随包 1.14.4（active）",
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }

    if (
      !(await this.tool(
        requestId,
        assistantId,
        "CatalogSearch",
        "region=jp, limit=10",
        880,
        "找到 1 个节点：东京 01（42ms）。",
        { argsPreview: { region: "jp", limit: 10 } },
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }

    if (
      !(await this.tool(
        requestId,
        assistantId,
        "VpnConnect",
        "连接 seed-jp-01",
        1500,
        "已连接到 东京 01，出口 IP 203.0.113.7，延迟 42ms。",
        {
          permissionLevel: "execute",
          argsPreview: { node_id: "seed-jp-01", strategy: "latency" },
          nextActions: [{ label: "断开连接", tool: "VpnDisconnect", args: {} }],
        },
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }

    // 先写健康快照再切状态：状态变更会触发 UI 重拉 runtime_status，
    // 反过来的话快照里 exit_ip 还是旧值，面板会短暂显示「未知」。
    this.health({
      process: true,
      clash_api: true,
      data_plane: true,
      exit_ip: MOCK_EXIT_IP,
      consecutive_failures: 0,
    });
    this.transition("running", "process_ready", {
      pid: 48213,
      uptime_seconds: 1,
      config_id: "prf_1",
      config_name: "东京 01",
      node_id: "prf_1",
      node_name: "东京 01",
      mixed_port: 2080,
      connected_since: now(),
      latency_ms: 42,
      node_latency_ms: 42,
      direct_ip: MOCK_DIRECT_IP,
      system_proxy_enabled: true,
      connections: 3,
    });

    const reply = `已连接到「东京 01」，出口 IP ${MOCK_EXIT_IP}，系统代理已生效。要换节点随时说。`;
    await this.type(requestId, assistantId, reply);
    this.finish(requestId, assistantId, "success", reply);
  }

  // 演示「全字段被脱敏 → 整个 args_preview 省略」：卡片上不出现参数行。
  private async saveKeyFlow(requestId: string, assistantId: string) {
    this.status(requestId, assistantId, "保存 Key", "preparing_tool");
    if (
      !(await this.tool(
        requestId,
        assistantId,
        "DeepseekSaveKey",
        "保存到本机",
        520,
        "Key 已保存到本机，并验证可用。",
        { permissionLevel: "write", argsPreview: undefined },
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }
    const reply = "Key 已经保存在本机了，之后不会再让你输入。";
    await this.type(requestId, assistantId, reply);
    this.finish(requestId, assistantId, "success", reply);
  }

  private async statusFlow(requestId: string, assistantId: string) {
    this.status(requestId, assistantId, "读取运行时状态", "preparing_tool");
    const running = this.runtime.state === "running";
    const summary = running
      ? `运行中，sing-box ${this.runtime.upstream_version}，出口 ${this.runtime.health.exit_ip}`
      : "未运行";
    if (!(await this.tool(requestId, assistantId, "RuntimeStatus", "查询状态", 380, summary))) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }
    const reply = running
      ? `当前已连接，出口 IP ${this.runtime.health.exit_ip}，本地代理监听 127.0.0.1:${this.runtime.mixed_port ?? "未知"}。`
      : "当前没有连接。要连的话直接说地区，例如「连到日本」。";
    await this.type(requestId, assistantId, reply);
    this.finish(requestId, assistantId, "success", reply);
  }

  /**
   * 运行时版本只读查询。安装/升级是 UI 专用路径（设置 › 高级 › 运行时），
   * 模型没有对应工具，mock 也不能演示成 AI 能装。
   */
  private async runtimeVersionFlow(requestId: string, assistantId: string) {
    this.status(requestId, assistantId, "查询运行时版本", "preparing_tool");

    if (
      !(await this.tool(
        requestId,
        assistantId,
        "CoreListVersions",
        "查询可用版本",
        640,
        "随包 1.14.4（active）",
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }

    const reply =
      "运行时随 Veyl 一起提供，我这边只能查看版本。要检查更新，去「设置 › 高级 › 运行时」。";
    await this.type(requestId, assistantId, reply);
    this.finish(requestId, assistantId, "success", reply);
  }

  /** 对话代劳升级：先出确认卡，用户点「升级」后才真正开始任务。 */
  private async upgradeConfirmFlow(
    sessionId: string,
    requestId: string,
    assistantId: string,
  ) {
    this.status(requestId, assistantId, "检查可用版本", "preparing_tool");
    if (
      !(await this.tool(
        requestId,
        assistantId,
        "CoreListVersions",
        "查询可用版本",
        640,
        `随包 ${this.coreBundledVersion}（active）`,
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }

    const target = this.coreActiveVersion === "1.15.0" ? "1.15.1" : "1.15.0";
    const size = 12 * 1024 * 1024;
    const question = `发现新版本 ${target}（约 12 MB）。要我帮你更新后台运行库吗？`;
    if (!(await this.type(requestId, assistantId, question))) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }
    this.finish(requestId, assistantId, "success", question);

    const questionId = `q_${requestId}`;
    this.pendingUpgradeQuestion = { id: questionId, version: target };
    this.emit({
      name: AGENT_EVENTS.askUserQuestion,
      payload: {
        contract_version: CONTRACT_VERSION,
        session_id: sessionId,
        request_id: requestId,
        question_id: questionId,
        question,
        options: ["升级", "取消"],
        kind: "core_upgrade_confirm",
        details: {
          current_version: this.coreActiveVersion,
          target_version: target,
          size,
          source: "official",
          restart_required: mockFlag("veyl.mock.core.restart") === "1",
        },
        created_at: Date.now(),
        expires_at: Date.now() + 300_000,
        emitted_at: now(),
      },
    });
  }

  private async disconnectFlow(requestId: string, assistantId: string) {
    this.status(requestId, assistantId, "正在断开", "preparing_tool");
    if (
      !(await this.tool(
        requestId,
        assistantId,
        "VpnDisconnect",
        "断开当前节点",
        700,
        "已断开，系统代理已恢复。",
        { permissionLevel: "write" },
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }
    this.transition("idle", "stopped", {
      pid: null,
      uptime_seconds: null,
      config_id: null,
      config_name: null,
      node_id: null,
      node_name: null,
      mixed_port: null,
      connected_since: null,
      latency_ms: null,
      system_proxy_enabled: false,
      connections: null,
    });
    this.health({ process: false, clash_api: false, data_plane: false, exit_ip: null });
    const reply = "已断开，系统代理恢复成你原来的设置。";
    await this.type(requestId, assistantId, reply);
    this.finish(requestId, assistantId, "success", reply);
  }

  async cancel(requestId: string): Promise<void> {
    this.cancelled.add(requestId);
  }

  async renameSession(sessionId: string, title: string): Promise<RenamedSession> {    await sleep(250);
    // mock 扮演后端：trim 与长度校验都在这边做，前端只管显示错误码对应的文案。
    const trimmed = title.trim();
    if (!trimmed) {
      throw {
        code: "INVALID_ARGUMENT",
        message: "标题不能为空",
        details: { reason: "empty_title" },
      };
    }
    if (Array.from(trimmed).length > 80) {
      throw {
        code: "INVALID_ARGUMENT",
        message: "标题最多 80 个字符",
        details: { reason: "title_too_long", max: 80 },
      };
    }
    return { id: sessionId, title: trimmed, createdAt: Date.now() };
  }

  async deleteSession(_sessionId: string): Promise<void> {
    // mock 没有本地库：会话状态由前端 reducer 维护，这里只模拟成功。
    await sleep(150);
  }

  async importSeedFile(_path: string): Promise<ImportSeedResult> {
    // 浏览器通道没有窗口级拖拽事件，也没有本地文件系统。
    throw {
      code: "UNSUPPORTED",
      message: "浏览器通道不支持拖拽导入，请在桌面应用里试",
    };
  }

  async getChatHistory(_sessionId?: string): Promise<ChatHistory> {
    // 浏览器通道没有本地数据库，恢复历史只在 Tauri 里生效。
    return { sessions: [], activeSessionId: null, messages: [] };
  }

  async configList(): Promise<ConfigListData> {
    // 浏览器通道的配置列表由 useVpnSession 的 mock 分支提供；这里只满足接口。
    return { configs: [], active_config_id: null };
  }

  async configDetail(_configId: string): Promise<ConfigDetail> {
    throw this.unsupportedConfigCommand("config_detail");
  }

  async configCreate(_input: ConfigCreateInput): Promise<ConfigDetail> {
    throw this.unsupportedConfigCommand("config_create");
  }

  async configDelete(configId: string): Promise<ConfigDeleteData> {
    // 浏览器通道的配置列表由 useVpnSession 的 mock 分支维护；这里只满足接口。
    return {
      config_id: configId,
      deleted: true,
      already_absent: false,
      active_config_id: null,
    };
  }

  async configActivate(
    _configId: string,
    _confirmDisconnect = false,
  ): Promise<ConfigActivateResult> {
    throw this.unsupportedConfigCommand("config_activate");
  }

  async nodeSwitch(_configId: string, _nodeId: string): Promise<NodeSwitchResult> {
    throw this.unsupportedConfigCommand("node_switch");
  }

  async nodeProbe(nodeId: string): Promise<NodeProbeResult> {
    return {
      node_id: nodeId,
      reachable: true,
      latency_ms: 42,
      probe_method: "tcp",
      checked_at: Date.now(),
      error: null,
    };
  }

  private unsupportedConfigCommand(command: string) {
    return {
      code: "UNSUPPORTED",
      message: `浏览器通道未实现 ${command}，配置操作走本地 mock 会话`,
    };
  }

  private keyMasked: string | null = null;
  private llmProviders: LlmProvider[] = [];
  private llmActiveId: string | null = null;
  private providerMigrated = false;

  /** 旧的单一 Key 迁移成内置 DeepSeek provider（R32），只做一次。 */
  private ensureProviders() {
    if (this.providerMigrated) return;
    this.providerMigrated = true;
    if (this.keyMasked) this.createBuiltinProvider();
  }

  private createBuiltinProvider() {
    this.llmProviders = [
      {
        providerId: "builtin_deepseek",
        name: "DeepSeek",
        protocol: "openai",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        hasKey: this.keyMasked !== null,
        isActive: true,
        isBuiltin: true,
      },
    ];
    this.llmActiveId = "builtin_deepseek";
  }

  private syncBuiltinProvider() {
    if (!this.keyMasked) return;
    const builtin = this.llmProviders.find((provider) => provider.isBuiltin);
    if (builtin) {
      builtin.hasKey = true;
      return;
    }
    if (this.llmProviders.length === 0) {
      this.providerMigrated = true;
      this.createBuiltinProvider();
    }
  }

  async getDeepSeekKey(): Promise<DeepSeekKeyState> {
    return {
      masked: this.keyMasked,
      verified: false,
      validation: this.keyMasked ? "unverified" : "unverified",
    };
  }

  async saveDeepSeekKey(key: string): Promise<DeepSeekKeyState> {
    await sleep(600);
    const trimmed = key.trim();

    if (!trimmed.startsWith("sk-") || trimmed.length < 12) {
      throw { code: "INVALID_ARGUMENT", message: "Key 格式看起来不对，应以 sk- 开头" };
    }

    // 含 offline 的 Key 模拟「保存成功但网络不可达，没能验证」。
    if (/offline/i.test(trimmed)) {
      this.keyMasked = maskKey(trimmed);
      this.syncBuiltinProvider();
      return { masked: this.keyMasked, verified: false, validation: "unverified" };
    }

    // 假 Key 走「已写入但鉴权失败」这条路径，和后端语义一致：
    // 失败码 INVALID_KEY 时 Key 其实已经落进本地凭据文件了。
    if (/test/i.test(trimmed) || trimmed.length < 30) {
      this.keyMasked = maskKey(trimmed);
      this.syncBuiltinProvider();
      throw { code: "INVALID_KEY", message: "DeepSeek 鉴权失败，Key 可能无效或已被吊销" };
    }

    this.keyMasked = maskKey(trimmed);
    this.syncBuiltinProvider();
    return { masked: this.keyMasked, verified: true, validation: "ok" };
  }

  async clearDeepSeekKey(): Promise<void> {
    await sleep(200);
    this.keyMasked = null;
    this.llmProviders = this.llmProviders.map((provider) =>
      provider.isBuiltin ? { ...provider, hasKey: false } : provider,
    );
  }

  async replyUserQuestion(
    _sessionId: string,
    questionId: string,
    answer: string,
  ): Promise<void> {
    const pending = this.pendingUpgradeQuestion;
    if (!pending || pending.id !== questionId) return;
    this.pendingUpgradeQuestion = null;
    if (!/升级|更新/.test(answer)) return;
    const job = { id: `core_chat_${Date.now()}`, cancelled: false, origin: "agent" as const };
    this.coreJob = job;
    void this.runMockUpgrade(job, pending.version, mockFlag("veyl.mock.core.upgrade"), "agent");
  }

  async listPendingQuestions(_sessionId: string): Promise<never[]> {
    return [];
  }

  async llmProviderList(): Promise<{
    providers: LlmProvider[];
    activeProviderId: string | null;
  }> {
    this.ensureProviders();
    return {
      providers: this.llmProviders.map((provider) => ({ ...provider })),
      activeProviderId: this.llmActiveId,
    };
  }

  async llmProviderSave(input: LlmProviderInput): Promise<LlmProvider> {
    this.ensureProviders();
    await sleep(350);

    const model = input.model.trim();
    if (!model) {
      throw { code: "INVALID_ARGUMENT", message: "模型不能为空" };
    }

    const providerId = input.providerId ?? `prv_${Math.random().toString(36).slice(2, 8)}`;
    const existingIndex = this.llmProviders.findIndex(
      (provider) => provider.providerId === providerId,
    );
    const existing = existingIndex >= 0 ? this.llmProviders[existingIndex] : undefined;
    const hasKey = input.apiKey.trim().length > 0 ? true : existing?.hasKey ?? false;
    if (!hasKey && !isLocalEndpoint(input.baseUrl)) {
      throw {
        code: "INVALID_ARGUMENT",
        message: "请填写 API Key；只有本机端点（localhost / 127.0.0.1）可以免 Key",
      };
    }

    const hadActive =
      this.llmActiveId !== null &&
      this.llmProviders.some((provider) => provider.providerId === this.llmActiveId);
    // 保存只保存：只有「本来就没有当前 provider」时才自动成为当前。
    const becomesActive = existing?.isActive === true || !hadActive;

    const saved: LlmProvider = {
      providerId,
      name: input.name.trim() || model,
      protocol: input.protocol,
      baseUrl: input.baseUrl.trim(),
      model,
      hasKey,
      isActive: becomesActive,
      isBuiltin: existing?.isBuiltin ?? false,
    };

    if (becomesActive) {
      this.llmProviders = this.llmProviders.map((provider) =>
        provider.providerId === providerId ? provider : { ...provider, isActive: false },
      );
      this.llmActiveId = providerId;
    }

    if (existingIndex >= 0) {
      this.llmProviders = this.llmProviders.map((provider) =>
        provider.providerId === providerId ? saved : provider,
      );
    } else {
      this.llmProviders = [...this.llmProviders, saved];
    }

    return { ...saved };
  }

  async llmProviderDelete(providerId: string): Promise<void> {
    this.ensureProviders();
    await sleep(200);
    const target = this.llmProviders.find((provider) => provider.providerId === providerId);
    if (!target) {
      throw { code: "NOT_FOUND", message: "provider 不存在" };
    }

    this.llmProviders = this.llmProviders.filter(
      (provider) => provider.providerId !== providerId,
    );
    // 删除 provider 必须同时删掉它的 Key，不留孤儿密钥。
    if (target.isBuiltin) this.keyMasked = null;

    if (this.llmActiveId === providerId) {
      // 不静默切到另一个端点；由用户再点「设为当前」。
      this.llmActiveId = null;
      this.llmProviders = this.llmProviders.map((provider) => ({
        ...provider,
        isActive: false,
      }));
    }
  }

  async llmProviderActivate(providerId: string): Promise<void> {
    this.ensureProviders();
    const target = this.llmProviders.find((provider) => provider.providerId === providerId);
    if (!target) {
      throw { code: "NOT_FOUND", message: "provider 不存在" };
    }
    if (!target.hasKey && !isLocalEndpoint(target.baseUrl)) {
      throw {
        code: "PRECONDITION_FAILED",
        message: "这个 provider 还没有可用的 API Key",
      };
    }

    this.llmActiveId = providerId;
    this.llmProviders = this.llmProviders.map((provider) => ({
      ...provider,
      isActive: provider.providerId === providerId,
    }));
  }

  async llmProviderTest(input: LlmProviderInput): Promise<LlmProviderTestResult> {
    await sleep(420);

    if (!input.model.trim()) {
      return { ok: false, latencyMs: null, error: "模型不能为空" };
    }
    const baseUrl = input.baseUrl.trim();
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, latencyMs: null, error: "Base URL 必须以 http:// 或 https:// 开头" };
    }

    const existing = this.llmProviders.find(
      (provider) => provider.providerId === input.providerId,
    );
    const hasKey = input.apiKey.trim().length > 0 || existing?.hasKey === true;
    if (!hasKey && !isLocalEndpoint(baseUrl)) {
      return { ok: false, latencyMs: null, error: "缺少 API Key" };
    }
    if (/invalid|fail/i.test(input.baseUrl)) {
      return { ok: false, latencyMs: null, error: "无法连接到该端点" };
    }
    return { ok: true, latencyMs: 180 + Math.floor(Math.random() * 220) };
  }

  dispose(): void {
    this.listeners.clear();
  }
}
