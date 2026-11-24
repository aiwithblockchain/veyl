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
  /** 登录态：邮箱账户且会话未过期；设备身份与过期会话都算未登录。 */
  signedIn: boolean;
  accountLoaded: boolean;
  accountError: boolean;
  /** 目录请求失败（控制面可达性探针）；null 不算失败，用显式标记。 */
  catalogError?: boolean;
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
  /** 选中服务器的本地节点最近一次探测不可达。 */
  repairAvailable?: boolean;
  /** 打开节点诊断面板（App 统一构造依赖）。 */
  onDiagnose?: (target: { serverId: string; nodeName: string }) => void;
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
  signedIn,
  accountLoaded,
  accountError,
  catalogError = false,
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
  repairAvailable = false,
  onDiagnose,
}: Props) {
  const t = useT();
  // 会话过期：邮箱账户明确未登录、且本地会话时刻已过；设备身份不走这句。
  const expiresAt = account?.session_expires_at;
  const sessionExpired =
    account?.account_kind === "email" &&
    account.logged_in === false &&
    typeof expiresAt === "string" &&
    expiresAt !== "" &&
    Number.isFinite(Date.parse(expiresAt)) &&
    Date.parse(expiresAt) <= Date.now();
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
  // 控制面不可达时整页报错只在未登录时接管；已登录且账户还在，详情与缓存内容优先，
  // 列表自己的读取失败交给列表错误态。否则「中间新建节点、整页却说连不上」会互相矛盾。
  const unreachable =
    (accountError || catalogError) && (!signedIn || account === null);
  if (unreachable) {
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

  if (signedIn && selected) {
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
            repairAvailable={repairAvailable}
            onDiagnose={onDiagnose}
          />
        )}
      </div>
    );
  }

  // 账户没读出来或列表在加载：统一给加载态，别先闪一下登录引导。
  if ((!accountLoaded && !accountError) || loading) {
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

  // 未登录：整页只留登录引导，不渲染列表、详情、余额、向导或导出入口。
  if (!signedIn) {
    return (
      <div className="myservers myservers--empty">
        <section className="myservers__empty">
          <h1 className="myservers__empty-title">{t("serversPage.loginTitle")}</h1>
          <p className="myservers__empty-text">
            {sessionExpired
              ? t("serversPage.loginExpired")
              : t("serversPage.loginText")}
          </p>
          {trialNote}
          <button
            type="button"
            className="btn btn--primary myservers__empty-cta"
            onClick={onLogin}
          >
            {t("serversPage.loginAction")}
          </button>
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
          <p className="myservers__empty-text myservers__error-hint">
            {t("serversPage.errorIpHint")}
          </p>
          <div className="myservers__empty-actions">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={retrying}
              aria-busy={retrying || undefined}
              onClick={onRetry}
            >
              {retrying ? t("serversPage.retrying") : t("serversPage.retry")}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={readOnly}
              onClick={onNew}
            >
              {t("serversPage.newNode")}
            </button>
          </div>
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
