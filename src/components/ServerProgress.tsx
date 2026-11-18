import { useEffect, useRef, useState } from "react";
import type { MyServer } from "../agent/bridge";
import {
  MY_SERVER_PHASE_TEXT,
  MY_SERVER_STATE_LABEL,
  serverProgress,
} from "../myservers/labels";

const STAGES = ["creating", "booting", "installing", "verifying"] as const;

/** 已等待：1 分 20 秒；不到一分钟只报秒。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0
    ? `已等待 ${minutes} 分 ${seconds} 秒`
    : `已等待 ${seconds} 秒`;
}

export function ServerProgress({ server }: { server: MyServer }) {
  // 从进入这台机器的详情起算；状态推进不重置，换一台才重新计时。
  const startedAtRef = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    startedAtRef.current = Date.now();
    setNow(Date.now());
  }, [server.server_id]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
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
        <span className="myservers__progress-meta">
          <span className="myservers__hint">通常 2–4 分钟。</span>
          <span className="myservers__hint num">
            {formatElapsed(now - startedAtRef.current)}
          </span>
        </span>
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
