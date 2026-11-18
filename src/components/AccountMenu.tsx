import { useEffect, useRef, useState } from "react";
import type { MyServerWallet } from "../agent/bridge";
import type { LogoutResult } from "../myservers/useMyServers";
import { useFocusTrap } from "../ui/focus";
import { formatUsdCents } from "../myservers/labels";

interface Props {
  /** 账号邮箱；菜单头部只显示这一行，不重复头像。 */
  email?: string | null;
  wallet: MyServerWallet | null;
  walletError: string | null;
  disabled?: boolean;
  /** 设备/账户的永久状态：给明确出路，不说「稍后再试」。 */
  identityProblem?: "lost" | "device_revoked" | "account_blocked" | null;
  onTopUp: () => void;
  onRefreshWallet: () => void;
  /** 重新注册设备；返回是否恢复成功。 */
  onReRegister?: () => Promise<boolean>;
  /** 账户停用：换一个账户（重新注册设备后再登录）。 */
  onSwitchAccount?: () => Promise<boolean>;
  onLogout: () => Promise<LogoutResult>;
  onClose: () => void;
}

const LOGOUT_FAILED = "没能退出登录，稍后再试。";
const RECOVER_FAILED = "这一步没完成。检查网络后再试一次；账户和服务器都还在。";

/** 账号菜单：邮箱 / 余额 / 充值 / 退出登录；不做二次确认，失败才给结果。 */
export function AccountMenu({
  email,
  wallet,
  walletError,
  disabled = false,
  identityProblem = null,
  onTopUp,
  onRefreshWallet,
  onReRegister,
  onSwitchAccount,
  onLogout,
  onClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [reRegistering, setReRegistering] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [reRegisterError, setReRegisterError] = useState<string | null>(null);
  useFocusTrap(true, panelRef);

  const recovery =
    identityProblem === "lost"
      ? {
          kind: "register" as const,
          text: "这台设备的身份丢了，需要重新注册设备；账户和服务器都在。",
          label: "重新注册设备",
        }
      : identityProblem === "device_revoked"
        ? {
            kind: "logout" as const,
            text: "这台设备已被停用。退出这台设备后可以重新登录。",
            label: "退出这台设备",
          }
        : identityProblem === "account_blocked"
          ? {
              kind: "switch" as const,
              text: "这个账户已停用。换一个账户需要重新注册这台设备；这台设备上的旧账户仍会保留。",
              label: "换一个账户",
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
    setLogoutError(result.message ?? LOGOUT_FAILED);
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
    if (!ok) setReRegisterError(RECOVER_FAILED);
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
        aria-label="账户菜单"
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
                  ? "正在退出…"
                  : recovery.label
                : recovery.kind === "switch"
                  ? switching
                    ? "正在切换…"
                    : recovery.label
                  : reRegistering
                    ? "正在处理…"
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
                {loggingOut ? "正在退出…" : "退出这台设备"}
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
              重试
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
            {loggingOut ? "正在退出…" : "退出登录"}
          </button>
        ) : null}
      </div>
    </>
  );
}
