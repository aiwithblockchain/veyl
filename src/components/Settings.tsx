import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBridge, DeepSeekKeyState } from "../agent/bridge";

interface Props {
  open: boolean;
  bridge: AgentBridge;
  onClose: () => void;
}

type Feedback = { kind: "ok" | "warn" | "error"; text: string } | null;

export function Settings({ open, bridge, onClose }: Props) {
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
  const inputRef = useRef<HTMLInputElement>(null);

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
    setFeedback(null);
    setValue("");
    setReveal(false);
    refresh();
  }, [open, refresh]);

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

  if (!open) return null;

  const save = async () => {
    const key = value.trim();
    if (!key || saving) return;

    setSaving(true);
    setFeedback(null);
    try {
      const next = await bridge.saveDeepSeekKey(key);
      setState(next);
      // 后端一定回 masked；万一是 null，就留在输入态，别假装保存成功。
      setEditing(next.masked === null);
      // 明文立刻从组件状态里清掉，不留在内存里等下一次渲染。
      setValue("");
      setReveal(false);
      setFeedback(
        next.verified
          ? { kind: "ok", text: "已保存，并验证可用。" }
          : { kind: "warn", text: "已保存，但当前没能验证（网络不可用）。稍后可以重试。" },
      );
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
    } catch (error) {
      setFeedback({ kind: "error", text: describeClearError(error) });
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
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
            ×
          </button>
        </header>

        <section className="settings-section">
          <h3 className="settings-section__title">DeepSeek API Key</h3>

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
                <button type="button" className="btn btn--ghost" onClick={() => setEditing(true)}>
                  更换
                </button>
                <button type="button" className="btn btn--danger-ghost" onClick={() => void clear()}>
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
            Key 加密保存在本机，仅用于调用模型接口；建议使用可随时吊销的 Key。界面只显示打码后的末四位。
          </p>
        </section>
      </div>
    </div>
  );
}

/** 后端错误对象形如 `{ code, message }`；这里翻成用户能行动的话，不甩原始报错。 */
function describeKeyError(error: unknown): string {
  const code = readCode(error);

  switch (code) {
    case "INVALID_ARGUMENT":
      return "Key 格式不对：应以 sk- 开头，长度至少 20 位。";
    case "INVALID_KEY":
      // 后端语义：Key 已落盘，只是鉴权没过。
      return "Key 已保存在本机，但 DeepSeek 鉴权失败（可能无效或已被吊销）。请重新输入一个有效的 Key。";
    case "SECRET_STORE":
      // 契约 1.0.6：凭据存本地加密文件 secrets.enc，失败统一用这个码。
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
