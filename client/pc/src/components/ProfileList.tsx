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
};

export function ProfileList({ profiles, activeId, onSelect, onImport }: Props) {
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
            <button
              type="button"
              key={profile.id}
              className="profile-row"
              aria-current={profile.id === activeId}
              onClick={() => onSelect(profile.id)}
            >
              <span className={`dot dot--${profile.sync_state}`} aria-hidden />
              <span className="profile-row__body">
                <span className="profile-row__name">{profile.name}</span>
                <span className="profile-row__meta">
                  {profile.node_count} 个节点 · {sourceLabel(profile)} ·{" "}
                  {syncLabel(profile.sync_state)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
