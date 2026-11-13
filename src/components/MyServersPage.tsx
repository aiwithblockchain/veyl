import type { AgentBridge, MyServer, MyServerCatalog } from "../agent/bridge";
import type { MyServersView } from "../myservers/useMyServers";
import { MyServerDetail } from "./MyServerDetail";
import { MyServerLogin } from "./MyServerLogin";
import { MyServerWizard } from "./MyServerWizard";

interface Props {
  bridge: AgentBridge;
  account: string | null;
  catalog: MyServerCatalog | null;
  servers: MyServer[];
  loading: boolean;
  error: string | null;
  selected: MyServer | null;
  view: MyServersView;
  confirmLeave: boolean;
  loginOpen: boolean;
  onOpenLogin: () => void;
  onCloseLogin: () => void;
  onSignedIn: (email: string) => void;
  onNew: () => void;
  onUseServer: (nodeId: string, serverName: string) => void;
  onChanged: () => void;
  onLeaveWizard: () => void;
  onKeepWizard: () => void;
  onOrdered: (serverId: string | null) => void;
  onResetToRoot: () => void;
}

/** 服务器 destination 的中间区：登录门 / 空态 / 选中那台的详情 / 新建向导。 */
export function MyServersPage({
  bridge,
  account,
  catalog,
  servers,
  loading,
  error,
  selected,
  view,
  confirmLeave,
  loginOpen,
  onOpenLogin,
  onCloseLogin,
  onSignedIn,
  onNew,
  onUseServer,
  onChanged,
  onLeaveWizard,
  onKeepWizard,
  onOrdered,
  onResetToRoot,
}: Props) {
  if (!account) {
    return (
      <div className="myservers">
        {error ? (
          <p className="myservers__notice" role="status">
            {error}
          </p>
        ) : null}
        {loginOpen ? (
          <MyServerLogin onDone={onSignedIn} onCancel={onCloseLogin} />
        ) : (
          <section className="myservers__gate">
            <p className="myservers__gate-text">登录后查看你的服务器</p>
            <p className="myservers__price num">
              1 核 1 GB · $0.007/小时 · 约 $5/月
            </p>
            <button type="button" className="btn btn--ghost" onClick={onOpenLogin}>
              登录
            </button>
          </section>
        )}
      </div>
    );
  }

  if (view === "wizard") {
    return (
      <div className="myservers">
        {confirmLeave ? (
          <div className="myservers__confirm" role="alert">
            <p>还没下单，离开后这次选择不会保存。</p>
            <div className="myservers__actions">
              <button type="button" className="btn btn--ghost" onClick={onKeepWizard}>
                继续填写
              </button>
              <button type="button" className="btn btn--ghost" onClick={onLeaveWizard}>
                离开
              </button>
            </div>
          </div>
        ) : null}
        <MyServerWizard
          bridge={bridge}
          catalog={catalog}
          onCancel={onLeaveWizard}
          onOrdered={onOrdered}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="myservers">
        <p className="myservers__hint" role="status">
          正在读取你的服务器…
        </p>
      </div>
    );
  }

  return (
    <div className="myservers">
      {error ? (
        <p className="myservers__notice" role="status">
          {error}
        </p>
      ) : null}

      {servers.length === 0 ? (
        <section className="myservers__empty">
          <p className="myservers__empty-title">还没有服务器</p>
          <p className="myservers__empty-text">
            用 Vultr 买一台属于你的服务器，Veyl 会帮你装好，建完就能当节点用。
          </p>
          <button type="button" className="btn btn--primary" onClick={onNew}>
            新建服务器
          </button>
        </section>
      ) : selected ? (
        <MyServerDetail
          bridge={bridge}
          server={selected}
          onUseServer={onUseServer}
          onChanged={onChanged}
          onGone={onResetToRoot}
        />
      ) : (
        <p className="myservers__hint" role="status">
          正在读取你的服务器…
        </p>
      )}
    </div>
  );
}
