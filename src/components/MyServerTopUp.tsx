import { useRef, useState } from "react";
import type { MyServerTopup, MyServerWallet } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { errorText } from "../i18n/errorText";
import { formatUsdCents } from "../myservers/labels";
import { copyText } from "../ui/clipboard";
import { t, useT } from "../i18n";

interface Props {
  wallet: MyServerWallet | null;
  onTopUp: (denominationCents: number) => Promise<MyServerTopup>;
  /** 收银台已在外部浏览器打开：由账户弹层关闭整块面板并给 toast。 */
  onCheckoutOpened: () => void;
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
  if (reason === "topup_rate_limited") {
    return t("topup.rateLimited");
  }
  if (problem.code === "TIMEOUT" || problem.code === "NETWORK") {
    return t("topup.network");
  }
  return errorText(error, t("topup.failed"));
}

/** 快捷档是整美元：显示 $6 而不是 $6.00；非整额才退回两位小数。 */
function wholeDollar(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : formatUsdCents(cents);
}

/** 充值面板：就地展开在账户弹层里；档位直接来自 wallet 的 denominations_cents。 */
export function MyServerTopUp({ wallet, onTopUp, onCheckoutOpened }: Props) {
  const tr = useT();
  const [busyCents, setBusyCents] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  /** 失焦或点过提交后才报格式错：输入过程中不打断。 */
  const [touched, setTouched] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    message: string;
    url: string | null;
    cents: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const busyRef = useRef(false);

  const start = async (cents: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyCents(cents);
    setNotice(null);
    setFailure(null);
    try {
      const result = await onTopUp(cents);
      if (result.checkout_url) {
        // 收银台已在外部浏览器打开：关掉账户面板，让桌面保持干净。
        onCheckoutOpened();
        return;
      }
      setNotice(
        tr("topup.charged", {
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

  const busy = busyCents !== null;
  const denominations = wallet?.denominations_cents ?? [];
  const minCents = wallet?.min_topup_cents ?? 600;
  const maxCents = wallet?.max_topup_cents ?? 30000;
  const customDollars = /^\d+$/.test(custom) ? Number(custom) : Number.NaN;
  const customCents = Number.isSafeInteger(customDollars)
    ? customDollars * 100
    : Number.NaN;
  const customValid =
    Number.isSafeInteger(customCents) && customCents >= minCents && customCents <= maxCents;
  const showInvalid = touched && custom.trim() !== "" && !customValid;
  const customSubmitLabel = customValid
    ? tr("topup.custom.submit", { amount: wholeDollar(customCents) })
    : tr("topup.submit");

  return (
    <div className="myservers-topup">
      {denominations.length > 0 ? (
        <div className="myservers-topup__grid">
          {denominations.map((cents) => (
            <button
              key={cents}
              type="button"
              className="btn btn--ghost myservers-topup__option num"
              disabled={busy}
              aria-busy={busyCents === cents || undefined}
              onClick={() => void start(cents)}
            >
              {wholeDollar(cents)}
            </button>
          ))}
        </div>
      ) : wallet ? (
        <p className="myservers__hint">{tr("topup.none")}</p>
      ) : null}

      <div className="myservers-topup__custom">
        <label
          className="myservers-topup__custom-label"
          htmlFor="myservers-topup-custom"
        >
          {tr("topup.custom.label")}
        </label>
        <div className="myservers-topup__custom-row">
          <input
            id="myservers-topup-custom"
            className="myservers-topup__input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder={tr("topup.custom.placeholder")}
            value={custom}
            disabled={busy}
            aria-invalid={showInvalid || undefined}
            aria-describedby="myservers-topup-custom-hint"
            onChange={(event) => {
              setCustom(event.target.value);
              setTouched(false);
            }}
            onBlur={() => setTouched(true)}
          />
          <button
            type="button"
            className="btn btn--primary myservers-topup__submit"
            disabled={busy || custom.trim() === ""}
            aria-busy={busyCents === customCents || undefined}
            onClick={() => {
              setTouched(true);
              if (customValid) void start(customCents);
            }}
          >
            {customSubmitLabel}
          </button>
        </div>
        <p
          id="myservers-topup-custom-hint"
          className={showInvalid ? "myservers__error" : "myservers__hint"}
          role={showInvalid ? "alert" : undefined}
        >
          {showInvalid ? tr("topup.custom.invalid") : tr("topup.custom.hint")}
        </p>
      </div>

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
    </div>
  );
}
