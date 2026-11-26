import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentBridge,
  BillingEntryKind,
  BillingLedger,
  BillingLedgerServer,
} from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { getLanguage, translate, useT, type Language, type MessageKey } from "../i18n";
import { errorText } from "../i18n/errorText";
import { formatUsdCents } from "../myservers/labels";
import { useFocusTrap } from "../ui/focus";
import { IconClose } from "./icons";

const WINDOW_DAYS = 30;

const KIND_LABELS: Record<BillingEntryKind, MessageKey> = {
  topup: "billing.kind.topup",
  machine_day: "billing.kind.machine_day",
  traffic: "billing.kind.traffic",
  refund: "billing.kind.refund",
  other: "billing.kind.other",
};

/** 行内补机器标识的类别；充值与其他行没有具体机器。 */
const SERVER_KINDS: ReadonlySet<BillingEntryKind> = new Set([
  "machine_day",
  "traffic",
  "refund",
]);

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; ledger: BillingLedger }
  | { kind: "failed"; message: string };

/**
 * 失败原因：登录 / 超时 / 服务 / 数据各有自己的说法；权限类复用全站对
 * `PERMISSION_DENIED` 的同一句话，不在这里另造第三套映射。
 * 用模块级 `translate` + 当前语言，避免把 `useT` 的函数身份带进 `load` 的依赖。
 */
export function billingFailureText(error: unknown): string {
  const problem = toBridgeError(error);
  const language = getLanguage();
  const text = (key: MessageKey) => translate(language, key);
  switch (problem.code) {
    case "UNAUTHENTICATED":
      return text("billing.failed.login");
    case "PERMISSION_DENIED":
      return errorText(error, text("billing.failed.generic"));
    case "TIMEOUT":
      return text("billing.failed.timeout");
    case "PRECONDITION_FAILED":
      // 业务错误不是「连不上」：只有 auth_required 归登录，其余用通用句。
      return problem.details?.reason === "auth_required"
        ? text("billing.failed.login")
        : text("billing.failed.generic");
    case "UPSTREAM_ERROR":
      return problem.details?.reason === "invalid_response"
        ? text("billing.failed.data")
        : text("billing.failed.unreachable");
    default:
      return text("billing.failed.generic");
  }
}

/** 日期格式器按语言各缓存一份：满量 1000 行不重复构造。 */
const DAY_FORMATTERS: Record<Language, Intl.DateTimeFormat> = {
  zh: new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }),
  en: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }),
};

/** 本地日：`at` 是毫秒，30 天窗口内只需要「M月D日」。 */
export function formatBillingDay(at: number, language: Language): string {
  return DAY_FORMATTERS[language].format(new Date(at));
}

function serverLabel(server: BillingLedgerServer): string {
  return `${server.name} · ${server.plan} / ${server.region}`;
}

function amountLabel(cents: number): string {
  // 正负都用同一份 --ink 颜色，只靠前缀区分；小数固定两位。零不带号。
  if (cents === 0) return formatUsdCents(0);
  const sign = cents < 0 ? "−" : "+";
  return `${sign}${formatUsdCents(Math.abs(cents))}`;
}

export function BillingLedgerDialog({
  bridge,
  language,
  onClose,
}: {
  bridge: AgentBridge;
  language: Language;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // 焦点归还由 Settings 的 returnBillsFocusRef 独占：这里的 trap 不自带 restore，
  // 否则会把 previous 改写成设置内部元素，再关设置时回不到打开设置的那个控件。
  useFocusTrap(true, dialogRef, false);

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const ledger = await bridge.myServerBillingLedger(WINDOW_DAYS);
      setPhase({ kind: "ready", ledger });
    } catch (error) {
      setPhase({ kind: "failed", message: billingFailureText(error) });
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div
      className="modal-backdrop modal-backdrop--nested"
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        className="modal modal--bills"
        role="dialog"
        aria-modal="true"
        aria-labelledby="billing-dialog-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 id="billing-dialog-title" className="modal__title">
            {t("settings.account.bills")}
          </h2>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <IconClose size={14} />
          </button>
        </header>

        {phase.kind === "loading" ? (
          <div className="billing-panel" role="status">
            <p className="billing-status">{t("billing.loading")}</p>
            <div className="billing-placeholder" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : null}

        {phase.kind === "failed" ? (
          <div className="billing-panel" role="alert">
            <h3 className="billing-failed__title">{t("billing.failedTitle")}</h3>
            <p className="billing-failed__reason">{phase.message}</p>
            <p className="billing-failed__next">{t("billing.failedNext")}</p>
            <div className="settings-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  void load();
                  // 重试按钮随面板卸载：先把焦点交给弹层本身，读屏不丢位置。
                  dialogRef.current?.focus();
                }}
              >
                {t("account.retry")}
              </button>
            </div>
          </div>
        ) : null}

        {phase.kind === "ready" ? (
          <BillingLedgerBody ledger={phase.ledger} language={language} />
        ) : null}
      </div>
    </div>
  );
}

function BillingLedgerBody({
  ledger,
  language,
}: {
  ledger: BillingLedger;
  language: Language;
}) {
  const t = useT();
  return (
    <>
      {/* 合计只用接口的 totals：列表被截断时它仍是全量。 */}
      <p className="billing-summary">
        {t("billing.summary", {
          balance: formatUsdCents(ledger.balance_cents),
          days: ledger.window_days,
          topup: formatUsdCents(ledger.totals.topup_cents),
          charge: formatUsdCents(ledger.totals.charge_cents),
        })}
      </p>

      {ledger.entries.length === 0 ? (
        <p className="billing-empty">{t("billing.empty")}</p>
      ) : (
        <div className="billing-body">
          <table className="billing-table">
            <thead>
              <tr>
                <th scope="col">{t("billing.column.kind")}</th>
                <th scope="col">{t("billing.column.date")}</th>
                <th scope="col" className="billing-table__amount-head">
                  {t("billing.column.amount")}
                </th>
              </tr>
            </thead>
            <tbody>
              {ledger.entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="billing-table__kind">
                    <span className="billing-table__label">
                      {t(KIND_LABELS[entry.kind])}
                    </span>
                    {entry.server && SERVER_KINDS.has(entry.kind) ? (
                      <span
                        className="billing-table__server"
                        title={serverLabel(entry.server)}
                      >
                        {serverLabel(entry.server)}
                      </span>
                    ) : null}
                  </td>
                  <td className="billing-table__date num">
                    {formatBillingDay(entry.at, language)}
                  </td>
                  <td className="billing-table__amount num">
                    {amountLabel(entry.amount_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {ledger.truncated ? (
            <p className="billing-footnote">{t("billing.truncated")}</p>
          ) : null}
        </div>
      )}
    </>
  );
}
