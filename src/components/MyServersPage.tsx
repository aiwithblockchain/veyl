import type { AgentBridge, MyServer, MyServerCatalog, MyServerState } from "../agent/bridge";
import type { ServersView } from "../myservers/useMyServers";
import { MyServerDetail } from "./MyServerDetail";
import { MyServerWizard } from "./MyServerWizard";

interface Props {
  bridge: AgentBridge;
  catalog: MyServerCatalog | null;
  selected: MyServer | null;
  view: ServersView;
  detailError: string | null;
  detailRetrying: boolean;
  /** 身份不可用：详情只读。 */
  readOnly: boolean;
  /** 从节点组「从我的服务器添加」进来：目标组名，用于顶部说明。 */
  joinGroupName: string | null;
  /** 同账户未销毁机器 > 1：流量额度是共享池。 */
  sharedTransfer: boolean;
  onNew: () => void;
  onEnsureIdentity: () => Promise<boolean>;
  onTopUp: () => void;
  onUseServer: (server: MyServer) => void;
  onJoinServer: (server: MyServer) => void;
  onChanged: () => void;
  onOrdered: (serverId: string | null) => void;
  /** 重建成功：选中新机器并显示安装进度。 */
  onRebuilt: (serverId: string, state: MyServerState) => void;
  onRetryDetail: () => void;
}

/** 「我的服务器」中间区：默认创建页；选中某台时才切到详情。 */
export function MyServersPage({
  bridge,
  catalog,
  selected,
  view,
  detailError,
  detailRetrying,
  readOnly,
  joinGroupName,
  sharedTransfer,
  onNew,
  onEnsureIdentity,
  onTopUp,
  onUseServer,
  onJoinServer,
  onChanged,
  onOrdered,
  onRebuilt,
  onRetryDetail,
}: Props) {
  const banner = joinGroupName ? (
    <p className="servers-banner" role="status">
      选择一台服务器，把节点加入「{joinGroupName}」
    </p>
  ) : null;

  if (view === "detail" && selected) {
    return (
      <div className="myservers">
        {banner}
        {detailError ? (
          <section className="myservers__detail-card" role="alert">
            <p className="myservers__detail-title">连不上服务器。</p>
            <p className="myservers__detail-text">没有产生或改动任何服务器。</p>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={detailRetrying}
              aria-busy={detailRetrying || undefined}
              onClick={onRetryDetail}
            >
              {detailRetrying ? "正在重试…" : "重试"}
            </button>
          </section>
        ) : (
          <MyServerDetail
            bridge={bridge}
            server={selected}
            regionLabel={
              catalog?.regions.find((region) => region.id === selected.region)?.name ??
              selected.region
            }
            readOnly={readOnly}
            sharedTransfer={sharedTransfer}
            joinLabel={joinGroupName ? `加入「${joinGroupName}」` : null}
            onJoin={joinGroupName ? () => onJoinServer(selected) : undefined}
            onCreateAnother={onNew}
            onUseServer={onUseServer}
            onChanged={onChanged}
            onRebuilt={onRebuilt}
            onGone={() => onOrdered(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="myservers">
      {banner}
      <MyServerWizard
        bridge={bridge}
        catalog={catalog}
        onOrdered={onOrdered}
        onEnsureIdentity={onEnsureIdentity}
        onTopUp={onTopUp}
      />
    </div>
  );
}
