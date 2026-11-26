import { useEffect, useRef, useState } from "react";
import type { MyServerTopup, MyServerWallet } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { errorText } from "../i18n/errorText";
import { formatUsdCents } from "../myservers/labels";
import { copyText } from "../ui/clipboard";
import { t, useT } from "../i18n";

interface Props {
  wallet: MyServerWallet | null;
  onTopUp: (denominationCents: number) => Promise<MyServerTopup>;
  /** 收银台已在外部浏览器打开：App 安排回焦时补刷余额；面板留在原地显示等待态。 */
  onCheckoutOpened: () => void;
  /** 外层充值区是否展开：收起后再展开回到「选择」态。 */
  open?: boolean;
}

/** 已在收银台打开、等余额变大的一单。 */
interface Checkout {
  cents: number;
  /** 打开收银台那一刻的余额；之后余额变大即视为到账。 */
  baselineCents: number | null;
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

/** 充值面板：选择 → 提交中 → 等待付款 → 已到账；失败回原地给原因与重试。 */
export function MyServerTopUp({
  wallet,
  onTopUp,
  onCheckoutOpened,
  open = true,
}: Props) {
  const tr = useT();
  const [busyCents, setBusyCents] = useState<number | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");
  /** 失焦或点过提交后才报格式错：输入过程中不打断。 */
  const [touched, setTouched] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  /** 等待态「改金额」：等网格重新出现再把焦点放进去，别掉到 body。 */
  const [returnToGrid, setReturnToGrid] = useState(false);
  const [failure, setFailure] = useState<{
    message: string;
    url: string | null;
    cents: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const busyRef = useRef(false);
  const openRef = useRef(open);
  const customInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const waitingRef = useRef<HTMLDivElement>(null);
  const paidRef = useRef<HTMLParagraphElement>(null);

  const balanceCents =
    typeof wallet?.balance_cents === "number" ? wallet.balance_cents : null;
  const paid =
    checkout !== null &&
    checkout.baselineCents !== null &&
    balanceCents !== null &&
    balanceCents > checkout.baselineCents;
  const waiting = checkout !== null && !paid;

  useEffect(() => {
    if (customOpen) customInputRef.current?.focus();
  }, [customOpen]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (waiting) waitingRef.current?.focus();
  }, [waiting]);

  useEffect(() => {
    if (paid) paidRef.current?.focus();
  }, [paid]);

  useEffect(() => {
    if (returnToGrid && checkout === null) {
      gridRef.current?.focus();
      setReturnToGrid(false);
    }
  }, [returnToGrid, checkout]);

  // 收起（或重新展开）都回到「选择」：已到账确认不跨次保留。
  useEffect(() => {
    setCheckout(null);
    setNotice(null);
    setFailure(null);
    setCustomOpen(false);
    setCustom("");
    setTouched(false);
  }, [open]);

  const start = async (cents: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyCents(cents);
    setNotice(null);
    setFailure(null);
    try {
      const result = await onTopUp(cents);
      // 收起后到达的响应整体丢弃：别把等待态写回已收起的面板。
      if (!openRef.current) return;
      if (result.checkout_url) {
        // 面板不关：换成就地等待，余额由 App 在窗口回焦时补刷。
        setCheckout({
          cents: result.denomination_cents,
          baselineCents: wallet?.balance_cents ?? null,
        });
        onCheckoutOpened();
        return;
      }
      // 直接到账：离开等待态回到选择（原有 notice 路径）。
      setCheckout(null);
      setNotice(
        tr("topup.charged", {
          amount: formatUsdCents(result.denomination_cents),
        }),
      );
    } catch (err) {
      if (!openRef.current) return;
      const details = toBridgeError(err).details;
      const raw = details?.checkout_url;
      const url = typeof raw === "string" && raw.startsWith("https://") ? raw : null;
      // 重开失败也回选择态，网格留着可重选，焦点落回网格。
      setCheckout(null);
      setReturnToGrid(true);
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
      {checkout && paid ? (
        <p
          ref={paidRef}
          className="myservers-topup__paid"
          role="status"
          tabIndex={-1}
        >
          <span className="myservers-topup__dot" aria-hidden="true" />
          {tr("topup.paid", {
            amount: wholeDollar(checkout.cents),
            balance: formatUsdCents(balanceCents ?? 0),
          })}
        </p>
      ) : checkout ? (
        <div
          ref={waitingRef}
          className="myservers-topup__wait"
          role="status"
          tabIndex={-1}
        >
          <div className="myservers-topup__wait-head">
            <span className="myservers-topup__wait-title">
              {tr("topup.waiting.title")}
            </span>
            <span className="myservers-topup__wait-amt num">
              {wholeDollar(checkout.cents)}
            </span>
          </div>
          <p className="myservers-topup__wait-note">
            {tr("topup.waiting.note")}
          </p>
          <div className="myservers-topup__wait-actions">
            <button
              type="button"
              className="btn btn--ghost myservers-topup__reopen"
              aria-disabled={busy || undefined}
              aria-busy={busy || undefined}
              onClick={() => {
                if (!busy) void start(checkout.cents);
              }}
            >
              {tr("topup.reopenCheckout")}
            </button>
            <button
              type="button"
              className="myservers-topup__change"
              disabled={busy}
              onClick={() => {
                setCheckout(null);
                setReturnToGrid(true);
              }}
            >
              {tr("topup.waiting.changeAmount")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div ref={gridRef} className="myservers-topup__grid" tabIndex={-1}>
            {denominations.map((cents) => (
              <button
                key={cents}
                type="button"
                className="myservers-topup__denom num"
                disabled={busy}
                aria-busy={busyCents === cents || undefined}
                onClick={() => void start(cents)}
              >
                {wholeDollar(cents)}
              </button>
            ))}
            <button
              type="button"
              className={`myservers-topup__denom${customOpen ? " is-open" : ""}`}
              aria-expanded={customOpen}
              aria-controls={customOpen ? "myservers-topup-custom" : undefined}
              disabled={busy || wallet === null}
              onClick={() => setCustomOpen((value) => !value)}
            >
              {tr("topup.other")}
            </button>
          </div>

          {/* 「其他」才展开输入框；收起时整块不占位。 */}
          {customOpen ? (
            <div className="myservers-topup__custom" id="myservers-topup-custom">
              <label className="sr-only" htmlFor="myservers-topup-custom-input">
                {tr("topup.custom.label")}
              </label>
              <div className="myservers-topup__custom-row">
                <input
                  id="myservers-topup-custom-input"
                  ref={customInputRef}
                  className="myservers-topup__input num"
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
                  disabled={busy || wallet === null || custom.trim() === ""}
                  aria-busy={busyCents === customCents || undefined}
                  onClick={() => {
                    setTouched(true);
                    if (customValid) void start(customCents);
                  }}
                >
                  {customSubmitLabel}
                </button>
              </div>
            </div>
          ) : null}

          <p
            id="myservers-topup-custom-hint"
            className={showInvalid ? "myservers__error" : "myservers-topup__hint"}
            role={showInvalid ? "alert" : undefined}
          >
            {showInvalid ? tr("topup.custom.invalid") : tr("topup.custom.hint")}
          </p>

          {wallet && denominations.length === 0 ? (
            <p className="myservers-topup__hint">{tr("topup.none")}</p>
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
        </>
      )}
    </div>
  );
}
