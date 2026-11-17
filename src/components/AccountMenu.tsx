import { useEffect, useRef, useState } from "react";
import type { MyServerWallet } from "../agent/bridge";
import type { LogoutResult } from "../myservers/useMyServers";
import { useFocusTrap } from "../ui/focus";
import { formatUsdCents } from "../myservers/labels";

interface Props {
  /** 锚在左栏账号行（向上展开）还是导航头像（右侧浮层）。 */
  variant: "rail" | "nav";
  wallet: MyServerWallet | null;
  walletError: string | null;
  disabled?: boolean;
  onTopUp: () => void;
  onRefreshWallet: () => void;
  onLogout: () => Promise<LogoutResult>;
  onClose: () => void;
}

const LOGOUT_FAILED = "没能退出登录，稍后再试。";

/** 账号菜单：余额 / 充值 / 退出登录；不做二次确认，失败才给结果。 */
export function AccountMenu({
  variant,
  wallet,
  walletError,
  disabled = false,
  onTopUp,
  onRefreshWallet,
  onLogout,
  onClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  useFocusTrap(true, panelRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    const result = await onLogout();
    setLoggingOut(false);
    if (result.ok) {
      onClose();
      return;
    }
    setLogoutError(result.message ?? LOGOUT_FAILED);
  };

  return (
    <>
      <div
        className="account-menu__backdrop"
        aria-hidden="true"
        onMouseDown={onClose}
      />
      <div
        ref={panelRef}
        id={variant === "rail" ? "rail-account-menu" : undefined}
        className={`account-menu account-menu--${variant}`}
        role="dialog"
        aria-label="账户菜单"
      >
        <div className="account-menu__balance">
          <div className="account-menu__balance-main">
            <span className="account-menu__label">余额</span>
            {walletError ? (
              <span className="account-menu__balance-error">
                余额暂时读不到。
                <button
                  type="button"
                  className="account-menu__link"
                  onClick={onRefreshWallet}
                >
                  重试
                </button>
              </span>
            ) : (
              <span className="account-menu__amount num">
                {wallet ? formatUsdCents(wallet.balance_cents) : "读取中"}
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn btn--ghost account-menu__topup"
            disabled={disabled}
            onClick={onTopUp}
          >
            充值
          </button>
        </div>

        <div className="account-menu__divider" />

        {logoutError ? (
          <p className="account-menu__error" role="alert">
            {logoutError}
            <button
              type="button"
              className="account-menu__link"
              disabled={loggingOut}
              onClick={() => void logout()}
            >
              重试
            </button>
          </p>
        ) : null}

        <button
          type="button"
          className="account-menu__logout"
          disabled={disabled || loggingOut}
          aria-busy={loggingOut || undefined}
          onClick={() => void logout()}
        >
          {loggingOut ? "正在退出…" : "退出登录"}
        </button>
      </div>
    </>
  );
}
