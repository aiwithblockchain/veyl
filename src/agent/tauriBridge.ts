import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentBridge,
  ChatHistory,
  ConfigActivateResult,
  ConfigCreateInput,
  ConfigDeleteData,
  ConfigListData,
  DeepSeekKeyState,
  DefaultProfileStatus,
  ImportSeedResult,
  LlmProvider,
  LlmProviderInput,
  LlmProviderTestResult,
  NetRepairAction,
  NetRepairResult,
  NodeProbeResult,
  NodeSwitchResult,
  PendingQuestion,
  RenamedSession,
  StoredChatMessage,
  StoredSessionSummary,
} from "./bridge";
import { toBridgeError } from "./errors";
import { createListenerManager } from "./listeners";
import { AGENT_EVENTS, APP_EVENT_NAMES, AI_EVENT_NAMES } from "./protocol";
import type { AgentEvent, ConfigDetail, RuntimeSnapshot } from "./protocol";

const EVENT_NAMES = [...AI_EVENT_NAMES, ...APP_EVENT_NAMES];

interface RawPendingQuestion {  question_id?: string;
  session_id?: string;
  request_id?: string;
  question?: string;
  options?: string[];
  created_at?: number;
  expires_at?: number;
}

interface RawDefaultProfile {
  package_id?: string | null;
  version?: string | null;
  applied_at?: string | null;
  new_version_available?: boolean;
  node_count?: number;
}

function normalizeDefaultProfile(raw: RawDefaultProfile): DefaultProfileStatus {
  return {
    packageId: raw.package_id ?? null,
    version: raw.version ?? null,
    appliedAt: raw.applied_at ?? null,
    newVersionAvailable: raw.new_version_available === true,
    nodeCount: raw.node_count ?? 0,
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
      return await call<RuntimeSnapshot>("runtime_status");
    } catch {
      // 状态面板拿不到快照时保持 idle，不打断对话。
      return null;
    }
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
    return call<ConfigDetail>("config_detail", { configId });
  }

  async configCreate(input: ConfigCreateInput): Promise<ConfigDetail> {
    return call<ConfigDetail>("config_create", {
      ...input,
    } as unknown as Record<string, unknown>);
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

  async defaultProfileStatus(): Promise<DefaultProfileStatus> {
    const raw = await call<RawDefaultProfile>("default_profile_status");
    return normalizeDefaultProfile(raw);
  }

  async defaultProfileRefresh(): Promise<DefaultProfileStatus> {
    const raw = await call<RawDefaultProfile>("default_profile_refresh");
    return normalizeDefaultProfile(raw);
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

  async openLogDir(): Promise<void> {
    await call("open_log_dir");
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

  async cancel(requestId: string): Promise<void> {
    await call("ai_cancel", { requestId });
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
        messages: raw.messages ?? [],
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
      profiles: raw.profiles ?? [],
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
      .map((item) => ({
        questionId: item.question_id ?? "",
        sessionId: item.session_id ?? sessionId,
        requestId: item.request_id ?? "",
        question: item.question ?? "",
        options: item.options ?? [],
        createdAt: item.created_at ?? 0,
        expiresAt: item.expires_at ?? item.created_at ?? 0,
      }))
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
