import type { AgentBridge, ChatHistory, DeepSeekKeyState, RenamedSession } from "./bridge";
import { maskKey } from "./bridge";
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

/** mock 通道固定出口 IP，方便自动化断言。 */
export const MOCK_EXIT_IP = "203.0.113.7";

/**
 * 会话内首次确认的工具（契约 tools.md §2.2）。
 * 其余需要确认的工具都是 `always`，每次都弹。
 */
const SESSION_SCOPED_TOOLS = new Set(["VpnConnect"]);

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
  /** 会话级授权：sessionId → 已放行的工具名。只存内存，新会话用新的 key。 */
  private grants = new Map<string, Set<string>>();
  /** 装过一次就不再走安装流程（真实链路同理，已安装时不重复装）。 */
  private installed = false;

  private hasGrant(sessionId: string, tool: string): boolean {
    return this.grants.get(sessionId)?.has(tool) ?? false;
  }

  private addGrant(sessionId: string, tool: string): void {
    const granted = this.grants.get(sessionId) ?? new Set<string>();
    granted.add(tool);
    this.grants.set(sessionId, granted);
  }

  /** 会话销毁时调用；界面上开新会话会拿到新的 sessionId，天然隔离。 */
  clearSessionGrants(sessionId: string): void {
    this.grants.delete(sessionId);
  }

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
    if (text.includes("安装")) return this.installOnlyFlow(sessionId, requestId, assistantId);
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
    const versionSummary = this.installed
      ? "已安装 1.14.4（active）"
      : "未安装，可安装 1.14.4";
    if (
      !(await this.tool(
        requestId,
        assistantId,
        "CoreListVersions",
        "查询可用版本",
        640,
        versionSummary,
      ))
    ) {
      return this.finish(requestId, assistantId, "cancelled", null);
    }

    if (!this.installed) {
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
      this.installed = true;
      this.transition("idle", "process_ready", {
        upstream_version: "1.14.4",
        pid: null,
      });

      await this.type(requestId, assistantId, "运行时装好了。正在查日本节点。");
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
      profile_id: "prf_1",
      system_proxy_enabled: true,
      connections: 3,
    });

    const reply = `已连接到「东京 01」，出口 IP ${MOCK_EXIT_IP}，系统代理已生效。要换节点随时说。`;
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

    // 会话内首次：已授权就直接放行，不再弹卡。
    const sessionScoped = SESSION_SCOPED_TOOLS.has(tool);
    if (sessionScoped && this.hasGrant(sessionId, tool)) {
      return true;
    }

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
    const allowed = decision === "allow" && !this.cancelled.has(requestId);

    // 只有「允许」才记授权；拒绝不记，下次仍然弹（验收口径）。
    if (allowed && sessionScoped) this.addGrant(sessionId, tool);
    return allowed;
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
      ? `当前已连接，出口 IP ${this.runtime.health.exit_ip}，本地代理监听 127.0.0.1:2080。`
      : "当前没有连接。要连的话直接说地区，例如「连到日本」。";
    await this.type(requestId, assistantId, reply);
    this.finish(requestId, assistantId, "success", reply);
  }

  // `always` 类工具：每次都要确认，不查也不写 Grant。
  private async installOnlyFlow(sessionId: string, requestId: string, assistantId: string) {
    this.status(requestId, assistantId, "准备安装运行时", "preparing_tool");

    const approved = await this.requestApproval(
      sessionId,
      requestId,
      "CoreInstall",
      "下载并安装 sing-box 1.14.4（约 28 MB）",
      "call",
      "medium",
    );
    if (!approved) {
      await this.type(requestId, assistantId, "好的，不装了。");
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

    this.installed = true;
    const reply = "运行时已经装好了，随时可以连节点。";
    await this.type(requestId, assistantId, reply);
    this.finish(requestId, assistantId, "success", reply);
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

  async renameSession(sessionId: string, title: string): Promise<RenamedSession> {
    await sleep(250);
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

  async getChatHistory(_sessionId?: string): Promise<ChatHistory> {
    // 浏览器通道没有本地数据库，恢复历史只在 Tauri 里生效。
    return { sessions: [], activeSessionId: null, messages: [] };
  }

  async deleteProfile(profileId: string): Promise<void> {
    if (this.runtime.state === "running" && this.runtime.profile_id === profileId) {
      throw new Error("当前连接仍在使用这个配置，请先断开再删除。");
    }
    this.runtime = { ...this.runtime, profile_id: null };
  }

  private keyMasked: string | null = null;

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
      return { masked: this.keyMasked, verified: false, validation: "unverified" };
    }

    // 假 Key 走「已写入但鉴权失败」这条路径，和后端语义一致：
    // 失败码 INVALID_KEY 时 Key 其实已经落进本地凭据文件了。
    if (/test/i.test(trimmed) || trimmed.length < 30) {
      this.keyMasked = maskKey(trimmed);
      throw { code: "INVALID_KEY", message: "DeepSeek 鉴权失败，Key 可能无效或已被吊销" };
    }

    this.keyMasked = maskKey(trimmed);
    return { masked: this.keyMasked, verified: true, validation: "ok" };
  }

  async clearDeepSeekKey(): Promise<void> {
    await sleep(200);
    this.keyMasked = null;
  }

  dispose(): void {
    this.listeners.clear();
    this.approvals.clear();
    this.grants.clear();
  }
}

function assistantIdFor(requestId: string): string {
  return `asst_${requestId}`;
}
