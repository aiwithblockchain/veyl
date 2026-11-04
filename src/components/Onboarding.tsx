import { useState } from "react";
import type { AgentBridge, LlmProtocol, LlmProviderInput } from "../agent/bridge";
import { isHttpUrl, isLocalEndpoint } from "../agent/bridge";
import { describeKeyError, describeProviderError } from "./Settings";
import { IconKey } from "./icons";
import { PRODUCT_NAME } from "../brand";

const PLATFORM_URL = "https://platform.deepseek.com/";

interface Props {
  bridge: AgentBridge;
  /** skipped 表示用户明确选择不用 AI；其余情况表示刚保存了 Key / 服务商。 */
  onDone: (skipped: boolean) => void;
}

interface CustomForm {
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

const EMPTY_CUSTOM: CustomForm = {
  protocol: "openai",
  baseUrl: "",
  model: "",
  apiKey: "",
};

export function Onboarding({ bridge, onDone }: Props) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState<"key" | "provider" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState<CustomForm>(EMPTY_CUSTOM);
  const [customError, setCustomError] = useState<string | null>(null);

  const saveKey = async () => {
    const key = value.trim();
    if (!key || saving) return;
    if (!key.startsWith("sk-")) {
      setError("Key 应以 sk- 开头，请检查是否复制完整。");
      return;
    }

    setSaving("key");
    setError(null);
    try {
      await bridge.saveDeepSeekKey(key);
      setValue("");
      onDone(false);
    } catch (saveError) {
      setError(describeKeyError(saveError));
    } finally {
      setSaving(null);
    }
  };

  const openPlatform = async () => {
    setError(null);
    try {
      await bridge.openExternal(PLATFORM_URL);
    } catch {
      setError(`当前版本还不能直接打开浏览器，请手动访问 ${PLATFORM_URL}`);
    }
  };

  const toggleCustom = () => {
    setCustomOpen((open) => !open);
    setCustomError(null);
    setError(null);
  };

  const buildProviderInput = (): LlmProviderInput | string => {
    const model = custom.model.trim();
    if (!model) return "模型不能为空";

    const baseUrl = custom.baseUrl.trim();
    if (!isHttpUrl(baseUrl)) return "Base URL 必须以 http:// 或 https:// 开头";
    if (baseUrl.toLowerCase().startsWith("http://") && !isLocalEndpoint(baseUrl)) {
      return "http 只允许本机地址（localhost / 127.0.0.1）；其他端点请用 https";
    }

    const apiKey = custom.apiKey.trim();
    if (!apiKey && !isLocalEndpoint(baseUrl)) {
      return "请填写 API Key；只有本机端点可以免 Key";
    }

    return {
      name: model,
      protocol: custom.protocol,
      baseUrl,
      model,
      apiKey,
    };
  };

  const saveProvider = async () => {
    if (saving) return;
    const input = buildProviderInput();
    if (typeof input === "string") {
      setCustomError(input);
      return;
    }

    setSaving("provider");
    setCustomError(null);
    try {
      const result = await bridge.llmProviderTest(input);
      if (!result.ok) {
        setCustomError(result.error || "连接失败，请检查端点和 Key。");
        return;
      }
      const saved = await bridge.llmProviderSave(input);
      try {
        await bridge.llmProviderActivate(saved.providerId);
      } catch {
        // 没有其他当前服务时，保存时已经设为当前。
      }
      onDone(false);
    } catch (saveError) {
      setCustomError(describeProviderError(saveError));
    } finally {
      setSaving(null);
    }
  };

  const primaryClass = customOpen ? "btn--ghost" : "btn--primary";

  return (
    <div className="onboarding">
      <div className="onboarding__shell">
        <div className="onboarding__brand">{PRODUCT_NAME}</div>
        <h1 className="onboarding__title">配置 AI 后，我来帮你连上网络。</h1>
        <p className="onboarding__text">
          Key 只保存在本机。配好之后，我来找节点、建立连接。
        </p>

        <form
          className="onboarding__form"
          aria-busy={saving === "key"}
          onSubmit={(event) => {
            event.preventDefault();
            void saveKey();
          }}
        >
          <div className="onboarding__field">
            <label className="onboarding__field-label" htmlFor="onboarding-deepseek-key">
              DeepSeek API Key
            </label>
            <div className="onboarding__keybox">
              <IconKey size={16} />
              <input
                id="onboarding-deepseek-key"
                className="onboarding__input"
                type="password"
                value={value}
                placeholder="粘贴 sk- 开头的 Key"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                onChange={(event) => setValue(event.target.value)}
              />
            </div>
          </div>
          <button
            type="submit"
            className={`btn ${primaryClass} onboarding__submit`}
            disabled={saving !== null || value.trim().length === 0}
          >
            {saving === "key" ? "验证中…" : "保存并验证"}
          </button>
        </form>

        {error ? <p className="onboarding__error">{error}</p> : null}

        <div className="onboarding__links">
          <button type="button" className="onboarding__link" onClick={() => void openPlatform()}>
            获取 DeepSeek API Key <span aria-hidden>↗</span>
          </button>
          <button
            type="button"
            className={`onboarding__toggle ${customOpen ? "is-open" : ""}`}
            aria-expanded={customOpen}
            onClick={toggleCustom}
          >
            {customOpen ? "收起其他 AI 服务" : "使用其他 AI 服务"}{" "}
            <span className="onboarding__arrow" aria-hidden>
              →
            </span>
          </button>
        </div>

        {customOpen ? (
          <form
            className="onboarding__custom"
            aria-busy={saving === "provider"}
            onSubmit={(event) => {
              event.preventDefault();
              void saveProvider();
            }}
          >
            <div className="onboarding__field">
              <span className="onboarding__field-label" id="onboarding-protocol-label">
                API 类型
              </span>
              <div
                className="onboarding__segmented"
                role="group"
                aria-labelledby="onboarding-protocol-label"
              >
                <button
                  type="button"
                  className={custom.protocol === "openai" ? "is-selected" : ""}
                  aria-pressed={custom.protocol === "openai"}
                  onClick={() => setCustom((form) => ({ ...form, protocol: "openai" }))}
                >
                  OpenAI 兼容
                </button>
                <button
                  type="button"
                  className={custom.protocol === "anthropic" ? "is-selected" : ""}
                  aria-pressed={custom.protocol === "anthropic"}
                  onClick={() => setCustom((form) => ({ ...form, protocol: "anthropic" }))}
                >
                  Anthropic 兼容
                </button>
              </div>
            </div>

            <div className="onboarding__field">
              <label className="onboarding__field-label" htmlFor="onboarding-base-url">
                Base URL
              </label>
              <input
                id="onboarding-base-url"
                className="onboarding__input"
                type="text"
                inputMode="url"
                value={custom.baseUrl}
                placeholder="https://api.example.com"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setCustom((form) => ({ ...form, baseUrl: event.target.value }))
                }
              />
            </div>

            <div className="onboarding__field">
              <label className="onboarding__field-label" htmlFor="onboarding-model">
                模型
              </label>
              <input
                id="onboarding-model"
                className="onboarding__input"
                type="text"
                value={custom.model}
                placeholder="如 deepseek-chat"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setCustom((form) => ({ ...form, model: event.target.value }))
                }
              />
            </div>

            <div className="onboarding__field">
              <label className="onboarding__field-label" htmlFor="onboarding-provider-key">
                API Key
              </label>
              <input
                id="onboarding-provider-key"
                className="onboarding__input"
                type="password"
                value={custom.apiKey}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setCustom((form) => ({ ...form, apiKey: event.target.value }))
                }
              />
            </div>

            {customError ? <p className="onboarding__error">{customError}</p> : null}

            <button
              type="submit"
              className="btn btn--primary onboarding__submit"
              disabled={saving !== null}
            >
              {saving === "provider" ? "验证中…" : "保存并验证"}
            </button>
          </form>
        ) : null}

        <div className="onboarding__divider" aria-hidden />

        <button
          type="button"
          className="onboarding__manual"
          disabled={saving !== null}
          onClick={() => onDone(true)}
        >
          我懂网络，不用 AI
        </button>
      </div>
    </div>
  );
}
