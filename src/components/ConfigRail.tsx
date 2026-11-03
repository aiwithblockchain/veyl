import { useState } from "react";
import type { ConnectMode, VpnConfig } from "../config/model";
import { portLabel } from "../config/model";
import { NewConfigDialog } from "./NewConfigDialog";

interface Props {
  configs: VpnConfig[];
  activeConfigId: string | null;
  /** 当前真正连着的那套配置；没连或没连上都是 null。 */
  connectedConfigId: string | null;
  onSelect: (configId: string) => void;
  onCreate: (name: string, mode: ConnectMode) => void;
}

export function ConfigRail({
  configs,
  activeConfigId,
  connectedConfigId,
  onSelect,
  onCreate,
}: Props) {
  const [creating, setCreating] = useState(false);

  return (
    <aside className="config-rail" aria-label="配置列表">
      <header className="config-rail__head">
        <span className="config-rail__title">配置</span>
        <button
          type="button"
          className="config-rail__add"
          aria-label="新建配置"
          title="新建配置"
          onClick={() => setCreating(true)}
        >
          ＋
        </button>
      </header>

      {configs.length === 0 ? (
        <div className="config-rail__empty">
          <p className="config-rail__empty-title">还没有配置</p>
          <p className="config-rail__empty-text">
            在右侧告诉助手你的情况，它会帮你配好第一套。也可以自己新建一套。
          </p>
          <button type="button" className="btn btn--ghost" onClick={() => setCreating(true)}>
            新建配置
          </button>
        </div>
      ) : (
        <>
          <ul className="config-list">
            {configs.map((config) => {
              const active = config.config_id === activeConfigId;
              const connected = config.config_id === connectedConfigId;
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
                      {config.nodes.length} 个节点 · {portLabel(config)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" className="config-rail__new" onClick={() => setCreating(true)}>
            ＋ 新建配置
          </button>
        </>
      )}

      {creating ? (
        <NewConfigDialog
          configs={configs}
          onClose={() => setCreating(false)}
          onCreate={(name, mode) => {
            onCreate(name, mode);
            setCreating(false);
          }}
        />
      ) : null}
    </aside>
  );
}
