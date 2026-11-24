import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  AgentBridge,
  MyServer,
  MyServerEvent,
  MyServerEventCode,
  MyServerEvents,
} from "../agent/bridge";
import { formatUsdCents, isProvisioning } from "../myservers/labels";
import { useLanguage, useT } from "../i18n";
import type { Language, MessageKey } from "../i18n";
import { IconChevronRight } from "./icons";

/** 开通中展开时的轮询间隔；事件稀疏，不与列表的 2 秒轮询同频。 */
const REFRESH_MS = 5_000;
/** 收起再展开的缓存窗口：30 秒内先用旧数据，不在眼前闪加载。 */
const CACHE_MS = 30_000;
/** 离开开通中后补取一次的延迟：审计行可能晚于状态变化落库。 */
const SETTLE_REFETCH_MS = 1_000;

const CODE_KEYS: Record<MyServerEventCode, MessageKey> = {
  "order.confirmed": "events.orderConfirmed",
  "machine.created": "events.machineCreated",
  "install.started": "events.installStarted",
  "verify.started": "events.verifyStarted",
  activated: "events.activated",
  "create.failed": "events.createFailed",
  "install.failed": "events.installFailed",
  "check.failed": "events.checkFailed",
  "settle.failed": "events.settleFailed",
  destroyed: "events.destroyed",
  "port.changed": "events.portChanged",
  "agent.rejoined": "events.rejoined",
  refunded: "events.refunded",
  "refund.pending": "events.refundPending",
};

/** `destroyed` 的 reason 白名单；未知值退回通用句。 */
const DESTROYED_KEYS: Record<string, MessageKey> = {
  user: "events.destroyed.user",
  billing_unpaid: "events.destroyed.billing",
  enrollment_expired: "events.destroyed.expired",
  activation_lost: "events.destroyed.lost",
  activate_failed: "events.destroyed.lost",
  agent_enroll_failed: "events.destroyed.lost",
  port_mismatch: "events.destroyed.portMismatch",
};

const FAILURE_CODES = new Set<MyServerEventCode>([
  "create.failed",
  "install.failed",
  "check.failed",
  "settle.failed",
]);

const EN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** 同年 `MM-DD HH:mm`（英文 `Nov 24, 14:32`），跨年补年份；不做相对时间。 */
function formatEventTime(at: number, language: Language, now: Date): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() !== now.getFullYear()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate(),
    )} ${time}`;
  }
  if (language === "en") {
    return `${EN_MONTHS[date.getMonth()]} ${date.getDate()}, ${time}`;
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function eventSentence(
  event: MyServerEvent,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (event.code === "destroyed") {
    return t(DESTROYED_KEYS[event.reason ?? ""] ?? "events.destroyed");
  }
  if (event.code === "refunded" || event.code === "refund.pending") {
    return t(CODE_KEYS[event.code], {
      // 契约里退款事件必带金额；缺字段时用破折号，不编造 0。
      amount:
        event.amount_cents === undefined ? "—" : formatUsdCents(event.amount_cents),
    });
  }
  return t(CODE_KEYS[event.code]);
}

interface Props {
  bridge: AgentBridge;
  /** 用它的 id 与状态决定默认展开和轮询；父级按 server_id 挂 key，换机即重置。 */
  server: MyServer;
}

/**
 * 服务器详情第四块：创建记录时间线。
 * 数据只活在这一块里——读取失败不影响状态、事实与危险操作。
 */
export function ServerEvents({ bridge, server }: Props) {
  const t = useT();
  const language = useLanguage();
  const panelId = useId();
  const serverId = server.server_id;
  const provisioning = isProvisioning(server.state);
  const defaultOpen =
    provisioning || server.state === "error" || server.state === "destroying";
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<MyServerEvents | null>(null);
  /** 从未取到过数据：整块显示错误与重试。 */
  const [failed, setFailed] = useState(false);
  /** 已有数据但后台刷新失败：保留列表，只加一行提示。 */
  const [staleError, setStaleError] = useState(false);
  const [loading, setLoading] = useState(false);
  const attemptedAtRef = useRef(0);
  const inFlightRef = useRef(false);
  /** 回调里判断有没有旧数据，不依赖闭包里的 state。 */
  const dataRef = useRef<MyServerEvents | null>(null);
  dataRef.current = data;

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    attemptedAtRef.current = Date.now();
    if (dataRef.current === null) setLoading(true);
    try {
      const next = await bridge.myServerEvents(serverId);
      setData(next);
      setFailed(false);
      setStaleError(false);
    } catch {
      if (dataRef.current === null) setFailed(true);
      else setStaleError(true);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [bridge, serverId]);

  // 挂载即取一次：收起状态也要显示条数。
  useEffect(() => {
    void load();
  }, [load]);

  // 重新展开：30 秒内先用旧数据，过期才后台重取；首次展开由上面那次取数负责。
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    if (attemptedAtRef.current === 0) return;
    if (Date.now() - attemptedAtRef.current >= CACHE_MS) void load();
  }, [open, load]);

  // 开通中且展开：每 5 秒一次；状态落定后停。
  useEffect(() => {
    if (!open || !provisioning) return;
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [open, provisioning, load]);

  // 离开开通中：状态一变就要看到「已开通」或「失败 + 销毁 + 退款」，绕过节流立刻取一次；
  // 审计行可能晚于状态变化落库，1 秒后再补一次。
  const prevProvisioningRef = useRef(provisioning);
  useEffect(() => {
    const was = prevProvisioningRef.current;
    prevProvisioningRef.current = provisioning;
    if (!was || provisioning) return;
    void load();
    const timer = window.setTimeout(() => void load(), SETTLE_REFETCH_MS);
    return () => window.clearTimeout(timer);
  }, [provisioning, load]);

  // 收到 my-server-changed 后父级会换新的 server 对象：距上次取数 ≥5 秒才重取。
  // 收起时也生效，标题行的条数才不会过期；只由变化触发，不跑定时器。
  useEffect(() => {
    if (attemptedAtRef.current === 0) return;
    if (Date.now() - attemptedAtRef.current < REFRESH_MS) return;
    void load();
  }, [server, load]);

  const count = data ? data.events.length : null;
  const countLabel =
    count === null
      ? null
      : count === 1
        ? t("events.countOne")
        : t("events.count", { count });
  const now = new Date();

  const errorRow = (
    <div className="myservers__events-note" role="alert">
      <span>{t("events.error")}</span>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => void load()}
      >
        {t("events.retry")}
      </button>
    </div>
  );

  return (
    <div className="myservers__events">
      <button
        type="button"
        className="myservers__events-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="myservers__events-title">{t("events.title")}</span>
        {countLabel !== null ? (
          <span className="myservers__events-count">{countLabel}</span>
        ) : null}
        <span
          className={`myservers__events-chevron${open ? " is-open" : ""}`}
          aria-hidden
        >
          <IconChevronRight size={12} />
        </span>
      </button>

      {/* 面板常驻：收起时用 hidden，aria-controls 始终指向存在的元素。 */}
      <div
        id={panelId}
        className="myservers__events-panel"
        role="region"
        aria-label={t("events.title")}
        aria-busy={loading || undefined}
        hidden={!open}
      >
        {failed ? (
          errorRow
        ) : data === null ? (
          <p className="myservers__events-note">{t("events.loading")}</p>
        ) : data.events.length === 0 ? (
          // 本来就没有记录：后台失败时只留错误行，不叠加空态那句。
          staleError ? errorRow : <p className="myservers__events-note">{t("events.empty")}</p>
        ) : (
          <>
            {staleError ? errorRow : null}
            <ol className="myservers__events-list">
              {data.events.map((event, index) => (
                <li
                  className="myservers__event"
                  key={`${event.at}-${event.code}-${index}`}
                >
                  <time
                    className="myservers__event-time num"
                    dateTime={new Date(event.at).toISOString()}
                    title={new Date(event.at).toLocaleString()}
                  >
                    {formatEventTime(event.at, language, now)}
                  </time>
                  <span
                    className={`myservers__event-dot${
                      FAILURE_CODES.has(event.code) ? " is-failure" : ""
                    }`}
                    aria-hidden
                  />
                  <span className="myservers__event-text">
                    {eventSentence(event, t)}
                    {event.count !== undefined && event.count > 1 ? (
                      <>
                        {language === "en" ? " " : ""}
                        <span className="myservers__event-meta">
                          {t("events.countTag", { count: event.count })}
                        </span>
                      </>
                    ) : null}
                    {event.version ? (
                      <>
                        {" · "}
                        <span className="myservers__event-meta num">
                          {event.version}
                        </span>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
            {data.has_more ? (
              <p className="myservers__events-note">{t("events.more")}</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
