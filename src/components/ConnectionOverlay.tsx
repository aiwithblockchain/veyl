import { useEffect, useRef, useState } from "react";
import type { ConfigConnectMode, RuntimeView } from "../agent/protocol";
import type { VpnConnectionState } from "../config/useVpnSession";
import { useFocusTrap } from "../ui/focus";

/** 超过这个时长仍在进行，就换成「还在……，请稍候」；只改文案，不释放遮罩。 */
export const SLOW_AFTER_MS = 10_000;

export type ConnectionStageKind =
  | "prepare_helper"
  | "prepare"
  | "connect"
  | "verify"
  | "disconnect"
  | "finish";

export interface ConnectionStage {
  kind: ConnectionStageKind;
  mode: "connect" | "disconnect";
  title: string;
  caption: string | null;
}

/**
 * 过渡阶段只由真实信号推导：连接会话状态 + 运行时健康快照。
 * 没有真实进度，所以不出现百分比。
 */
export function connectionStage({
  connection,
  preparingHelper,
  checkingHelper = false,
  runtime,
  connectMode,
}: {
  connection: VpnConnectionState;
  preparingHelper: boolean;
  checkingHelper?: boolean;
  runtime: RuntimeView;
  connectMode: ConfigConnectMode | null;
}): ConnectionStage | null {
  // 失败立即让位给已有的失败卡，遮罩不重复报错。
  // 但用户点了「重新连接」时 connection 已先进入 starting：这时运行时可能还停在
  // failed，遮罩必须立刻出现，否则前置检查这段时间界面还是没有反应。
  if (runtime.state === "failed" && connection !== "starting") return null;

  // 后台组件还在查：健康快照可能残留上一次连接的值，不能据此显示成
  // 「正在建立连接」或「正在确认出口」。
  if (connection === "starting" && checkingHelper) {
    return {
      kind: "prepare",
      mode: "connect",
      title: "正在准备连接",
      caption: "正在检查后台组件。",
    };
  }

  // 授权阶段只到运行时进程起来为止：之后连接已经进入下一段。
  if (preparingHelper && !runtime.health.process) {
    return {
      kind: "prepare_helper",
      mode: "connect",
      title: "正在准备后台组件",
      caption: "系统会请求一次授权。",
    };
  }

  if (connection === "starting") {
    const health = runtime.health;
    if (health.data_plane || health.exit_ip) {
      return {
        kind: "verify",
        mode: "connect",
        title: "正在确认出口",
        caption: "正在确认流量已经走节点。",
      };
    }
    if (health.process) {
      return {
        kind: "connect",
        mode: "connect",
        title: "正在建立连接",
        caption: "正在连接节点。",
      };
    }
    return {
      kind: "prepare",
      mode: "connect",
      title: "正在准备连接",
      caption: "正在启动后台组件。",
    };
  }

  if (connection === "stopping") {
    // 已经回到 idle 说明断开结束，哪怕会话状态晚一拍也不能继续遮。
    if (runtime.state === "idle") return null;
    if (runtime.state === "stopping") {
      return {
        kind: "finish",
        mode: "disconnect",
        title: "正在收尾",
        caption: "正在停止后台组件并做收尾。",
      };
    }
    return {
      kind: "disconnect",
      mode: "disconnect",
      title: "正在断开连接",
      caption: connectMode === "tun" ? "使用「全部流量」时通常会久一些。" : null,
    };
  }

  return null;
}

export function ConnectionOverlay({
  connection,
  preparingHelper,
  checkingHelper = false,
  runtime,
  connectMode,
}: {
  connection: VpnConnectionState;
  preparingHelper: boolean;
  checkingHelper?: boolean;
  runtime: RuntimeView;
  connectMode: ConfigConnectMode | null;
}) {
  const stage = connectionStage({
    connection,
    preparingHelper,
    checkingHelper,
    runtime,
    connectMode,
  });
  const active = stage !== null;
  const mode = stage?.mode ?? null;
  const [slow, setSlow] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useFocusTrap(active, cardRef);

  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    cardRef.current?.focus();
    // 一次连接/断开只计一次时；阶段推进不重置。
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [active, mode]);

  if (!stage) return null;

  return (
    <div
      className="connection-overlay"
      role="dialog"
      aria-modal="true"
      aria-busy="true"
      aria-labelledby="connection-stage-title"
      aria-describedby={stage.caption ? "connection-stage-caption" : undefined}
    >
      <div ref={cardRef} className="connection-overlay__card" tabIndex={-1}>
        <div className="connection-overlay__bar" aria-hidden>
          <span />
        </div>
        <h2 id="connection-stage-title" className="connection-overlay__title" aria-live="polite">
          {stage.title}
        </h2>
        {stage.caption ? (
          <p id="connection-stage-caption" className="connection-overlay__caption">
            {stage.caption}
          </p>
        ) : null}
        {slow ? (
          <p className="connection-overlay__slow" role="status" aria-live="polite">
            {stage.mode === "connect" ? "还在连接，请稍候。" : "还在断开，请稍候。"}
          </p>
        ) : null}
      </div>
    </div>
  );
}
