import { useRef, useState } from "react";

import type { ProfileDetail as Detail } from "../api";
import { syncLabel } from "./ProfileList";

type Props = {
  detail: Detail;
  busy: boolean;
  onRefresh: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
};

function formatTime(millis: number | null): string {
  if (!millis) return "从不同步";
  const date = new Date(millis);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function ProfileDetail({ detail, busy, onRefresh, onRename, onDelete }: Props) {
  const { profile, nodes, source_label } = detail;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 回车与失焦都会触发保存；用 ref 保证只提交一次。
  const savedRef = useRef(false);

  const isSubscription = profile.source.kind === "subscription";

  const startEditing = () => {
    savedRef.current = false;
    setDraft(profile.name);
    setEditing(true);
  };

  const cancelEditing = () => {
    savedRef.current = true;
    setEditing(false);
    setDraft(profile.name);
  };

  const saveName = () => {
    if (savedRef.current) return;
    savedRef.current = true;
    const name = draft.trim();
    setEditing(false);
    if (name === "" || name === profile.name) {
      setDraft(profile.name);
      return;
    }
    onRename(name);
  };

  return (
    <section aria-label="配置详情">
      <header className="detail__head">
        <div>
          {editing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                saveName();
              }}
            >
              <input
                className="field__input"
                aria-label="配置名称"
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={saveName}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelEditing();
                  }
                }}
              />
            </form>
          ) : (
            <h1 className="detail__title">{profile.name}</h1>
          )}
          <p className="detail__source num">{source_label}</p>
        </div>

        <div className="detail__actions">
          {isSubscription ? (
            <button type="button" className="btn" onClick={onRefresh} disabled={busy}>
              刷新
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={startEditing}
            disabled={busy}
          >
            重命名
          </button>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className="btn btn--danger-ghost"
                onClick={onDelete}
                disabled={busy}
              >
                确认删除
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setConfirmingDelete(false)}
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--danger-ghost"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
            >
              删除
            </button>
          )}
        </div>
      </header>

      <div className="detail__facts">
        <div>
          <div className="fact__label">节点</div>
          <div className="fact__value num">{profile.node_count}</div>
        </div>
        <div>
          <div className="fact__label">同步状态</div>
          <div className="fact__value">{syncLabel(profile.sync_state)}</div>
        </div>
        <div>
          <div className="fact__label">最近同步</div>
          <div className="fact__value num">{formatTime(profile.last_synced_at)}</div>
        </div>
      </div>

      {profile.sync_error ? (
        <p className="notice notice--error">{profile.sync_error}</p>
      ) : null}

      {profile.kernel_check === "unavailable" && profile.node_count > 0 ? (
        <p className="notice">
          这台机器上还没有随包内核，本次没有做内核校验；结构校验已通过。
        </p>
      ) : null}

      {profile.node_count === 0 ? (
        <p className="notice">
          这套配置里没有可用节点。回桌面端确认账户下还有服务器，然后刷新。
        </p>
      ) : (
        <div className="nodes">
          <h2 className="nodes__title">节点</h2>
          <ul className="nodes__list">
            {nodes.map((node) => (
              <li className="nodes__row" key={node.tag}>
                <span>{node.tag}</span>
                <span className="nodes__kind num">{node.kind}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="footnote">连接能力将在下一阶段接入；现在只能导入和查看配置。</p>
    </section>
  );
}
