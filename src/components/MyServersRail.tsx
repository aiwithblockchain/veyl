import { useEffect, useState } from "react";
import type { MyServer, MyServerCatalog } from "../agent/bridge";
import { formatDailyPrice, isProvisioning, serverRailState, serverTone } from "../myservers/labels";
import { isTombstone } from "../myservers/tombstones";
import { IconClose, IconPhone, IconPlus } from "./icons";
import { useT } from "../i18n";
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
  /** 登录态：未登录只留标题与一行提示，不渲染服务器行与「在其它设备上使用」。 */
  signedIn?: boolean;
  /** 账户读失败（DNS / 网络 / 5xx）：左栏给「连不上」，不要写成登录提示。 */
  accountError?: boolean;
  /** 目录探针失败：未登录时同样按「控制面不可达」显示。 */
  catalogError?: boolean;
  /** 已登录 + 至少一台节点就绪时，底部多一行「在其它设备上使用」。 */
  showMobile?: boolean;
  onMobile?: (trigger: HTMLElement) => void;
  /** 标题行的同步按钮；不给就不渲染。 */
  onSync?: () => void;
  syncBusy?: boolean;
  onSelect: (serverId: string) => void;
  onNew: () => void;
}

/** 左栏计时：m:ss；满一小时才带小时，避免列表行里出现三位数。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

function ServerRow({
  server,
  selected,
  disabled,
  regionLabel,
  now,
  onSelect,
}: {
  server: MyServer;
  selected: boolean;
  disabled: boolean;
  regionLabel: string;
  now: number;
  onSelect: (serverId: string) => void;
}) {
  const t = useT();
  const provisioning = isProvisioning(server.state);
  const created = provisioning ? Date.parse(server.created_at) : NaN;
  const elapsed =
    provisioning && Number.isFinite(created) ? formatElapsed(now - created) : null;
  // 失败机器的计费字段可能是 0：副行不写日价，避免读成「免费 / 计费坏了」。
  // 停机删除的墓碑也不再报价：机器已经没了，价格只会误导。
  // 进行中的行只报状态与计时，不报日价，也不再说「开通中」。
  const billingPart =
    server.state === "error" || isTombstone(server) || provisioning
      ? null
      : (
          <>
            <span className="num">
              {formatDailyPrice(server.daily_price_cents)}
            </span>
            {t("rail.perDay")}
          </>
        );
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
          className={`led is-${serverTone(server)}`}
          aria-hidden
        />
      </span>
      <span className="rail-server__meta">
        {serverRailState(server)}
        {elapsed ? (
          <>
            {" "}
            <span className="num" aria-hidden="true">
              {elapsed}
            </span>
          </>
        ) : null}
        {" · "}
        {regionLabel}
        {billingPart ? <> · {billingPart}</> : null}
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
  signedIn = true,
  accountError = false,
  catalogError = false,
  showMobile = false,
  onMobile,
  onSync,
  syncBusy = false,
  onSelect,
  onNew,
}: Props) {
  const t = useT();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 整张列表只跑一个每秒时钟：进行中的行共用同一个 now，不为每行各开一个 timer。
  const counting = servers.some(
    (server) =>
      isProvisioning(server.state) && Number.isFinite(Date.parse(server.created_at)),
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [counting]);
  const regionName = (regionId: string) =>
    catalog?.regions.find((region) => region.id === regionId)?.name ?? regionId;

  /**
   * 建机入口：只在「已登录且至少一台服务器」时出现，并且是实心主按钮。
   * 0 台时中间空态已有同款主按钮、未登录时中间已有登录主按钮，左栏再放一份
   * 就是同屏两个主按钮或两个同名动作。列表加载中 / 读取失败时也不出现。
   */
  const buildCta = () =>
    !loading && !error ? (
      <button
        type="button"
        className="btn btn--primary rail-build"
        disabled={disabled}
        onClick={onNew}
      >
        <IconPlus size={16} />
        {t("rail.newNode")}
      </button>
    ) : null;

  // 未登录：不渲染服务器行、同步与「在其它设备上使用」；错误态只留标题与「连不上」，
  // 非错误态保留底部建机入口（点击由 App 门禁到登录弹窗）。
  if (!signedIn) {
    const unreachable = Boolean(error) || accountError || catalogError;
    return (
      <aside
        id="config-rail"
        className={`rail ${compact ? "rail--compact" : ""}`.trim()}
        aria-label={t("rail.listAria")}
      >
        <div className="rail__section">
          <span className="rail__label">{t("rail.myServers")}</span>
        </div>
        <p
          className="rail__empty-text myservers__rail-hint"
          role={unreachable ? "alert" : undefined}
        >
          {unreachable ? t("rail.error") : t("rail.loginHint")}
        </p>
      </aside>
    );
  }

  /** 滚动区内容：错误 / 骨架 / 服务器行。 */
  // 已登录时只认列表自己的读取失败；控制面不可达的整页错误留给中间区，
  // 左栏有缓存行就保留，别和中间的错误页各说各话。
  const listUnreachable = Boolean(error);
  const content = (
    <>
      {listUnreachable ? (
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
            {t("rail.error")}
          </p>
        </>
      ) : loading ? (
        <div className="rail__loading" role="status" aria-busy="true" aria-label={t("rail.loading")}>
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
                now={now}
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
            {t("serversPage.goConsole")}
          </button>
        ) : null}
      </p>
    ) : null;

  return (
    <aside
      id="config-rail"
      className={`rail ${compact ? "rail--compact" : ""} ${disabled ? "rail--locked" : ""}`.trim()}
      aria-label={t("rail.listAria")}
    >
      {compact ? (
        <button
          type="button"
          className="rail__drawer-btn"
          aria-label={t(
            servers.length === 1 ? "rail.drawerAriaOne" : "rail.drawerAria",
            { count: servers.length },
          )}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <span className="rail__drawer-count">{servers.length}</span>
        </button>
      ) : (
        <>
          <div className="rail__section">
            <span className="rail__label">{t("rail.myServers")}</span>
            <span className="rail__count">{servers.length}</span>
            {onSync ? (
              <button
                type="button"
                className="icon-btn rail__sync"
                aria-label={t("rail.sync")}
                title={t("rail.sync")}
                aria-busy={syncBusy || undefined}
                disabled={disabled || syncBusy}
                onClick={onSync}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                  <path
                    d="M13 8a5 5 0 1 1-1.46-3.54M13 3v3.2H9.8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn rail__add"
              aria-label={t("rail.newNode")}
              title={t("rail.newNode")}
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
          {servers.length > 0 ? buildCta() : null}
          {showMobile && onMobile && !loading && !error ? (
            <button
              type="button"
              className="rail__action-row"
              aria-haspopup="dialog"
              disabled={disabled}
              onClick={(event) => onMobile(event.currentTarget)}
            >
              <span className="rail__new-row__icon">
                <IconPhone size={14} />
              </span>
              <span>{t("rail.useOnPhone")}</span>
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
            aria-label={t("rail.listAria")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="rail-drawer__head">
              <span className="rail__label">{t("rail.myServers")} {servers.length}</span>
              <div className="rail-drawer__actions">
                {onSync ? (
                  <button
                    type="button"
                    className="icon-btn rail__sync"
                    aria-label={t("rail.sync")}
                    title={t("rail.sync")}
                    aria-busy={syncBusy || undefined}
                    disabled={disabled || syncBusy}
                    onClick={onSync}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                      <path
                        d="M13 8a5 5 0 1 1-1.46-3.54M13 3v3.2H9.8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t("rail.closeList")}
                  onClick={() => setDrawerOpen(false)}
                >
                  <IconClose size={14} />
                </button>
              </div>
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
              {t("rail.newNode")}
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
