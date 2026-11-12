import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBridge, TunHelperInfo } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";

export interface TunHelperController {
  loading: boolean;
  info: TunHelperInfo | null;
  available: boolean;
  busy: boolean;
  failure: string | null;
  hint: string | null;
  adminHint: boolean;
  restart: () => void;
  openSettings: () => void;
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

/** 后台组件状态与「更新」；状态放在设置页顶层，切换分区不丢失。 */
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
  const [failure, setFailure] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [adminHint, setAdminHint] = useState(false);

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
          setInfo(null);
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
        setFailure(
          result.needsAdminRestart
            ? "这次没有授权，可以再试一次。"
            : "更新没有完成，请稍后再试。",
        );
        return;
      }
      setHint("后台组件已更新。");
      await load(false);
    } catch (error) {
      if (!mounted.current) return;
      if (isMissingCommand(error)) {
        setAvailable(false);
        return;
      }
      if (isBusy(error)) {
        setHint("正在准备，请稍后再试。");
        return;
      }
      setFailure(
        isDenied(error) ? "这次没有授权，可以再试一次。" : "更新没有完成，请稍后再试。",
      );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [bridge, load]);

  const openSettings = useCallback(async () => {
    setFailure(null);
    try {
      await bridge.tunHelperOpenSettings();
    } catch (error) {
      if (isMissingCommand(error)) {
        setAvailable(false);
        return;
      }
      setFailure("没能打开系统设置，请手动打开「系统设置 › 通用 › 登录项与扩展」。");
    }
  }, [bridge]);

  return {
    loading,
    info,
    available,
    busy,
    failure,
    hint,
    adminHint,
    restart,
    openSettings: () => void openSettings(),
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
          {info.helperVersion ? `已是最新（${info.helperVersion}）` : "已是最新"}
        </p>
      );
    case "not_running":
      return <p className="tun-helper__status">现在没有运行，连接时会自动启动。</p>;
    case "stale":
      return (
        <p className="tun-helper__status">
          {activeConnection ? "有更新，断开后自动完成。" : "有更新，下次连接时自动完成。"}
        </p>
      );
    case "start_failed":
      return (
        <p className="tun-helper__status is-error">
          没有启动成功，连接「全部流量」时会再试一次。
        </p>
      );
    case "file_invalid":
      return (
        <p className="tun-helper__status is-error">
          文件校验失败，重新安装 Veyl 可以修复。
        </p>
      );
    default:
      return <p className="tun-helper__status">暂时读不到后台组件状态。</p>;
  }
}

interface RowProps {
  controller: TunHelperController;
  activeConnection: boolean;
}

export function TunHelperRow({ controller, activeConnection }: RowProps) {
  const { loading, info, available, busy, failure, hint, adminHint, restart, openSettings } =
    controller;
  const showAdmin = adminHint && available && !loading && info?.state !== "file_invalid";
  // 「已是最新」和「文件校验失败」不需要这个入口：前者没事可做，后者只能重装。
  // stale 也不给：它已经有「下次连接自动完成」的说明，再放跳转入口语义冲突。
  const showSettings =
    !loading && available && info !== null && ["not_running", "start_failed"].includes(info.state);

  return (
    <div className="settings-row settings-row--stack">
      <div className="tun-helper">
        <div className="settings-row__label">更新后台组件</div>
        <div className="settings-row__value">接管全部流量时要用的系统服务。</div>

        {loading ? <p className="settings-note tun-helper__status">正在读取状态…</p> : null}
        {!loading && info ? (
          <StatusLine info={info} activeConnection={activeConnection} />
        ) : null}
        {!loading && !info ? (
          <p className="settings-note tun-helper__status">暂时读不到后台组件状态。</p>
        ) : null}

        {showAdmin ? (
          <p className="settings-note">需要更新：连接「全部流量」时会请求一次系统授权。</p>
        ) : null}

        {failure ? (
          <p className="settings-feedback settings-feedback--error" role="alert">
            {failure}
          </p>
        ) : null}
        {hint ? <p className="settings-feedback settings-feedback--ok">{hint}</p> : null}
      </div>

      {showAdmin || showSettings ? (
        <div className="settings-row__aside">
          {showSettings ? (
            <button type="button" className="btn btn--ghost" onClick={openSettings}>
              打开系统设置
            </button>
          ) : null}
          {showAdmin ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => void restart()}
            >
              {busy ? "更新中…" : "更新"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
