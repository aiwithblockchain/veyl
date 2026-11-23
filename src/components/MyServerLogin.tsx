import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { toBridgeError } from "../agent/errors";
import { errorText } from "../i18n/errorText";
import type { MyServerLoginTicket } from "../agent/bridge";
import { IconClose } from "./icons";
import { t, useT } from "../i18n";

interface Props {
  onStart: (email: string) => Promise<MyServerLoginTicket>;
  onVerify: (email: string, code: string) => Promise<unknown>;
  /** 设备身份丢了：重新注册设备；返回是否恢复成功。 */
  onReRegister?: () => Promise<boolean>;
  onCancel: () => void;
}

interface LoginError {
  message: string;
  hint?: string;
  /** 发码冷却还差几秒。 */
  cooldown?: number;
  /** 回到第一步重新发码。 */
  backToEmail?: boolean;
  /** 码已经发过且仍有效：直接进入验证码步骤。 */
  toCode?: boolean;
  /** 中性提示，不用红色错误样式。 */
  tone?: "error" | "notice";
  /** 清空已输入的验证码。 */
  clearCode?: boolean;
  /** 设备身份对不上：给「重新注册设备」入口。 */
  reRegister?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function startError(error: unknown): LoginError {
  const problem = toBridgeError(error);
  const reason = typeof problem.details?.reason === "string" ? problem.details.reason : "";
  if (reason === "email_invalid") {
    return { message: t("login.error.emailInvalid"), hint: t("login.hint.emailInvalid") };
  }
  if (reason === "email_cooldown") {
    const wait = readNumber(problem.details?.retry_after_seconds) ?? 60;
    // 码已经发过且仍有效：不是失败，直接让用户输码。
    return {
      message: t("login.notice.codeSent"),
      hint: t("login.hint.cooldown", { seconds: wait }),
      cooldown: wait,
      toCode: true,
      tone: "notice",
    };
  }
  if (reason === "email_rate_limited") {
    return { message: t("login.error.rateLimited"), hint: t("login.hint.rateLimited") };
  }
  if (problem.code === "UNSUPPORTED") {
    return {
      message: errorText(error, t("login.error.sendFailed")),
      hint: t("login.hint.otherVersion"),
    };
  }
  if (problem.code === "TIMEOUT" || problem.code === "NETWORK") {
    return { message: t("login.error.sendFailed"), hint: t("login.hint.sendFailed") };
  }
  return {
    message: errorText(error, t("login.error.sendFailed")),
    hint: t("login.hint.sendFailedLater"),
  };
}

function verifyError(error: unknown): LoginError {
  const problem = toBridgeError(error);
  const reason = typeof problem.details?.reason === "string" ? problem.details.reason : "";
  if (reason === "code_invalid") {
    const left = readNumber(problem.details?.attempts_remaining);
    return {
      message: t("login.error.codeInvalid"),
      hint:
        left === null
          ? t("login.hint.tryAgain")
          : t("login.hint.attemptsLeft", { count: Math.max(0, left) }),
    };
  }
  if (reason === "code_expired") {
    return {
      message: t("login.error.codeExpired"),
      hint: t("login.hint.tapResend"),
      clearCode: true,
    };
  }
  if (reason === "too_many_attempts") {
    return {
      message: t("login.error.tooManyAttempts"),
      hint: t("login.hint.sendNewCode"),
      backToEmail: true,
    };
  }
  if (reason === "account_conflict") {
    return {
      message: t("login.error.accountConflict"),
      hint: t("login.hint.accountConflict"),
      backToEmail: true,
    };
  }
  if (
    reason === "device_mismatch" ||
    reason === "device_identity_lost" ||
    reason === "device_missing"
  ) {
    return {
      message: t("login.error.deviceMismatch"),
      hint: t("login.hint.deviceMismatch"),
      reRegister: true,
    };
  }
  if (reason === "device_revoked") {
    return {
      message: t("login.error.deviceRevoked"),
      hint: t("login.hint.deviceRevoked"),
      reRegister: true,
    };
  }
  if (reason === "account_blocked") {
    return {
      message: t("login.error.accountBlocked"),
      hint: t("login.hint.accountBlocked"),
    };
  }
  if (problem.code === "UNSUPPORTED") {
    return {
      message: errorText(error, t("login.error.failed")),
      hint: t("login.hint.otherVersion"),
    };
  }
  if (problem.code === "TIMEOUT" || problem.code === "NETWORK") {
    return { message: t("login.error.network"), hint: t("login.hint.network") };
  }
  return {
    message: errorText(error, t("login.error.failed")),
    hint: t("login.hint.failed"),
  };
}

/** 唯一的登录模态：邮箱 → 验证码；登录成功由父组件关闭并刷新列表。 */
export function MyServerLogin({ onStart, onVerify, onReRegister, onCancel }: Props) {
  const tr = useT();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<LoginError | null>(null);
  const [busy, setBusy] = useState(false);
  const [reRegistering, setReRegistering] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const busyRef = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  // 两个步骤共用同一个倒数：退回邮箱步骤后数字也要继续走，别冻在旧值上。
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(
      () => setCooldown((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const requestCode = async () => {
    if (busyRef.current) return;
    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setError({ message: tr("login.error.emailInvalid"), hint: tr("login.hint.emailInvalid") });
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
      if (mapped.toCode) {
        setStep("code");
        setCode("");
      }
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
      setError({ message: tr("login.error.codeLength"), hint: tr("login.hint.codeLength") });
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
      if (mapped.clearCode) setCode("");
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

  const reRegisterDevice = async () => {
    if (reRegistering || !onReRegister) return;
    setReRegistering(true);
    try {
      const ok = await onReRegister();
      setError(
        ok
          ? { message: tr("login.notice.reRegistered"), tone: "notice" }
          : {
              message: tr("login.error.reRegisterFailed"),
              hint: tr("login.hint.reRegisterFailed"),
            },
      );
    } catch {
      setError({
        message: tr("login.error.reRegisterFailed"),
        hint: tr("login.hint.reRegisterFailed"),
      });
    } finally {
      setReRegistering(false);
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
            {tr("login.title")}
          </h2>
          <button
            type="button"
            className="modal__close"
            aria-label={tr("common.close")}
            disabled={busy}
            onClick={onCancel}
          >
            <IconClose size={14} />
          </button>
        </header>

        {step === "email" ? (
          <form className="myservers__login-form myservers-login__body" onSubmit={sendCode}>
            <label className="myservers__field">
              <span>{tr("login.email")}</span>
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
              <p className="myservers__hint">{tr("login.sendHint")}</p>
            )}
            <div className="myservers__login-actions">
              <button
                type="submit"
                className="btn btn--primary"
                disabled={busy || cooldown > 0}
                aria-busy={busy || undefined}
              >
                {busy
                  ? tr("login.sending")
                  : cooldown > 0
                    ? tr("login.resendIn", { seconds: cooldown })
                    : tr("login.sendCode")}
              </button>
            </div>
          </form>
        ) : (
          <form className="myservers__login-form myservers-login__body" onSubmit={signIn}>
            {error?.tone === "notice" ? (
              <p className="myservers__notice" role="status">
                {error.message}
                {error.hint ? ` ${error.hint}` : ""}
              </p>
            ) : (
              <p className="myservers__hint">{tr("login.sentTo", { email: email.trim() })}</p>
            )}
            <label className="myservers__field">
              <span>{tr("login.code")}</span>
              <input
                inputMode="numeric"
                value={code}
                autoFocus
                maxLength={6}
                disabled={busy}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              />
            </label>
            {error && error.tone !== "notice" ? (
              <>
                <p className="myservers__error" role="alert">
                  {error.message}
                </p>
                {error.hint ? <p className="myservers__hint">{error.hint}</p> : null}
              </>
            ) : null}
            {error?.reRegister ? (
              <div className="myservers__login-actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy || reRegistering}
                  aria-busy={reRegistering || undefined}
                  onClick={() => void reRegisterDevice()}
                >
                  {reRegistering ? tr("login.reRegistering") : tr("login.reRegister")}
                </button>
              </div>
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
                {tr("login.changeEmail")}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy || cooldown > 0}
                onClick={() => void requestCode()}
              >
                {cooldown > 0 ? tr("login.resendIn", { seconds: cooldown }) : tr("login.resend")}
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={busy}
                aria-busy={busy || undefined}
              >
                {busy ? tr("login.signingIn") : tr("login.submit")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
