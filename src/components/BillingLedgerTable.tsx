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

const WINDOW_DAYS = 30;
/** 折叠行只给摘要：40 条先够看，再往上每次多 100 条。 */
const INITIAL_ROWS = 40;
const MORE_ROWS = 100;

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

export function amountLabel(cents: number): string {
  // 正负都用同一份 --ink 颜色，只靠前缀区分；小数固定两位。零不带号。
  if (cents === 0) return formatUsdCents(0);
  const sign = cents < 0 ? "−" : "+";
  return `${sign}${formatUsdCents(Math.abs(cents))}`;
}

/**
 * 最近 30 天账单：默认折叠成一行摘要，展开后是三列表格（机器名挂在类别下）。
 * 打开即请求，不等展开；滚动交给账户弹层的 body，表头 sticky。
 */
export function BillingLedgerTable({
  bridge,
  language,
}: {
  bridge: AgentBridge;
  language: Language;
}) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

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

  if (phase.kind === "loading") {
    return (
      <div className="billing-disclosure" role="status">
        <span className="billing-disclosure__text">{t("billing.loading")}</span>
      </div>
    );
  }

  if (phase.kind === "failed") {
    return (
      <div className="billing-disclosure billing-disclosure--failed" role="alert">
        <span className="billing-disclosure__text">{phase.message}</span>
        <button type="button" className="settings-link" onClick={() => void load()}>
          {t("account.retry")}
        </button>
      </div>
    );
  }

  return <BillingLedgerBody ledger={phase.ledger} language={language} />;
}

function BillingLedgerBody({
  ledger,
  language,
}: {
  ledger: BillingLedger;
  language: Language;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState(INITIAL_ROWS);
  const detailsRef = useRef<HTMLDivElement>(null);
  /** 「显示更多」之后要聚焦的第一条新行；渲染完成再取节点。 */
  const pendingFocusRef = useRef<string | null>(null);

  useEffect(() => {
    const id = pendingFocusRef.current;
    if (!id) return;
    pendingFocusRef.current = null;
    const row =
      detailsRef.current?.querySelector<HTMLElement>(`tr[data-entry-id="${id}"]`) ??
      null;
    row?.focus();
    row?.scrollIntoView?.({ block: "nearest" });
  }, [visible]);

  const summary = t("billing.summary", {
    topup: formatUsdCents(ledger.totals.topup_cents),
    charge: formatUsdCents(ledger.totals.charge_cents),
  });
  const empty = ledger.entries.length === 0;
  const shown = ledger.entries.slice(0, visible);

  const showMore = () => {
    const next = ledger.entries[visible];
    if (next) pendingFocusRef.current = next.id;
    setVisible((count) => count + MORE_ROWS);
  };

  if (empty) {
    return (
      <div className="billing-disclosure billing-disclosure--empty">
        <span className="billing-disclosure__text">{summary}</span>
        <span className="billing-disclosure__note">{t("billing.empty")}</span>
      </div>
    );
  }

  return (
    <div className="billing-inline">
      <button
        type="button"
        className="billing-disclosure billing-disclosure--toggle"
        aria-expanded={expanded}
        aria-controls="account-billing-details"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="billing-disclosure__text">{summary}</span>
        <span className="billing-disclosure__action">
          {t("billing.showDetails")}
          <span
            className={`billing-disclosure__chevron${expanded ? " is-open" : ""}`}
            aria-hidden="true"
          />
        </span>
      </button>

      {/* 常驻 DOM：aria-controls 在折叠时也必须有目标。 */}
      <div
        className="billing-details"
        id="account-billing-details"
        ref={detailsRef}
        hidden={!expanded}
      >
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
              {shown.map((entry) => (
                <tr key={entry.id} data-entry-id={entry.id} tabIndex={-1}>
                  <td className="billing-table__kind">
                    {t(KIND_LABELS[entry.kind])}
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
          {visible < ledger.entries.length ? (
            <div className="billing-more">
              <button type="button" className="btn btn--ghost" onClick={showMore}>
                {t("billing.showMore")}
              </button>
            </div>
          ) : null}
      </div>
    </div>
  );
}
