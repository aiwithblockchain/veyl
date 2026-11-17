import type { MyServerAccount, MyServerWallet } from "../agent/bridge";
import type { LogoutResult } from "../myservers/useMyServers";
import { formatUsdCents } from "../myservers/labels";
import { AccountAvatar } from "./AccountAvatar";
import { AccountMenu } from "./AccountMenu";

interface Props {
  account: MyServerAccount | null;
  loaded: boolean;
  /** 账户命令失败：显示「账户暂时读不到」，不冒充未登录。 */
  accountError: boolean;
  wallet: MyServerWallet | null;
  walletError: string | null;
  /** 账号菜单是否展开（由 Host 统一管理，保证同时只有一个）。 */
  open: boolean;
  disabled?: boolean;
  compact?: boolean;
  onToggle: () => void;
  onLogin: () => void;
  onLogout: () => Promise<LogoutResult>;
  onTopUp: () => void;
  onRefreshWallet: () => void;
  onRefreshAccount: () => void;
}

/** 左栏底部账号行：头像 + 身份 + 余额摘要；菜单里放充值 / 退出登录。 */
export function MyServersAccount({
  account,
  loaded,
  accountError,
  wallet,
  walletError,
  open,
  disabled = false,
  compact = false,
  onToggle,
  onLogin,
  onLogout,
  onTopUp,
  onRefreshWallet,
  onRefreshAccount,
}: Props) {
  const loggedIn = account?.logged_in === true;
  const email = account?.email ?? null;
  const loading = !loaded && !accountError;

  const menu = open && loggedIn ? (
    <AccountMenu
      variant={compact ? "nav" : "rail"}
      wallet={wallet}
      walletError={walletError}
      disabled={disabled}
      onTopUp={onTopUp}
      onRefreshWallet={onRefreshWallet}
      onLogout={onLogout}
      onClose={onToggle}
    />
  ) : null;

  if (compact) {
    return (
      <div className="rail-account rail-account--compact">
        <button
          type="button"
          className="rail-account__avatar-btn"
          aria-label={loggedIn ? `账户，${email ?? ""}` : "账户，未登录"}
          aria-expanded={loggedIn ? open : undefined}
          disabled={disabled || loading || Boolean(accountError && !account)}
          onClick={() => {
            if (loading) return;
            if (!loggedIn) {
              onLogin();
              return;
            }
            onToggle();
          }}
        >
          <AccountAvatar
            email={email}
            loading={loading}
            size="nav"
          />
        </button>
        {menu}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rail-account rail-account--loading">
        <AccountAvatar email={null} loading size="row" />
        <span className="rail-account__loading-text">正在读取账户…</span>
      </div>
    );
  }

  if (accountError && !account) {
    return (
      <div className="rail-account">
        <AccountAvatar email={null} size="row" />
        <span className="rail-account__text">账户暂时读不到</span>
        <button
          type="button"
          className="rail-account__retry"
          onClick={onRefreshAccount}
        >
          重试
        </button>
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div className="rail-account">
        <AccountAvatar email={null} size="row" />
        <span className="rail-account__text">未登录</span>
        <button
          type="button"
          className="rail-account__login"
          disabled={disabled}
          onClick={onLogin}
        >
          登录
        </button>
      </div>
    );
  }

  const balanceText = walletError
    ? "余额读不到"
    : wallet
      ? null
      : "余额读取中…";

  return (
    <div className="rail-account rail-account--signed-in">
      <button
        type="button"
        className="rail-account__row"
        aria-expanded={open}
        aria-controls="rail-account-menu"
        disabled={disabled}
        onClick={onToggle}
      >
        <AccountAvatar email={email} size="row" />
        <span className="rail-account__meta">
          <span className="rail-account__email" title={email ?? ""}>
            {email}
          </span>
          <span
            className={`rail-account__balance${walletError ? " is-error" : ""}`}
          >
            {balanceText ?? (
              <>
                余额 <span className="num">{formatUsdCents(wallet!.balance_cents)}</span>
              </>
            )}
          </span>
        </span>
        <span className="rail-account__chevron" aria-hidden="true">
          {open ? "⌃" : "⌄"}
        </span>
      </button>
      {menu}
    </div>
  );
}
