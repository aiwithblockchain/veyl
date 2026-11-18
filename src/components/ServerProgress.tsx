import { useEffect, useRef, useState } from "react";
import type { MyServer } from "../agent/bridge";
import {
  MY_SERVER_PHASE_TEXT,
  MY_SERVER_STATE_LABEL,
} from "../myservers/labels";

const STAGES = ["creating", "booting", "installing", "verifying"] as const;
/** 某一阶段超过这么久就换一句「还在继续」，不再说「通常 2–4 分钟」。 */
const STAGE_TIMEOUT_MS = 180_000;

/** 已等待：1 分 20 秒；不到一分钟只报秒。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0
    ? `已等待 ${minutes} 分 ${seconds} 秒`
    : `已等待 ${seconds} 秒`;
}

/** 阶段开始时刻：后端给了这个阶段的字段才用；缺字段就不编。 */
function stageStartedAt(server: MyServer): number | null {
  const raw =
    server.state === "creating"
      ? server.created_at
      : server.state === "installing"
        ? server.installing_at ?? null
        : server.state === "verifying"
          ? server.verifying_at ?? null
          : null;
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
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
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const index = STAGES.indexOf(server.state as (typeof STAGES)[number]);
  const stageStart = stageStartedAt(server);
  const stageElapsed =
    stageStart === null ? null : Math.max(0, now - stageStart);
  const overtime =
    stageElapsed !== null && stageElapsed > STAGE_TIMEOUT_MS;
  const note = overtime
    ? `这一步已经 ${Math.floor((stageElapsed ?? 0) / 60_000)} 分钟，还在继续。`
    : server.state === "installing" && server.singbox_version
      ? `正在安装 sing-box ${server.singbox_version}`
      : "通常 2–4 分钟。";

  return (
    <div className="myservers__progress" role="group" aria-label="建机进度">
      <div className="myservers__progress-head">
        <span>{MY_SERVER_PHASE_TEXT[server.state] ?? "正在处理"}</span>
        <span className="num">{formatElapsed(now - startedAtRef.current)}</span>
      </div>
      <div className="myservers__bar is-active">
        <span style={{ width: `${((index + 1) / STAGES.length) * 100}%` }} />
      </div>
      <p className="myservers__progress-note">{note}</p>
      <ol className="myservers__steps">
        {STAGES.map((stage, stageIndex) => (
          <li
            key={stage}
            aria-current={stageIndex === index ? "step" : undefined}
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
