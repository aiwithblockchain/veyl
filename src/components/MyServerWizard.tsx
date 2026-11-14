import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentBridge,
  MyServerCatalog,
  MyServerPlan,
  MyServerRegion,
} from "../agent/bridge";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { toBridgeError } from "../agent/errors";
import { CONTINENT_LABELS, formatUsd, formatUsdHourly } from "../myservers/labels";

interface Props {
  bridge: AgentBridge;
  catalog: MyServerCatalog | null;
  onOrdered: (serverId: string | null) => void;
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

export function MyServerWizard({ bridge, catalog, onOrdered }: Props) {
  const [fetched, setFetched] = useState<MyServerCatalog | null>(null);
  const [fetchState, setFetchState] = useState<"loading" | "ready" | "failed">(
    catalog ? "ready" : "loading",
  );
  const [regionId, setRegionId] = useState<string | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const idempotencyKey = useRef(
    `wiz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );

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

  const currentRegion =
    regions.find((region) => region.id === regionId) ??
    groups[0]?.regions[0] ??
    null;
  const currentPlan =
    plans.find((plan) => plan.id === planId) ?? defaultPlan(plans);

  const placeOrder = async () => {
    if (!currentPlan || !currentRegion || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await bridge.myServerCreate({
        region: currentRegion.id,
        plan: currentPlan.id,
        idempotencyKey: idempotencyKey.current,
      });
      const order = await bridge.myServerCheckout(created.order_id);
      onOrdered(order.server_id ?? null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (unreadable) {
    const pending = fetchState === "loading";
    return (
      <div className="myservers__wizard">
        <h4 className="myservers__wizard-title">新建服务器</h4>
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
    <div className="myservers__wizard">
      <h4 className="myservers__wizard-title">新建服务器</h4>

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
                      onClick={() => setRegionId(region.id)}
                      onKeyDown={(event) => {
                        if (event.key === " " || event.key === "Enter") {
                          event.preventDefault();
                          setRegionId(region.id);
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
                onClick={() => setPlanId(plan.id)}
                onKeyDown={(event) => {
                  if (event.key === " " || event.key === "Enter") {
                    event.preventDefault();
                    setPlanId(plan.id);
                  }
                }}
              >
                {tier ? <span className="wizard-plan__tier">{tier}</span> : null}
                <span className="wizard-plan__spec">{plan.label}</span>
                <span className="wizard-plan__price">
                  <span className="num">{formatUsd(plan.monthly_usd)}</span>/月
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

      {error ? (
        <>
          <p className="myservers__error" role="alert">
            {error.message}
          </p>
          <p className="myservers__hint">
            {error.retryable
              ? "可以点「创建服务器」再试一次。"
              : "换一个地区或档位，再点「创建服务器」。"}
          </p>
        </>
      ) : null}

      <div className="wizard-foot">
        <div className="wizard-foot__meta">
          <p className="wizard-foot__price">
            {currentPlan ? (
              <>
                约 <span className="num">{formatUsd(currentPlan.monthly_usd)}</span>/月 ·{" "}
                <span className="num">{formatUsdHourly(currentPlan.hourly_usd)}</span>/小时
              </>
            ) : null}
          </p>
          <p className="myservers__demo">体验流程，不会真实扣费。</p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !currentPlan || !currentRegion}
          aria-busy={busy || undefined}
          onClick={() => void placeOrder()}
        >
          {busy ? "正在创建…" : "创建服务器"}
        </button>      </div>
    </div>
  );
}
