import { useState } from "react";
import type { MyServer, MyServerAccount, MyServerWallet } from "../agent/bridge";
import type { LogoutResult } from "../myservers/useMyServers";
import { formatDailyPrice, serverRailState, stateTone } from "../myservers/labels";
import { MyServersAccount } from "./MyServersAccount";
import { IconClose } from "./icons";

interface Props {
  servers: MyServer[];
  selectedId: string | null;
  loading: boolean;
  /** 还没有登录：列表区只给登录提示。 */
  identityMissing?: boolean;
  /** 登录态；账号块的数据源。 */
  account?: MyServerAccount | null;
  accountLoaded?: boolean;
  accountError?: boolean;
  wallet?: MyServerWallet | null;
  walletError?: string | null;
  /** 账号菜单展开状态由 Host 统一管理。 */
  accountOpen?: boolean;
  /** 列表读取失败说明；只在左栏就地显示。 */
  error?: string | null;
  retrying?: boolean;
  /** 重试成功后的播报文本（视觉隐藏）。 */
  retryNotice?: string | null;
  /** 向导打开或身份不可用：行与「新建」都不可点。 */
  disabled?: boolean;
  compact?: boolean;
  onSelect: (serverId: string) => void;
  onNew: () => void;
  onRetry?: () => void;
  onLogin?: () => void;
  onLogout?: () => Promise<LogoutResult>;
  onTopUp?: () => void;
  onRefreshWallet?: () => void;
  onRefreshAccount?: () => void;
  onToggleAccount?: () => void;
}

function ServerRow({
  server,
  selected,
  disabled,
  onSelect,
}: {
  server: MyServer;
  selected: boolean;
  disabled: boolean;
  onSelect: (serverId: string) => void;
}) {
  return (
    <button
      type="button"
      className={`rail-server ${selected ? "is-active" : ""}`}
      aria-current={selected ? "true" : undefined}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => onSelect(server.server_id)}
    >
      <span className="rail-server__head">
        <span className="rail-server__name" title={server.name}>
          {server.name}
        </span>
        <span className="rail-server__price num">
          每天 {formatDailyPrice(server.daily_price_cents)}
        </span>
      </span>
      <span className="rail-server__state myservers__rail-state">
        <span className={`led is-${stateTone(server.state)}`} aria-hidden />
        {serverRailState(server.state)}
      </span>
    </button>
  );
}

export function MyServersRail({
  servers,
  selectedId,
  loading,
  identityMissing = false,
  account = null,
  accountLoaded = false,
  accountError = false,
  wallet = null,
  walletError = null,
  accountOpen = false,
  error = null,
  retrying = false,
  retryNotice = null,
  disabled = false,
  compact = false,
  onSelect,
  onNew,
  onRetry,
  onLogin,
  onLogout,
  onTopUp,
  onRefreshWallet,
  onRefreshAccount,
  onToggleAccount,
}: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const list = (
    <>
      {identityMissing ? (
        <p className="rail__empty-text myservers__rail-hint">
          登录后查看你的服务器
        </p>
      ) : error ? (
        <>
          <div className="rail__placeholders" aria-hidden>
            {[0, 1, 2].map((row) => (
              <div key={row} className="rail__placeholder">
                <span className="rail__placeholder-line" />
                <span className="rail__placeholder-line is-short" />
              </div>
            ))}
          </div>
          <div className="rail__error">
            <p className="rail__empty-text myservers__rail-hint" role="alert">
              连不上服务器，稍后再试
            </p>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={retrying}
              aria-busy={retrying || undefined}
              onClick={onRetry}
            >
              {retrying ? "正在重试…" : "重试"}
            </button>
          </div>
        </>
      ) : loading ? (
        <div className="rail__loading" role="status" aria-busy="true" aria-label="正在读取服务器">
          {[0, 1, 2].map((row) => (
            <div className="skeleton-row" key={row} aria-hidden>
              <span className="skeleton skeleton--name" />
              <span className="skeleton skeleton--meta" />
            </div>
          ))}
        </div>
      ) : servers.length === 0 ? (
        <p className="rail__empty-text myservers__rail-hint">还没有服务器</p>
      ) : (
        <ul className="rail-servers">
          {servers.map((server) => (
            <li key={server.server_id} className="rail-servers__item">
              <ServerRow
                server={server}
                selected={server.server_id === selectedId}
                disabled={disabled}
                onSelect={(serverId) => {
                  onSelect(serverId);
                  setDrawerOpen(false);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <aside
      id="config-rail"
      className={`rail ${compact ? "rail--compact" : ""}`}
      aria-label="服务器列表"
    >
      {!compact ? (
        <header className="rail__brand">
          <span className="wordmark">Veyl</span>
          <span className="rail__sub">网络控制台</span>
        </header>
      ) : (
        <span className="wordmark wordmark--mark">V</span>
      )}

      {compact ? (
        <button
          type="button"
          className="rail__drawer-btn"
          aria-label={`服务器列表，${servers.length} 台`}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <span className="rail__drawer-count">{servers.length}</span>
        </button>
      ) : (
        <>
          <div className="rail__section">
            <span className="rail__label">我的服务器</span>
            <span className="rail__count">{servers.length}</span>
            <button
              type="button"
              className="icon-btn rail__add"
              aria-label="新建节点"
              title="新建节点"
              disabled={disabled}
              onClick={onNew}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <path
                  d="M8 3.5v9M3.5 8h9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
          {list}
        </>
      )}

      {retryNotice ? (
        <p className="sr-only" role="status" aria-live="polite">
          {retryNotice}
        </p>
      ) : null}

      <footer className="rail__foot">
        <MyServersAccount
          account={account}
          loaded={accountLoaded}
          accountError={accountError}
          wallet={wallet}
          walletError={walletError}
          open={accountOpen}
          disabled={disabled}
          compact={compact}
          onToggle={() => onToggleAccount?.()}
          onLogin={() => onLogin?.()}
          onLogout={
            onLogout ?? (async () => ({ ok: false, message: "这个版本还不支持退出登录。" }))
          }
          onTopUp={() => onTopUp?.()}
          onRefreshWallet={() => onRefreshWallet?.()}
          onRefreshAccount={() => onRefreshAccount?.()}
        />
      </footer>

      {compact && drawerOpen ? (
        <div className="rail-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
          <div
            className="rail-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="服务器列表"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="rail-drawer__head">
              <span className="rail__label">我的服务器 {servers.length}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="关闭服务器列表"
                onClick={() => setDrawerOpen(false)}
              >
                <IconClose size={14} />
              </button>
            </div>
            <button
              type="button"
              className="btn btn--ghost rail-drawer__new"
              disabled={disabled}
              onClick={() => {
                setDrawerOpen(false);
                onNew();
              }}
            >
              新建节点
            </button>
            {list}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
