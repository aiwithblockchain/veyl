import { useEffect, useRef, useState } from "react";
import type { MyServer } from "../agent/bridge";
import {
  formatBuildDuration,
  formatDuration,
  serverStateLabel,
} from "../myservers/labels";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n";

const STAGES = ["creating", "booting", "installing", "verifying"] as const;
/** 每个阶段一句自己的说明；通用句会让用户以为创建中也在下载节点程序。 */
const STAGE_NOTE_KEYS: Partial<Record<MyServer["state"], MessageKey>> = {
  creating: "progress.creating",
  booting: "progress.booting",
  installing: "progress.installing",
  verifying: "progress.verifying",
};
/** 某一阶段超过这么久就换一句「还在继续」，不再说「通常 2–4 分钟」。 */
const STAGE_TIMEOUT_MS = 180_000;
/** 整机硬边界：从 created_at 起算 15 分钟，到点改判「安装超时」。 */
const BUILD_TIMEOUT_MS = 15 * 60_000;
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

/** 整机计时起点：一律用 created_at，重进详情不从头算。 */
function buildStartedAt(server: MyServer): number | null {
  const at = Date.parse(server.created_at);
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
  // 整机计时一律从 created_at 起算：booting 没有阶段时间戳，也不会因为
  // 离开详情再回来而从头算。只有 created_at 缺失时才退回进入详情的时刻。
  const baseRef = useRef<number | null>(null);
  const serverIdRef = useRef(server.server_id);
  const [now, setNow] = useState(() => Date.now());

  const stageStart = stageStartedAt(server);
  const buildStart = buildStartedAt(server);
  if (serverIdRef.current !== server.server_id) {
    serverIdRef.current = server.server_id;
    baseRef.current = buildStart ?? Date.now();
  } else if (buildStart !== null) {
    baseRef.current = buildStart;
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
        <p className="myservers__created-in">
          {t("progress.ready")}
          {" · "}
          {buildDuration ? (
            <>
              {t("progress.used")}{" "}
              <span className="num">{buildDuration}</span>
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
      ? t("progress.installingVersion", { version: server.singbox_version })
      : t(STAGE_NOTE_KEYS[server.state] ?? "progress.processing");
  const elapsedMs = Math.max(0, now - (baseRef.current ?? now));
  const buildTimedOut = elapsedMs >= BUILD_TIMEOUT_MS;

  return (
    <div className="myservers__progress" role="group" aria-label={t("progress.groupAria")}>
      <div className="myservers__progress-head">
        <span>{serverStateLabel(server.state) || t("progress.processing")}</span>
        <span className="num">
          {t("progress.waited", {
            duration: formatDuration(elapsedMs / 1000),
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
      {buildTimedOut ? (
        <p
          className="myservers__progress-note is-timeout"
          role="status"
        >
          {t("progress.buildTimeout")}
        </p>
      ) : null}
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
