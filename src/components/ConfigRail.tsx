import { useEffect, useRef, useState } from "react";
import type { ConfigSummary } from "../agent/protocol";
import { portLabel } from "../config/model";
import { useFocusTrap } from "../ui/focus";
import { IconClose, IconTrash } from "./icons";

interface Props {
  configs: ConfigSummary[];
  activeConfigId: string | null;
  /** 当前真正连着的那套配置；没连或没连上都是 null。 */
  connectedConfigId: string | null;
  loading?: boolean;
  error?: string | null;
  onSelect: (configId: string) => void;
  onNewConfig: () => void;
  onDelete: (configId: string) => Promise<{ ok: boolean; message?: string }>;
}

export function ConfigRail({
  configs,
  activeConfigId,
  connectedConfigId,
  loading = false,
  error = null,
  onSelect,
  onNewConfig,
  onDelete,
}: Props) {
  const [confirming, setConfirming] = useState<ConfigSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  useFocusTrap(Boolean(confirming), confirmRef);

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

  const submitDelete = async () => {
    if (!confirming || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const result = await onDelete(confirming.config_id);
    setDeleting(false);
    if (result.ok) setConfirming(null);
    else setDeleteError(result.message ?? "删除失败，请重试");
  };

  return (
    <aside className="config-rail" aria-label="配置列表">
      <header className="config-rail__head">
        <span className="config-rail__title">配置</span>
        <button
          type="button"
          className="config-rail__add"
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
      </header>

      {loading ? (
        <div
          className="config-rail__loading"
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
        <div className="config-rail__empty">
          <p className="config-rail__empty-title">配置读取失败</p>
          <p className="config-rail__empty-text">{error}</p>
        </div>
      ) : configs.length === 0 ? (
        <div className="config-rail__empty">
          <p className="config-rail__empty-title">还没有配置</p>
          <p className="config-rail__empty-text">
            自己新建一套，或在对话里让助手帮你配好第一套。
          </p>
          <button type="button" className="btn btn--ghost" onClick={onNewConfig}>
            新建配置
          </button>
        </div>
      ) : (
        <>
          <ul className="config-list">
            {configs.map((config) => {
              const active = config.config_id === activeConfigId;
              const connected = config.config_id === connectedConfigId;
              const port = portLabel(config);
              return (
                <li key={config.config_id}>
                  <div className="config-list__row ai-history__row">
                    <button
                      type="button"
                      className={`config-list__item ${active ? "is-active" : ""}`}
                      aria-current={active ? "true" : undefined}
                      onClick={() => onSelect(config.config_id)}
                    >
                      <span className="config-list__top">
                        <span className="config-list__name">{config.name}</span>
                        {connected ? (
                          <span className="config-list__status">
                            <span className="config-list__dot" aria-hidden />
                            已连接
                          </span>
                        ) : null}
                      </span>
                      <span className="config-list__meta">
                        {config.node_count} 个节点 ·{" "}
                        {/^\d+$/.test(port) ? <span className="num">{port}</span> : port}
                      </span>
                    </button>
                    <div className="ai-history__actions">
                      <button
                        type="button"
                        className="ai-history__action ai-history__action--danger"
                        aria-label={`删除配置 ${config.name}`}
                        title={`删除「${config.name}」`}
                        onClick={() => {
                          setConfirming(config);
                          setDeleteError(null);
                        }}
                      >
                        <IconTrash size={13} />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <button type="button" className="config-rail__new" onClick={onNewConfig}>
            <span className="config-rail__new-plus" aria-hidden>
              +
            </span>
            新建配置
          </button>
        </>
      )}

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
