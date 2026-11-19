import { useState } from "react";
import type { MyServer, MyServerCatalog } from "../agent/bridge";
import { formatDailyPrice, isProvisioning, serverRailState, stateTone } from "../myservers/labels";
import { IconClose, IconPlus } from "./icons";

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
  /** 试用还有免费节点可用时的一行旁注；null/不给则不显示。 */
  trialHint?: string | null;
  /** 旁注里的「去控制台」：切到连接页。 */
  onGoConnect?: () => void;
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
  // 失败机器的计费字段可能是 0：副行不写日价，避免读成「免费 / 计费坏了」。
  const billingPart =
    server.state === "error"
      ? null
      : server.billing_state === "pending" && isProvisioning(server.state)
        ? "开通中"
        : `${formatDailyPrice(server.daily_price_cents)}/天`;
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
        {serverRailState(server.state)} · {regionLabel}
        {billingPart ? ` · ${billingPart}` : null}
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
  trialHint = null,
  onGoConnect,
  onSelect,
  onNew,
}: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const regionName = (regionId: string) =>
    catalog?.regions.find((region) => region.id === regionId)?.name ?? regionId;

  /** 滚动区内容：错误 / 骨架 / 服务器行。 */
  const content = (
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

  /** 试用旁注：常驻在列表下方，不跟着列表滚走；读列表失败时不夹带旁注。 */
  const trialNote =
    servers.length > 0 && !loading && !error && trialHint ? (
      <p className="myservers__trial-hint myservers__trial-hint--rail">
        {trialHint}
        {onGoConnect ? (
          <button
            type="button"
            className="myservers__trial-link"
            disabled={disabled}
            onClick={onGoConnect}
          >
            去控制台
          </button>
        ) : null}
      </p>
    ) : null;

  return (
    <aside
      id="config-rail"
      className={`rail ${compact ? "rail--compact" : ""} ${disabled ? "rail--locked" : ""}`.trim()}
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
          {/* 列表自己滚：.rail 是 overflow:hidden，不套这层超出的行会被裁掉。 */}
          <div className="rail__body">{content}</div>
          {trialNote}
          {servers.length > 0 && !loading && !error ? (
            <button
              type="button"
              className="rail__new-row"
              disabled={disabled}
              onClick={onNew}
            >
              <span className="rail__new-row__icon">
                <IconPlus size={14} />
              </span>
              <span>新建节点</span>
            </button>
          ) : null}
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
            {/* 抽屉的「新建节点」沿用顶部动作位；试用旁注固定在底部。
                两者相对位置与左栏不同，是有意保留抽屉既有结构。 */}
            {/* 抽屉同样受限高滚动，长列表不会溢出视口。 */}
            <div className="rail__body">{content}</div>
            {trialNote}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
