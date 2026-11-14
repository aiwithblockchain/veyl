import { useState } from "react";
import type { MyServer } from "../agent/bridge";
import { serverRailState, stateTone } from "../myservers/labels";
import { IconClose } from "./icons";

interface Props {
  servers: MyServer[];
  selectedId: string | null;
  loading: boolean;
  /** 向导打开或身份不可用：行与「新建」都不可点。 */
  disabled?: boolean;
  compact?: boolean;
  onSelect: (serverId: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
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
      className={`config ${selected ? "is-active" : ""}`}
      aria-current={selected ? "true" : undefined}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => onSelect(server.server_id)}
    >
      <span className="config__name" title={server.name}>
        <span className="config__name-text">{server.name}</span>
      </span>
      <span className="config__meta myservers__rail-state">
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
  disabled = false,
  compact = false,
  onSelect,
  onNew,
  onOpenSettings,
}: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const list = (
    <>
      {loading ? (
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
        <ul className="configs">
          {servers.map((server) => (
            <li key={server.server_id} className="configs__row">
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
              aria-label="新建服务器"
              title="新建服务器"
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

      <footer className="rail__foot">
        <button
          type="button"
          className="rail__settings"
          aria-label="设置"
          onClick={onOpenSettings}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
            <path
              d="M2.5 5h11M2.5 11h11"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
            <circle cx="6" cy="5" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="10" cy="11" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          {!compact ? <span>设置</span> : null}
        </button>
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
              新建服务器
            </button>
            {list}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
