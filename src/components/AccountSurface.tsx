import { useEffect, useRef, useState } from "react";
import type {
  AgentBridge,
  MyServerAccount,
  MyServerTopup,
  MyServerWallet,
  TrafficPool,
} from "../agent/bridge";
import type { WalletTrigger } from "../myservers/useMyServers";
import { getLanguage, t, useT } from "../i18n";
import { formatUsdCents } from "../myservers/labels";
import { copyText } from "../ui/clipboard";
import { useFocusTrap } from "../ui/focus";
import { BillingLedgerTable } from "./BillingLedgerTable";
import { formatTrafficGib, formatTrafficGibValue, formatTrafficReset, trafficPoolTomorrowBytes } from "./traffic";
import { MyServerTopUp } from "./MyServerTopUp";
import { IconClose } from "./icons";

export type AccountPoint = { row: string | null; nonce: number };

interface Props {
  open: boolean;
  bridge: AgentBridge;
  account?: MyServerAccount | null;
  wallet?: MyServerWallet | null;
  walletLoading?: boolean;
  /** 已有值时的刷新在途：余额行入口写「刷新中」，旧值不动。 */
  walletRefreshing?: boolean;
  walletError?: string | null;
  /** 刷新失败但手上还有旧值：显示旧值并注明「显示的是上次的余额」。 */
  walletStale?: boolean;
  /** 打开账户时触发一次刷新（30 秒节流在 refreshWallet 里）；失败重试也走这里。 */
  onRefreshWallet?: (trigger: WalletTrigger) => void;
  /** 余额行的「刷新」：强制刷新，不受 30 秒门禁限制。 */
  onForceRefresh?: () => void;
  /** 就地充值：建单成功后收银台已在外部浏览器打开。 */
  onTopUp?: (denominationCents: number) => Promise<MyServerTopup>;
  /** 收银台已打开：App 关闭本层、给 toast，并安排回来时补刷余额。 */
  onCheckoutOpened?: () => void;
  onLogin?: () => void;
  identityProblem?: "lost" | "device_revoked" | "account_blocked" | null;
  onReRegister?: () => Promise<boolean>;
  onSwitchAccount?: () => Promise<boolean>;
  onLogout?: () => Promise<{ ok: boolean; message?: string }>;
  onClose: () => void;
  /** 更上层弹层（AI 告警）打开时让出焦点陷阱与 Esc。 */
  trapPaused?: boolean;
  /** AI 指路：滚到对应行并高亮 2 秒。 */
  point?: AccountPoint | null;
}

export function AccountSurface({
  open,
  bridge,
  account = null,
  wallet = null,
  walletLoading = false,
  walletRefreshing = false,
  walletError = null,
  walletStale = false,
  onRefreshWallet,
  onForceRefresh,
  onTopUp,
  onCheckoutOpened,
  onLogin,
  identityProblem = null,
  onReRegister,
  onSwitchAccount,
  onLogout,
  onClose,
  trapPaused = false,
  point = null,
}: Props) {
  const tr = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copy, setCopy] = useState<"idle" | "ok" | "error">("idle");
  const copyTimerRef = useRef<number | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [reRegistering, setReRegistering] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const [pointedRow, setPointedRow] = useState<string | null>(null);
  const pointTimerRef = useRef<number | null>(null);
  /** 充值档位默认收起；主按钮在余额行，展开后才出现。 */
  const [topupOpen, setTopupOpen] = useState(false);
  const topupRef = useRef<HTMLDivElement>(null);
  const topupButtonRef = useRef<HTMLButtonElement>(null);

  const refreshWalletRef = useRef(onRefreshWallet);
  refreshWalletRef.current = onRefreshWallet;
  // 打开弹层就刷新一次余额；未登录不发请求。
  useEffect(() => {
    if (!open || account?.logged_in !== true) return;
    refreshWalletRef.current?.("open_settings");
  }, [open, account?.logged_in]);

  /**
   * 账号池只认控制面下发的 `traffic_pool`：列表不含已销毁 / 已 dismiss 的行，
   * 对 `servers[]` 求和会少算、显示「没超」而实际已扣钱。
   */
  const [traffic, setTraffic] = useState<{
    pool: TrafficPool;
    resetAt: string;
    /** 明天账号会新增的额度；逐台增量之和，不是账号余额。 */
    tomorrowBytes: number;
  } | null>(null);
  /** 每天在扣的合计与台数：余额下面的那句「每天约 X · N 台服务器」。 */
  const [daily, setDaily] = useState<{
    cents: number;
    count: number;
  } | null>(null);
  useEffect(() => {
    if (!open || account?.logged_in !== true) {
      setTraffic(null);
      setDaily(null);
      return;
    }
    if (typeof bridge.myServerList !== "function") return;
    let cancelled = false;
    bridge
      .myServerList()
      .then((list) => {
        if (cancelled) return;
        const billable = list.servers.filter(
          (server) =>
            server.billing_state === "active" ||
            server.billing_state === "past_due",
        );
        setDaily({
          cents: billable.reduce(
            (sum, server) => sum + server.daily_price_cents,
            0,
          ),
          count: billable.length,
        });
        // 后一次结果没有 pool：清掉旧值，别让上一个账号/上一次的汇总留着。
        if (!list.traffic_pool) {
          setTraffic(null);
          return;
        }
        // 重置时刻是账号级同一个 UTC 月界，取任意一台非空值即可；列表可能为空。
        const resetAt =
          list.servers.find((server) => server.traffic_reset_at !== "")
            ?.traffic_reset_at ?? "";
        setTraffic({
          pool: list.traffic_pool,
          resetAt,
          tomorrowBytes: trafficPoolTomorrowBytes(list.servers),
        });
      })
      .catch(() => {
        // 旧控制面 / 读取失败：流量整行不渲染，余额下退回固定说明，不在弹层里报错。
        if (!cancelled) {
          setTraffic(null);
          setDaily(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, account?.logged_in, account?.account_id, bridge]);

  useFocusTrap(open && !trapPaused, dialogRef);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (trapPaused || event.key !== "Escape") return;
      // 充值展开时 Esc 只收面板；再按一次才关账户层。
      if (topupOpen) {
        event.preventDefault();
        setTopupOpen(false);
        topupButtonRef.current?.focus();
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, trapPaused, onClose, topupOpen]);

  // 展开后焦点进第一个档位；收起由 Esc 或主按钮负责送回。
  useEffect(() => {
    if (!topupOpen) return;
    topupRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [topupOpen]);

  // AI 指路：滚到目标块并高亮 2 秒。
  useEffect(() => {
    if (!open || !point?.row) return;
    const row = point.row;
    if (row === "account.topup") setTopupOpen(true);
    const target =
      dialogRef.current?.querySelector<HTMLElement>(`[data-point="${row}"]`) ?? null;
    if (!target) return;
    target.scrollIntoView?.({ block: "center" });
    setPointedRow(row);
    if (pointTimerRef.current) window.clearTimeout(pointTimerRef.current);
    pointTimerRef.current = window.setTimeout(() => {
      pointTimerRef.current = null;
      setPointedRow(null);
    }, 2000);
  }, [open, point?.nonce, point?.row]);

  useEffect(
    () => () => {
      if (pointTimerRef.current) window.clearTimeout(pointTimerRef.current);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const copyEmail = () => {
    const email = account?.email;
    if (!email) return;
    void copyText(email).then((ok) => {
      setCopy(ok ? "ok" : "error");
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopy("idle");
      }, 1500);
    });
  };

  const blockedIdentity =
    identityProblem === "device_revoked" || identityProblem === "account_blocked";
  const recovery =
    identityProblem === "lost"
      ? {
          kind: "register" as const,
          text: t("account.identity.lost"),
          label: t("account.identity.lostLabel"),
        }
      : identityProblem === "device_revoked"
        ? {
            kind: "logout" as const,
            text: t("account.identity.revoked"),
            label: t("account.identity.revokedLabel"),
          }
        : identityProblem === "account_blocked"
          ? {
              kind: "switch" as const,
              text: t("account.identity.blocked"),
              label: t("account.identity.blockedLabel"),
            }
          : null;
  const identityBusy = loggingOut || switching || reRegistering;

  const logout = async () => {
    if (loggingOut || !onLogout) return;
    setLoggingOut(true);
    setLogoutError(null);
    const result = await onLogout();
    setLoggingOut(false);
    if (result.ok) {
      onClose();
      return;
    }
    setLogoutError(result.message ?? t("account.logoutFailed"));
  };

  const recoverIdentity = async () => {
    if (!recovery || identityBusy) return;
    if (recovery.kind === "logout") {
      await logout();
      return;
    }
    const run = recovery.kind === "switch" ? onSwitchAccount : onReRegister;
    if (!run) return;
    const setBusy = recovery.kind === "switch" ? setSwitching : setReRegistering;
    setBusy(true);
    setRecoverError(null);
    const ok = await run();
    setBusy(false);
    if (!ok) setRecoverError(t("account.recoverFailed"));
  };

  if (!open) return null;

  const trafficOver =
    traffic !== null && traffic.pool.limitBytes > 0
      ? Math.max(0, traffic.pool.usedBytes - traffic.pool.limitBytes)
      : 0;
  /** 三态只看账号池；80% 用整数比较，浮点会把恰好 80% 判成 ok。 */
  const trafficState =
    traffic === null || traffic.pool.limitBytes === 0
      ? "unknown"
      : trafficOver > 0
        ? "over"
        : traffic.pool.usedBytes * 5 >= traffic.pool.limitBytes * 4
          ? "near"
          : "ok";
  const trafficReset =
    traffic && traffic.resetAt !== ""
      ? formatTrafficReset(traffic.resetAt, getLanguage())
      : null;
  /** 有服务器才给动态估算；读不到列表就退回固定说明。 */
  const dailyLabel =
    daily !== null && daily.count > 0
      ? tr("account.daily", {
          amount: formatUsdCents(daily.cents),
          count: daily.count,
        })
      : null;
  /** 进度条只做视觉比例，不写百分比文字；超额时铺满。 */
  const trafficRatio =
    traffic !== null && traffic.pool.limitBytes > 0
      ? traffic.pool.usedBytes / traffic.pool.limitBytes
      : 0;
  const trafficBarWidth = Number.isFinite(trafficRatio)
    ? `${Math.min(100, Math.max(0, trafficRatio * 100)).toFixed(2)}%`
    : "0.00%";

  const pointAttrs = (row: string) => ({
    "data-point": row,
    "data-pointed": pointedRow === row ? "true" : undefined,
  });

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal account-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-surface-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 id="account-surface-title" className="modal__title">
            {tr("controls.account")}
          </h2>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label={tr("common.close")}
          >
            <IconClose size={14} />
          </button>
        </header>

        <div className="account-surface__body">
          {recovery ? (
            <div className="account-surface__recovery">
              <p className="settings-note">{recovery.text}</p>
              {recoverError ? (
                <p className="settings-feedback settings-feedback--error" role="alert">
                  {recoverError}
                </p>
              ) : null}
              {logoutError && recovery.kind !== "register" ? (
                <p className="settings-feedback settings-feedback--error" role="alert">
                  {logoutError}{" "}
                  <button
                    type="button"
                    className="settings-link"
                    disabled={loggingOut}
                    onClick={() => void logout()}
                  >
                    {tr("account.retry")}
                  </button>
                </p>
              ) : null}
              <div className="settings-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={
                    identityBusy ||
                    !(recovery.kind === "logout"
                      ? onLogout
                      : recovery.kind === "switch"
                        ? onSwitchAccount
                        : onReRegister)
                  }
                  aria-busy={
                    (recovery.kind === "logout"
                      ? loggingOut
                      : recovery.kind === "switch"
                        ? switching
                        : reRegistering) || undefined
                  }
                  onClick={() => void recoverIdentity()}
                >
                  {recovery.kind === "logout"
                    ? loggingOut
                      ? tr("account.loggingOut")
                      : recovery.label
                    : recovery.kind === "switch"
                      ? switching
                        ? tr("account.switching")
                        : recovery.label
                      : reRegistering
                        ? tr("account.working")
                        : recovery.label}
                </button>
                {recovery.kind === "switch" ? (
                  <button
                    type="button"
                    className="btn btn--danger-ghost"
                    disabled={identityBusy || !onLogout}
                    aria-busy={loggingOut || undefined}
                    onClick={() => void logout()}
                  >
                    {loggingOut ? tr("account.loggingOut") : tr("account.logoutDevice")}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {account?.logged_in ? (
            <>
              {blockedIdentity ? null : (
                <>
                  <div
                    className="account-surface__balance"
                    {...pointAttrs("account.balance")}
                  >
                    <div className="account-surface__balance-main">
                      <div className="account-surface__balance-head">
                        <span className="account-surface__label">
                          {tr("settings.account.balance")}
                        </span>
                        {walletError ? null : (
                          <button
                            type="button"
                            className="settings-link"
                            onClick={onForceRefresh}
                            disabled={!onForceRefresh || walletRefreshing}
                          >
                            {walletRefreshing
                              ? tr("settings.account.refreshing")
                              : tr("settings.account.refresh")}
                          </button>
                        )}
                      </div>
                      {walletError ? (
                        <p className="account-surface__error">
                          {tr("account.walletError")}
                          <button
                            type="button"
                            className="settings-link"
                            onClick={() => onRefreshWallet?.("retry")}
                            disabled={!onRefreshWallet}
                          >
                            {tr("account.retry")}
                          </button>
                        </p>
                      ) : (
                        <div className="account-surface__amount num">
                          {walletLoading
                            ? tr("settings.account.loading")
                            : wallet
                              ? formatUsdCents(wallet.balance_cents)
                              : "—"}
                        </div>
                      )}
                      <p className="account-surface__daily">
                        {dailyLabel ?? tr("settings.account.billingNote")}
                      </p>
                      {walletStale && wallet && !walletError ? (
                        <p className="settings-note">{tr("account.stale")}</p>
                      ) : null}
                    </div>
                    {onTopUp ? (
                      <button
                        ref={topupButtonRef}
                        type="button"
                        className="btn btn--primary"
                        aria-expanded={topupOpen}
                        aria-controls="account-topup"
                        onClick={() => setTopupOpen((value) => !value)}
                      >
                        {topupOpen
                          ? tr("account.topUp.collapse")
                          : tr("account.topUp")}
                      </button>
                    ) : null}
                  </div>

                  {/* 充值档位默认收起：首次点「充值」才展开，内容常驻以便收动画。 */}
                  {onTopUp ? (
                    <div
                      ref={topupRef}
                      id="account-topup"
                      className={`account-surface__reveal account-surface__topup${
                        topupOpen ? " is-open" : ""
                      }`}
                      {...pointAttrs("account.topup")}
                      inert={!topupOpen}
                      aria-hidden={!topupOpen || undefined}
                    >
                      <div className="account-surface__reveal-inner">
                        <div className="account-surface__topup-body">
                          <MyServerTopUp
                            wallet={wallet}
                            onTopUp={onTopUp}
                            onCheckoutOpened={() => onCheckoutOpened?.()}
                          />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </>
              )}

              {blockedIdentity ? null : traffic ? (
                <>
                  <div className="account-surface__hair" aria-hidden="true" />
                  <div
                    className="account-surface__traffic-block"
                    {...pointAttrs("account.traffic")}
                  >
                    <div className="account-surface__traffic-head">
                      <span className="account-surface__label">
                        {tr("account.traffic.title")}
                      </span>
                      {trafficReset ? (
                        <span className="account-surface__traffic-reset">
                          {tr("detail.trafficResetAt", { date: trafficReset })}
                        </span>
                      ) : null}
                    </div>
                    {trafficState === "unknown" ? null : (
                      <div
                        className="account-surface__traffic-bar"
                        aria-hidden="true"
                      >
                        <span
                          className={`account-surface__traffic-fill is-${trafficState}`}
                          style={{ width: trafficBarWidth }}
                        />
                      </div>
                    )}
                    <p className="account-surface__traffic-line">
                      {trafficState === "unknown"
                        ? tr("account.traffic.unknown", {
                            used: formatTrafficGib(traffic.pool.usedBytes),
                          })
                        : (
                          <>
                            {tr("account.traffic.summary", {
                              limit: formatTrafficGibValue(traffic.pool.limitBytes),
                              used: formatTrafficGibValue(traffic.pool.usedBytes),
                            })}
                            {trafficState === "over" ? (
                              <>
                                {" · "}
                                <span className="account-surface__traffic-over">
                                  {tr("account.traffic.over", {
                                    over: formatTrafficGib(trafficOver),
                                  })}
                                </span>
                              </>
                            ) : (
                              <>
                                {traffic.tomorrowBytes > 0 ? (
                                  <>
                                    {" · "}
                                    {tr("account.traffic.tomorrow", {
                                      amount: formatTrafficGibValue(
                                        traffic.tomorrowBytes,
                                      ),
                                    })}
                                  </>
                                ) : null}
                                {trafficState === "near" ? (
                                  <>
                                    {" · "}
                                    <span className="account-surface__traffic-near">
                                      {tr("account.traffic.near")}
                                    </span>
                                  </>
                                ) : null}
                              </>
                            )}
                          </>
                        )}
                    </p>
                  </div>
                </>
              ) : null}

              {blockedIdentity ? null : (
                <>
                  <div className="account-surface__hair" aria-hidden="true" />
                  <div
                    className="account-surface__bills-block"
                    {...pointAttrs("account.bills")}
                  >
                    <BillingLedgerTable bridge={bridge} language={getLanguage()} />
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="account-surface__signed-out" {...pointAttrs("account.login")}>
              <div>
                <div className="account-surface__label">
                  {tr("settings.account.signedOut")}
                </div>
                <p className="settings-note">{tr("settings.account.signedOutNote")}</p>
              </div>
              <button
                type="button"
                className="btn btn--primary"
                onClick={onLogin}
                disabled={!onLogin}
              >
                {tr("serversPage.login")}
              </button>
            </div>
          )}
        </div>

        {/* 邮箱与退出登录同在最底：不随正文滚走，也不画线。 */}
        {account?.logged_in ? (
          <footer className="account-surface__footer">
            {logoutError && !blockedIdentity ? (
              <p className="account-surface__footer-error" role="alert">
                {logoutError}{" "}
                <button
                  type="button"
                  className="settings-link"
                  disabled={loggingOut}
                  onClick={() => void logout()}
                >
                  {tr("account.retry")}
                </button>
              </p>
            ) : null}
            <div className="account-surface__footer-row">
              <div
                className="account-surface__who"
                {...pointAttrs("account.login")}
              >
                <span
                  className="account-surface__email"
                  title={account.email ?? undefined}
                >
                  {account.email ?? tr("settings.account.signedIn")}
                </span>
                {account.email ? (
                  <>
                    <span
                      className="account-surface__who-sep"
                      aria-hidden="true"
                    >
                      ·
                    </span>
                    <button
                      type="button"
                      className="account-surface__copy"
                      onClick={copyEmail}
                    >
                      {copy === "ok"
                        ? tr("chat.copy.copied")
                        : copy === "error"
                          ? tr("chat.copy.failed")
                          : tr("detail.copy")}
                    </button>
                  </>
                ) : null}
              </div>
              {blockedIdentity ? null : (
                <button
                  type="button"
                  className="account-surface__logout"
                  disabled={loggingOut || !onLogout}
                  aria-busy={loggingOut || undefined}
                  onClick={() => void logout()}
                >
                  {loggingOut ? tr("account.loggingOut") : tr("account.logout")}
                </button>
              )}
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
