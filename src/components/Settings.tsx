import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  AgentBridge,
  DeepSeekKeyState,
  DefaultProfileStatus,
  ImportSeedResult,
  LlmProtocol,
  LlmProvider,
  LlmProviderInput,
} from "../agent/bridge";
import { isHttpUrl, isLocalEndpoint } from "../agent/bridge";
import type { RuntimeView } from "../agent/protocol";
import { toBridgeError } from "../agent/errors";
import { advancedPrompt, ADVANCED_FIELDS } from "../ai/advancedPrompts";
import { useFocusTrap } from "../ui/focus";
import { formatPort, formatDate } from "../format";
import { IconClose } from "./icons";

const DEFAULT_SOURCE_URL = "https://meshnetprotocol.github.io/bootstrap.json";
const APP_VERSION = "0.1.0";

interface Props {
  open: boolean;
  bridge: AgentBridge;
  runtime: RuntimeView;
  defaultProfile: DefaultProfileStatus | null;
  onClose: () => void;
  onNotice: (notice: { level: "info" | "error"; text: string }) => void;
  importing: boolean;
  dragging: boolean;
  importResult: ImportSeedResult | null;
  importError: string | null;
  onImportPath: (path: string) => void;
  onRestartOnboarding: () => void;
  onOpenLogs: () => void;
  onRestoreNetwork: () => void;
  onAskAi: (text: string) => void;
  /** 从导入入口进来时直接落到「网络」；默认「账号与 AI」。 */
  initialSection?: SectionId;
}

type Feedback = { kind: "ok" | "warn" | "error"; text: string } | null;
type ApiMode = "basic" | "advanced";
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

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: "ai", label: "账号与 AI" },
  { id: "network", label: "网络" },
  { id: "advanced", label: "高级" },
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

function emptyForm(): ProviderForm {
  return { name: "", protocol: "openai", baseUrl: "", model: "", apiKey: "", hasKey: false };
}

export function Settings({
  open,
  bridge,
  runtime,
  defaultProfile,
  onClose,
  onNotice,
  importing,
  dragging,
  importResult,
  importError,
  onImportPath,
  onRestartOnboarding,
  onOpenLogs,
  onRestoreNetwork,
  onAskAi,
  initialSection = "ai",
}: Props) {
  const [section, setSection] = useState<SectionId>("ai");
  const [state, setState] = useState<DeepSeekKeyState>({
    masked: null,
    verified: false,
    validation: "unverified",
  });
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [apiMode, setApiMode] = useState<ApiMode>("basic");
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
  const [pendingDelete, setPendingDelete] = useState<LlmProvider | null>(null);
  const [diagnosticNotice, setDiagnosticNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, dialogRef);

  const refreshProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const data = await bridge.llmProviderList();
      setProviders(data.providers);
      setActiveProviderId(data.activeProviderId);
    } catch {
      // provider 命令未接线时保持空列表，基础模式不受影响。
    } finally {
      setProvidersLoading(false);
    }
  }, [bridge]);

  const refresh = useCallback(() => {
    setLoading(true);
    void bridge
      .getDeepSeekKey()
      .then((next) => {
        setState(next);
        setEditing(next.masked === null);
      })
      .finally(() => setLoading(false));
  }, [bridge]);

  useEffect(() => {
    if (!open) return;
    setSection(initialSection);
    setFeedback(null);
    setValue("");
    setReveal(false);
    setApiMode("basic");
    setProviderForm(null);
    setProviderNotice(null);
    setProviderError(null);
    setProviderTest({ state: "idle", text: "" });
    setPendingDelete(null);
    setDiagnosticNotice(null);
    void refreshProviders();
    refresh();
  }, [open, refresh, refreshProviders, initialSection]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (open && editing) inputRef.current?.focus();
  }, [open, editing]);

  const save = async () => {
    const key = value.trim();
    if (!key || saving) return;

    setSaving(true);
    setFeedback(null);
    try {
      const next = await bridge.saveDeepSeekKey(key);
      setState(next);
      setEditing(next.masked === null);
      setValue("");
      setReveal(false);
      setFeedback(
        next.verified
          ? { kind: "ok", text: "已保存，并验证可用。" }
          : { kind: "warn", text: "已保存，但当前没能验证（网络不可用）。稍后可以重试。" },
      );
      void refreshProviders();
    } catch (error) {
      setFeedback({ kind: "error", text: describeKeyError(error) });
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setFeedback(null);
    try {
      await bridge.clearDeepSeekKey();
      setState({ masked: null, verified: false, validation: "unverified" });
      setEditing(true);
      setFeedback({ kind: "ok", text: "已从本机移除。" });
      void refreshProviders();
    } catch (error) {
      setFeedback({ kind: "error", text: describeClearError(error) });
    }
  };

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
      refresh();
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
          ? "已删除，同时清除了该 provider 的 Key。没有当前 provider，请选择一个。"
          : "已删除，同时清除了该 provider 的 Key。",
      });
      await refreshProviders();
      refresh();
    } catch (error) {
      setPendingDelete(null);
      setProviderNotice({ kind: "error", text: describeProviderError(error) });
    }
  };

  const askAi = (field: string, value: string) => {
    onAskAi(advancedPrompt(field, value));
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

  const pickFile = useCallback(async () => {
    try {
      const path = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "节点配置", extensions: ["json"] }],
      });
      if (typeof path === "string") onImportPath(path);
    } catch (error) {
      onNotice({ level: "error", text: describePickerError(error) });
    }
  }, [onImportPath, onNotice]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal modal--settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
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

        <nav className="settings-nav" aria-label="设置分区">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? "is-active" : ""}
              aria-current={section === item.id}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {section === "ai" ? (
          <section className="settings-section">
            <div className="settings-section__head">
              <h3 className="settings-section__title">模型 API</h3>
              <div className="settings-mode" role="tablist" aria-label="API 设置模式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={apiMode === "basic"}
                  className={apiMode === "basic" ? "is-active" : ""}
                  onClick={() => setApiMode("basic")}
                >
                  基础
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={apiMode === "advanced"}
                  className={apiMode === "advanced" ? "is-active" : ""}
                  onClick={() => {
                    setApiMode("advanced");
                    void refreshProviders();
                  }}
                >
                  高级
                </button>
              </div>
            </div>

            {apiMode === "basic" ? (
              <>
                {loading ? (
                  <p className="settings-muted">读取当前配置…</p>
                ) : editing ? (
                  <form
                    className="settings-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save();
                    }}
                  >
                    {state.masked ? (
                      <p className="settings-warning">
                        更换 Key 会重建当前会话，对话上下文将清空。
                      </p>
                    ) : null}
                    <div className="settings-input">
                      <input
                        ref={inputRef}
                        type={reveal ? "text" : "password"}
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        placeholder="sk-..."
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-label="DeepSeek API Key"
                      />
                      <button
                        type="button"
                        className="settings-reveal"
                        onClick={() => setReveal((shown) => !shown)}
                      >
                        {reveal ? "隐藏" : "显示"}
                      </button>
                    </div>
                    <div className="settings-actions">
                      <button
                        type="submit"
                        className="btn btn--primary"
                        disabled={saving || value.trim().length === 0}
                      >
                        {saving ? "保存中…" : "保存"}
                      </button>
                      {state.masked ? (
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => {
                            setEditing(false);
                            setValue("");
                            setFeedback(null);
                          }}
                        >
                          取消
                        </button>
                      ) : null}
                    </div>
                  </form>
                ) : (
                  <div className="settings-saved">
                    <code className="settings-key">{state.masked}</code>
                    <div className="settings-actions">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => setEditing(true)}
                      >
                        更换
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger-ghost"
                        onClick={() => void clear()}
                      >
                        清除
                      </button>
                    </div>
                  </div>
                )}

                {feedback ? (
                  <p className={`settings-feedback settings-feedback--${feedback.kind}`}>
                    {feedback.text}
                  </p>
                ) : null}

                <p className="settings-note">
                  Key 加密保存在本机，仅用于调用模型接口；界面只显示打码后的末四位。
                </p>
              </>
            ) : (
              <div className="settings-providers">
                <p className="settings-risk">请求会发往你填写的端点，请确认你信任它。</p>

                {providersLoading ? (
                  <p className="settings-muted">读取 provider…</p>
                ) : providers.length === 0 ? (
                  <p className="settings-muted">还没有 provider。可以用下面的预设一键填充。</p>
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
                              onClick={() => openEditProvider(provider)}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="btn btn--danger-ghost provider-item__btn"
                              onClick={() => setPendingDelete(provider)}
                              disabled={provider.isBuiltin}
                              title={provider.isBuiltin ? "内置 provider 不可删除" : undefined}
                            >
                              删除
                            </button>
                          </div>

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
                    新增 Provider
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void refreshProviders()}
                  >
                    刷新
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
                      {providerForm.providerId ? "编辑 Provider" : "新增 Provider"}
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
            )}
          </section>
        ) : null}

        {section === "network" ? (
          <section className="settings-section">
            <h3 className="settings-section__title">网络</h3>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">代理模式</div>
                <div className="settings-row__value">系统代理</div>
              </div>
              <div className="settings-row__aside">
                <button
                  type="button"
                  className="ask-ai"
                  onClick={() => askAi(ADVANCED_FIELDS.proxyMode, "系统代理")}
                >
                  问 AI
                </button>
              </div>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">本地端口</div>
                <div className="settings-row__value num">
                  {formatPort(runtime.mixed_port)}
                </div>
              </div>
              <button
                type="button"
                className="ask-ai"
                onClick={() =>
                  askAi(
                    ADVANCED_FIELDS.mixedPort,
                    runtime.mixed_port === null ? "（未连接）" : String(runtime.mixed_port),
                  )
                }
              >
                问 AI
              </button>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">默认配置源</div>
                <div className="settings-row__value">
                  {defaultProfile?.version
                    ? `v${defaultProfile.version} · ${defaultProfile.nodeCount} 个节点 · 更新于 ${formatDate(defaultProfile.appliedAt)}`
                    : "未启用"}
                </div>
              </div>
              <button
                type="button"
                className="ask-ai"
                onClick={() =>
                  askAi(
                    ADVANCED_FIELDS.defaultSource,
                    defaultProfile?.version ? `v${defaultProfile.version}` : "未启用",
                  )
                }
              >
                问 AI
              </button>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">恢复网络</div>
                <div className="settings-row__value">
                  撤销系统代理并停止运行时，适合连不上网时使用。
                </div>
              </div>
              <button type="button" className="btn btn--ghost" onClick={onRestoreNetwork}>
                恢复网络
              </button>
            </div>

            <div className="settings-subhead">导入节点文件</div>
            <div
              className={`dropzone ${dragging ? "is-dragging" : ""} ${
                importing ? "is-busy" : ""
              }`}
            >
              {importing
                ? "正在导入…"
                : dragging
                  ? "松手即可导入"
                  : `拖入文件，或选择`}{" "}
              {dragging ? null : (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void pickFile()}
                  disabled={importing}
                >
                  选择文件
                </button>
              )}
            </div>

            {importResult ? (
              <div className="settings-import">
                <p className="settings-feedback settings-feedback--ok">
                  已导入 {importResult.imported} 个节点
                </p>
                <ul className="settings-import__list">
                  {importResult.profiles.map((profile) => (
                    <li key={profile.id}>
                      <span className="settings-import__name">{profile.name}</span>
                      <code>
                        {profile.server}
                        {profile.server_port ? `:${profile.server_port}` : ""}
                      </code>
                    </li>
                  ))}
                </ul>
                {importResult.skipped.length > 0 ? (
                  <ul className="settings-import__skipped">
                    {importResult.skipped.map((item) => (
                      <li key={`${item.name}-${item.reason}`}>
                        {item.name}：{item.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {importError ? (
              <p className="settings-feedback settings-feedback--error">{importError}</p>
            ) : null}

            <p className="settings-note">
              没有网络也能导入：文件在本地解析，不依赖默认配置源。默认源暂时不可达属于正常现象。
            </p>
            <p className="settings-note">这份文件包含共享凭据，请勿外传。</p>
          </section>
        ) : null}

        {section === "advanced" ? (
          <section className="settings-section">
            <h3 className="settings-section__title">高级</h3>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">默认配置源地址</div>
                <div className="settings-row__value num">{DEFAULT_SOURCE_URL}</div>
              </div>
              <button
                type="button"
                className="ask-ai"
                onClick={() => askAi(ADVANCED_FIELDS.defaultSource, DEFAULT_SOURCE_URL)}
              >
                问 AI
              </button>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">日志级别</div>
                <div className="settings-row__value">info（固定）</div>
              </div>
              <button
                type="button"
                className="ask-ai"
                onClick={() => askAi("日志级别", "info")}
              >
                问 AI
              </button>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">诊断信息</div>
                <div className="settings-row__value">
                  复制当前状态，便于排查问题；不包含 Key。
                </div>
              </div>
              <div className="settings-row__aside">
                <button
                  type="button"
                  className="ask-ai"
                  onClick={() => askAi("诊断信息", "当前应用与运行时状态")}
                >
                  问 AI
                </button>
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
          </section>
        ) : null}

        {section === "about" ? (
          <section className="settings-section">
            <h3 className="settings-section__title">关于</h3>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">版本</div>
                <div className="settings-row__value num">v{APP_VERSION}</div>
              </div>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">事件源</div>
                <div className="settings-row__value">
                  {bridge.mode === "mock" ? "MOCK 事件源" : "已连接 Host"}
                </div>
              </div>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">首次引导</div>
                <div className="settings-row__value">
                  重新走一遍两步引导，不会删除已有 Key 或节点。
                </div>
              </div>
              <button type="button" className="btn btn--ghost" onClick={onRestartOnboarding}>
                重新运行
              </button>
            </div>

            <div className="settings-row">
              <div>
                <div className="settings-row__label">日志</div>
                <div className="settings-row__value">在文件管理器中定位最近的日志文件。</div>
              </div>
              <button type="button" className="btn btn--ghost" onClick={onOpenLogs}>
                打开日志目录
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function describeProviderError(error: unknown): string {
  const bridgeError = toBridgeError(error);
  if (/not found|unknown command/i.test(bridgeError.message)) {
    return "provider 命令还没有接入当前版本，请稍后再试。";
  }
  if (bridgeError.code === "NOT_FOUND") {
    return "这个 provider 已经不存在了。";
  }
  if (bridgeError.code === "PRECONDITION_FAILED") {
    const reason = bridgeError.details?.reason;
    if (reason === "builtin_provider") return "内置 provider 不可删除";
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

function describeClearError(error: unknown): string {
  const code = readCode(error);
  if (code === "SECRET_STORE") {
    return "本地加密凭据文件删除失败（secrets.enc），请检查磁盘权限后重试。";
  }
  const message = readMessage(error);
  return message ? `清除失败：${message}` : "清除失败，请稍后重试。";
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

function describePickerError(error: unknown): string {
  const message = readMessage(error);
  if (/plugin dialog|dialog\|open|__TAURI_INTERNALS__/i.test(message)) {
    return "文件选择器暂时不可用，请把文件直接拖进窗口。";
  }
  return "无法打开文件选择器，请把文件直接拖进窗口。";
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
