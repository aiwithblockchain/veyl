import { useEffect, useRef, useState } from "react";

import type { ConnectionSnapshot, ProfileDetail as Detail } from "../api";
import { syncLabel } from "./ProfileList";

type Props = {
  detail: Detail;
  busy: boolean;
  connection: ConnectionSnapshot | null;
  onRefresh: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onSwitchNode: (tag: string) => void;
};

function formatTime(millis: number | null): string {
  if (!millis) return "从不同步";
  const date = new Date(millis);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function formatUptime(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${pad(minutes)}:${pad(rest)}`;
}

function useUptime(snapshot: ConnectionSnapshot | null): number {
  const base = snapshot?.state === "connected" ? (snapshot.uptime_seconds ?? 0) : 0;
  const startedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    startedAt.current = Date.now();
    setNow(Date.now());
    if (snapshot?.state !== "connected") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot?.state, snapshot?.uptime_seconds]);

  if (snapshot?.state !== "connected") return 0;
  return base + Math.floor((now - startedAt.current) / 1000);
}

export function ProfileDetail({
  detail,
  busy,
  connection,
  onRefresh,
  onRename,
  onDelete,
  onConnect,
  onDisconnect,
  onSwitchNode,
}: Props) {
  const { profile, nodes, source_label } = detail;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 回车与失焦都会触发保存；用 ref 保证只提交一次。
  const savedRef = useRef(false);

  const isSubscription = profile.source.kind === "subscription";
  const state = connection?.state ?? "idle";
  const connected = state === "connected";
  const connecting = state === "connecting";
  const disconnecting = state === "disconnecting";
  const uptime = useUptime(connection);
  // 未连接时也要显示用户选过哪个节点（后端会把它带在快照里）。
  const currentNode =
    connection?.selected_node ??
    (connection?.state === "connected" ? connection.node : null);

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

  const statusWord =
    state === "connected"
      ? "已连接"
      : state === "connecting"
        ? "连接中…"
        : state === "disconnecting"
          ? "断开中…"
          : state === "failed"
            ? "连接失败"
            : "未连接";

  const primary =
    connected
      ? { label: "断开 VPN", run: onDisconnect, disabled: busy || disconnecting }
      : connecting || disconnecting
        ? { label: connecting ? "连接中…" : "断开中…", run: () => {}, disabled: true }
        : {
            label: state === "failed" ? "重新连接" : "启动 VPN",
            run: onConnect,
            disabled: busy || profile.node_count === 0,
          };

  return (
    <section aria-label="配置详情">
      <div className="hero">
        <div className="hero__status">
          <span
            className={`dot dot--${connected ? "ok" : state === "failed" ? "failed" : "never"}`}
            aria-hidden
          />
          <span className="hero__word">{statusWord}</span>
          {connected ? (
            <span className="hero__timer num">{formatUptime(uptime)}</span>
          ) : null}
          {connected && currentNode ? (
            <span className="hero__node">{currentNode}</span>
          ) : null}
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={primary.run}
          disabled={primary.disabled}
        >
          {primary.label}
        </button>
      </div>

      {state === "failed" && connection?.state === "failed" ? (
        <div className="notice notice--error" role="alert">
          <p>{connection.message}</p>
          {connection.reason ? <p>{connection.reason}</p> : null}
          {connection.hint ? <p>{connection.hint}</p> : null}
        </div>
      ) : null}

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
          <button type="button" className="btn" onClick={startEditing} disabled={busy}>
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
          <h2 className="nodes__title">
            节点{connected ? "（点一行即可切换）" : ""}
          </h2>
          <ul className="nodes__list">
            {nodes.map((node) => {
              const current = currentNode === node.tag;
              return (
                <li key={node.tag}>
                  <button
                    type="button"
                    className="nodes__row"
                    aria-current={current}
                    onClick={() => onSwitchNode(node.tag)}
                    disabled={busy || connecting || disconnecting}
                  >
                    <span className="nodes__name">
                      {current ? <span className="dot dot--ok" aria-hidden /> : null}
                      {node.tag}
                    </span>
                    <span className="nodes__kind num">{node.kind}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
