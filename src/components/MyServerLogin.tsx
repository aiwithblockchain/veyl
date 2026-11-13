import { useState } from "react";
import type { FormEvent } from "react";
import { MOCK_EMAIL_CODE, saveAccount } from "../myservers/account";

interface Props {
  onDone: (email: string) => void;
  onCancel: () => void;
}

/** 登录门：本期不发真邮件，验证码固定 123456。 */
export function MyServerLogin({ onDone, onCancel }: Props) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);

  const sendCode = (event: FormEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError("邮箱格式不对，检查一下再试。");
      return;
    }
    setError(null);
    setStep("code");
  };

  const signIn = (event: FormEvent) => {
    event.preventDefault();
    if (code.trim() !== MOCK_EMAIL_CODE) {
      setError("验证码不对，再输一次。");
      return;
    }
    setError(null);
    saveAccount(email);
    onDone(email.trim());
  };

  return (
    <div className="myservers__login" role="dialog" aria-label="登录">
      <h4 className="myservers__login-title">登录我的服务器</h4>
      {step === "email" ? (
        <form className="myservers__login-form" onSubmit={sendCode}>
          <label className="myservers__field">
            <span>邮箱</span>
            <input
              type="email"
              value={email}
              autoFocus
              placeholder="you@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          {error ? (
            <p className="myservers__error" role="alert">
              {error}
            </p>
          ) : null}
          <p className="myservers__hint">本期不发真实邮件，验证码固定 123456。</p>
          <div className="myservers__login-actions">
            <button type="button" className="btn btn--ghost" onClick={onCancel}>
              返回
            </button>
            <button type="submit" className="btn btn--primary">
              发送验证码
            </button>
          </div>
        </form>
      ) : (
        <form className="myservers__login-form" onSubmit={signIn}>
          <p className="myservers__hint">验证码已发到 {email.trim()}（演示固定 123456）。</p>
          <label className="myservers__field">
            <span>验证码</span>
            <input
              inputMode="numeric"
              value={code}
              autoFocus
              maxLength={6}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          {error ? (
            <p className="myservers__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="myservers__login-actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setError(null);
                setStep("email");
              }}
            >
              返回
            </button>
            <button type="submit" className="btn btn--primary">
              登录
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
