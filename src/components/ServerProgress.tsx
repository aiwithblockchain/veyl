import { useEffect, useRef, useState } from "react";
import type { MyServer } from "../agent/bridge";
import {
  formatBuildDuration,
  formatDuration,
  serverStateLabel,
  serverStepDoneLabel,
} from "../myservers/labels";
import { useT } from "../i18n";

const STAGES = ["creating", "booting", "installing", "verifying"] as const;
/** 某一阶段超过这么久就换一句「还在继续」，不再说「通常 2–4 分钟」。 */
const STAGE_TIMEOUT_MS = 180_000;
/**
 * 进度块里每一格至少停留这么久。真机上安装 + 验证可能只有几秒：
 * 状态一次跨两格时逐格补齐，别让用户只看见「等待开机 → 可用」。
 */
const STEP_MIN_MS = 800;

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
  const t = useT();
  // 建好之后这块原地换成完成态：四个步骤全打勾 + 创建用时，页面不位移。
  const ready = server.state === "healthy" || server.state === "active";
  const stageIndex = STAGES.indexOf(server.state as (typeof STAGES)[number]);
  /** 真实状态对应的目标格：完成态也只到最后一格，最后一格亮过再切完成态。 */
  const target = ready ? STAGES.length - 1 : Math.max(0, stageIndex);
  /**
   * 已显示到第几步。只前进不后退：状态一次跨两格时逐格补齐，
   * 迟到的旧快照（回退）既不重放也不闪。
   */
  const [shown, setShown] = useState(target);
  const [done, setDone] = useState(ready);
  const [shownServerId, setShownServerId] = useState(server.server_id);
  const advancedAtRef = useRef(Date.now());
  // 计时基准是这台机器进入当前状态的时刻（有阶段时间戳就用它），
  // 所以离开详情再回来不会从头算；只有没有时间戳时才退回进入详情的时刻。
  const baseRef = useRef<number | null>(null);
  const serverIdRef = useRef(server.server_id);
  const [now, setNow] = useState(() => Date.now());

  const stageStart = stageStartedAt(server);
  if (serverIdRef.current !== server.server_id) {
    serverIdRef.current = server.server_id;
    baseRef.current = stageStart ?? Date.now();
  } else if (stageStart !== null) {
    baseRef.current = stageStart;
  } else if (baseRef.current === null) {
    baseRef.current = Date.now();
  }

  // 换服务器：游标回到这台的当前格，不重放入场动画。
  if (shownServerId !== server.server_id) {
    setShownServerId(server.server_id);
    setShown(target);
    setDone(ready);
    advancedAtRef.current = Date.now();
  }

  useEffect(() => {
    if (done) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [server.server_id, done]);

  // 目标还在前面：每次到点只前进一格，格与格之间至少隔 STEP_MIN_MS。
  useEffect(() => {
    if (shown >= target) return;
    const wait = Math.max(0, advancedAtRef.current + STEP_MIN_MS - Date.now());
    const timer = window.setTimeout(() => {
      advancedAtRef.current = Date.now();
      setShown((value) => Math.min(value + 1, target));
    }, wait);
    return () => window.clearTimeout(timer);
  }, [shown, target]);

  // 最后一格亮过之后的下一次渲染再切完成态：不让最后一个勾和「可用」同一帧出现。
  useEffect(() => {
    if (!ready || done || shown < STAGES.length - 1) return;
    const timer = window.setTimeout(() => setDone(true), 0);
    return () => window.clearTimeout(timer);
  }, [ready, done, shown]);

  if (done) {
    const buildDuration = formatBuildDuration(
      server.created_at,
      server.ready_at ?? null,
    );
    return (
      <div
        className="myservers__progress is-done"
        role="group"
        aria-label={t("progress.groupAria")}
      >
        <ol className="myservers__steps">
          {STAGES.map((stage) => (
            <li key={stage} className="is-done">
              <span className="myservers__step-tick" aria-hidden="true">
                ✓
              </span>
              {serverStepDoneLabel(stage)}
            </li>
          ))}
        </ol>
        <p className="myservers__created-in">
          {buildDuration ? (
            <>
              {t("progress.createdIn")} <span className="num">{buildDuration}</span>
            </>
          ) : (
            t("progress.durationMissing")
          )}
        </p>
      </div>
    );
  }

  const stageElapsed =
    stageStart === null ? null : Math.max(0, now - stageStart);
  const overtime =
    stageElapsed !== null && stageElapsed > STAGE_TIMEOUT_MS;
  const note = overtime
    ? t("progress.overtime", {
        minutes: Math.floor((stageElapsed ?? 0) / 60_000),
      })
    : server.state === "installing" && server.singbox_version
      ? t("progress.installing", { version: server.singbox_version })
      : t("progress.typical");

  return (
    <div className="myservers__progress" role="group" aria-label={t("progress.groupAria")}>
      <div className="myservers__progress-head">
        <span>{serverStateLabel(server.state) || t("progress.processing")}</span>
        <span className="num">
          {t("progress.waited", {
            duration: formatDuration((now - (baseRef.current ?? now)) / 1000),
          })}
        </span>
      </div>
      <div className="myservers__bar">
        {STAGES.map((stage, stageIndex) => (
          <span
            key={stage}
            className={
              stageIndex < shown
                ? "is-done"
                : stageIndex === shown
                  ? "is-current"
                  : ""
            }
          />
        ))}
      </div>
      <p className="myservers__progress-note">{note}</p>
      <ol className="myservers__steps">
        {STAGES.map((stage, stageIndex) => (
          <li
            key={stage}
            aria-current={stageIndex === shown ? "step" : undefined}
            className={
              stageIndex < shown
                ? "is-done"
                : stageIndex === shown
                  ? "is-current"
                  : ""
            }
          >
            {serverStateLabel(stage)}
          </li>
        ))}
      </ol>
    </div>
  );
}
