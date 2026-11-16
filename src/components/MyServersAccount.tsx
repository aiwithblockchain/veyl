import { useEffect, useState } from "react";
import type { MyServerAccount, MyServerWallet } from "../agent/bridge";
import type { LogoutResult } from "../myservers/useMyServers";
import { formatUsdCents } from "../myservers/labels";

interface Props {
  account: MyServerAccount | null;
  loaded: boolean;
  wallet: MyServerWallet | null;
  walletLoading: boolean;
  walletError: string | null;
  disabled?: boolean;
  compact?: boolean;
  onLogin: () => void;
  onLogout: () => Promise<LogoutResult>;
  onTopUp: () => void;
  onRefreshWallet: () => void;
}

/** 「我的服务器」左栏底部账号块：未登录只有登录，登录后展开余额 / 充值 / 登出。 */
export function MyServersAccount({
  account,
  loaded,
  wallet,
  walletLoading,
  walletError,
  disabled = false,
  compact = false,
  onLogin,
  onLogout,
  onTopUp,
  onRefreshWallet,
}: Props) {
  const [open, setOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const loggedIn = account?.logged_in === true;
  const email = account?.email ?? "";

  useEffect(() => {
    if (!loggedIn) {
      setOpen(false);
      setConfirmLogout(false);
      setLogoutError(null);
    }
  }, [loggedIn]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setConfirmLogout(false);
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (compact) {
    return (
      <button
        type="button"
        className="rail__identity"
        aria-label={loggedIn ? `账号 ${email}` : "登录"}
        title={loggedIn ? email : "登录"}
        onClick={loggedIn ? onTopUp : onLogin}
      >
        <span className={`led ${loggedIn ? "is-ok" : "is-warn"}`} aria-hidden />
        <span className="rail__identity-text">{loggedIn ? email : "未登录"}</span>
      </button>
    );
  }

  if (!loggedIn) {
    return (
      <div className="rail__account rail__account--row">
        <span className="rail__identity rail__identity--static">
          <span className="led is-warn" aria-hidden />
          <span className="rail__identity-text" title={loaded ? "未登录" : undefined}>
            {loaded ? "未登录" : "正在读取…"}
          </span>
        </span>
        {loaded ? (
          <button
            type="button"
            className="btn btn--ghost rail__account__login"
            onClick={onLogin}
          >
            登录
          </button>
        ) : null}
      </div>
    );
  }

  const confirm = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    const result = await onLogout();
    setLoggingOut(false);
    if (result.ok) {
      setConfirmLogout(false);
      setOpen(false);
      return;
    }
    setLogoutError(result.message ?? "没退出登录。服务器没有变化，可以再试一次。");
  };

  return (
    <div className="rail__account">
      <button
        type="button"
        className="rail__identity rail__account__row"
        aria-expanded={open}
        aria-controls="rail-account-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="led is-ok" aria-hidden />
        <span className="rail__identity-text" title={email}>
          <span className="rail__account__email">{email}</span>
          <span className="rail__account__sub">已登录 · 这台设备</span>
        </span>
        <span className="rail__account__chevron" aria-hidden>
          {open ? "⌃" : "⌄"}
        </span>
      </button>

      {open ? (
        <div id="rail-account-panel" className="rail__account__panel">
          <p className="rail__account__balance">
            余额{" "}
            <span className="num">
              {wallet
                ? formatUsdCents(wallet.balance_cents)
                : walletLoading
                  ? "读取中"
                  : "—"}
            </span>
          </p>
          {walletError ? (
            <p className="rail__account__error" role="alert">
              {walletError}
              <button
                type="button"
                className="rail__account__link"
                onClick={onRefreshWallet}
              >
                重试
              </button>
            </p>
          ) : null}

          <div className="rail__account__actions">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={disabled}
              onClick={onTopUp}
            >
              充值
            </button>
            {confirmLogout ? null : (
              <button
                type="button"
                className="btn btn--ghost"
                disabled={disabled}
                onClick={() => {
                  setLogoutError(null);
                  setConfirmLogout(true);
                }}
              >
                登出
              </button>
            )}
          </div>

          {confirmLogout ? (
            <div className="rail__account__confirm">
              <p className="rail__account__note">
                退出后这台设备不再属于该账户；已有配置和节点不受影响。
              </p>
              {logoutError ? (
                <p className="rail__account__error" role="alert">
                  {logoutError}
                </p>
              ) : null}
              <div className="rail__account__actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={loggingOut}
                  onClick={() => setConfirmLogout(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn--danger-ghost"
                  disabled={loggingOut}
                  aria-busy={loggingOut || undefined}
                  onClick={() => void confirm()}
                >
                  {loggingOut ? "正在退出…" : "确认退出"}
                </button>
              </div>
            </div>
          ) : (
            <p className="rail__account__note">已有配置和节点不受影响。</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
