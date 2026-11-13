import { useEffect, useRef, useState } from "react";
import type { ConfigSummary } from "../agent/protocol";
import { levelLabel } from "../ui/configLabels";
import { useFocusTrap } from "../ui/focus";
import { isComposingEvent } from "../ui/ime";
import { IconClose, IconList, IconPencil, IconTrash } from "./icons";

function modeClass(connectMode: ConfigSummary["connect_mode"]): string {
  return connectMode === "tun"
    ? "config__mode config__mode--tun"
    : "config__mode config__mode--proxy";
}

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
  /** 只改名字；成功后由上层就地更新列表，不整表重载。 */
  onRename: (configId: string, name: string) => Promise<{ ok: boolean; message?: string }>;
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
  onRename,
  onOpenSettings,
  compact = false,
}: Props) {
  const [confirming, setConfirming] = useState<ConfigSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<{ id: string; message: string } | null>(
    null,
  );
  const confirmRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameTargetRef = useRef<ConfigSummary | null>(null);
  const renameDraftRef = useRef("");
  const savingRenameRef = useRef(false);
  const cancelRenameRef = useRef(false);
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

  useEffect(() => {
    if (!renameId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renameId]);

  useEffect(() => {
    if (renameId && !configs.some((config) => config.config_id === renameId)) {
      renameTargetRef.current = null;
      setRenameId(null);
      setRenameError(null);
    }
  }, [configs, renameId]);

  const closeRename = () => {
    renameTargetRef.current = null;
    setRenameId(null);
  };

  const startRename = (config: ConfigSummary) => {
    renameTargetRef.current = config;
    renameDraftRef.current = config.name;
    savingRenameRef.current = false;
    cancelRenameRef.current = false;
    setRenameId(config.config_id);
    setRenameDraft(config.name);
    setRenameError(null);
  };

  const submitRename = async () => {
    const target = renameTargetRef.current;
    if (!target || savingRenameRef.current || cancelRenameRef.current) return;
    const next = renameDraftRef.current.trim();
    if (!next || next === target.name) {
      closeRename();
      return;
    }
    savingRenameRef.current = true;
    const result = await onRename(target.config_id, next);
    savingRenameRef.current = false;
    if (cancelRenameRef.current) return;
    // 保存期间已经切到别的行时，不要关掉新的编辑态。
    if (renameTargetRef.current?.config_id === target.config_id) closeRename();
    setRenameError(
      result.ok
        ? null
        : { id: target.config_id, message: result.message ?? "改名失败，请重试" },
    );
  };

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
            const editing = config.config_id === renameId;
            return (
              <li key={config.config_id} className="configs__row">
                {editing ? (
                  <div className={`config config--editing ${active ? "is-active" : ""}`}>
                    <div className="config__name config__name--editing">
                      <span className={modeClass(config.connect_mode)} aria-hidden />
                      <input
                        ref={renameInputRef}
                        className="config__rename-input"
                        value={renameDraft}
                        maxLength={40}
                        aria-label="配置名称"
                        onChange={(event) => {
                          renameDraftRef.current = event.target.value;
                          setRenameDraft(event.target.value);
                        }}
                        onKeyDown={(event) => {
                          if (isComposingEvent(event)) return;
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void submitRename();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            cancelRenameRef.current = true;
                            closeRename();
                          }
                        }}
                        onBlur={() => void submitRename()}
                      />
                    </div>
                    <span className="config__meta">
                      {config.node_count} 个节点 · {levelLabel(config)}
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={`config ${active ? "is-active" : ""}`}
                    aria-current={active ? "true" : undefined}
                    onClick={() => {
                      onSelect(config.config_id);
                      setDrawerOpen(false);
                    }}
                  >
                    <span
                      className="config__name"
                      title={config.name}
                      onDoubleClick={() => startRename(config)}
                    >
                      <span className={modeClass(config.connect_mode)} aria-hidden />
                      <span className="config__name-text">{config.name}</span>
                    </span>
                    <span className="config__meta">
                      {config.node_count} 个节点 · {levelLabel(config)}
                    </span>
                  </button>
                )}
                {!editing ? (
                  <>
                    <button
                      type="button"
                      className="config__rename"
                      aria-label={`重命名配置 ${config.name}`}
                      title={`重命名「${config.name}」`}
                      onClick={() => startRename(config)}
                    >
                      <IconPencil size={13} />
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
                  </>
                ) : null}
                {renameError?.id === config.config_id ? (
                  <p className="config__rename-error" role="status">
                    {renameError.message}
                  </p>
                ) : null}
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
