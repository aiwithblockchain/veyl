import { useMemo, useRef, useState } from "react";
import type { AgentBridge, MyServerCatalog, MyServerRegion } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { CONTINENT_LABELS } from "../myservers/mockMyServerService";
import { formatUsd } from "../myservers/labels";

interface Props {
  bridge: AgentBridge;
  catalog: MyServerCatalog | null;
  onCancel: () => void;
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

function errorText(error: unknown): string {
  const message = toBridgeError(error).message;
  return message && message !== "操作失败"
    ? message
    : "下单没成功。没有产生服务器；稍后再试，或换一个地区。";
}

export function MyServerWizard({ bridge, catalog, onCancel, onOrdered }: Props) {
  const [step, setStep] = useState<"region" | "confirm">("region");
  const [regionId, setRegionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef(
    `wiz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );

  const groups = useMemo(() => {
    const regions = catalog?.regions ?? [];
    return CONTINENT_ORDER.map((continent) => ({
      continent,
      label: CONTINENT_LABELS[continent],
      regions: regions.filter((region) => region.continent === continent),
    })).filter((group) => group.regions.length > 0);
  }, [catalog]);

  const plan = catalog?.plans[0] ?? null;
  const selected =
    catalog?.regions.find((region) => region.id === regionId) ??
    catalog?.regions[0] ??
    null;
  const current = regionId ?? selected?.id ?? null;

  const placeOrder = async () => {
    if (!plan || !current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await bridge.myServerCreate({
        region: current,
        plan: plan.id,
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

  if (!catalog) {
    return (
      <div className="myservers__wizard">
        <p className="myservers__hint" role="status">
          正在读取可选的地区…
        </p>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div className="myservers__wizard">
        <h4 className="myservers__wizard-title">确认订单</h4>
        <dl className="myservers__facts">
          <div>
            <dt>地区</dt>
            <dd>{selected?.name ?? current}</dd>
          </div>
          <div>
            <dt>套餐</dt>
            <dd>
              {plan?.id} · {plan?.label}
            </dd>
          </div>
          <div>
            <dt>费用</dt>
            <dd className="num">
              {plan ? `${formatUsd(plan.hourly_usd)}/小时` : ""} · 约{" "}
              {plan ? formatUsd(plan.monthly_usd) : ""}/月（730 小时）
            </dd>
          </div>
        </dl>
        <p className="myservers__hint">以实际账单为准。销毁后停止计费。</p>
        <p className="myservers__demo">体验流程，不会真实扣费。</p>
        {error ? (
          <p className="myservers__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="myservers__actions">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => setStep("region")}
          >
            返回
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void placeOrder()}
          >
            {busy ? "正在开始…" : "确认下单"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="myservers__wizard">
      <h4 className="myservers__wizard-title">选择地区</h4>
      <p className="myservers__hint">选一个离你常用的服务近的地区，之后可以重建换地区。</p>
      <div className="myservers__regions">
        {groups.map((group) => (
          <div key={group.continent} className="myservers__region-group">
            <p className="myservers__region-label">{group.label}</p>
            <div className="myservers__region-grid">
              {group.regions.map((region) => (
                <button
                  key={region.id}
                  type="button"
                  role="radio"
                  aria-checked={current === region.id}
                  className={`myservers__region ${
                    current === region.id ? "is-selected" : ""
                  }`}
                  onClick={() => setRegionId(region.id)}
                >
                  {region.name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="myservers__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!current}
          onClick={() => setStep("confirm")}
        >
          下一步
        </button>
      </div>
    </div>
  );
}
