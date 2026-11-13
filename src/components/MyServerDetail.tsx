import { useState } from "react";
import type { AgentBridge, MyServer, MyServerSshCredentials } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { copyText } from "../ui/clipboard";
import { ServerProgress } from "./ServerProgress";
import {
  MY_SERVER_STATE_LABEL,
  formatServerTime,
  isProvisioning,
  stateTone,
} from "../myservers/labels";

interface Props {
  bridge: AgentBridge;
  server: MyServer;
  onUseServer: (nodeId: string, serverName: string) => void;
  onChanged: () => void;
  /** 销毁或重建后回到根视图。 */
  onGone: () => void;
}

function errorText(error: unknown): string {
  const message = toBridgeError(error).message;
  return message && message !== "操作失败" ? message : "这台服务器暂时读不到，稍后再试。";
}

export function MyServerDetail({
  bridge,
  server,
  onUseServer,
  onChanged,
  onGone,
}: Props) {
  const [sshOpen, setSshOpen] = useState(false);
  const [ssh, setSsh] = useState<MyServerSshCredentials | null>(null);
  const [sshError, setSshError] = useState<string | null>(null);
  const [passwordShown, setPasswordShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleSsh = () => {
    const next = !sshOpen;
    setSshOpen(next);
    if (!next || ssh || !server.ip) return;
    void bridge
      .myServerSshCredentials(server.server_id)
      .then((value) => {
        setSsh(value);
        setSshError(null);
      })
      .catch((err) => setSshError(errorText(err)));
  };

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

  // 就绪前既没有节点也拿不到 SSH 凭据，这两个入口都不出现。
  const ready =
    Boolean(server.node_id) && (server.state === "healthy" || server.state === "active");

  return (
    <div className="myservers__detail">
      <header className="myservers__detail-head">
        <h4 className="myservers__wizard-title">{server.name}</h4>
        <span className={`myservers__state is-${stateTone(server.state)}`}>
          <span className={`led is-${stateTone(server.state)}`} aria-hidden />
          {MY_SERVER_STATE_LABEL[server.state]}
        </span>
      </header>

      {isProvisioning(server.state) ? <ServerProgress server={server} /> : null}

      <dl className="myservers__facts">
        <div>
          <dt>地区</dt>
          <dd>{server.name.replace(" · Vultr", "")}</dd>
        </div>
        <div>
          <dt>IP</dt>
          <dd className="num">{server.ip ?? "还没分配"}</dd>
        </div>
        <div>
          <dt>节点</dt>
          <dd>{server.node_id ? "已就绪，可作为节点使用" : "还没就绪"}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd className="num">{formatServerTime(server.created_at)}</dd>
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

      {server.state === "error" || ready ? (
        <div className="myservers__actions">
          {server.state === "error" ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void rebuild()}
            >
              重新建一台
            </button>
          ) : null}
          {ready ? (
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => server.node_id && onUseServer(server.node_id, server.name)}
            >
              用来建配置
            </button>
          ) : null}
        </div>
      ) : null}

      {ready ? (
      <section className="myservers__ssh">
        <button
          type="button"
          className="myservers__ssh-toggle"
          aria-expanded={sshOpen}
          onClick={toggleSsh}
        >
          SSH 登录 <span aria-hidden>{sshOpen ? "⌄" : "›"}</span>
        </button>
        {sshOpen ? (
          sshError ? (
            <p className="myservers__error" role="alert">
              {sshError}
            </p>
          ) : ssh ? (
            <dl className="myservers__facts myservers__facts--compact">
              <div>
                <dt>地址</dt>
                <dd className="num">
                  {ssh.host}:{ssh.port}
                  <button
                    type="button"
                    className="myservers__copy"
                    onClick={() => void copyText(`${ssh.host}:${ssh.port}`)}
                  >
                    复制
                  </button>
                </dd>
              </div>
              <div>
                <dt>用户名</dt>
                <dd className="num">
                  {ssh.username}
                  <button
                    type="button"
                    className="myservers__copy"
                    onClick={() => void copyText(ssh.username)}
                  >
                    复制
                  </button>
                </dd>
              </div>
              <div>
                <dt>认证方式</dt>
                <dd>密码</dd>
              </div>
              <div>
                <dt>密码</dt>
                <dd className="num">
                  {passwordShown ? ssh.password ?? "—" : "••••••••"}
                  <button
                    type="button"
                    className="myservers__copy"
                    onClick={() => setPasswordShown((value) => !value)}
                  >
                    {passwordShown ? "隐藏" : "显示"}
                  </button>
                  {passwordShown && ssh.password ? (
                    <button
                      type="button"
                      className="myservers__copy"
                      onClick={() => void copyText(ssh.password ?? "")}
                    >
                      复制
                    </button>
                  ) : null}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="myservers__hint" role="status">
              正在读取登录信息…
            </p>
          )
        ) : null}
      </section>
      ) : null}

      <div className="myservers__danger">
        {confirming ? (
          <div className="myservers__confirm" role="alert">
            <p>销毁后这台服务器和它的节点都不能再用。</p>
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
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            销毁
          </button>
        )}
      </div>
    </div>
  );
}
