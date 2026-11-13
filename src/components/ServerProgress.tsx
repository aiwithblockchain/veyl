import type { MyServer } from "../agent/bridge";
import {
  MY_SERVER_PHASE_TEXT,
  MY_SERVER_STATE_LABEL,
  serverProgress,
} from "../myservers/labels";

const STAGES = ["creating", "booting", "installing", "verifying"] as const;

export function ServerProgress({ server }: { server: MyServer }) {
  const pct = serverProgress(server.state);
  const index = STAGES.indexOf(server.state as (typeof STAGES)[number]);
  return (
    <div
      className="myservers__progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={MY_SERVER_STATE_LABEL[server.state]}
    >
      <div className="myservers__progress-head">
        <span>
          {MY_SERVER_PHASE_TEXT[server.state] ?? "正在处理"} {pct}%
        </span>
        <span className="myservers__hint">通常 2–4 分钟。</span>
      </div>
      <div className="myservers__bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <ol className="myservers__steps">
        {STAGES.map((stage, stageIndex) => (
          <li
            key={stage}
            className={
              stageIndex < index
                ? "is-done"
                : stageIndex === index
                  ? "is-current"
                  : ""
            }
          >
            {MY_SERVER_STATE_LABEL[stage]}
          </li>
        ))}
      </ol>
    </div>
  );
}
