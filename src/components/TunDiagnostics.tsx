import { useEffect, useRef, useState } from "react";
import type { AgentBridge, TunProbeData } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { t as translate, useT } from "../i18n";

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
      return translate("tunDiag.announce.running");
    case "precondition":
      return translate("tunDiag.announce.notConnected");
    case "done":
      return translate("tunDiag.announce.done", {
        conclusion: phase.result.conclusion,
      });
    default:
      return "";
  }
}

/**
 * debug 构建专用的 TUN 诊断入口。命令 `tun_probe` 只在 debug 注册，
 * 所以整行由调用方用 `import.meta.env.DEV` 挂载。
 */
export function TunDiagnosticsRow({ bridge }: Props) {
  const t = useT();
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
          text:
            bridgeError.message.trim() || t("tunDiag.failed"),
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
        <div className="settings-row__label">{t("tunDiag.title")}</div>
        <div className="settings-row__value">
          {t("tunDiag.debugOnly")}
        </div>

        {phase.kind === "running" ? (
          <p className="settings-note tun-probe__status">{t("tunDiag.running")}</p>
        ) : null}
        {phase.kind === "precondition" ? (
          <p className="settings-note tun-probe__status">{t("tunDiag.connectFirst")}</p>
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
                <dt>{t("tunDiag.iface")}</dt>
                <dd>
                  {phase.result.utun.length > 0
                    ? phase.result.utun.map((line) => (
                        <span key={line} className="tun-probe__line">
                          {line}
                        </span>
                      ))
                    : t("tunDiag.noIface")}
                </dd>
              </div>
              <div className="tun-probe__item">
                <dt>{t("tunDiag.direct")}</dt>
                <dd>{phase.result.node || "—"}</dd>
              </div>
              <div className="tun-probe__item">
                <dt>{t("tunDiag.dns")}</dt>
                <dd>{phase.result.dns || "—"}</dd>
              </div>
              <div className="tun-probe__item">
                <dt>{t("tunDiag.tunnel")}</dt>
                <dd>{phase.result.https || "—"}</dd>
              </div>
              <div className="tun-probe__item">
                <dt>{t("tunDiag.process")}</dt>
                <dd>{phase.result.process || "—"}</dd>
              </div>
            </dl>
            {phase.result.reportPath ? (
              <button
                type="button"
                className="tun-probe__path"
                title={t("tunDiag.copyPathTitle")}
                onClick={() => void copyPath(phase.result.reportPath)}
              >
                {phase.result.reportPath}
                <span className="tun-probe__copy">
                  {copy === "ok"
                  ? t("chat.copy.copied")
                  : copy === "error"
                    ? t("chat.copy.failed")
                    : t("tunDiag.copyPath")}
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
          {canRerun ? t("tunDiag.rerun") : t("tunDiag.title")}
        </button>
      </div>
    </div>
  );
}
