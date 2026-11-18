import { useEffect, useRef, useState } from "react";
import type { AgentBridge, MyServer, MyServerState } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { ServerProgress } from "./ServerProgress";
import {
  MY_SERVER_STATE_LABEL,
  billingNoticeText,
  formatUsdCents,
  isProvisioning,
  serverBillingText,
  stateTone,
} from "../myservers/labels";

interface Props {
  bridge: AgentBridge;
  server: MyServer;
  /** 地区显示名（来自目录）；目录读不到时退回 slug。 */
  regionLabel: string;
  /** 身份不可用：只读，不提供任何改动机器的操作。 */
  readOnly?: boolean;
  /** 当前连接的就是这台。 */
  connectedHere?: boolean;
  /** 失败时把结构化失败交给 AI。 */
  onAiLocate?: (serverId: string) => void;
  /** 再建一台：打开 client 舞台的新建节点。 */
  onCreateAnother: () => void;
  /** 同账户未销毁机器 > 1：流量额度是共享池。 */
  sharedTransfer?: boolean;
  /** 可用时去取凭据并连接这台（Host 验签后把节点设为当前）。 */
  onUseServer: (server: MyServer) => void | Promise<void>;
  /** 连接的就是这台时，主按钮执行断开。 */
  onDisconnect?: () => void;
  onChanged: () => void;
  /** 重建成功：选中 newServerId，详情继续显示安装进度。 */
  onRebuilt: (serverId: string, state: MyServerState) => void;
  /** 销毁后收起详情。 */
  onGone: () => void;
}

/** 服务端允许对 destroying 再发一次销毁；界面等这么久才放开重试入口。 */
export const DESTROY_RETRY_MS = 60_000;

function errorText(error: unknown): string {
  const problem = toBridgeError(error);
  const message = problem.message && problem.message !== "操作失败" ? problem.message : "";
  const tail = problem.retryable ? "没有改动这台服务器；稍后再试。" : "没有改动这台服务器。";
  return message ? `${message}${tail}` : `这次操作没完成。${tail}`;
}

/** 服务器详情：事实 + 底部操作行（销毁在左，主按钮在右）。 */
export function MyServerDetail({
  bridge,
  server,
  regionLabel,
  readOnly = false,
  connectedHere = false,
  onAiLocate,
  onCreateAnother,
  sharedTransfer = false,
  onUseServer,
  onDisconnect,
  onChanged,
  onRebuilt,
  onGone,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [destroyRetryAllowed, setDestroyRetryAllowed] = useState(false);
  const [useBusy, setUseBusy] = useState(false);
  const useBusyRef = useRef(false);

  const rebuild = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await bridge.myServerRebuild(server.server_id, true);
      onRebuilt(result.newServerId, result.state);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const destroy = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await bridge.myServerDestroy(server.server_id, true);
      onChanged();
      onGone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const ready = server.state === "healthy" || server.state === "active";
  const destroying = server.state === "destroying";

  useEffect(() => {
    setBusy(false);
    setConfirming(false);
    setError(null);
  }, [server.server_id]);

  useEffect(() => {
    if (!destroying) {
      setDestroyRetryAllowed(false);
      return;
    }
    const timer = window.setTimeout(
      () => setDestroyRetryAllowed(true),
      DESTROY_RETRY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [destroying, server.server_id]);

  const locked = readOnly || busy || (destroying && !destroyRetryAllowed);

  /** 主按钮在途时只允许一次；取凭据失败也由 App 播报。 */
  const useServerNow = async () => {
    if (useBusyRef.current || readOnly) return;
    useBusyRef.current = true;
    setUseBusy(true);
    try {
      await onUseServer(server);
    } finally {
      useBusyRef.current = false;
      setUseBusy(false);
    }
  };

  const primary = isProvisioning(server.state)
    ? null
    : server.state === "error"
      ? { label: "重新建一台", disabled: locked, onClick: onCreateAnother }
      : server.state === "gone"
        ? { label: "重新购买", disabled: locked, onClick: onCreateAnother }
        : ready
          ? connectedHere
            ? {
                label: "断开",
                disabled: locked || !onDisconnect,
                onClick: () => onDisconnect?.(),
              }
            : {
                label: "连接",
                disabled: locked || useBusy,
                onClick: () => void useServerNow(),
              }
          : null;

  /** 没建成的机器不存在「本期有效至」：费用行只说退款结论。 */
  const failed = server.state === "error";
  const chargedCents = server.charged_cents;
  const refundedCents = server.refunded_cents;
  const failedBilling =
    chargedCents === undefined || refundedCents === undefined
      ? "费用信息暂时读不到"
      : refundedCents > 0
        ? `已退回 ${formatUsdCents(refundedCents)}`
        : chargedCents === 0
          ? "本次没有扣费"
          : `已扣 ${formatUsdCents(chargedCents)}，退款处理中`;

  return (
    <div className="myservers__detail">
      <div className="myservers__detail-head">
        <h2 className="myservers__detail-name">{server.name}</h2>
        <span className={`myservers__state is-${stateTone(server.state)}`}>
          <span className={`led is-${stateTone(server.state)}`} aria-hidden />
          {MY_SERVER_STATE_LABEL[server.state]}
        </span>
      </div>

      {isProvisioning(server.state) ? <ServerProgress server={server} /> : null}

      <dl className="myservers__facts">
        <div>
          <dt>地区</dt>
          <dd>{regionLabel}</dd>
        </div>
        <div>
          <dt>节点</dt>
          <dd>{server.node_id ? "已就绪" : "未就绪"}</dd>
        </div>
        <div>
          <dt>费用</dt>
          <dd className="num">{failed ? failedBilling : serverBillingText(server)}</dd>
        </div>
        {!failed && server.transfer_gib > 0 ? (
          <div>
            <dt>流量</dt>
            <dd>{`每月 ${server.transfer_gib} GB（出站）${
              sharedTransfer ? "（同账户多台共用额度）" : ""
            }`}</dd>
          </div>
        ) : null}
      </dl>

      {server.billing_state === "past_due" || server.billing_state === "expired" ? (
        <p
          className={`myservers__billing ${
            server.billing_state === "expired" ? "is-expired" : ""
          }`}
          role="status"
        >
          {billingNoticeText(server)}
        </p>
      ) : null}

      {server.failure ? (
        <div className="myservers__failure" role="alert">
          <p>{server.failure.message}</p>
          {onAiLocate ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onAiLocate(server.server_id)}
            >
              AI 定位
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="myservers__error" role="alert">
          {error}
        </p>
      ) : null}

      {/* 重建端点当前不可用（rebuild_not_supported）：入口先隐藏，保留实现等后端。 */}
      {void rebuild}

      <div className="myservers__footer">
        <div className="myservers__danger">
          {destroying && !destroyRetryAllowed ? (
            <p className="myservers__hint" role="status">
              正在销毁…
            </p>
          ) : confirming ? (
            <div className="myservers__confirm" role="alert">
              <p>
                {isProvisioning(server.state)
                  ? "取消创建并销毁这台服务器？正在进行的安装会中断。"
                  : "销毁后不再产生新费用。未用完的整天退回余额，当天已扣不退。配置里会少一个节点。"}
              </p>
              <div className="myservers__actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn--danger-ghost"
                  disabled={busy}
                  onClick={() => void destroy()}
                >
                  {busy ? "正在销毁…" : "确认销毁"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn--danger-ghost"
              disabled={locked}
              onClick={() => setConfirming(true)}
            >
              {destroying ? "重试销毁" : "销毁"}
            </button>
          )}
        </div>
        {primary ? (
          <button
            type="button"
            className="btn btn--primary myservers__primary"
            disabled={primary.disabled}
            onClick={primary.onClick}
          >
            {primary.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
