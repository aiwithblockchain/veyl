import { useState } from "react";
import type { MyServer, MyServerCatalog } from "../agent/bridge";
import { formatDailyPrice, serverRailState, stateTone } from "../myservers/labels";
import { IconClose } from "./icons";

interface Props {
  servers: MyServer[];
  selectedId: string | null;
  loading: boolean;
  /** 目录用于把地区 slug 显示成名字。 */
  catalog?: MyServerCatalog | null;
  /** 列表读取失败说明；只在左栏就地显示。 */
  error?: string | null;
  /** 重试成功后的播报文本（视觉隐藏）。 */
  retryNotice?: string | null;
  /** 身份不可用：行与「新建」都不可点。 */
  disabled?: boolean;
  compact?: boolean;
  onSelect: (serverId: string) => void;
  onNew: () => void;
}

function ServerRow({
  server,
  selected,
  disabled,
  regionLabel,
  onSelect,
}: {
  server: MyServer;
  selected: boolean;
  disabled: boolean;
  regionLabel: string;
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
      <span className="rail-server__line1">
        <span className="rail-server__name" title={server.name}>
          {server.name}
        </span>
        <span
          className={`led is-${stateTone(server.state)}`}
          aria-hidden
        />
      </span>
      <span className="rail-server__meta">
        {serverRailState(server.state)} · {regionLabel} ·{" "}
        {formatDailyPrice(server.daily_price_cents)}/天
      </span>
    </button>
  );
}

export function MyServersRail({
  servers,
  selectedId,
  loading,
  catalog = null,
  error = null,
  retryNotice = null,
  disabled = false,
  compact = false,
  onSelect,
  onNew,
}: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const regionName = (regionId: string) =>
    catalog?.regions.find((region) => region.id === regionId)?.name ?? regionId;

  const list = (
    <>
      {error ? (
        <>
          <div className="rail__placeholders" aria-hidden>
            {[0, 1, 2].map((row) => (
              <div key={row} className="rail__placeholder">
                <span className="rail__placeholder-line" />
                <span className="rail__placeholder-line is-short" />
              </div>
            ))}
          </div>
          <p className="rail__empty-text myservers__rail-hint">
            连不上服务器，稍后再试
          </p>
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
      ) : servers.length === 0 ? null : (
        <ul className="rail-servers">
          {servers.map((server) => (
            <li key={server.server_id} className="rail-servers__item">
              <ServerRow
                server={server}
                selected={server.server_id === selectedId}
                disabled={disabled}
                regionLabel={regionName(server.region)}
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
