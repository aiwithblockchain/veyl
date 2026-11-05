import { useEffect, useRef, useState } from "react";
import type { AgentBridge, TunProbeData } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";

type Phase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: TunProbeData }
  | { kind: "precondition" }
  | { kind: "error"; text: string };

type CopyState = "idle" | "ok" | "error";

interface Props {
  bridge: AgentBridge;
}

function announcement(phase: Phase): string {
  switch (phase.kind) {
    case "running":
      return "正在运行网络诊断";
    case "precondition":
      return "还没有连接，无法运行诊断";
    case "done":
      return `${phase.result.conclusion}，诊断报告已生成`;
    default:
      return "";
  }
}

/**
 * debug 构建专用的 TUN 诊断入口。命令 `tun_probe` 只在 debug 注册，
 * 所以整行由调用方用 `import.meta.env.DEV` 挂载。
 */
export function TunDiagnosticsRow({ bridge }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [copy, setCopy] = useState<CopyState>("idle");
  const copyTimer = useRef<number | null>(null);
  const runningRef = useRef(false);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setCopy("idle");
    setPhase({ kind: "running" });
    try {
      const result = await bridge.tunProbe();
      setPhase({ kind: "done", result });
    } catch (error) {
      const bridgeError = toBridgeError(error);
      if (bridgeError.code === "PRECONDITION_FAILED") {
        setPhase({ kind: "precondition" });
      } else {
        setPhase({
          kind: "error",
          text: bridgeError.message.trim() || "诊断没有完成，请稍后重试。",
        });
      }
    } finally {
      runningRef.current = false;
    }
  };

  const copyPath = async (path: string) => {
    let next: CopyState = "ok";
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      next = "error";
    }
    setCopy(next);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopy("idle"), 2000);
  };

  const running = phase.kind === "running";
  const canRerun = phase.kind === "done" || phase.kind === "error";

  return (
    <div className="settings-row settings-row--stack">
      <div className="tun-probe">
        <div className="settings-row__label">运行诊断</div>
        <div className="settings-row__value">
          只在 debug 构建可用；采集接口、节点、DNS 与出站，写一份报告。
        </div>

        {phase.kind === "running" ? (
          <p className="settings-note tun-probe__status">正在诊断…</p>
        ) : null}
        {phase.kind === "precondition" ? (
          <p className="settings-note tun-probe__status">连上之后再运行诊断</p>
        ) : null}
        {phase.kind === "error" ? (
          <p className="settings-feedback settings-feedback--error" role="alert">
            {phase.text}
          </p>
        ) : null}
        {phase.kind === "done" ? (
          <div className="tun-probe__result">
            <p className="tun-probe__conclusion">{phase.result.conclusion}</p>
            <dl className="tun-probe__items">
              <div className="tun-probe__item">
                <dt>接口</dt>
                <dd>
                  {phase.result.utun.length > 0
                    ? phase.result.utun.map((line) => (
                        <span key={line} className="tun-probe__line">
                          {line}
                        </span>
                      ))
                    : "未发现 utun 接口"}
                </dd>
              </div>
              <div className="tun-probe__item">
                <dt>节点直连</dt>
                <dd>{phase.result.node || "—"}</dd>
              </div>
              <div className="tun-probe__item">
                <dt>系统 DNS</dt>
                <dd>{phase.result.dns || "—"}</dd>
              </div>
              <div className="tun-probe__item">
                <dt>经隧道 HTTPS</dt>
                <dd>{phase.result.https || "—"}</dd>
              </div>
              <div className="tun-probe__item">
                <dt>进程</dt>
                <dd>{phase.result.process || "—"}</dd>
              </div>
            </dl>
            {phase.result.reportPath ? (
              <button
                type="button"
                className="tun-probe__path"
                title="点击复制报告路径"
                onClick={() => void copyPath(phase.result.reportPath)}
              >
                {phase.result.reportPath}
                <span className="tun-probe__copy">
                  {copy === "ok" ? "已复制" : copy === "error" ? "复制失败" : "复制路径"}
                </span>
              </button>
            ) : null}
          </div>
        ) : null}

        <p className="sr-only" role="status" aria-live="polite">
          {announcement(phase)}
        </p>
      </div>
      <div className="settings-row__aside">
        <button
          type="button"
          className="btn btn--ghost"
          disabled={running}
          onClick={() => void run()}
        >
          {canRerun ? "重新诊断" : "运行诊断"}
        </button>
      </div>
    </div>
  );
}
