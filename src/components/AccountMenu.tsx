import { useEffect, useRef, useState } from "react";
import type { MyServerWallet } from "../agent/bridge";
import type { LogoutResult, WalletTrigger } from "../myservers/useMyServers";
import { useFocusTrap } from "../ui/focus";
import { formatUsdCents } from "../myservers/labels";
import { useT } from "../i18n";

interface Props {
  /** 账号邮箱；菜单头部只显示这一行，不重复头像。 */
  email?: string | null;
  wallet: MyServerWallet | null;
  /** 从未取到值且请求在途：只有这时才写「读取中」，否则写「—」。 */
  walletLoading?: boolean;
  walletError: string | null;
  /** 显示的是上次的余额：只写一行小字，不加按钮、不加角标。 */
  walletStale?: boolean;
  disabled?: boolean;
  /** 设备/账户的永久状态：给明确出路，不说「稍后再试」。 */
  identityProblem?: "lost" | "device_revoked" | "account_blocked" | null;
  onTopUp: () => void;
  onRefreshWallet: (trigger: WalletTrigger) => void;
  /** 重新注册设备；返回是否恢复成功。 */
  onReRegister?: () => Promise<boolean>;
  /** 账户停用：换一个账户（重新注册设备后再登录）。 */
  onSwitchAccount?: () => Promise<boolean>;
  onLogout: () => Promise<LogoutResult>;
  onClose: () => void;
}

/** 账号菜单：邮箱 / 余额 / 充值 / 退出登录；不做二次确认，失败才给结果。 */
export function AccountMenu({
  email,
  wallet,
  walletLoading = false,
  walletError,
  walletStale = false,
  disabled = false,
  identityProblem = null,
  onTopUp,
  onRefreshWallet,
  onReRegister,
  onSwitchAccount,
  onLogout,
  onClose,
}: Props) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [reRegistering, setReRegistering] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [reRegisterError, setReRegisterError] = useState<string | null>(null);
  useFocusTrap(true, panelRef);
  // 菜单是条件渲染的：挂载即打开。打开即刷，30 秒节流在 refreshWallet 里。
  const refreshOnMountRef = useRef(onRefreshWallet);
  useEffect(() => {
    refreshOnMountRef.current("open_menu");
  }, []);

  const recovery =
    identityProblem === "lost"
      ? {
          kind: "register" as const,
          text: t("account.identity.lost"),
          label: t("account.identity.lostLabel"),
        }
      : identityProblem === "device_revoked"
        ? {
            kind: "logout" as const,
            text: t("account.identity.revoked"),
            label: t("account.identity.revokedLabel"),
          }
        : identityProblem === "account_blocked"
          ? {
              kind: "switch" as const,
              text: t("account.identity.blocked"),
              label: t("account.identity.blockedLabel"),
            }
          : null;
  const blocked =
    identityProblem === "device_revoked" || identityProblem === "account_blocked";
  const showLogout = !blocked;

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
    setLogoutError(result.message ?? t("account.logoutFailed"));
  };

  const recover = async () => {
    if (!recovery || actionBusy) return;
    if (recovery.kind === "logout") {
      await logout();
      return;
    }
    const run = recovery.kind === "switch" ? onSwitchAccount : onReRegister;
    if (!run) return;
    const setBusy = recovery.kind === "switch" ? setSwitching : setReRegistering;
    setBusy(true);
    setReRegisterError(null);
    const ok = await run();
    setBusy(false);
    if (!ok) setReRegisterError(t("account.recoverFailed"));
  };
  // 换账户、重新注册、退出三件事互斥：任一件在途，另一件的按钮也不能点。
  const actionBusy = loggingOut || switching || reRegistering;
  return (
    <>
      <div
        className="account-menu__backdrop"
        aria-hidden="true"
        onMouseDown={onClose}
      />
      <div
        ref={panelRef}
        className="account-menu"
        role="dialog"
        aria-label={t("account.menuAria")}
      >
        {email ? (
          <>
            <div className="account-menu__email" title={email}>
              {email}
            </div>
            <div className="account-menu__divider" />
          </>
        ) : null}

        {blocked ? null : (
          <>
            <div className="account-menu__balance">
              <div className="account-menu__balance-main">
                <span className="account-menu__label">{t("account.balance")}</span>
                {walletError ? (
                  <span className="account-menu__balance-error">
                    {t("account.walletError")}
                    <button
                      type="button"
                      className="account-menu__link"
                      onClick={() => onRefreshWallet("retry")}
                    >
                      {t("account.retry")}
                    </button>
                  </span>
                ) : (
                  <span className="account-menu__amount num">
                    {wallet
                      ? formatUsdCents(wallet.balance_cents)
                      : walletLoading
                        ? t("account.loading")
                        : "—"}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="btn btn--ghost account-menu__topup"
                disabled={disabled}
                onClick={onTopUp}
              >
                {t("account.topUp")}
              </button>
            </div>
            {walletStale && !walletError ? (
              <p className="account-menu__balance-error">
                {t("account.stale")}
                <button
                  type="button"
                  className="account-menu__link"
                  onClick={() => onRefreshWallet("retry")}
                >
                  {t("account.retry")}
                </button>
              </p>
            ) : null}
          </>
        )}

        <div className="account-menu__divider" />

        {recovery ? (
          <>
            <p className="account-menu__identity">{recovery.text}</p>
            {reRegisterError ? (
              <p className="account-menu__error" role="alert">
                {reRegisterError}
              </p>
            ) : null}
            <button
              type="button"
              className="account-menu__recover"
              disabled={disabled || actionBusy}
              aria-busy={
                (recovery.kind === "logout"
                  ? loggingOut
                  : recovery.kind === "switch"
                    ? switching
                    : reRegistering) || undefined
              }
              onClick={() => void recover()}
            >
              {recovery.kind === "logout"
                ? loggingOut
                  ? t("account.loggingOut")
                  : recovery.label
                : recovery.kind === "switch"
                  ? switching
                    ? t("account.switching")
                    : recovery.label
                  : reRegistering
                    ? t("account.working")
                    : recovery.label}
            </button>
            {recovery.kind === "switch" ? (
              <button
                type="button"
                className="account-menu__recover account-menu__recover--secondary"
                disabled={disabled || actionBusy}
                aria-busy={loggingOut || undefined}
                onClick={() => void logout()}
              >
                {loggingOut ? t("account.loggingOut") : t("account.logoutDevice")}
              </button>
            ) : null}
            <div className="account-menu__divider" />
          </>
        ) : null}

        {logoutError ? (
          <p className="account-menu__error" role="alert">
            {logoutError}
            <button
              type="button"
              className="account-menu__link"
              disabled={loggingOut}
              onClick={() => void logout()}
            >
              {t("account.retry")}
            </button>
          </p>
        ) : null}

        {showLogout ? (
          <button
            type="button"
            className="account-menu__logout"
            disabled={disabled || loggingOut}
            aria-busy={loggingOut || undefined}
            onClick={() => void logout()}
          >
            {loggingOut ? t("account.loggingOut") : t("account.logout")}
          </button>
        ) : null}
      </div>
    </>
  );
}
