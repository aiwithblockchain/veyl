import { useState } from "react";
import type { AgentBridge, DeepSeekKeyState } from "../agent/bridge";
import { describeKeyError } from "./Settings";
import { PRODUCT_NAME } from "../brand";

const PLATFORM_URL = "https://platform.deepseek.com/";

interface Props {
  bridge: AgentBridge;
  initialKey: DeepSeekKeyState;
  /** 完成或跳过引导：skippedKey 表示用户明确跳过了 Key 这一步。 */
  onDone: (skippedKey: boolean) => void;
  /** 选「导入文件」：由 App 记录完成状态并打开设置页的导入区。 */
  onImport: (skippedKey: boolean) => void;
}

const STEP_LABELS = ["认识 " + PRODUCT_NAME, "配置 DeepSeek Key", "准备配置文件"];

function keyStatusText(state: DeepSeekKeyState): string | null {
  if (!state.masked) return null;
  if (state.validation === "ok") return "已验证";
  if (state.validation === "invalid") return "无效或已吊销";
  return "已保存但未验证";
}

export function Onboarding({ bridge, initialKey, onDone, onImport }: Props) {
  const [step, setStep] = useState(0);
  const [keyState, setKeyState] = useState<DeepSeekKeyState>(initialKey);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [keySkipped, setKeySkipped] = useState(false);

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
      // 失败时保留输入，方便改完重试；只有成功才清空。
      setValue("");
      setKeySkipped(false);
    } catch (saveError) {
      setError(describeKeyError(saveError));
    } finally {
      setSaving(false);
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

  const skipKey = () => {
    setKeySkipped(true);
    setStep(2);
  };

  return (
    <div className="onboarding">
      <div className="onboarding__card">
        <ol className="onboarding__steps">
          {STEP_LABELS.map((label, index) => (
            <li
              key={label}
              className={
                index === step ? "is-active" : index < step ? "is-done" : undefined
              }
            >
              <span className="onboarding__step-index">{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <section className="onboarding__body">
            <h1 className="onboarding__title">一个会自己动手的网络工具</h1>
            <p className="onboarding__text">
              {PRODUCT_NAME} 把「连上网络」这件事拆成几个你可以直接看到的动作：下载运行时、挑选节点、连接、接管系统代理。你可以用一句话指挥它，也可以完全不用 AI，直接用按钮操作。
            </p>
            <div className="onboarding__columns">
              <div>
                <h2 className="onboarding__heading">它现在能做什么</h2>
                <ul className="onboarding__list">
                  <li>导入节点文件并连接、断开</li>
                  <li>解释连接失败的原因</li>
                  <li>在断网时帮你恢复网络</li>
                </ul>
              </div>
              <div>
                <h2 className="onboarding__heading">需要你准备</h2>
                <ul className="onboarding__list">
                  <li>DeepSeek API Key（可选，用于对话与诊断）</li>
                  <li>一个节点配置文件（.json）</li>
                </ul>
              </div>
            </div>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="onboarding__body">
            <h1 className="onboarding__title">配置 DeepSeek Key</h1>
            <p className="onboarding__text">
              AI 用来看懂你的意图、解释错误、推荐节点。它不代理你的流量，也看不到你的账号密码。没有 Key 也能导入节点并连接，只是用不了对话和 AI 诊断。
            </p>

            <div className="onboarding__link-row">
              <button type="button" className="btn btn--primary" onClick={() => void openPlatform()}>
                打开 DeepSeek 开放平台
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void copyLink()}>
                {copied ? "已复制" : "复制链接"}
              </button>
            </div>
            <code className="onboarding__url">{PLATFORM_URL}</code>

            <ol className="onboarding__list onboarding__list--ordered">
              <li>注册 / 登录</li>
              <li>进入「API Keys」</li>
              <li>创建新的 Key</li>
              <li>复制以 sk- 开头的字符串</li>
              <li>粘贴回这里并保存</li>
            </ol>

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
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void saveKey()}
                  disabled={saving || value.trim().length === 0}
                >
                  {saving ? "验证中…" : "保存并验证"}
                </button>
              </div>
            )}

            {error ? <p className="onboarding__error">{error}</p> : null}
          </section>
        ) : null}

        {step === 2 ? (
          <section className="onboarding__body">
            <h1 className="onboarding__title">准备一个配置文件</h1>
            <p className="onboarding__text">
              节点信息放在一个 .json 文件里。你可以用官方默认配置，或导入朋友发给你的文件。
            </p>
            <p className="onboarding__text onboarding__text--faint">
              没有网络也能导入本地文件；官方默认配置需要联网，暂时不可达属于正常现象。
            </p>

            <div className="onboarding__choices">
              <div className="onboarding__choice">
                <h2 className="onboarding__heading">使用官方默认配置</h2>
                <p className="onboarding__choice-text">由官方维护、自动更新。后端将在下一个版本接入。</p>
                <button type="button" className="btn btn--ghost" disabled>
                  即将支持
                </button>
              </div>
              <div className="onboarding__choice">
                <h2 className="onboarding__heading">导入我收到的文件</h2>
                <p className="onboarding__choice-text">选择或拖入 .json 文件，立即导入节点。</p>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => onImport(keySkipped || keyState.masked === null)}
                >
                  导入文件
                </button>
              </div>
            </div>

            <p className="onboarding__text onboarding__text--faint">
              两者都不选也可以继续，主界面会一直提示你补上这一步。
            </p>
          </section>
        ) : null}

        <footer className="onboarding__footer">
          {step > 0 ? (
            <button type="button" className="btn btn--ghost" onClick={() => setStep(step - 1)}>
              上一步
            </button>
          ) : (
            <span />
          )}

          <div className="onboarding__footer-right">
            {step === 1 ? (
              <button type="button" className="btn btn--ghost" onClick={skipKey}>
                跳过这一步
              </button>
            ) : null}
            {step === 2 ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => onDone(keySkipped || keyState.masked === null)}
              >
                稍后再说
              </button>
            ) : null}
            {step < 2 ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setStep(step + 1)}
                disabled={step === 1 && keyState.masked === null && !keySkipped}
              >
                下一步
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
