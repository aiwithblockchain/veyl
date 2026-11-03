import { useState } from "react";
import type { AgentBridge, DeepSeekKeyState } from "../agent/bridge";
import { describeKeyError } from "./Settings";
import { PRODUCT_NAME } from "../brand";

const PLATFORM_URL = "https://platform.deepseek.com/";

interface Props {
  bridge: AgentBridge;
  initialKey: DeepSeekKeyState;
  /** 第一步：用默认配置包直接连接；返回的 Promise 结束时才解除 busy。 */
  onConnectTest: () => Promise<void> | void;
  /** 第一步：去导入自己的配置文件。 */
  onImport: () => void;
  /** 完成或跳过：skippedKey 表示用户明确没有配置 Key。 */
  onDone: (skippedKey: boolean) => void;
}

function keyStatusText(state: DeepSeekKeyState): string | null {
  if (!state.masked) return null;
  if (state.validation === "ok") return "已验证";
  if (state.validation === "invalid") return "无效或已吊销";
  return "已保存但未验证";
}

export function Onboarding({ bridge, initialKey, onConnectTest, onImport, onDone }: Props) {
  const [step, setStep] = useState<0 | 1>(0);
  const [keyState, setKeyState] = useState<DeepSeekKeyState>(initialKey);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const saveKey = async () => {
    const key = value.trim();
    if (!key || saving) return;
    if (!key.startsWith("sk-")) {
      setError("Key 应以 sk- 开头，请检查是否复制完整。");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const next = await bridge.saveDeepSeekKey(key);
      setKeyState(next);
      setValue("");
      onDone(false);
    } catch (saveError) {
      setError(describeKeyError(saveError));
    } finally {
      setSaving(false);
    }
  };

  const connectTest = async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      await onConnectTest();
    } finally {
      setConnecting(false);
    }
  };

  const openPlatform = async () => {
    try {
      await bridge.openExternal(PLATFORM_URL);
    } catch {
      setError(`当前版本还不能直接打开浏览器，请手动访问 ${PLATFORM_URL}`);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(PLATFORM_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("复制失败，请手动选中链接复制。");
    }
  };

  if (step === 0) {
    return (
      <div className="onboarding">
        <div className="onboarding__card onboarding__card--intro">
          <span className="onboarding__brand">{PRODUCT_NAME}</span>
          <h1 className="onboarding__title">先连上，再聊。</h1>
          <p className="onboarding__text">
            用官方提供的测试节点，点一下就能用。不需要先配置 AI，也不需要先读文档。
          </p>

          <div className="onboarding__line" aria-hidden>
            <span className="onboarding__line-dot" />
            <span className="onboarding__line-rail" />
            <span className="onboarding__line-dot" />
          </div>

          <div className="onboarding__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void connectTest()}
              disabled={connecting}
            >
              {connecting ? "正在连接…" : "连接测试节点"}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onImport}
              disabled={connecting}
            >
              导入我的配置文件
            </button>
          </div>

          <button
            type="button"
            className="onboarding__skip"
            onClick={() => onDone(true)}
            disabled={connecting}
          >
            跳过，直接进入
          </button>

          <p className="onboarding__next">
            下一步：配置 AI（可选）
            <button
              type="button"
              className="onboarding__next-link"
              onClick={() => setStep(1)}
              disabled={connecting}
            >
              现在配置
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding">
      <div className="onboarding__card">
        <button type="button" className="onboarding__back" onClick={() => setStep(0)}>
          ← 返回
        </button>
        <h1 className="onboarding__title">配置 AI（可选）</h1>
        <p className="onboarding__text">
          AI 用来看懂你的意图、解释错误、推荐节点。它不代理你的流量，也看不到你的账号密码。不配置也能导入节点并连接。
        </p>

        <p className="onboarding__text onboarding__text--faint">
          打开{" "}
          <button type="button" className="onboarding__link" onClick={() => void openPlatform()}>
            platform.deepseek.com
          </button>{" "}
          创建以 sk- 开头的 Key，再粘贴回这里。
        </p>

        {keyState.masked ? (
          <div className="onboarding__saved">
            <code>{keyState.masked}</code>
            <span className={`onboarding__badge onboarding__badge--${keyState.validation}`}>
              {keyStatusText(keyState)}
            </span>
          </div>
        ) : (
          <div className="onboarding__key-row">
            <input
              type="password"
              value={value}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              aria-label="DeepSeek API Key"
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveKey();
                }
              }}
            />
          </div>
        )}

        {error ? <p className="onboarding__error">{error}</p> : null}

        <div className="onboarding__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void saveKey()}
            disabled={saving || value.trim().length === 0}
          >
            {saving ? "验证中…" : "保存并验证"}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => onDone(true)}>
            稍后再说
          </button>
          <button type="button" className="onboarding__copy" onClick={() => void copyLink()}>
            {copied ? "已复制链接" : "复制平台链接"}
          </button>
        </div>
      </div>
    </div>
  );
}
