import type {
  AgentBridge,
  MyServer,
  MyServerAccount,
  MyServerCatalog,
  MyServerState,
} from "../agent/bridge";
import type { TrialState } from "../agent/protocol";
import { trialEmptyHint } from "../myservers/labels";
import { MyServerDetail } from "./MyServerDetail";
import { useT } from "../i18n";

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
  /** 打开充值：就绪后扣费失败时详情给「去充值」。 */
  onTopUp?: () => void;
  onNew: () => void;
  onLogin: () => void;
  onRefreshAccount: () => void;
  onRetry: () => void;
  onChanged: () => void;
  /** 销毁后让 Host 收起详情并刷新列表。 */
  onGone: () => void;
  /** 停机删除的墓碑：删本地节点，墓碑行随之消失。 */
  onForget: (serverId: string, nodeId: string) => Promise<void>;
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
  /** 空态里的「去控制台」：切到连接目的地。 */
  onGoConnect: () => void;
  /** 已下单但还认不出新机器：不选中任何一台，只给一行提示。 */
  pendingServer?: boolean;
  /** 改名成功：用返回的完整对象更新列表与详情。 */
  onRenamed?: (server: MyServer) => void;
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
  onTopUp,
  onNew,
  onLogin,
  onRefreshAccount,
  onRetry,
  onChanged,
  onGone,
  onForget,
  onRebuilt,
  onRetryDetail,
  onAiLocate,
  trial = null,
  onGoConnect,
  pendingServer = false,
  onRenamed,
}: Props) {
  const t = useT();
  const trialHint = trial
    ? trialEmptyHint(
        trial.state,
        trial.seedNodeCount,
        trial.expiresAt,
        Date.now(),
      )
    : null;

  /** 空态旁注：只在没有自建服务器时出现，唯一可点的是「去控制台」。 */
  const trialNote = trialHint ? (
    <p className="myservers__trial-hint">
      {trialHint}
      <button
        type="button"
        className="myservers__trial-link"
        onClick={onGoConnect}
      >
        {t("serversPage.goConsole")}
      </button>
    </p>
  ) : null;
  if (accountError && !account) {
    return (
      <div className="myservers myservers--empty">
        <section className="myservers__empty" role="alert">
          <h1 className="myservers__empty-title">{t("serversPage.accountUnavailable")}</h1>
          <p className="myservers__empty-text">{t("serversPage.checkNetwork")}</p>
          <button type="button" className="btn btn--ghost" onClick={onRefreshAccount}>
            {t("serversPage.retry")}
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
            <p className="myservers__detail-title">{t("serversPage.detailUnavailable")}</p>
            <p className="myservers__detail-text">{t("serversPage.detailRetry")}</p>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={detailRetrying}
              aria-busy={detailRetrying || undefined}
              onClick={onRetryDetail}
            >
              {detailRetrying ? t("serversPage.retrying") : t("serversPage.retry")}
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
            onTopUp={onTopUp}
            onAiLocate={onAiLocate}
            readOnly={readOnly}
            onCreateAnother={onNew}
            onChanged={onChanged}
            onRebuilt={onRebuilt}
            onGone={onGone}
            onForget={onForget}
            onRenamed={onRenamed}
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
          <h1 className="myservers__empty-title">{t("serversPage.loginTitle")}</h1>
          <p className="myservers__empty-text">
            {t("serversPage.loginText")}
          </p>
          {trialNote}
          <button
            type="button"
            className="btn btn--primary myservers__empty-cta"
            onClick={onLogin}
          >
            {t("serversPage.login")}
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
          <h1 className="myservers__empty-title">{t("serversPage.errorTitle")}</h1>
          <p className="myservers__empty-text">{t("serversPage.errorText")}</p>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={retrying}
            aria-busy={retrying || undefined}
            onClick={onRetry}
          >
            {retrying ? t("serversPage.retrying") : t("serversPage.retry")}
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
            {t("serversPage.pending")}
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="myservers myservers--empty">
      <section className="myservers__empty">
        <h1 className="myservers__empty-title">{t("serversPage.emptyTitle")}</h1>
        <p className="myservers__empty-text">
          {t("serversPage.emptyText")}
        </p>
        {trialNote}
        <button
          type="button"
          className="btn btn--primary myservers__empty-cta"
          disabled={readOnly}
          onClick={onNew}
        >
          {t("serversPage.newNode")}
        </button>
      </section>
    </div>
  );
}
