import { useState } from "react";
import type { NodeGroup } from "../groups/mockGroups";
import { IconClose } from "./icons";

interface Props {
  groups: NodeGroup[];
  selectedId: string | null;
  activeGroupId: string | null;
  compact?: boolean;
  onSelect: (groupId: string) => void;
  onCreate: () => void;
  onOpenSettings: () => void;
}

function GroupRow({
  group,
  selected,
  active,
  onSelect,
}: {
  group: NodeGroup;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`config ${selected ? "is-active" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="config__name" title={group.name}>
        <span className="config__name-text">{group.name}</span>
      </span>
      <span className="config__meta">
        {group.nodes.length} 个节点
        {active ? " · 当前节点组" : ""}
      </span>
    </button>
  );
}

export function NodeGroupsRail({
  groups,
  selectedId,
  activeGroupId,
  compact = false,
  onSelect,
  onCreate,
  onOpenSettings,
}: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const free = groups.filter((group) => group.read_only);
  const mine = groups.filter((group) => !group.read_only);

  const rows = (list: NodeGroup[]) => (
    <ul className="configs">
      {list.map((group) => (
        <li key={group.group_id} className="configs__row">
          <GroupRow
            group={group}
            selected={group.group_id === selectedId}
            active={group.group_id === activeGroupId}
            onSelect={() => {
              onSelect(group.group_id);
              setDrawerOpen(false);
            }}
          />
        </li>
      ))}
    </ul>
  );

  const sections = (
    <>
      {free.length > 0 ? (
        <>
          <p className="rail__group-label">免费</p>
          {rows(free)}
        </>
      ) : null}
      <p className="rail__group-label">我的组</p>
      {mine.length === 0 ? (
        <div className="rail__empty">
          <p className="rail__empty-text">还没有自己的组</p>
          <button type="button" className="btn btn--ghost rail__empty-action" onClick={onCreate}>
            新建组
          </button>
        </div>
      ) : (
        rows(mine)
      )}
    </>
  );

  return (
    <aside
      id="config-rail"
      className={`rail ${compact ? "rail--compact" : ""}`}
      aria-label="节点组列表"
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
          aria-label={`节点组列表，${groups.length} 个`}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <span className="rail__drawer-count">{groups.length}</span>
        </button>
      ) : (
        <>
          <div className="rail__section">
            <span className="rail__label">节点组</span>
            <span className="rail__count">{groups.length}</span>
            <button
              type="button"
              className="icon-btn rail__add"
              aria-label="新建组"
              title="新建组"
              onClick={onCreate}
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
          <div className="rail__groups">{sections}</div>
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
            className="rail-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="节点组列表"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="rail-drawer__head">
              <span className="rail__label">节点组 {groups.length}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="关闭节点组列表"
                onClick={() => setDrawerOpen(false)}
              >
                <IconClose size={14} />
              </button>
            </div>
            <button type="button" className="btn btn--ghost rail-drawer__new" onClick={onCreate}>
              新建组
            </button>
            {sections}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
