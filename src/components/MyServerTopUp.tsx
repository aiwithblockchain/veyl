import { useEffect, useRef, useState } from "react";
import type { MyServerTopup, MyServerWallet } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { errorText } from "../i18n/errorText";
import { formatUsdCents } from "../myservers/labels";
import { IconClose } from "./icons";
import { useFocusTrap } from "../ui/focus";
import { copyText } from "../ui/clipboard";
import { t, useT } from "../i18n";
import type { WalletRefreshResult } from "../myservers/useMyServers";

interface Props {
  wallet: MyServerWallet | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRetry: () => Promise<WalletRefreshResult>;
  onTopUp: (denominationCents: number) => Promise<MyServerTopup>;
  onClose: () => void;
}

function topupError(error: unknown): string {
  const problem = toBridgeError(error);
  const reason = typeof problem.details?.reason === "string" ? problem.details.reason : "";
  if (reason === "invalid_denomination") {
    return t("topup.invalidDenomination");
  }
  if (reason === "checkout_unavailable") {
    return t("topup.checkoutUnavailable");
  }
  if (reason === "auth_required" || reason === "token_invalid") {
    return t("topup.authRequired");
  }
  if (reason === "channel_not_allowed") {
    return t("topup.channelNotAllowed");
  }
  if (problem.code === "TIMEOUT" || problem.code === "NETWORK") {
    return t("topup.network");
  }
  return errorText(error, t("topup.failed"));
}

/** 充值模态：档位直接来自 wallet 的 denominations_cents。 */
export function MyServerTopUp({
  wallet,
  loading,
  refreshing,
  error,
  onRetry,
  onTopUp,
  onClose,
}: Props) {
  const tr = useT();
  const [busyCents, setBusyCents] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    message: string;
    url: string | null;
    cents: number;
  } | null>(null);
  const busyRef = useRef(false);
  const refreshBusyRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  useFocusTrap(true, dialogRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    },
    [],
  );

  const start = async (cents: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyCents(cents);
    setNotice(null);
    setFailure(null);
    setRefreshNotice(null);
    setRefreshFailure(null);
    try {
      const result = await onTopUp(cents);
      setNotice(
        result.checkout_url
          ? tr("topup.opened")
          : tr("topup.charged", {
              amount: formatUsdCents(result.denomination_cents),
            }),
      );
    } catch (err) {
      const details = toBridgeError(err).details;
      const raw = details?.checkout_url;
      const url = typeof raw === "string" && raw.startsWith("https://") ? raw : null;
      setFailure({
        message: topupError(err),
        url,
        cents,
      });
    } finally {
      busyRef.current = false;
      setBusyCents(null);
    }
  };

  const refreshInFlight = refreshBusy || refreshing;

  const refreshBalance = async () => {
    if (refreshBusyRef.current || refreshing) return;
    refreshBusyRef.current = true;
    setRefreshBusy(true);
    setRefreshNotice(null);
    setRefreshFailure(null);
    try {
      const result = await onRetry();
      if (!result.ok) {
        // skipped 表示没有真的发请求（在途 / 门禁 / 登出 / 切账户），不能当成失败报错。
        if (result.reason === "failed") {
          setRefreshFailure(tr("topup.refreshFailed"));
        }
        return;
      }
      setRefreshNotice(
        tr("topup.balanceUpdated", {
          amount: formatUsdCents(result.wallet.balance_cents),
        }),
      );
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        setRefreshNotice(null);
      }, 2500);
    } catch {
      setRefreshFailure(tr("topup.refreshFailed"));
    } finally {
      refreshBusyRef.current = false;
      setRefreshBusy(false);
    }
  };

  const busy = busyCents !== null;
  const denominations = wallet?.denominations_cents ?? [];

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        ref={dialogRef}
        className="modal myservers-topup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="myservers-topup-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 id="myservers-topup-title" className="modal__title">
            {tr("topup.title")}
          </h2>
          <button
            type="button"
            className="modal__close"
            aria-label={tr("common.close")}
            disabled={busy}
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </header>

        <div className="myservers-login__body">
          <p className="myservers__hint">
            {tr("topup.balance")}{" "}
            <span className="num">
              {wallet ? formatUsdCents(wallet.balance_cents) : "—"}
            </span>
            {loading ? ` · ${tr("topup.refreshing")}` : null}
          </p>

          {!wallet && loading ? (
            <p className="myservers__hint" role="status">
              {tr("topup.loading")}
            </p>
          ) : !wallet && error ? (
            <>
              <p className="myservers__error" role="alert">
                {error}
              </p>
              <div className="myservers__login-actions">
                <button type="button" className="btn btn--ghost" onClick={() => void onRetry()}>
                  {tr("topup.retry")}
                </button>
              </div>
            </>
          ) : denominations.length === 0 ? (
            <>
              <p className="myservers__hint">{tr("topup.none")}</p>
              <div className="myservers__login-actions">
                <button type="button" className="btn btn--ghost" onClick={() => void onRetry()}>
                  {tr("topup.refresh")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="myservers__hint">{tr("topup.pick")}</p>
              <div className="myservers-topup__grid">
                {denominations.map((cents) => (
                  <button
                    key={cents}
                    type="button"
                    className="btn btn--ghost myservers-topup__option"
                    disabled={busy}
                    aria-busy={busyCents === cents || undefined}
                    onClick={() => void start(cents)}
                  >
                    {formatUsdCents(cents)}
                  </button>
                ))}
              </div>
            </>
          )}

          {error && wallet ? (
            <p className="myservers__hint" role="alert">
              {error}
            </p>
          ) : null}
          {failure ? (
            <>
              <p className="myservers__error" role="alert">
                {failure.message}
              </p>
              {failure.url ? (
                <>
                  <code className="myservers-topup__link">{failure.url}</code>
                  <div className="myservers__login-actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => void start(failure.cents)}
                    >
                      {tr("topup.reopenCheckout")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => {
                        void copyText(failure.url ?? "").then((ok) => {
                          setCopied(ok);
                          window.setTimeout(() => setCopied(false), 1500);
                        });
                      }}
                    >
                      {copied ? tr("chat.copy.copied") : tr("topup.copyLink")}
                    </button>
                  </div>
                </>
              ) : (
                <div className="myservers__login-actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void start(failure.cents)}
                  >
                    {tr("topup.retry")}
                  </button>
                </div>
              )}
            </>
          ) : null}
          {notice ? (
            <p className="myservers__hint" role="status">
              {notice}
            </p>
          ) : null}
          {refreshNotice ? (
            <p className="myservers__hint" role="status">
              {refreshNotice}
            </p>
          ) : null}
          {refreshFailure ? (
            <p className="myservers__error" role="alert">
              {refreshFailure}
            </p>
          ) : null}

          <div className="myservers__login-actions">
            {notice ? (
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy || refreshInFlight}
                aria-busy={refreshInFlight || undefined}
                onClick={() => void refreshBalance()}
              >
                {refreshInFlight ? (
                  <>
                    <span className="myservers-topup__spinner" aria-hidden="true" />
                    {tr("topup.refreshingBalance")}
                  </>
                ) : (
                  tr("topup.refreshBalance")
                )}
              </button>
            ) : null}
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>
              {tr("common.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
