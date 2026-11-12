import { useEffect, useRef, useState } from "react";
import type { ConfigSummary } from "../agent/protocol";
import { levelLabel } from "../ui/configLabels";
import { useFocusTrap } from "../ui/focus";
import { IconClose, IconList, IconTrash } from "./icons";

interface Props {
  configs: ConfigSummary[];
  activeConfigId: string | null;
  /** 当前真正连着的那套配置；没连或没连上都是 null。 */
  connectedConfigId: string | null;
  loading?: boolean;
  error?: string | null;
  onSelect: (configId: string) => void;
  onNewConfig: () => void;
  /** 读取失败时就地重试，和首次加载同一条路径。 */
  onRetry: () => void;
  onDelete: (configId: string) => Promise<{ ok: boolean; message?: string }>;
  onOpenSettings: () => void;
  /** <1024：收成 72px 图标栏，列表放进抽屉。 */
  compact?: boolean;
}

export function ConfigRail({
  configs,
  activeConfigId,
  connectedConfigId,
  loading = false,
  error = null,
  onSelect,
  onNewConfig,
  onRetry,
  onDelete,
  onOpenSettings,
  compact = false,
}: Props) {
  const [confirming, setConfirming] = useState<ConfigSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  useFocusTrap(Boolean(confirming), confirmRef);
  // 确认框开着时把抽屉的陷阱让出去，否则两层会互相抢 Tab 和 Esc。
  useFocusTrap(drawerOpen && !confirming, drawerRef);

  useEffect(() => {
    if (confirming && !configs.some((config) => config.config_id === confirming.config_id)) {
      setConfirming(null);
    }
  }, [configs, confirming]);

  useEffect(() => {
    if (!confirming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) setConfirming(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirming, deleting]);

  useEffect(() => {
    if (!drawerOpen || confirming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, confirming]);

  const submitDelete = async () => {
    if (!confirming || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const result = await onDelete(confirming.config_id);
    setDeleting(false);
    if (result.ok) {
      setConfirming(null);
      // 触发按钮随行卸载，焦点陷阱可能已把焦点还给 body；把焦点放回配置栏。
      window.setTimeout(() => railRef.current?.focus(), 0);
    } else {
      setDeleteError(result.message ?? "删除失败，请重试");
    }
  };

  const list = (
    <>
      {loading ? (
        <div
          className="rail__loading"
          role="status"
          aria-busy="true"
          aria-label="正在读取配置"
        >
          {[0, 1, 2].map((row) => (
            <div className="skeleton-row" key={row} aria-hidden>
              <span className="skeleton skeleton--name" />
              <span className="skeleton skeleton--meta" />
            </div>
          ))}
        </div>
      ) : configs.length === 0 && error ? (
        <div className="rail__empty">
          <p className="rail__empty-title">配置读取失败</p>
          <p className="rail__empty-text">{error}</p>
          <button
            type="button"
            className="btn btn--ghost rail__empty-action"
            onClick={onRetry}
          >
            重新读取
          </button>
        </div>
      ) : configs.length === 0 ? (
        <div className="rail__empty">
          <p className="rail__empty-title">还没有配置</p>
          <p className="rail__empty-text">让助手配一条，或自己新建一套。</p>
          <button
            type="button"
            className="btn btn--ghost rail__empty-action"
            onClick={onNewConfig}
          >
            新建配置
          </button>
        </div>
      ) : (
        <ul className="configs">
          {configs.map((config) => {
            const active = config.config_id === activeConfigId;
            return (
              <li key={config.config_id} className="configs__row">
                <button
                  type="button"
                  className={`config ${active ? "is-active" : ""}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => {
                    onSelect(config.config_id);
                    setDrawerOpen(false);
                  }}
                >
                  <span className="config__name" title={config.name}>
                    {config.name}
                  </span>
                  <span className="config__meta">
                    {config.node_count} 个节点 · {levelLabel(config)}
                  </span>
                </button>
                <button
                  type="button"
                  className="config__delete"
                  aria-label={`删除配置 ${config.name}`}
                  title={`删除「${config.name}」`}
                  onClick={() => {
                    setConfirming(config);
                    setDeleteError(null);
                  }}
                >
                  <IconTrash size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  return (
    <aside
      id="config-rail"
      ref={railRef}
      tabIndex={-1}
      className={`rail ${compact ? "rail--compact" : ""}`}
      aria-label="配置列表"
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
          aria-label={`配置列表，${configs.length} 套`}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <IconList size={16} />
          <span className="rail__drawer-count">{configs.length}</span>
        </button>
      ) : (
        <>
          <div className="rail__section">
            <span className="rail__label">配置</span>
            <span className="rail__count">{configs.length}</span>
            <button
              type="button"
              className="icon-btn rail__add"
              aria-label="新建配置"
              title="新建配置"
              onClick={onNewConfig}
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
            ref={drawerRef}
            className="rail-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="配置列表"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="rail-drawer__head">
              <span className="rail__label">配置 {configs.length}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="关闭配置列表"
                onClick={() => setDrawerOpen(false)}
              >
                <IconClose size={14} />
              </button>
            </div>
            <button type="button" className="btn btn--ghost rail-drawer__new" onClick={onNewConfig}>
              新建配置
            </button>
            {list}
          </div>
        </div>
      ) : null}

      {confirming ? (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            if (!deleting) setConfirming(null);
          }}
        >
          <div
            ref={confirmRef}
            className="modal modal--confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-config-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="modal__head">
              <h2 id="delete-config-title" className="modal__title">
                删除配置
              </h2>
              <button
                type="button"
                className="modal__close"
                onClick={() => setConfirming(null)}
                disabled={deleting}
                aria-label="关闭"
              >
                <IconClose size={14} />
              </button>
            </header>
            <p className="confirm__text">
              {confirming.config_id === connectedConfigId
                ? "这套配置正在连接。删除会先断开连接，然后再删除。"
                : `「${confirming.name}」删除后无法恢复。`}
            </p>
            {deleteError ? <p className="confirm__error">{deleteError}</p> : null}
            <div className="confirm__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setConfirming(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--danger-ghost"
                onClick={() => void submitDelete()}
                disabled={deleting}
              >
                {deleting ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
