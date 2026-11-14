import { useState } from "react";
import type { AgentBridge, MyServer } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { ServerProgress } from "./ServerProgress";
import {
  MY_SERVER_STATE_LABEL,
  formatUsd,
  isProvisioning,
  stateTone,
} from "../myservers/labels";

interface Props {
  bridge: AgentBridge;
  server: MyServer;
  /** 身份不可用：只读，不提供任何改动机器的操作。 */
  readOnly?: boolean;
  /** 从节点组进来：主按钮换成「加入「X」」。 */
  joinLabel?: string | null;
  onJoin?: () => void;
  onUseServer: (nodeId: string, serverName: string) => void;
  onChanged: () => void;
  /** 销毁或重建后收起详情。 */
  onGone: () => void;
}

function errorText(error: unknown): string {
  const problem = toBridgeError(error);
  const message = problem.message && problem.message !== "操作失败" ? problem.message : "";
  const tail = problem.retryable ? "没有改动这台服务器；稍后再试。" : "没有改动这台服务器。";
  return message ? `${message}${tail}` : `这次操作没完成。${tail}`;
}

/** 服务器子视图里的就地详情：SSH 与地址类事实已撤掉。 */
export function MyServerDetail({
  bridge,
  server,
  readOnly = false,
  joinLabel = null,
  onJoin,
  onUseServer,
  onChanged,
  onGone,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rebuild = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await bridge.myServerRebuild(server.server_id, true);
      onChanged();
      onGone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const destroy = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await bridge.myServerDestroy(server.server_id, true);
      onChanged();
      onGone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const ready =
    Boolean(server.node_id) && (server.state === "healthy" || server.state === "active");
  const destroying = server.state === "destroying";
  const locked = readOnly || busy || destroying;

  return (
    <div className="myservers__detail">
      <div className="myservers__detail-head">
        <span className={`myservers__state is-${stateTone(server.state)}`}>
          <span className={`led is-${stateTone(server.state)}`} aria-hidden />
          {MY_SERVER_STATE_LABEL[server.state]}
        </span>
      </div>

      {isProvisioning(server.state) ? <ServerProgress server={server} /> : null}

      <dl className="myservers__facts">
        <div>
          <dt>地区</dt>
          <dd>{server.name.split(" · ")[0]}</dd>
        </div>
        <div>
          <dt>节点</dt>
          <dd>{server.node_id ? "已就绪" : "未就绪"}</dd>
        </div>
        <div>
          <dt>费用</dt>
          <dd className="num">约 {formatUsd(server.monthly_usd)}/月</dd>
        </div>
      </dl>

      {server.failure ? (
        <div className="myservers__failure" role="alert">
          <p>{server.failure.message}</p>
        </div>
      ) : null}

      {error ? (
        <p className="myservers__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="myservers__actions">
        {server.state === "error" ? (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={locked}
            onClick={() => void rebuild()}
          >
            重新建一台
          </button>
        ) : null}
        {ready ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={locked}
            onClick={() => {
              if (joinLabel && onJoin) onJoin();
              else if (server.node_id) onUseServer(server.node_id, server.name);
            }}
          >
            {joinLabel ?? "用来建配置"}
          </button>
        ) : null}
      </div>

      <div className="myservers__danger">
        {destroying ? (
          <p className="myservers__hint" role="status">
            正在销毁…
          </p>
        ) : confirming ? (
          <div className="myservers__confirm" role="alert">
            <p>
              {isProvisioning(server.state)
                ? "取消创建并销毁这台服务器？正在进行的安装会中断。"
                : "销毁后这台服务器和它的节点都不能再用。"}
            </p>
            <div className="myservers__actions">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--danger-ghost"
                disabled={busy}
                onClick={() => void destroy()}
              >
                {busy ? "正在销毁…" : "确认销毁"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn--danger-ghost"
            disabled={locked}
            onClick={() => setConfirming(true)}
          >
            销毁
          </button>
        )}
      </div>
    </div>
  );
}
