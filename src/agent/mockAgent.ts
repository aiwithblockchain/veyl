import type { AgentBridge } from "./bridge";
import { AGENT_EVENTS, CONTRACT_VERSION } from "./protocol";
import type {
  AgentEvent,
  AiStatusPhase,
  ApprovalDecision,
  ApprovalScope,
  NextAction,
  RuntimeSnapshot,
  RuntimeState,
  ToolPermissionLevel,
} from "./protocol";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const CHUNK_INTERVAL = 16;

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
export class MockAgentBridge implements AgentBridge {
  readonly mode = "mock" as const;

  private listeners = new Set<(event: AgentEvent) => void>();
  private cancelled = new Set<string>();
  private approvals = new Map<string, (decision: ApprovalDecision) => void>();
  private activeRequests = new Set<string>();

  private runtime: RuntimeSnapshot = {
    contract_version: CONTRACT_VERSION,
    state: "idle",
    mode: "system_proxy",
    pid: null,
    upstream_version: null,
    uptime_seconds: null,
    profile_id: null,
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

  private emit(event: AgentEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private transition(
    to: RuntimeState,
    event: "start_req" | "process_ready" | "stop_req" | "stopped",
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
        emitted_at: now(),
      },
    });
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
      approvalPolicy?: "never" | "always" | "first_time_per_session";
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
        approval_policy: options.approvalPolicy ?? "never",
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

  private waitApproval(approvalId: string): Promise<ApprovalDecision> {
    return new Promise((resolve) => this.approvals.set(approvalId, resolve));
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

  async sendMessage(sessionId: string, text: string): Promise<{ requestId: string }> {
    const requestId = `req_${Math.random().toString(36).slice(2, 10)}`;
    const assistantId = `asst_${requestId}`;
    this.cancelled.delete(requestId);
    this.activeRequests.add(requestId);

    void this.run(sessionId, requestId, assistantId, text);
    return { requestId };
  }

  private async run(sessionId: string, requestId: string, assistantId: string, text: string) {
    if (text.includes("断开")) return this.disconnectFlow(requestId, assistantId);
    if (text.includes("状态")) return this.statusFlow(requestId, assistantId);
    if (text.includes("安装")) return this.installOnlyFlow(requestId, assistantId);

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
        "已安装 0 个版本，可安装 1.14.4。",
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }

    if (
      !(await this.type(
        requestId,
        assistantId,
        "本地还没有安装 sing-box。我先装一个官方版本，再帮你连到日本。",
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }

    const approved = await this.requestApproval(
      sessionId,
      requestId,
      "CoreInstall",
      "下载并安装 sing-box 1.14.4（约 28 MB）",
      "call",
      "medium",
    );
    if (!approved) {
      await this.type(requestId, assistantId, "好的，先不安装。需要的时候跟我说「安装运行时」。");
      return this.finish(requestId, assistantId, "success", "已取消安装");
    }

    if (
      !(await this.tool(
        requestId,
        assistantId,
        "CoreInstall",
        "安装 1.14.4",
        1900,
        "已安装 sing-box 1.14.4。",
        {
          permissionLevel: "execute",
          approvalPolicy: "always",
          argsPreview: { version: "1.14.4" },
        },
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }
    this.transition("idle", "process_ready", {
      upstream_version: "1.14.4",
      pid: null,
    });

    await this.type(requestId, assistantId, "运行时装好了。正在查日本节点。");
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

    const connectApproved = await this.requestApproval(
      sessionId,
      requestId,
      "VpnConnect",
      "连接到 东京 01",
      "session",
      "high",
    );
    if (!connectApproved) {
      await this.type(requestId, assistantId, "已取消连接。需要换节点再告诉我。");
      return this.finish(requestId, assistantId, "success", "已取消连接");
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
          approvalPolicy: "first_time_per_session",
          argsPreview: { node_id: "seed-jp-01", strategy: "latency" },
          nextActions: [{ label: "断开连接", tool: "VpnDisconnect", args: {} }],
        },
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }

    this.transition("running", "process_ready", {
      pid: 48213,
      uptime_seconds: 1,
      profile_id: "prf_1",
      system_proxy_enabled: true,
      connections: 3,
    });
    this.health({
      process: true,
      clash_api: true,
      data_plane: true,
      exit_ip: "203.0.113.7",
      consecutive_failures: 0,
    });

    const reply =
      "已连接到「东京 01」，出口 IP 203.0.113.7，系统代理已生效。要换节点随时说。";
    await this.type(requestId, assistantId, reply);
    this.finish(requestId, assistantId, "success", reply);
  }

  private async requestApproval(
    sessionId: string,
    requestId: string,
    tool: string,
    summary: string,
    scope: ApprovalScope,
    risk: "low" | "medium" | "high",
    argsPreview?: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.cancelled.has(requestId)) return false;

    const approvalId = `apr_${Math.random().toString(36).slice(2, 9)}`;
    this.status(requestId, assistantIdFor(requestId), `等待确认：${summary}`, "waiting_permission");
    this.emit({
      name: AGENT_EVENTS.approvalRequested,
      payload: {
        contract_version: CONTRACT_VERSION,
        approval_id: approvalId,
        request_id: requestId,
        session_id: sessionId,
        tool,
        args_preview: argsPreview,
        summary,
        risk,
        scope,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        emitted_at: now(),
      },
    });

    const decision = await this.waitApproval(approvalId);
    return decision === "allow" && !this.cancelled.has(requestId);
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
      ? `当前已连接，出口 IP ${this.runtime.health.exit_ip}，本地代理监听 127.0.0.1:2080。`
      : "当前没有连接。要连的话直接说地区，例如「连到日本」。";
    await this.type(requestId, assistantId, reply);
    this.finish(requestId, assistantId, "success", reply);
  }

  private async installOnlyFlow(requestId: string, assistantId: string) {
    this.status(requestId, assistantId, "准备安装运行时", "preparing_tool");
    if (
      !(await this.tool(
        requestId,
        assistantId,
        "RuntimeStart",
        "启动运行时",
        900,
        "运行时已启动，PID 48213。",
        { permissionLevel: "write" },
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }
    await this.type(requestId, assistantId, "运行时已经启动了。");
    this.finish(requestId, assistantId, "success", "运行时已启动");
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
      profile_id: null,
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
    for (const resolve of this.approvals.values()) resolve("deny");
    this.approvals.clear();
  }

  async respondApproval(
    approvalId: string,
    decision: ApprovalDecision,
    _scope: ApprovalScope,
  ): Promise<void> {
    const resolve = this.approvals.get(approvalId);
    if (!resolve) return;
    this.approvals.delete(approvalId);
    resolve(decision);
  }

  dispose(): void {
    this.listeners.clear();
    this.approvals.clear();
  }
}

function assistantIdFor(requestId: string): string {
  return `asst_${requestId}`;
}
