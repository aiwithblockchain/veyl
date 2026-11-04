import type { ConfigSummary } from "../agent/protocol";
import { portLabel } from "../config/model";

interface Props {
  configs: ConfigSummary[];
  activeConfigId: string | null;
  /** 当前真正连着的那套配置；没连或没连上都是 null。 */
  connectedConfigId: string | null;
  loading?: boolean;
  error?: string | null;
  onSelect: (configId: string) => void;
  onNewConfig: () => void;
}

export function ConfigRail({
  configs,
  activeConfigId,
  connectedConfigId,
  loading = false,
  error = null,
  onSelect,
  onNewConfig,
}: Props) {

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
    </aside>
  );
}
