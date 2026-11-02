import type { RuntimeProfile } from "../agent/bridge";

interface Props {
  profiles: RuntimeProfile[];
  /** 当前生效的 profile；未连接时是上次使用的那个。 */
  currentId: string | null;
  disabled: boolean;
  onSelect: (profileId: string) => void;
}

export function ProfileList({ profiles, currentId, disabled, onSelect }: Props) {
  if (profiles.length === 0) {
    return <p className="profile-list__empty">还没有节点</p>;
  }

  return (
    <ul className="profile-list">
      {profiles.map((profile) => {
        const current = profile.id === currentId;
        const meta = [profile.region, profile.protocol].filter(Boolean).join(" · ");
        const source = profile.nodeId ? "目录导入" : "种子导入";

        return (
          <li key={profile.id}>
            <button
              type="button"
              className={`profile-list__item ${current ? "is-current" : ""}`}
              disabled={disabled || current}
              onClick={() => onSelect(profile.id)}
            >
              <span className="profile-list__name">{profile.name}</span>
              <span className="profile-list__meta">
                {meta ? `${meta} · ` : ""}
                {source}
              </span>
              {current ? <span className="profile-list__badge">当前</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
