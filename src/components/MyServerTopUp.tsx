import { useEffect, useRef, useState } from "react";
import type { MyServerTopup, MyServerWallet } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { formatUsdCents } from "../myservers/labels";
import { IconClose } from "./icons";
import { useFocusTrap } from "../ui/focus";
import { copyText } from "../ui/clipboard";

interface Props {
  wallet: MyServerWallet | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onTopUp: (denominationCents: number) => Promise<MyServerTopup>;
  onClose: () => void;
}

function topupError(error: unknown): string {
  const problem = toBridgeError(error);
  const reason = typeof problem.details?.reason === "string" ? problem.details.reason : "";
  if (reason === "invalid_denomination") {
    return "这个充值档位现在不可用。换一档再试。";
  }
  if (reason === "checkout_unavailable") {
    return "收银台暂时打不开。没有扣钱，稍后再点一次。";
  }
  if (reason === "auth_required" || reason === "token_invalid") {
    return "登录已过期。重新登录后再充值。";
  }
  if (reason === "channel_not_allowed") {
    return "这个环境不能充值。换正式环境再试。";
  }
  if (problem.code === "TIMEOUT" || problem.code === "NETWORK") {
    return "没连上服务器。没有扣钱，稍后再试。";
  }
  return problem.message && problem.message !== "操作失败"
    ? problem.message
    : "没发起充值。稍后再试。";
}

/** 充值模态：档位直接来自 wallet 的 denominations_cents。 */
export function MyServerTopUp({
  wallet,
  loading,
  error,
  onRetry,
  onTopUp,
  onClose,
}: Props) {
  const [busyCents, setBusyCents] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    message: string;
    url: string | null;
    cents: number;
  } | null>(null);
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  useFocusTrap(true, dialogRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const start = async (cents: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyCents(cents);
    setNotice(null);
    setFailure(null);
    try {
      const result = await onTopUp(cents);
      setNotice(
        result.checkout_url
          ? "已打开支付页面。付完回到这里，余额会自动刷新。"
          : `已充值 ${formatUsdCents(result.denomination_cents)}。`,
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
            充值
          </h2>
          <button
            type="button"
            className="modal__close"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </header>

        <div className="myservers-login__body">
          <p className="myservers__hint">
            当前余额{" "}
            <span className="num">
              {wallet ? formatUsdCents(wallet.balance_cents) : "—"}
            </span>
            {loading ? " · 正在刷新" : null}
          </p>

          {!wallet && loading ? (
            <p className="myservers__hint" role="status">
              正在读取充值档位…
            </p>
          ) : !wallet && error ? (
            <>
              <p className="myservers__error" role="alert">
                {error}
              </p>
              <div className="myservers__login-actions">
                <button type="button" className="btn btn--ghost" onClick={onRetry}>
                  重试
                </button>
              </div>
            </>
          ) : denominations.length === 0 ? (
            <>
              <p className="myservers__hint">现在没有可用的充值档位。</p>
              <div className="myservers__login-actions">
                <button type="button" className="btn btn--ghost" onClick={onRetry}>
                  刷新
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="myservers__hint">选一档充值。</p>
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
                      重新打开支付页面
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
                      {copied ? "已复制" : "复制链接"}
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
                    重试
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

          <div className="myservers__login-actions">
            {notice ? (
              <button type="button" className="btn btn--ghost" onClick={onRetry}>
                刷新余额
              </button>
            ) : null}
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
