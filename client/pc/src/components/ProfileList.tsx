import { useRef, useState } from "react";

import type { Profile, SyncState } from "../api";

const SYNC_LABEL: Record<SyncState, string> = {
  ok: "已同步",
  failed: "上次同步失败",
  unauthorized: "链接已失效",
  never: "不参与同步",
};

export function syncLabel(state: SyncState): string {
  return SYNC_LABEL[state];
}

export function sourceLabel(profile: Profile): string {
  return profile.source.kind === "subscription" ? "订阅" : "本地文件";
}

type Props = {
  profiles: Profile[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onImport: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
};

export function ProfileList({
  profiles,
  activeId,
  onSelect,
  onImport,
  onRename,
  onDelete,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Esc 会先改状态、再让输入框失焦；失焦不能把按 Esc 前的内容当成新名字。
  const skipSave = useRef(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const startEditing = (profile: Profile) => {
    skipSave.current = false;
    setDraft(profile.name);
    setEditingId(profile.id);
  };

  const cancelEditing = () => {
    skipSave.current = true;
    setEditingId(null);
    setDraft("");
  };

  const saveName = (profile: Profile) => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    const name = draft.trim();
    setEditingId(null);
    if (name === "" || name === profile.name) return;
    onRename(profile.id, name);
  };

  return (
    <aside className="rail">
      <div className="rail__head">
        <span className="rail__title">配置</span>
        <button
          type="button"
          className="btn btn--icon"
          onClick={onImport}
          aria-label="导入订阅"
          title="导入订阅"
        >
          +
        </button>
      </div>

      {profiles.length === 0 ? (
        <p className="rail__empty">还没有配置</p>
      ) : (
        <div className="rail__list">
          {profiles.map((profile) => (
            <div key={profile.id}>
              <div
                className="profile-row"
                role="button"
                tabIndex={0}
                aria-label={profile.name}
                aria-current={profile.id === activeId}
                onClick={() => onSelect(profile.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(profile.id);
                  }
                }}
              >
                <span className={`dot dot--${profile.sync_state}`} aria-hidden />
                <span className="profile-row__body">
                  {editingId === profile.id ? (
                    <input
                      className="profile-row__input"
                      aria-label="配置名称"
                      autoFocus
                      value={draft}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => saveName(profile)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          saveName(profile);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelEditing();
                        }
                      }}
                    />
                  ) : (
                    <span
                      className="profile-row__name"
                      onDoubleClick={() => startEditing(profile)}
                    >
                      {profile.name}
                    </span>
                  )}
                  <span className="profile-row__meta">
                    {profile.node_count} 个节点 · {sourceLabel(profile)} ·{" "}
                    {syncLabel(profile.sync_state)}
                  </span>
                </span>
                <span className="profile-row__actions">
                  <button
                    type="button"
                    className="btn btn--icon"
                    aria-label={`重命名 ${profile.name}`}
                    title="重命名"
                    onClick={(event) => {
                      event.stopPropagation();
                      startEditing(profile);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="btn btn--icon"
                    aria-label={`删除 ${profile.name}`}
                    title="删除"
                    onClick={(event) => {
                      event.stopPropagation();
                      setConfirmingId(
                        confirmingId === profile.id ? null : profile.id,
                      );
                    }}
                  >
                    ×
                  </button>
                </span>
              </div>

              {confirmingId === profile.id ? (
                <div
                  className="profile-row__confirm"
                  role="group"
                  aria-label={`确认删除 ${profile.name}`}
                >
                  <span className="profile-row__confirm-text">
                    删除后本机副本与已保存的链接都会消失。
                  </span>
                  <button
                    type="button"
                    className="btn btn--danger-ghost"
                    onClick={() => {
                      setConfirmingId(null);
                      onDelete(profile.id);
                    }}
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setConfirmingId(null)}
                  >
                    取消
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
