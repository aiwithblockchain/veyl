import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBridge, TunHelperInfo } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";

interface Failure {
  reason: string;
  impact: string;
  next: string;
}

const IMPACT = "直连可用，接管全部流量暂时不可用。";
const RETRY_NEXT = "点「检查并更新」再试一次；仍失败就复制诊断信息发给助手。";

const UPDATE_FAILED: Failure = {
  reason: "后台组件没有更新成功。",
  impact: IMPACT,
  next: RETRY_NEXT,
};

const UPDATE_DENIED: Failure = {
  reason: "没有获得管理员授权。",
  impact: IMPACT,
  next: "需要时再点「检查并更新」，输入管理员密码即可。",
};

export interface TunHelperController {
  loading: boolean;
  info: TunHelperInfo | null;
  available: boolean;
  busy: boolean;
  failure: Failure | null;
  hint: string | null;
  adminHint: boolean;
  loadFailed: boolean;
  retry: () => void;
  restart: () => void;
}

function isMissingCommand(error: unknown): boolean {
  const bridgeError = toBridgeError(error);
  return (
    bridgeError.code === "UNSUPPORTED" ||
    /not found|unknown command|not allowed|no such command/i.test(bridgeError.message)
  );
}

function isDenied(error: unknown): boolean {
  const bridgeError = toBridgeError(error);
  if (["AUTH_DENIED", "PERMISSION_DENIED", "USER_CANCELLED", "CANCELLED"].includes(bridgeError.code)) {
    return true;
  }
  const reason = String(bridgeError.details?.reason ?? "");
  if (/denied|cancel|authoriz|admin/i.test(reason)) return true;
  return /拒绝|取消|未授权|没有授权|authoriz|denied|cancel/i.test(bridgeError.message);
}

function isBusy(error: unknown): boolean {
  const bridgeError = toBridgeError(error);
  const reason = String(bridgeError.details?.reason ?? "").toLowerCase();
  return (
    (bridgeError.code === "PRECONDITION_FAILED" && bridgeError.retryable) ||
    bridgeError.code.toUpperCase() === "HELPER_BUSY" ||
    reason === "helper_busy"
  );
}

/** 后台组件状态与「检查并更新」；状态放在设置页顶层，切换分区不丢失。 */
export function useTunHelper({
  bridge,
  enabled,
}: {
  bridge: AgentBridge;
  enabled: boolean;
}): TunHelperController {
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<TunHelperInfo | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [adminHint, setAdminHint] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const mounted = useRef(true);
  const seq = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (showLoading: boolean) => {
      const id = ++seq.current;
      if (showLoading) setLoading(true);
      setLoadFailed(false);
      try {
        const next = await bridge.tunHelperInfo();
        if (!mounted.current || id !== seq.current) return;
        setInfo(next);
        setAvailable(true);
        setAdminHint(next.needsAdminRestart);
      } catch (error) {
        if (!mounted.current || id !== seq.current) return;
        if (isMissingCommand(error)) {
          setInfo(null);
          setAvailable(false);
        } else {
          setLoadFailed(true);
        }
      } finally {
        if (mounted.current && id === seq.current) setLoading(false);
      }
    },
    [bridge],
  );

  useEffect(() => {
    if (!enabled) return;
    setFailure(null);
    setHint(null);
    void load(true);
  }, [enabled, load]);

  const retry = useCallback(() => {
    setFailure(null);
    setHint(null);
    void load(true);
  }, [load]);

  const restart = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setHint(null);
    try {
      const result = await bridge.tunHelperRestart();
      if (!mounted.current) return;
      setAdminHint(result.needsAdminRestart);
      if (!result.ok) {
        setFailure(UPDATE_FAILED);
        return;
      }
      setHint(result.needsAdminRestart ? null : "后台组件已更新。");
      await load(false);
    } catch (error) {
      if (!mounted.current) return;
      if (isMissingCommand(error)) {
        setAvailable(false);
        return;
      }
      if (isBusy(error)) {
        setFailure(null);
        setAdminHint(false);
        setHint("正在准备，请稍后再试");
        return;
      }
      setFailure(isDenied(error) ? UPDATE_DENIED : UPDATE_FAILED);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [bridge, load]);

  return {
    loading,
    info,
    available,
    busy,
    failure,
    hint,
    adminHint,
    loadFailed,
    retry,
    restart,
  };
}

function StatusLine({
  info,
  activeConnection,
}: {
  info: TunHelperInfo;
  activeConnection: boolean;
}) {
  switch (info.state) {
    case "running":
      return (
        <p className="tun-helper__status">
          {info.runningBuild ? `正在使用 ${info.runningBuild}` : "正在使用"}
        </p>
      );
    case "not_running":
      return <p className="tun-helper__status">空闲已退出，下次连接会自动启动</p>;
    case "stale":
      return (
        <p className={`tun-helper__status${activeConnection ? "" : " is-warn"}`}>
          需要更新，连接结束后生效
        </p>
      );
    case "start_failed":
      return (
        <>
          <p className="tun-helper__status is-error">没有启动成功</p>
          <p className="settings-note">{IMPACT}</p>
          <p className="settings-note">{RETRY_NEXT}</p>
        </>
      );
    case "file_invalid":
      return (
        <>
          <p className="tun-helper__status is-error">文件校验失败，重新安装可修复</p>
          <p className="settings-note">{IMPACT}</p>
          <p className="settings-note">
            点「检查并更新」重新安装；仍失败就复制诊断信息发给助手。
          </p>
        </>
      );
    default:
      return <p className="tun-helper__status">状态未知</p>;
  }
}

interface RowProps {
  controller: TunHelperController;
  activeConnection: boolean;
}

export function TunHelperRow({ controller, activeConnection }: RowProps) {
  const {
    loading,
    info,
    available,
    busy,
    failure,
    hint,
    adminHint,
    loadFailed,
    retry,
    restart,
  } = controller;

  const staleWaiting = info?.state === "stale" && activeConnection;
  const canRestart = available && !loading && !busy && !staleWaiting;

  return (
    <div className="settings-row settings-row--stack">
      <div className="tun-helper">
        <div className="settings-row__label">后台组件</div>
        <div className="settings-row__value">接管全部流量所需的系统服务。</div>

        {loading ? <p className="settings-note tun-helper__status">正在读取状态…</p> : null}
        {!loading && info ? (
          <StatusLine info={info} activeConnection={activeConnection} />
        ) : null}
        {!loading && !info ? (
          <p className="settings-note tun-helper__status">暂时读不到后台组件状态。</p>
        ) : null}

        {adminHint && available && !loading && info?.state !== "file_invalid" ? (
          <p className="settings-note">
            后台组件需要更新：连接「全部流量」时会请求一次系统授权。
          </p>
        ) : null}
        {staleWaiting ? (
          <p className="settings-note">连接结束后会自动更新。</p>
        ) : null}

        {failure ? (
          <div className="tun-helper__failure" role="alert">
            <p className="settings-feedback settings-feedback--error">{failure.reason}</p>
            <p className="settings-note">{failure.impact}</p>
            <p className="settings-note">{failure.next}</p>
          </div>
        ) : null}
        {hint ? <p className="settings-feedback settings-feedback--ok">{hint}</p> : null}
      </div>

      <div className="settings-row__aside">
        {!available || loading ? null : loadFailed && !info ? (
          <button type="button" className="btn btn--ghost" onClick={retry}>
            重试
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={!canRestart}
            onClick={() => void restart()}
          >
            {busy ? "正在检查…" : staleWaiting ? "连接结束后自动更新" : "检查并更新"}
          </button>
        )}
      </div>
    </div>
  );
}
