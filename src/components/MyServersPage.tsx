import type { AgentBridge, MyServer, MyServerCatalog } from "../agent/bridge";
import type { ServersView } from "../myservers/useMyServers";
import { formatUsd, formatUsdHourly } from "../myservers/labels";
import { MyServerDetail } from "./MyServerDetail";
import { MyServerWizard } from "./MyServerWizard";

interface Props {
  bridge: AgentBridge;
  catalog: MyServerCatalog | null;
  servers: MyServer[];
  loading: boolean;
  error: string | null;
  detailError: string | null;
  selected: MyServer | null;
  view: ServersView;
  confirmLeave: boolean;
  /** 身份不可用：提示 + 重新注册设备，操作只读。 */
  identityLost: boolean;
  identityMessage: string;
  /** 从节点组「从我的服务器添加」进来：目标组名，用于顶部说明。 */
  joinGroupName: string | null;
  onNew: () => void;
  onUseServer: (nodeId: string, serverName: string) => void;
  onJoinServer: (server: MyServer) => void;
  onChanged: () => void;
  onLeaveWizard: () => void;
  onKeepWizard: () => void;
  onOrdered: (serverId: string | null) => void;
  onReRegister: () => void;
}

/** 「我的服务器」destination 的中间区：空态 / 选中那台详情 / 新建向导。 */
export function MyServersPage({
  bridge,
  catalog,
  servers,
  loading,
  error,
  detailError,
  selected,
  view,
  confirmLeave,
  identityLost,
  identityMessage,
  joinGroupName,
  onNew,
  onUseServer,
  onJoinServer,
  onChanged,
  onLeaveWizard,
  onKeepWizard,
  onOrdered,
  onReRegister,
}: Props) {
  const banner = joinGroupName ? (
    <p className="servers-banner" role="status">
      选择一台服务器，把节点加入「{joinGroupName}」
    </p>
  ) : null;
  const gatePlan =
    catalog?.plans.find((plan) => plan.id === "s-1vcpu-1gb") ?? null;

  const identityBanner = identityLost ? (
    <section className="myservers__identity" role="alert">
      <p className="myservers__identity-text">{identityMessage}</p>
      <div className="myservers__actions">
        <button type="button" className="btn btn--ghost" onClick={onReRegister}>
          重新注册设备
        </button>
      </div>
    </section>
  ) : null;

  if (view === "wizard") {
    return (
      <div className="myservers">
        {banner}
        {identityBanner}
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
          onOrdered={onOrdered}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="myservers">
        {banner}
        {identityBanner}
        <p className="myservers__hint" role="status">
          正在读取你的服务器…
        </p>
      </div>
    );
  }

  return (
    <div className="myservers">
      {banner}
      {identityBanner}
      {error ? (
        <p className="myservers__notice" role="status">
          {error}
        </p>
      ) : null}

      {servers.length === 0 ? (
        <section className="myservers__empty">
          <p className="myservers__empty-title">还没有服务器</p>
          <p className="myservers__empty-text">
            买一台属于你的服务器，Veyl 会帮你装好，建完就能当节点用。
          </p>
          {gatePlan ? (
            <p className="myservers__price">
              {gatePlan.label} ·{" "}
              <span className="num">{formatUsdHourly(gatePlan.hourly_usd)}</span>/小时 · 约{" "}
              <span className="num">{formatUsd(gatePlan.monthly_usd)}</span>/月
            </p>
          ) : null}
          <button
            type="button"
            className="btn btn--primary"
            disabled={identityLost}
            onClick={onNew}
          >
            新建服务器
          </button>
        </section>
      ) : selected ? (
        <>
          {detailError ? (
            <p className="myservers__notice" role="status">
              {detailError}
            </p>
          ) : null}
          <MyServerDetail
            bridge={bridge}
            server={selected}
            readOnly={identityLost}
            joinLabel={joinGroupName ? `加入「${joinGroupName}」` : null}
            onJoin={joinGroupName ? () => onJoinServer(selected) : undefined}
            onUseServer={onUseServer}
            onChanged={onChanged}
            onGone={() => onOrdered(null)}
          />
        </>
      ) : (
        <p className="myservers__hint" role="status">
          正在读取你的服务器…
        </p>
      )}
    </div>
  );
}
