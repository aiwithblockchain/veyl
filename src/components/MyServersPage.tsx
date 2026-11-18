import type {
  AgentBridge,
  MyServer,
  MyServerAccount,
  MyServerCatalog,
  MyServerState,
} from "../agent/bridge";
import type { TrialState } from "../agent/protocol";
import { formatTrialExpiry } from "../myservers/labels";
import { MyServerDetail } from "./MyServerDetail";

interface Props {
  bridge: AgentBridge;
  catalog: MyServerCatalog | null;
  selected: MyServer | null;
  account: MyServerAccount | null;
  accountLoaded: boolean;
  accountError: boolean;
  /** 服务器列表加载中。 */
  loading: boolean;
  /** 列表读取失败说明。 */
  error: string | null;
  retrying: boolean;
  detailError: string | null;
  detailRetrying: boolean;
  /** 身份不可用：详情只读。 */
  readOnly: boolean;
  /** 当前连接的就是这台。 */
  connectedHere?: boolean;
  onNew: () => void;
  onLogin: () => void;
  onRefreshAccount: () => void;
  onRetry: () => void;
  onUseServer: (server: MyServer) => void;
  onDisconnect?: () => void;
  onChanged: () => void;
  /** 销毁后让 Host 收起详情并刷新列表。 */
  onGone: () => void;
  /** 重建成功：选中新机器并显示安装进度。 */
  onRebuilt: (serverId: string, state: MyServerState) => void;
  onRetryDetail: () => void;
  /** 失败时交给 AI 定位（结构化失败在右侧会话里解释）。 */
  onAiLocate?: (serverId: string) => void;
  /** 试用状态：空态里的免费节点说明；不给或 expired 时不显示。 */
  trial?: {
    state: TrialState;
    seedNodeCount: number;
    expiresAt: string | null;
  } | null;
  /** 空态里的「去连接」：切到连接目的地。 */
  onGoConnect: () => void;
  /** 已下单但还认不出新机器：不选中任何一台，只给一行提示。 */
  pendingServer?: boolean;
}

/**
 * 「我的服务器」中间区：有服务器就显示默认选中那台的详情；
 * 零台 / 未登录 / 读取失败都有空态，中间不留白。
 */
export function MyServersPage({
  bridge,
  catalog,
  selected,
  account,
  accountLoaded,
  accountError,
  loading,
  error,
  retrying,
  detailError,
  detailRetrying,
  readOnly,
  connectedHere = false,
  onNew,
  onLogin,
  onRefreshAccount,
  onRetry,
  onUseServer,
  onDisconnect,
  onChanged,
  onGone,
  onRebuilt,
  onRetryDetail,
  onAiLocate,
  trial = null,
  onGoConnect,
  pendingServer = false,
}: Props) {
  const trialHint = (() => {
    if (!trial || trial.seedNodeCount <= 0) return null;
    if (trial.state === "available") {
      return `还有 ${trial.seedNodeCount} 个免费节点，试用 7 天。`;
    }
    if (trial.state === "active") {
      const expiry = formatTrialExpiry(trial.expiresAt, Date.now());
      return expiry
        ? `还有 ${trial.seedNodeCount} 个免费节点，${expiry}。`
        : null;
    }
    return null;
  })();

  /** 空态旁注：只在没有自建服务器时出现，唯一可点的是「去连接」。 */
  const trialNote = trialHint ? (
    <p className="myservers__trial-hint">
      {trialHint}
      <button
        type="button"
        className="myservers__trial-link"
        onClick={onGoConnect}
      >
        去连接
      </button>
    </p>
  ) : null;
  if (accountError && !account) {
    return (
      <div className="myservers myservers--empty">
        <section className="myservers__empty" role="alert">
          <h1 className="myservers__empty-title">账户暂时读不到</h1>
          <p className="myservers__empty-text">检查网络后再试。</p>
          <button type="button" className="btn btn--ghost" onClick={onRefreshAccount}>
            重试
          </button>
        </section>
      </div>
    );
  }

  if (selected) {
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
            connectedHere={connectedHere}
            onDisconnect={onDisconnect}
            onAiLocate={onAiLocate}
            readOnly={readOnly}
            onCreateAnother={onNew}
            onUseServer={onUseServer}
            onChanged={onChanged}
            onRebuilt={onRebuilt}
            onGone={onGone}
          />
        )}
      </div>
    );
  }

  if (!accountLoaded) {
    return (
      <div className="myservers myservers--empty">
        <section className="myservers__empty" role="status" aria-busy="true">
          <span className="skeleton skeleton--title" aria-hidden />
          <span className="skeleton skeleton--line" aria-hidden />
          <span className="skeleton skeleton--line is-short" aria-hidden />
        </section>
      </div>
    );
  }

  if (account?.logged_in !== true) {
    return (
      <div className="myservers myservers--empty">
        <section className="myservers__empty">
          <h1 className="myservers__empty-title">先登录</h1>
          <p className="myservers__empty-text">
            登录后可以买服务器；装好后节点会出现在这里，也能直接用来连接。
          </p>
          {trialNote}
          <button
            type="button"
            className="btn btn--primary myservers__empty-cta"
            onClick={onLogin}
          >
            登录
          </button>
        </section>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="myservers myservers--empty">
        <section className="myservers__empty" role="status" aria-busy="true">
          <span className="skeleton skeleton--title" aria-hidden />
          <span className="skeleton skeleton--line" aria-hidden />
          <span className="skeleton skeleton--line is-short" aria-hidden />
        </section>
      </div>
    );
  }

  if (error) {
    return (
      <div className="myservers myservers--empty">
        <section className="myservers__empty" role="alert">
          <h1 className="myservers__empty-title">连不上服务器，稍后再试</h1>
          <p className="myservers__empty-text">已有服务器和节点不受影响。</p>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={retrying}
            aria-busy={retrying || undefined}
            onClick={onRetry}
          >
            {retrying ? "正在重试…" : "重试"}
          </button>
        </section>
      </div>
    );
  }

  // 下单成功但还认不出是哪台：先不选中，避免打开别人的机器详情。
  if (pendingServer) {
    return (
      <div className="myservers myservers--empty">
        <section className="myservers__empty" role="status">
          <p className="myservers__empty-text">
            服务器已下单，正在创建，稍后会自动出现。
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="myservers myservers--empty">
      <section className="myservers__empty">
        <h1 className="myservers__empty-title">还没有服务器</h1>
        <p className="myservers__empty-text">
          买一台装好后，节点会出现在这里，也能直接用来连接。
        </p>
        {trialNote}
        <button
          type="button"
          className="btn btn--primary myservers__empty-cta"
          disabled={readOnly}
          onClick={onNew}
        >
          新建节点
        </button>
      </section>
    </div>
  );
}
