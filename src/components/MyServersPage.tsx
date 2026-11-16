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
  /** 同账户未销毁机器 > 1：流量额度是共享池。 */
  sharedTransfer: boolean;
  onNew: () => void;
  onEnsureIdentity: () => Promise<boolean>;
  onTopUp: () => void;
  onUseServer: (server: MyServer) => void;
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
  sharedTransfer,
  onNew,
  onEnsureIdentity,
  onTopUp,
  onUseServer,
  onChanged,
  onOrdered,
  onRebuilt,
  onRetryDetail,
}: Props) {
  if (view === "detail" && selected) {
    return (
      <div className="myservers">
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
