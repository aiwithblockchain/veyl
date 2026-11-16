import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { toBridgeError } from "../agent/errors";
import type { MyServerLoginTicket } from "../agent/bridge";
import { IconClose } from "./icons";

interface Props {
  onStart: (email: string) => Promise<MyServerLoginTicket>;
  onVerify: (email: string, code: string) => Promise<unknown>;
  onCancel: () => void;
  /** mock 通道不发真邮件，提示演示验证码。 */
  mockHint?: boolean;
}

interface LoginError {
  message: string;
  hint?: string;
  /** 发码冷却还差几秒。 */
  cooldown?: number;
  /** 回到第一步重新发码。 */
  backToEmail?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function startError(error: unknown): LoginError {
  const problem = toBridgeError(error);
  const reason = typeof problem.details?.reason === "string" ? problem.details.reason : "";
  if (reason === "email_invalid") {
    return { message: "邮箱格式不对。", hint: "检查一下地址，再点「发送验证码」。" };
  }
  if (reason === "email_cooldown") {
    const wait = readNumber(problem.details?.retry_after_seconds) ?? 60;
    return {
      message: "刚发过验证码。",
      hint: `还差 ${wait} 秒才能再发。`,
      cooldown: wait,
    };
  }
  if (reason === "email_rate_limited") {
    return { message: "发得太频繁了。", hint: "等一会儿再点「发送验证码」。" };
  }
  if (problem.code === "UNSUPPORTED") {
    return { message: problem.message, hint: "换一个版本再试。" };
  }
  if (problem.code === "TIMEOUT" || problem.code === "NETWORK") {
    return { message: "没发出去。", hint: "检查网络后再点「发送验证码」。" };
  }
  return {
    message: problem.message && problem.message !== "操作失败" ? problem.message : "没发出去。",
    hint: "稍后再点「发送验证码」。",
  };
}

function verifyError(error: unknown): LoginError {
  const problem = toBridgeError(error);
  const reason = typeof problem.details?.reason === "string" ? problem.details.reason : "";
  if (reason === "code_invalid") {
    const left = readNumber(problem.details?.attempts_remaining);
    return {
      message: "验证码不对。",
      hint: left === null ? "再输一次。" : `还可以试 ${Math.max(0, left)} 次。`,
    };
  }
  if (reason === "code_expired") {
    return {
      message: "验证码过期了。",
      hint: "重新发一次验证码。",
      backToEmail: true,
    };
  }
  if (reason === "too_many_attempts") {
    return {
      message: "这个验证码已作废。",
      hint: "重新发一次验证码。",
      backToEmail: true,
    };
  }
  if (reason === "account_conflict") {
    return {
      message: "这台设备已经绑定了另一个邮箱。",
      hint: "先在账号块里退出当前账户，再登录这个邮箱。",
      backToEmail: true,
    };
  }
  if (reason === "device_revoked") {
    return { message: "这台设备已被停用。", hint: "换一台设备再登录。" };
  }
  if (problem.code === "UNSUPPORTED") {
    return { message: problem.message, hint: "换一个版本再试。" };
  }
  if (problem.code === "TIMEOUT" || problem.code === "NETWORK") {
    return { message: "没连上服务器。", hint: "检查网络后再点「登录」。" };
  }
  return {
    message: problem.message && problem.message !== "操作失败" ? problem.message : "登录没成功。",
    hint: "稍后再点「登录」。",
  };
}

/** 唯一的登录模态：邮箱 → 验证码；登录成功由父组件关闭并刷新列表。 */
export function MyServerLogin({ onStart, onVerify, onCancel, mockHint = false }: Props) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<LoginError | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const busyRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  useEffect(() => {
    if (step !== "code" || cooldown <= 0) return;
    const timer = window.setTimeout(
      () => setCooldown((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [step, cooldown]);

  const requestCode = async () => {
    if (busyRef.current) return;
    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setError({ message: "邮箱格式不对。", hint: "检查一下地址，再点「发送验证码」。" });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const ticket = await onStart(value);
      setStep("code");
      setCode("");
      setCooldown(ticket.cooldown_seconds > 0 ? ticket.cooldown_seconds : 60);
    } catch (err) {
      const mapped = startError(err);
      setError(mapped);
      if (mapped.cooldown !== undefined) setCooldown(mapped.cooldown);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const sendCode = (event: FormEvent) => {
    event.preventDefault();
    void requestCode();
  };

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    const value = email.trim();
    const input = code.trim();
    if (!/^\d{6}$/.test(input)) {
      setError({ message: "验证码是 6 位数字。", hint: "看一下邮件里的 6 位码。" });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onVerify(value, input);
    } catch (err) {
      const mapped = verifyError(err);
      setError(mapped);
      if (mapped.backToEmail) {
        setStep("email");
        setCode("");
        setCooldown(0);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !busyRef.current && onCancel()}>
      <div
        className="modal myservers-login"
        role="dialog"
        aria-modal="true"
        aria-labelledby="myservers-login-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 id="myservers-login-title" className="modal__title">
            登录我的服务器
          </h2>
          <button
            type="button"
            className="modal__close"
            aria-label="关闭"
            disabled={busy}
            onClick={onCancel}
          >
            <IconClose size={14} />
          </button>
        </header>

        {step === "email" ? (
          <form className="myservers__login-form myservers-login__body" onSubmit={sendCode}>
            <label className="myservers__field">
              <span>邮箱</span>
              <input
                type="email"
                value={email}
                autoFocus
                placeholder="you@example.com"
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            {error ? (
              <>
                <p className="myservers__error" role="alert">
                  {error.message}
                </p>
                {error.hint ? <p className="myservers__hint">{error.hint}</p> : null}
              </>
            ) : (
              <p className="myservers__hint">发一个 6 位验证码到这个邮箱。</p>
            )}
            <div className="myservers__login-actions">
              <button
                type="submit"
                className="btn btn--primary"
                disabled={busy || cooldown > 0}
                aria-busy={busy || undefined}
              >
                {busy
                  ? "正在发送…"
                  : cooldown > 0
                    ? `${cooldown} 秒后可重发`
                    : "发送验证码"}
              </button>
            </div>
          </form>
        ) : (
          <form className="myservers__login-form myservers-login__body" onSubmit={signIn}>
            <p className="myservers__hint">验证码已发到 {email.trim()}。</p>
            {mockHint ? (
              <p className="myservers__hint">演示环境：验证码固定 123456。</p>
            ) : null}
            <label className="myservers__field">
              <span>验证码</span>
              <input
                inputMode="numeric"
                value={code}
                autoFocus
                maxLength={6}
                disabled={busy}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              />
            </label>
            {error ? (
              <>
                <p className="myservers__error" role="alert">
                  {error.message}
                </p>
                {error.hint ? <p className="myservers__hint">{error.hint}</p> : null}
              </>
            ) : null}
            <div className="myservers__login-actions">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setError(null);
                }}
              >
                换一个邮箱
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy || cooldown > 0}
                onClick={() => void requestCode()}
              >
                {cooldown > 0 ? `${cooldown} 秒后可重发` : "重发验证码"}
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={busy}
                aria-busy={busy || undefined}
              >
                {busy ? "正在登录…" : "登录"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
