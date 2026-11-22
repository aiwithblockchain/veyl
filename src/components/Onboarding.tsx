import { useEffect, useRef, useState } from "react";
import type {
  AgentBridge,
  LlmProtocol,
  LlmProviderInput,
} from "../agent/bridge";
import { isHttpUrl, isLocalEndpoint } from "../agent/bridge";
import { providerUsable } from "../config/onboarding";
import { describeKeyError, describeProviderError } from "./Settings";
import { isComposingEvent } from "../ui/ime";
import { useT } from "../i18n";
import { PRODUCT_NAME } from "../brand";
import logoUrl from "../assets/logo.png";

const PLATFORM_URL = "https://platform.deepseek.com/";

interface Props {
  bridge: AgentBridge;
  /** 首启成功：App 负责打开右栏并刷新 AI 状态。 */
  onDone: () => void;
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

function VerifyingDots() {
  const t = useT();
  return (
    <>
      <span className="sr-only">{t("onboarding.verifying")}</span>
      <span className="first-run__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </>
  );
}

function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return true;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Onboarding({ bridge, onDone }: Props) {
  const t = useT();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState<"key" | "provider" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState<CustomForm>(EMPTY_CUSTOM);
  const [customError, setCustomError] = useState<string | null>(null);
  const [fading, setFading] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const focusKeyOnReturn = useRef(false);

  useEffect(() => {
    // 读一次已保存的 Key 状态；Host 版本不支持时静默，不阻塞首屏。
    void bridge.getDeepSeekKey().catch(() => {});
  }, [bridge]);

  useEffect(() => {
    if (!customOpen && focusKeyOnReturn.current) {
      focusKeyOnReturn.current = false;
      keyInputRef.current?.focus();
    }
  }, [customOpen]);

  const saveKey = async () => {
    const key = value.trim();
    if (!key || saving) return;
    if (!key.startsWith("sk-")) {
      setError(t("onboarding.error.keyPrefix"));
      return;
    }

    setSaving("key");
    setError(null);
    try {
      await bridge.saveDeepSeekKey(key);
      setValue("");
      onDone();
    } catch (saveError) {
      setError(describeKeyError(saveError));
    } finally {
      setSaving(null);
    }
  };

  const openPlatform = async () => {
    setError(null);
    setCustomError(null);
    try {
      await bridge.openExternal(PLATFORM_URL);
    } catch {
      const message = t("onboarding.error.openBrowser", { url: PLATFORM_URL });
      if (customOpen) setCustomError(message);
      else setError(message);
    }
  };

  const switchMode = (next: boolean) => {
    if (next === customOpen || fading) return;
    setCustomError(null);
    setError(null);
    if (!next) focusKeyOnReturn.current = true;
    if (prefersReducedMotion()) {
      setCustomOpen(next);
      setFading(false);
      return;
    }
    setFading(true);
    window.setTimeout(() => {
      setCustomOpen(next);
      // 不用 requestAnimationFrame：窗口被遮挡时它会停，界面会卡在透明态。
      window.setTimeout(() => setFading(false), 20);
    }, 160);
  };

  const customReady =
    custom.baseUrl.trim() !== "" &&
    custom.model.trim() !== "" &&
    (custom.apiKey.trim() !== "" || isLocalEndpoint(custom.baseUrl));

  const buildProviderInput = (): LlmProviderInput | string => {
    const model = custom.model.trim();
    if (!model) return t("onboarding.error.modelRequired");

    const baseUrl = custom.baseUrl.trim();
    if (!isHttpUrl(baseUrl)) return t("onboarding.error.baseUrlScheme");
    if (baseUrl.toLowerCase().startsWith("http://") && !isLocalEndpoint(baseUrl)) {
      return t("onboarding.error.httpLocalOnly");
    }

    const apiKey = custom.apiKey.trim();
    if (!apiKey && !isLocalEndpoint(baseUrl)) {
      return t("onboarding.error.apiKeyRequired");
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
        setCustomError(result.error || t("onboarding.error.providerTest"));
        return;
      }
      const saved = await bridge.llmProviderSave(input);
      try {
        await bridge.llmProviderActivate(saved.providerId);
      } catch {
        // activate 不一定成功；保存后还要用列表复核当前 AI。
      }

      let activeId: string | null = null;
      let savedUsable = false;
      try {
        const list = await bridge.llmProviderList();
        activeId = list.activeProviderId;
        const listed = list.providers.find(
          (provider) => provider.providerId === saved.providerId,
        );
        savedUsable = listed ? providerUsable(listed) : false;
      } catch {
        // 读不到列表就按「没能确认当前 AI」处理，停在首屏。
      }

      if (activeId !== saved.providerId || !savedUsable) {
        setCustomError(t("onboarding.error.notActivated"));
        return;
      }
      onDone();
    } catch (saveError) {
      setCustomError(describeProviderError(saveError));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="first-run">
      <div className="first-run__shell">
        <div className="first-run__brand">
          <img src={logoUrl} alt="" width={48} height={48} />
          <span>{PRODUCT_NAME}</span>
        </div>
        <h1 className="first-run__title">
          Veyl keeps your line open.
        </h1>

        <div className={`first-run__switcher ${fading ? "is-fading" : ""}`}>
          {customOpen ? (
            <form
              className="first-run__custom"
              aria-busy={saving === "provider"}
              onSubmit={(event) => {
                event.preventDefault();
                void saveProvider();
              }}
              onKeyDown={(event) => {
                if (isComposingEvent(event)) event.preventDefault();
              }}
            >
              <button
                type="button"
                className="first-run__back"
                onClick={() => switchMode(false)}
              >
                {t("onboarding.backToKey")}
              </button>

              <div className="first-run__custom-head">
                <h2 className="first-run__custom-title">{t("onboarding.customTitle")}</h2>
                <p className="first-run__custom-sub">{t("onboarding.customSub")}</p>
              </div>

              <div className="first-run__field">
                <span className="first-run__label" id="first-run-protocol-label">
                  {t("onboarding.protocolLabel")}
                </span>
                <div
                  className="first-run__segmented"
                  role="group"
                  aria-labelledby="first-run-protocol-label"
                >
                  <button
                    type="button"
                    className={custom.protocol === "openai" ? "is-selected" : ""}
                    aria-pressed={custom.protocol === "openai"}
                    onClick={() =>
                      setCustom((form) => ({ ...form, protocol: "openai" }))
                    }
                  >
                    {t("onboarding.protocolOpenai")}
                  </button>
                  <button
                    type="button"
                    className={
                      custom.protocol === "anthropic" ? "is-selected" : ""
                    }
                    aria-pressed={custom.protocol === "anthropic"}
                    onClick={() =>
                      setCustom((form) => ({ ...form, protocol: "anthropic" }))
                    }
                  >
                    {t("onboarding.protocolAnthropic")}
                  </button>
                </div>
              </div>

              <div className="first-run__field">
                <label className="first-run__label" htmlFor="first-run-base-url">
                  Base URL
                </label>
                <input
                  id="first-run-base-url"
                  className="first-run__input"
                  type="text"
                  inputMode="url"
                  value={custom.baseUrl}
                  placeholder="https://api.example.com"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setCustom((form) => ({
                      ...form,
                      baseUrl: event.target.value,
                    }))
                  }
                />
                <p className="first-run__hint">{t("onboarding.baseUrlHint")}</p>
              </div>

              <div className="first-run__field">
                <label className="first-run__label" htmlFor="first-run-model">
                  {t("onboarding.modelLabel")}
                </label>
                <input
                  id="first-run-model"
                  className="first-run__input"
                  type="text"
                  value={custom.model}
                  placeholder={t("onboarding.modelPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setCustom((form) => ({ ...form, model: event.target.value }))
                  }
                />
                <p className="first-run__hint">{t("onboarding.modelHint")}</p>
              </div>

              <div className="first-run__field">
                <label
                  className="first-run__label"
                  htmlFor="first-run-provider-key"
                >
                  API Key
                </label>
                <input
                  id="first-run-provider-key"
                  className="first-run__input"
                  type="password"
                  value={custom.apiKey}
                  placeholder="sk-…"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setCustom((form) => ({
                      ...form,
                      apiKey: event.target.value,
                    }))
                  }
                />
                <p className="first-run__hint">
                  {t("onboarding.keyHint")}
                </p>
              </div>

              {customError ? (
                <p className="first-run__error" role="alert">
                  {customError}
                </p>
              ) : null}

              <button
                type="submit"
                className={`first-run__submit ${
                  saving === "provider" ? "is-verifying" : ""
                }`}
                disabled={saving !== null || !customReady}
              >
                {saving === "provider" ? (
                  <VerifyingDots />
                ) : (
                  t("onboarding.connect")
                )}
              </button>
            </form>
          ) : (
            <>
              <form
                className="first-run__form"
                aria-busy={saving === "key"}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveKey();
                }}
                onKeyDown={(event) => {
                  // 组合期间不让表单隐式提交（WebKit 会把组合态回车当提交）。
                  if (isComposingEvent(event)) event.preventDefault();
                }}
              >
                <div className="first-run__field">
                  <label
                    className="first-run__label"
                    htmlFor="first-run-deepseek-key"
                  >
                    DeepSeek API Key
                  </label>
                  <input
                    id="first-run-deepseek-key"
                    ref={keyInputRef}
                    className="first-run__input"
                    type="password"
                    value={value}
                    placeholder="sk-…"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "first-run-key-error" : undefined}
                    onChange={(event) => {
                      setValue(event.target.value);
                      if (error) setError(null);
                    }}
                  />
                </div>
                {error ? (
                  <p
                    id="first-run-key-error"
                    className="first-run__error"
                    role="alert"
                  >
                    {error}
                  </p>
                ) : null}
                <button
                  type="submit"
                  className={`first-run__submit ${
                    saving === "key" ? "is-verifying" : ""
                  }`}
                  disabled={saving !== null || value.trim().length === 0}
                >
                  {saving === "key" ? <VerifyingDots /> : t("onboarding.connect")}
                </button>
              </form>

              <div className="first-run__links">
                <button
                  type="button"
                  className="first-run__link"
                  onClick={() => void openPlatform()}
                >
                  {t("onboarding.getKey")} <span aria-hidden>↗</span>
                </button>
                <button
                  type="button"
                  className="first-run__link"
                  onClick={() => switchMode(true)}
                >
                  {t("onboarding.useOtherAi")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
