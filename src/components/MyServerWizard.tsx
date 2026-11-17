import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentBridge,
  MyServerCatalog,
  MyServerPlan,
  MyServerRegion,
} from "../agent/bridge";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { toBridgeError } from "../agent/errors";
import {
  CONTINENT_LABELS,
  formatDailyPrice,
  formatMonthlyFromDaily,
  formatUsdCents,
} from "../myservers/labels";
import { IconChevronLeft } from "./icons";

interface Props {
  bridge: AgentBridge;
  catalog: MyServerCatalog | null;
  onOrdered: (serverId: string | null) => void;
  /** 下单前确认设备身份；没有身份时由 Host 懒注册。 */
  onEnsureIdentity: () => Promise<boolean>;
  /** 余额不足时的唯一去处。 */
  onTopUp: () => void;
  /** 次级入口：让 AI 帮我选。 */
  onAskAi?: () => void;
  /** 创建失败后带服务器 id 让 AI 定位。 */
  onAiLocate?: (serverId: string) => void;
  /** Host 回 auth_required 时拉起登录框（不能只看本地 account）。 */
  onAuthRequired?: () => void;
  /** 地区和档位选择变化：用于上报 last_action。 */
  onSelect?: (kind: "region" | "plan", id: string) => void;
  /** AI 代选后同步给 Host 保存；不算用户动作。 */
  onSelectionApplied?: (selection: { region: string; plan: string }) => void;
  /** 从新建节点舞台返回；身份/创建过程中锁住。 */
  onBack?: () => void;
  /** 返回后再进来时恢复上次选择。 */
  initialSelection?: { region?: string | null; plan?: string | null } | null;
  /** 创建中由 Host 忽略 stage-select；舞台把 busy 报上去。 */
  onBusyChange?: (busy: boolean) => void;
  /** AI 选好的地区/规格（events.md §4.26）；null = 这次没请求，不覆盖。 */
  aiSelection?: {
    region: string | null;
    plan: string | null;
    nonce: number;
  } | null;
}

interface WizardError {
  message: string;
  retryable: boolean;
  /** 余额不足还差多少（USD 分）；有值时给「去充值」。 */
  shortfallCents?: number;
}

const CONTINENT_ORDER: MyServerRegion["continent"][] = [
  "asia",
  "north_america",
  "europe",
  "south_america",
  "oceania",
  "africa",
];

const TIERS = ["入门", "标准", "进阶"];

const PREFERRED_PLAN = "s-1vcpu-1gb";

/** 没有明确选择时落在中档；目录只有一档时就是它。 */
function defaultPlan(plans: MyServerPlan[]): MyServerPlan | null {
  if (plans.length === 0) return null;
  return (
    plans.find((plan) => plan.id === PREFERRED_PLAN) ??
    plans[Math.floor(plans.length / 2)] ??
    null
  );
}

function errorText(error: unknown): { message: string; retryable: boolean } {
  const problem = toBridgeError(error);
  const message =
    problem.message && problem.message !== "操作失败"
      ? problem.message
      : "服务器没建起来。这笔订单已结束，没有产生服务器。";
  return { message, retryable: problem.retryable };
}

function makeIdempotencyKey(): string {
  return `wiz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 结果未知（超时/网络/5xx/在途）重试保持同键；明确终态失败才换新键。 */
function shouldKeepIdempotencyKey(error: unknown): boolean {
  const problem = toBridgeError(error);
  const reason =
    typeof problem.details?.reason === "string" ? problem.details.reason : "";
  if (
    reason === "instance_create_failed" ||
    reason === "region_unavailable" ||
    reason === "idempotency_conflict" ||
    reason === "order_not_payable" ||
    reason === "order_expired" ||
    reason === "price_mismatch" ||
    reason === "invalid_region" ||
    reason === "invalid_plan" ||
    reason === "account_blocked" ||
    reason === "device_revoked"
  ) {
    return false;
  }
  if (
    reason === "timeout" ||
    reason === "idempotency_in_flight" ||
    reason === "provider_unavailable" ||
    reason === "rate_limited" ||
    reason === "auth_required" ||
    // 余额不足时订单还在 pending；充值后复用同一单，避免留一堆过期订单。
    reason === "insufficient_balance"
  ) {
    return true;
  }
  if (problem.code === "TIMEOUT" || problem.code === "NETWORK") return true;
  // 5xx 等上游错误：可重试即视为结果未知。
  return problem.code === "UPSTREAM_ERROR" && problem.retryable;
}

/** 方向键在同组单选里移动并选中，符合 radiogroup 的键盘预期。 */
function moveWithinGroup(event: ReactKeyboardEvent<HTMLElement>) {
  const key = event.key;
  if (
    key !== "ArrowDown" &&
    key !== "ArrowUp" &&
    key !== "ArrowRight" &&
    key !== "ArrowLeft"
  ) {
    return;
  }
  const options = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
  );
  if (options.length === 0) return;
  event.preventDefault();
  const current = options.indexOf(document.activeElement as HTMLElement);
  const forward = key === "ArrowDown" || key === "ArrowRight";
  const from = current === -1 ? 0 : current;
  const next = (from + (forward ? 1 : -1) + options.length) % options.length;
  options[next]?.focus();
  options[next]?.click();
}

export function MyServerWizard({
  bridge,
  catalog,
  onOrdered,
  onEnsureIdentity,
  onTopUp,
  onAskAi,
  onAiLocate,
  onSelect,
  onSelectionApplied,
  onBusyChange,
  onBack,
  initialSelection = null,
  aiSelection = null,
  onAuthRequired,
}: Props) {
  const [fetched, setFetched] = useState<MyServerCatalog | null>(null);
  const [fetchState, setFetchState] = useState<"loading" | "ready" | "failed">(
    catalog ? "ready" : "loading",
  );
  const [regionId, setRegionId] = useState<string | null>(
    initialSelection?.region ?? null,
  );
  const [planId, setPlanId] = useState<string | null>(
    initialSelection?.plan ?? null,
  );
  const [phase, setPhase] = useState<"identity" | "creating" | null>(null);
  /** 点下「创建」就锁住返回，不等身份校验开始。 */
  const [submitting, setSubmitting] = useState(false);
  const busy = phase !== null || submitting;
  const [error, setError] = useState<WizardError | null>(null);
  /** 订单已经建出来但后续失败时记下服务器 id，AI 定位要用。 */
  const [failedServerId, setFailedServerId] = useState<string | null>(null);
  const [charged, setCharged] = useState<{
    chargedCents: number;
    balanceAfterCents: number;
  } | null>(null);
  // 同一组选择重试复用键：超时/网络失败时结果未知，换键会建第二台。
  // 键和地区+套餐绑定，换了选择必须换键，否则控制面按「同键不同请求」拒绝。
  const idempotencyKey = useRef({ key: "", region: "", plan: "" });
  const rootRef = useRef<HTMLDivElement>(null);
  const highlightTimer = useRef<number | null>(null);
  const [pointed, setPointed] = useState(false);

  const loadCatalog = useCallback(async () => {
    setFetchState("loading");
    try {
      const value = await bridge.myServerCatalog();
      setFetched(value);
      setFetchState("ready");
    } catch {
      setFetchState("failed");
    }
  }, [bridge]);

  useEffect(() => {
    if (catalog) {
      setFetchState("ready");
      return;
    }
    void loadCatalog();
  }, [catalog, loadCatalog]);

  const active = fetched ?? catalog;
  const regions = active?.regions ?? [];
  const plans = active?.plans ?? [];
  const unreadable = !active || regions.length === 0 || plans.length === 0;

  const groups = useMemo(
    () =>
      CONTINENT_ORDER.map((continent) => ({
        continent,
        label: CONTINENT_LABELS[continent],
        regions: regions.filter((region) => region.continent === continent),
      })).filter((group) => group.regions.length > 0),
    [regions],
  );

  // 舞台开着时把 busy 报给 Host：创建中收到 stage-select 要整条忽略。
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(
    () => () => {
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    },
    [],
  );

  const currentRegion =
    regions.find((region) => region.id === regionId) ??
    groups[0]?.regions[0] ??
    null;
  const currentPlan =
    plans.find((plan) => plan.id === planId) ?? defaultPlan(plans);
  const currentTier =
    currentPlan && plans.length === 3
      ? (TIERS[plans.findIndex((plan) => plan.id === currentPlan.id)] ?? null)
      : null;

  const consumedAiNonce = useRef<number | null>(null);
  // AI 选好地区/规格：null 不覆盖；同值不高亮；正在创建时整条忽略。
  useEffect(() => {
    if (!aiSelection) return;
    if (consumedAiNonce.current === aiSelection.nonce) return;
    consumedAiNonce.current = aiSelection.nonce;
    if (busy) return;
    const nextRegion =
      aiSelection.region !== null &&
      regions.some((region) => region.id === aiSelection.region)
        ? aiSelection.region
        : null;
    const nextPlan =
      aiSelection.plan !== null &&
      plans.some((plan) => plan.id === aiSelection.plan)
        ? aiSelection.plan
        : null;
    if (nextRegion === null && nextPlan === null) return;
    const mergedRegion = nextRegion ?? currentRegion?.id ?? null;
    const mergedPlan = nextPlan ?? currentPlan?.id ?? null;
    const changed =
      (nextRegion !== null && nextRegion !== currentRegion?.id) ||
      (nextPlan !== null && nextPlan !== currentPlan?.id);
    if (nextRegion !== null) setRegionId(nextRegion);
    if (nextPlan !== null) setPlanId(nextPlan);
    if (mergedRegion && mergedPlan) {
      onSelectionApplied?.({ region: mergedRegion, plan: mergedPlan });
    }
    // 成功不等于一定高亮：只有选择真的变了才滚过去。
    if (!changed) return;
    setPointed(true);
    rootRef.current?.scrollIntoView?.({ block: "center" });
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => {
      highlightTimer.current = null;
      setPointed(false);
    }, 1500);
  }, [aiSelection?.nonce, busy, regions, plans, regionId, planId]);

  const placeOrder = async () => {
    if (!currentPlan || !currentRegion || busy) return;
    setSubmitting(true);
    setError(null);
    setCharged(null);
    setFailedServerId(null);
    // 创建前先看余额：不够就不下单，直接在原地提示。
    try {
      const wallet = await bridge.myServerWallet();
      const shortfall = currentPlan.daily_price_cents - wallet.balance_cents;
      if (shortfall > 0) {
        setError({
          message: `余额不足，还差 ${formatUsdCents(shortfall)}。`,
          retryable: true,
          shortfallCents: shortfall,
        });
        setSubmitting(false);
        return;
      }
    } catch {
      // 读不到余额不拦，下单会再校验一次。
    }
    setPhase("identity");
    try {
      const ready = await onEnsureIdentity();
      if (!ready) {
        setError({
          message: "先登录，才能买服务器。",
          retryable: true,
        });
        onAuthRequired?.();
        return;
      }
      setPhase("creating");
      const chosen = { region: currentRegion.id, plan: currentPlan.id };
      if (
        !idempotencyKey.current.key ||
        idempotencyKey.current.region !== chosen.region ||
        idempotencyKey.current.plan !== chosen.plan
      ) {
        idempotencyKey.current = { key: makeIdempotencyKey(), ...chosen };
      }
      const created = await bridge.myServerCreate({
        region: chosen.region,
        plan: chosen.plan,
        idempotencyKey: idempotencyKey.current.key,
      });
      setFailedServerId(created.server_id);
      const charge = await bridge.myServerCheckout(created.order_id);
      setFailedServerId(null);
      setCharged({
        chargedCents: charge.charged_cents,
        balanceAfterCents: charge.balance_after_cents,
      });
      // 留在创建页显示扣费结果；新服务器在左栏以「建机器中」出现。
      onOrdered(null);
    } catch (err) {
      const problem = toBridgeError(err);
      const reason =
        typeof problem.details?.reason === "string" ? problem.details.reason : "";
      const shortfallRaw = problem.details?.shortfall_cents;
      const shortfall =
        typeof shortfallRaw === "number" && Number.isFinite(shortfallRaw)
          ? Math.max(0, Math.trunc(shortfallRaw))
          : 0;
      if (
        reason === "auth_required" ||
        reason === "token_invalid" ||
        reason === "device_identity_lost" ||
        reason === "device_missing" ||
        reason === "device_mismatch"
      ) {
        setError({ message: "登录已过期。重新登录后再试。", retryable: true });
        onAuthRequired?.();
      } else if (reason === "insufficient_balance") {
        setError({
          message:
            shortfall > 0
              ? `余额不足，还差 ${formatUsdCents(shortfall)}。`
              : "余额不足。",
          retryable: true,
          shortfallCents: shortfall,
        });
      } else {
        setError(errorText(err));
      }
      if (!shouldKeepIdempotencyKey(err)) idempotencyKey.current = { key: "", region: "", plan: "" };
    } finally {
      setPhase(null);
      setSubmitting(false);
    }
  };

  if (unreadable) {
    const pending = fetchState === "loading";
    return (
      <div ref={rootRef} className={`myservers__wizard ${pointed ? "is-pointed" : ""}`}>
        <div className="myservers__wizard-head">
          {onBack ? (
            <button
              type="button"
              className="myservers__wizard-back"
              onClick={onBack}
              disabled={busy}
            >
              <IconChevronLeft size={14} />
              返回
            </button>
          ) : null}
          <h4 className="myservers__wizard-title">新建节点</h4>
        </div>
        {pending ? (
          <p className="myservers__hint" role="status">
            正在读取可选的地区…
          </p>
        ) : (
          <>
            <p className="myservers__hint" role="status">
              读不到可选地区
            </p>
            <div className="myservers__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void loadCatalog()}
              >
                重试
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`myservers__wizard ${pointed ? "is-pointed" : ""}`}>
      <div className="myservers__wizard-head">
        {onBack ? (
          <button
            type="button"
            className="myservers__wizard-back"
            onClick={onBack}
            disabled={busy}
          >
            <IconChevronLeft size={14} />
            返回
          </button>
        ) : null}
        <h4 className="myservers__wizard-title">新建节点</h4>
      </div>

      <section className="wizard-block">
        <p className="wizard-block__title">地区</p>
        <div
          className="myservers__regions"
          role="radiogroup"
          aria-label="地区"
          onKeyDown={moveWithinGroup}
        >
          {groups.map((group) => (
            <div key={group.continent} className="myservers__region-group">
              <p className="myservers__region-label">{group.label}</p>
              <div className="myservers__region-grid">
                {group.regions.map((region) => {
                  const selected = currentRegion?.id === region.id;
                  return (
                    <button
                      key={region.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      className={`myservers__region ${selected ? "is-selected" : ""}`}
                      disabled={busy}
                      onClick={() => {
                        setRegionId(region.id);
                        onSelect?.("region", region.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === " " || event.key === "Enter") {
                          event.preventDefault();
                          setRegionId(region.id);
                          onSelect?.("region", region.id);
                        }
                      }}
                    >
                      {region.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="wizard-block">
        <p className="wizard-block__title">服务器类型</p>
        <div
          className="wizard-plan-cards"
          role="radiogroup"
          aria-label="服务器类型"
          onKeyDown={moveWithinGroup}
        >
          {plans.map((plan, index) => {
            const selected = currentPlan?.id === plan.id;
            const tier = plans.length === 3 ? TIERS[index] : null;
            return (
              <button
                key={plan.id}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                className={`wizard-plan ${selected ? "is-selected" : ""}`}
                disabled={busy}
                onClick={() => {
                  setPlanId(plan.id);
                  onSelect?.("plan", plan.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === " " || event.key === "Enter") {
                    event.preventDefault();
                    setPlanId(plan.id);
                    onSelect?.("plan", plan.id);
                  }
                }}
              >
                {tier ? <span className="wizard-plan__tier">{tier}</span> : null}
                <span className="wizard-plan__spec">{plan.label}</span>
                <span className="wizard-plan__sub">
                  <span className="wizard-plan__price">
                    每天{" "}
                    <span className="num">
                      {formatDailyPrice(plan.daily_price_cents)}
                    </span>
                  </span>
                  {plan.transfer_gib > 0 ? (
                    <span className="wizard-plan__transfer">
                      每月 {plan.transfer_gib} GB
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="wizard-block">
        <p className="wizard-block__title">系统</p>
        <p className="wizard-system">Ubuntu 24.04 LTS</p>
      </section>

      {charged ? (
        <p className="myservers__success" role="status">
          {charged.chargedCents > 0
            ? `已扣 ${formatUsdCents(charged.chargedCents)}，余额 ${formatUsdCents(charged.balanceAfterCents)}。`
            : `这台服务器已经开通过，没有重复扣费。余额 ${formatUsdCents(charged.balanceAfterCents)}。`}
        </p>
      ) : null}

      {error ? (
        <>
          <p className="myservers__error" role="alert">
            {error.message}
          </p>
          <p className="myservers__hint">
            {error.shortfallCents !== undefined
              ? "充值后回到这里，再点「创建」。"
              : error.retryable
                ? "可以点「创建」再试一次。"
                : "换一个地区或档位，再点「创建」。"}
          </p>
          {error.shortfallCents !== undefined ? (
            <div className="myservers__actions">
              <button type="button" className="btn btn--ghost" onClick={onTopUp}>
                去充值
              </button>
            </div>
          ) : null}
          {failedServerId && onAiLocate ? (
            <div className="myservers__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => onAiLocate(failedServerId)}
              >
                AI 定位
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="wizard-foot">
        <div className="wizard-foot__meta">
          <p className="wizard-foot__price">
            {currentPlan
              ? `${currentTier ? `${currentTier} · ` : ""}约 ${formatMonthlyFromDaily(currentPlan.daily_price_cents)}/月`
              : null}
          </p>
          <p className="myservers__demo">从余额扣一天；之后每天续扣，余额不足会提示充值。</p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !currentPlan || !currentRegion}
          aria-busy={busy || undefined}
          onClick={() => void placeOrder()}
        >
          {phase === "identity"
            ? "正在登录…"
            : phase === "creating"
              ? "正在创建…"
              : "创建"}
        </button>
      </div>

      {onAskAi ? (
        <button type="button" className="settings-link wizard-ask-ai" onClick={onAskAi}>
          让 AI 帮我选
        </button>
      ) : null}
    </div>
  );
}
