import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBridge, CoreInfo, CoreUpdateCandidate } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { AGENT_EVENTS } from "../agent/protocol";
import type {
  CoreUpgradeFinishedPayload,
  CoreUpgradeProgressPayload,
} from "../agent/protocol";

type UpgradePhase =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up_to_date" }
  | { kind: "available"; candidate: CoreUpdateCandidate; cached: boolean }
  | { kind: "unreachable"; network: "unreachable" | "source_error" }
  | {
      kind: "downloading";
      targetVersion: string;
      received: number;
      total: number | null;
    }
  | { kind: "verifying"; targetVersion: string }
  | { kind: "installing"; targetVersion: string }
  | { kind: "working"; targetVersion: string }
  | { kind: "done"; version: string | null; restartRequired: boolean }
  | {
      kind: "failed";
      operation: "upgrade" | "rollback";
      code: string | null;
      targetVersion: string | null;
    };

type CopyState = "idle" | "ok" | "error";

/** jobId 返回前收到的升级事件，按到达顺序暂存，拿到 id 后回放。 */
type BufferedCoreEvent =
  | { kind: "progress"; payload: CoreUpgradeProgressPayload }
  | { kind: "finished"; payload: CoreUpgradeFinishedPayload };

export interface RuntimeUpgradeController {
  phase: UpgradePhase;
  info: CoreInfo | null;
  note: string | null;
  copyState: CopyState;
  /** 命令不存在时的只读降级：保留版本展示，不显示任何动作。 */
  readOnly: boolean;
  startCheck: () => void;
  cancelCheck: () => void;
  startUpgrade: () => void;
  cancelUpgrade: () => void;
  rollback: () => void;
  retry: () => void;
  dismiss: () => void;
  useBundled: () => void;
  copyDiagnostics: () => void;
}

const COPY_FLASH_MS = 2000;

function isMissingCommand(error: unknown): boolean {
  const { code, message } = toBridgeError(error);
  // 不能用 NOT_FOUND：core_upgrade / core_rollback 的正常业务错误也用这个码。
  return (
    code === "UNSUPPORTED" ||
    /not found|unknown command|not allowed|no such command/i.test(message)
  );
}

function pickLatest(candidates: CoreUpdateCandidate[]): CoreUpdateCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) =>
    b.version.localeCompare(a.version, undefined, { numeric: true }),
  )[0];
}

function formatSize(bytes: number): string | null {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function normalizePhase(phase: string): "download" | "verify" | "install" | "working" {
  const value = phase.toLowerCase();
  if (value.includes("download") || value.includes("fetch")) return "download";
  if (value.includes("verify") || value.includes("checksum") || value.includes("validat")) {
    return "verify";
  }
  // unpacking / activating 都是「安装中」对用户可见的阶段。
  if (
    value.includes("install") ||
    value.includes("apply") ||
    value.includes("unpack") ||
    value.includes("activat")
  ) {
    return "install";
  }
  return "working";
}

/** 状态提升到 Settings 层：切换设置分区时升级进度不丢。 */
export function useRuntimeUpgrade({
  bridge,
  enabled,
}: {
  bridge: AgentBridge;
  enabled: boolean;
}): RuntimeUpgradeController {
  const [phase, setPhase] = useState<UpgradePhase>({ kind: "loading" });
  const [info, setInfo] = useState<CoreInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [readOnly, setReadOnly] = useState(false);

  const phaseRef = useRef<UpgradePhase>(phase);
  const jobRef = useRef<string | null>(null);
  const targetRef = useRef<string | null>(null);
  const candidateRef = useRef<CoreUpdateCandidate | null>(null);
  const checkEpochRef = useRef(0);
  const cancelRequestedRef = useRef(false);
  const awaitingJobRef = useRef(false);
  const bufferedEventsRef = useRef<BufferedCoreEvent[]>([]);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const refreshInfo = useCallback(
    async (markUnsupported = false): Promise<CoreInfo | null> => {
      try {
        const next = await bridge.coreInfo();
        setInfo(next);
        return next;
      } catch {
        const settled =
          phaseRef.current.kind === "loading" || phaseRef.current.kind === "idle";
        if (markUnsupported && settled) setPhase({ kind: "unsupported" });
        return null;
      }
    },
    [bridge],
  );

  // 每次打开设置刷新一次版本；升级进行中只更新版本信息，不动进度。
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      const next = await refreshInfo(true);
      if (!alive || !next) return;
      setPhase((current) =>
        current.kind === "loading" || current.kind === "unsupported"
          ? { kind: "idle" }
          : current,
      );
    })();
    return () => {
      alive = false;
    };
  }, [enabled, refreshInfo]);

  const applyProgress = useCallback((payload: CoreUpgradeProgressPayload) => {
    const stage = normalizePhase(payload.phase);
    const targetVersion = targetRef.current ?? "";
    if (stage === "download") {
      setPhase({
        kind: "downloading",
        targetVersion,
        received: payload.received ?? 0,
        total: payload.total ?? null,
      });
    } else if (stage === "verify") {
      setPhase({ kind: "verifying", targetVersion });
    } else if (stage === "install") {
      setPhase({ kind: "installing", targetVersion });
    } else {
      setPhase({ kind: "working", targetVersion });
    }
  }, []);

  const applyFinished = useCallback(
    (payload: CoreUpgradeFinishedPayload) => {
      if (!jobRef.current || payload.job_id !== jobRef.current) return;
      jobRef.current = null;
      setNote(null);
      // 后端取消时可能只发 ok:false 而不带 code，用本地取消标记兜底。
      const cancelled =
        payload.code === "CANCELLED" ||
        (cancelRequestedRef.current && !payload.code);
      cancelRequestedRef.current = false;
      if (payload.ok) {
        if (payload.version) targetRef.current = payload.version;
        const version = payload.version ?? targetRef.current;
        // 生效方式由 restart_required 决定，等 core_info 回来再展示，避免先闪错分支。
        void (async () => {
          const next = await refreshInfo();
          setPhase({
            kind: "done",
            version,
            restartRequired: next?.restartRequired ?? true,
          });
        })();
      } else if (cancelled) {
        // 用户取消：回到可升级态，不展示失败。
        const candidate =
          candidateRef.current && candidateRef.current.version === targetRef.current
            ? candidateRef.current
            : targetRef.current
              ? { version: targetRef.current, size: 0 }
              : null;
        setPhase(candidate ? { kind: "available", candidate, cached: false } : { kind: "idle" });
        void refreshInfo();
      } else {
        setPhase({
          kind: "failed",
          operation: "upgrade",
          code: payload.code ?? null,
          targetVersion: targetRef.current,
        });
        void refreshInfo();
      }
    },
    [refreshInfo],
  );

  useEffect(() => {
    return bridge.subscribe((event) => {
      if (event.name === AGENT_EVENTS.coreUpgradeProgress) {
        // job_id 回来之前先暂存：后端常先 spawn 再返回 id，快速失败会抢跑。
        if (awaitingJobRef.current) {
          bufferedEventsRef.current.push({ kind: "progress", payload: event.payload });
          return;
        }
        if (!jobRef.current || event.payload.job_id !== jobRef.current) return;
        applyProgress(event.payload);
        return;
      }

      if (event.name === AGENT_EVENTS.coreUpgradeFinished) {
        if (awaitingJobRef.current) {
          bufferedEventsRef.current.push({ kind: "finished", payload: event.payload });
          return;
        }
        applyFinished(event.payload);
      }
    });
  }, [bridge, applyProgress, applyFinished]);

  const startCheck = useCallback(() => {
    const epoch = checkEpochRef.current + 1;
    checkEpochRef.current = epoch;
    cancelRequestedRef.current = false;
    setNote(null);
    setPhase({ kind: "checking" });
    void (async () => {
      try {
        const result = await bridge.coreCheckUpdates();
        if (checkEpochRef.current !== epoch) return;
        // 非缓存结果只要联网失败就短路，候选一律不展示。
        if (result.network !== "ok" && !result.cached) {
          setPhase({ kind: "unreachable", network: result.network });
          return;
        }
        const best = pickLatest(result.candidates);
        if (best) {
          candidateRef.current = best;
          setPhase({ kind: "available", candidate: best, cached: result.cached });
        } else if (result.network !== "ok") {
          // 缓存里也没有比当前新的版本，仍然按连不上处理。
          setPhase({ kind: "unreachable", network: result.network });
        } else {
          setPhase({ kind: "up_to_date" });
        }
      } catch (error) {
        if (checkEpochRef.current !== epoch) return;
        if (isMissingCommand(error)) {
          setReadOnly(true);
          setPhase({ kind: "idle" });
          setNote("当前版本还不支持检查更新。");
        } else {
          setPhase({ kind: "unreachable", network: "unreachable" });
        }
      }
    })();
  }, [bridge]);

  const cancelCheck = useCallback(() => {
    checkEpochRef.current += 1;
    setPhase({ kind: "idle" });
  }, []);

  const cancelUpgrade = useCallback(() => {
    const jobId = jobRef.current;
    if (!jobId) {
      // job_id 还没回来：先记下取消意图，拿到 id 后补发。
      if (awaitingJobRef.current) {
        cancelRequestedRef.current = true;
        setNote("正在取消…");
      }
      return;
    }
    cancelRequestedRef.current = true;
    void (async () => {
      try {
        const { cancelled } = await bridge.coreCancelUpgrade(jobId);
        // 任务已经结束时不抢状态，等 core-upgrade-finished 收尾。
        if (!cancelled) return;
        cancelRequestedRef.current = false;
        jobRef.current = null;
        setNote(null);
        const target = targetRef.current;
        const candidate =
          candidateRef.current && candidateRef.current.version === target
            ? candidateRef.current
            : target
              ? { version: target, size: 0 }
              : null;
        setPhase(candidate ? { kind: "available", candidate, cached: false } : { kind: "idle" });
      } catch (error) {
        if (isMissingCommand(error)) setNote("当前版本还不支持取消升级。");
      }
    })();
  }, [bridge]);

  const runUpgrade = useCallback(
    (candidate: CoreUpdateCandidate) => {
      candidateRef.current = candidate;
      targetRef.current = candidate.version;
      cancelRequestedRef.current = false;
      awaitingJobRef.current = true;
      bufferedEventsRef.current = [];
      setNote(null);
      setPhase({
        kind: "downloading",
        targetVersion: candidate.version,
        received: 0,
        total: candidate.size > 0 ? candidate.size : null,
      });
      void (async () => {
        try {
          const { jobId } = await bridge.coreUpgrade(candidate.version);
          if (!jobId) {
            awaitingJobRef.current = false;
            bufferedEventsRef.current = [];
            setPhase({
              kind: "failed",
              operation: "upgrade",
              code: null,
              targetVersion: candidate.version,
            });
            return;
          }
          jobRef.current = jobId;
          awaitingJobRef.current = false;

          // 回放先到的事件；同一 job 的 finished 只处理第一条。
          const buffered = bufferedEventsRef.current;
          bufferedEventsRef.current = [];
          let ended = false;
          for (const item of buffered) {
            if (item.payload.job_id !== jobId) continue;
            if (item.kind === "finished") {
              if (ended) continue;
              ended = true;
              applyFinished(item.payload);
            } else if (!ended) {
              applyProgress(item.payload);
            }
          }

          // 等 id 期间点过取消：现在补发，避免取消按钮失效。
          if (cancelRequestedRef.current && jobRef.current) {
            cancelUpgrade();
          }
        } catch (error) {
          awaitingJobRef.current = false;
          bufferedEventsRef.current = [];
          if (isMissingCommand(error)) {
            setReadOnly(true);
            setPhase({ kind: "idle" });
            setNote("当前版本还不支持升级。");
          } else {
            setPhase({
              kind: "failed",
              operation: "upgrade",
              code: toBridgeError(error).code,
              targetVersion: candidate.version,
            });
          }
        }
      })();
    },
    [applyFinished, applyProgress, bridge, cancelUpgrade],
  );

  const startUpgrade = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind === "available" && !current.cached) runUpgrade(current.candidate);
  }, [runUpgrade]);

  const runRollback = useCallback(async () => {
    setNote(null);
    try {
      await bridge.coreRollback();
      setInfo((current) =>
        current
          ? {
              ...current,
              activeVersion: current.bundledVersion,
              activeSource: "bundled",
            }
          : current,
      );
      setPhase({ kind: "idle" });
      void refreshInfo();
    } catch (error) {
      if (isMissingCommand(error)) {
        setReadOnly(true);
        setNote("当前版本还不支持切回随包版本。");
        return;
      }
      const { code } = toBridgeError(error);
      if (code === "NOT_FOUND") {
        // 没有可回退的版本，等价于已经在用随包版本。
        setInfo((current) =>
          current
            ? { ...current, activeVersion: current.bundledVersion, activeSource: "bundled" }
            : current,
        );
        setPhase({ kind: "idle" });
        void refreshInfo();
        return;
      }
      setPhase({
        kind: "failed",
        operation: "rollback",
        code,
        targetVersion: null,
      });
    }
  }, [bridge, refreshInfo]);

  const rollback = useCallback(() => {
    void runRollback();
  }, [runRollback]);

  const retry = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind !== "failed") return;
    if (current.operation === "rollback") {
      void runRollback();
      return;
    }
    const version = current.targetVersion ?? candidateRef.current?.version;
    if (!version) {
      startCheck();
      return;
    }
    const candidate =
      candidateRef.current?.version === version
        ? candidateRef.current
        : { version, size: 0 };
    runUpgrade(candidate);
  }, [runRollback, runUpgrade, startCheck]);

  const dismiss = useCallback(() => {
    setNote(null);
    setPhase({ kind: "idle" });
  }, []);

  const useBundled = useCallback(() => {
    if (info?.activeSource === "installed") {
      void runRollback();
      return;
    }
    dismiss();
  }, [dismiss, info?.activeSource, runRollback]);

  const copyDiagnostics = useCallback(() => {
    const current = phaseRef.current;
    const payload = {
      bundledVersion: info?.bundledVersion ?? null,
      activeVersion: info?.activeVersion ?? null,
      activeSource: info?.activeSource ?? null,
      restartRequired: info?.restartRequired ?? null,
      stage: current.kind,
      targetVersion: targetRef.current,
      code: current.kind === "failed" ? current.code : null,
    };
    navigator.clipboard
      .writeText(JSON.stringify(payload, null, 2))
      .then(() => {
        setCopyState("ok");
      })
      .catch(() => {
        setCopyState("error");
      })
      .finally(() => {
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), COPY_FLASH_MS);
      });
  }, [info]);

  return {
    phase,
    info,
    note,
    copyState,
    readOnly,
    startCheck,
    cancelCheck,
    startUpgrade,
    cancelUpgrade,
    rollback,
    retry,
    dismiss,
    useBundled,
    copyDiagnostics,
  };
}

function statusText(phase: UpgradePhase, info: CoreInfo | null): string {
  switch (phase.kind) {
    case "loading":
      return "正在读取运行时信息…";
    case "unsupported":
      return "暂时读不到运行时信息。";
    case "idle":
      if (!info) return "暂时读不到运行时信息。";
      if (info.activeSource === "installed") {
        const bundled = info.bundledVersion ? `（随包 ${info.bundledVersion}）` : "";
        return `正在使用 ${info.activeVersion || "已安装版本"}${bundled}`;
      }
      return info.activeVersion
        ? `正在使用随包版本 ${info.activeVersion}`
        : "正在使用随包版本";
    case "checking":
      return "正在检查更新…";
    case "up_to_date":
      return "已是最新版本";
    case "available": {
      const size = formatSize(phase.candidate.size);
      return `可升级到 ${phase.candidate.version}${size ? `（约 ${size}）` : ""}`;
    }
    case "unreachable":
      return phase.network === "source_error"
        ? "更新源暂时不可用"
        : "连不上更新服务器";
    case "downloading": {
      const ratio =
        phase.total && phase.total > 0 ? phase.received / phase.total : null;
      const percent =
        ratio === null ? null : Math.min(100, Math.max(0, Math.floor(ratio * 100)));
      return percent === null ? "正在下载…" : `正在下载 ${percent}%`;
    }
    case "verifying":
      return "正在校验安装包…";
    case "installing":
      return "正在安装…";
    case "working":
      return "正在升级…";
    case "done":
      return phase.restartRequired
        ? "新版本会在重启 App 后生效"
        : "新版本会在下次连接时生效";
    case "failed":
      return "";
  }
}

/** 只随阶段变化：进度百分比变化不触发 aria-live 重复播报。 */
function announceText(phase: UpgradePhase, info: CoreInfo | null): string {
  switch (phase.kind) {
    case "loading":
      return "正在读取运行时信息";
    case "unsupported":
      return "暂时读不到运行时信息";
    case "idle":
      return statusText(phase, info);
    case "checking":
      return "正在检查更新";
    case "up_to_date":
      return "已是最新版本";
    case "available":
      return phase.cached
        ? `发现新版本 ${phase.candidate.version}，来自上次检查`
        : `发现新版本 ${phase.candidate.version}`;
    case "unreachable":
      return statusText(phase, info);
    case "downloading":
      return "正在下载安装包";
    case "verifying":
      return "正在校验安装包";
    case "installing":
      return "正在安装";
    case "working":
      return "正在升级";
    case "done":
      return statusText(phase, info);
    case "failed":
      // 失败块用 role="alert" 播报，避免重复。
      return "";
  }
}

function statusTone(phase: UpgradePhase): string {
  if (phase.kind === "failed") return "is-error";
  if (phase.kind === "unreachable") return "is-warn";
  if (phase.kind === "done") return "is-ok";
  if (phase.kind === "unsupported") return "is-muted";
  return "";
}

function failureReason(phase: Extract<UpgradePhase, { kind: "failed" }>): string {
  if (phase.operation === "rollback") return "没有切回随包版本。";
  const code = (phase.code ?? "").toUpperCase();
  if (code.includes("HASH") || code.includes("CHECKSUM") || code.includes("INTEGRITY")) {
    return "安装包校验没有通过。";
  }
  if (code.includes("SOURCE")) return "更新源暂时不可用。";
  if (code.includes("DISK")) return "磁盘空间不够。";
  if (code.includes("BUSY")) return "已经有一个升级任务在进行。";
  if (code.includes("NOT_FOUND")) return "这个版本已经不可用，请重新检查更新。";
  if (code.includes("DOWNLOAD") || code.includes("NETWORK") || code.includes("UNREACH")) {
    return "安装包没有下载完。";
  }
  if (code.includes("INSTALL") || code.includes("PERMISSION")) {
    return "新版本没有装好。";
  }
  return "升级没有完成。";
}

export function RuntimeUpgradeRow({
  controller,
}: {
  controller: RuntimeUpgradeController;
}) {
  const { phase, info, note, copyState } = controller;
  const actionsRef = useRef<HTMLDivElement>(null);

  // 点击后按钮会随状态换掉；焦点掉到 body 时接回新出现的第一个动作。
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.activeElement !== document.body) return;
    actionsRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [phase.kind]);

  const text = statusText(phase, info);
  const progress =
    phase.kind === "downloading" && phase.total && phase.total > 0
      ? Math.min(100, Math.max(0, Math.floor((phase.received / phase.total) * 100)))
      : null;
  const indeterminate =
    phase.kind === "verifying" ||
    phase.kind === "installing" ||
    phase.kind === "working" ||
    (phase.kind === "downloading" && progress === null);

  return (
    <div className="settings-row core-upgrade">
      <div className="core-upgrade__main">
        <div className="settings-row__label">运行时</div>
        <div className="settings-row__value">建立连接时实际运行的程序。</div>

        <p className="sr-only" role="status" aria-live="polite">
          {announceText(phase, info)}
        </p>

        {phase.kind === "failed" ? (
          <div className="core-upgrade__fail" role="alert">
            <p>{failureReason(phase)}</p>
            <p>
              {phase.operation === "rollback"
                ? "当前的运行时没有被改动，连接和配置也没有变化。"
                : "当前的运行时没有被替换，连接和配置都没有改动。"}
            </p>
            <p>
              {phase.operation === "rollback"
                ? "点「重试」再试一次；仍失败就复制诊断信息发给助手。"
                : "点「重试」再试一次；仍失败就继续用当前版本，复制诊断信息发给助手。"}
            </p>
          </div>
        ) : (
          <p className={`core-upgrade__status ${statusTone(phase)}`}>{text}</p>
        )}

        {phase.kind === "idle" && info?.restartRequired ? (
          <p className="core-upgrade__note">新版本会在重启 App 后生效。</p>
        ) : null}
        {phase.kind === "available" && phase.cached ? (
          <p className="core-upgrade__cached">上次检查的结果，可能不是最新</p>
        ) : null}
        {note ? <p className="core-upgrade__note">{note}</p> : null}

        {phase.kind === "downloading" ||
        phase.kind === "verifying" ||
        phase.kind === "installing" ||
        phase.kind === "working" ? (
          <div
            className={`core-upgrade__bar ${indeterminate ? "is-indeterminate" : ""}`}
            role="progressbar"
            aria-label="升级进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ?? undefined}
          >
            <span style={progress === null ? undefined : { width: `${progress}%` }} />
          </div>
        ) : null}
      </div>

      {controller.readOnly ? null : (
        <div className="settings-row__aside core-upgrade__actions" ref={actionsRef}>
        {phase.kind === "idle" ? (
          <>
            <button type="button" className="btn btn--ghost" onClick={controller.startCheck}>
              检查更新
            </button>
            {info?.activeSource === "installed" ? (
              <button type="button" className="btn btn--ghost" onClick={controller.rollback}>
                回到随包版本
              </button>
            ) : null}
          </>
        ) : null}

        {phase.kind === "checking" ? (
          <button type="button" className="btn btn--ghost" onClick={controller.cancelCheck}>
            取消
          </button>
        ) : null}

        {phase.kind === "up_to_date" ? (
          <button type="button" className="btn btn--ghost" onClick={controller.startCheck}>
            重新检查
          </button>
        ) : null}

        {phase.kind === "available" ? (
          <>
            {phase.cached ? (
              // 缓存结果可能过期：先重新检查，不直接给升级入口。
              <button type="button" className="btn btn--primary" onClick={controller.startCheck}>
                重新检查
              </button>
            ) : (
              <button type="button" className="btn btn--primary" onClick={controller.startUpgrade}>
                升级
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={controller.dismiss}>
              取消
            </button>
          </>
        ) : null}

        {phase.kind === "unreachable" ? (
          <>
            <button type="button" className="btn btn--ghost" onClick={controller.startCheck}>
              重试
            </button>
            <button type="button" className="btn btn--ghost" onClick={controller.useBundled}>
              用随包版本继续
            </button>
          </>
        ) : null}

        {phase.kind === "downloading" || phase.kind === "verifying" ? (
          <button type="button" className="btn btn--ghost" onClick={controller.cancelUpgrade}>
            取消
          </button>
        ) : null}

        {phase.kind === "done" ? (
          <button type="button" className="btn btn--ghost" onClick={controller.dismiss}>
            关闭
          </button>
        ) : null}

        {phase.kind === "failed" ? (
          <>
            <button type="button" className="btn btn--ghost" onClick={controller.retry}>
              重试
            </button>
            <button type="button" className="btn btn--link" onClick={controller.copyDiagnostics}>
              {copyState === "ok" ? "已复制" : copyState === "error" ? "复制失败" : "复制诊断"}
            </button>
          </>
        ) : null}
        </div>
      )}
    </div>
  );
}
