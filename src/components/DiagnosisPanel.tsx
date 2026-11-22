import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n";
import {
  type DiagnosisAction,
  type DiagnosisConclusion,
  type DiagnosisDeps,
  type DiagnosisStep,
  type DiagnosisStepId,
  useNodeDiagnosis,
} from "../myservers/useNodeDiagnosis";
import { useFocusTrap } from "../ui/focus";
import { IconClose } from "./icons";

interface Props {
  /** 只用于标题行「诊断：<节点名>」。 */
  nodeName: string;
  deps: DiagnosisDeps;
  onClose: () => void;
}

const STEP_TITLE: Record<DiagnosisStepId, MessageKey> = {
  connectivity: "diagnosis.step.connectivity",
  config: "diagnosis.step.config",
  rotate: "diagnosis.step.rotate",
  ai: "diagnosis.step.ai",
};

const ACTION_LABEL: Record<DiagnosisAction, MessageKey> = {
  start: "diagnosis.action.start",
  updateConfig: "diagnosis.action.updateConfig",
  resetPort: "diagnosis.action.resetPort",
  askAi: "diagnosis.action.askAi",
  goServers: "diagnosis.action.goServers",
};

const STATUS_LABEL: Record<DiagnosisStep["status"], MessageKey> = {
  running: "diagnosis.status.running",
  passed: "diagnosis.status.passed",
  failed: "diagnosis.status.failed",
};

/** 破坏性动作才用 danger-ghost；其余只有一个主按钮。 */
const DANGER_ACTIONS = new Set<DiagnosisAction>(["resetPort", "goServers"]);

/** 稳定码只进交给 AI 的清单；界面显示人话。 */
const ROTATE_REASON_KEY: Record<string, MessageKey> = {
  agent_token_unavailable: "diagnosis.reason.agentTokenUnavailable",
  agent_tls_untrusted: "diagnosis.reason.agentTlsUntrusted",
  agent_token_rejected: "diagnosis.reason.agentTokenRejected",
  agent_tool_failed: "diagnosis.reason.agentToolFailed",
  agent_timeout: "diagnosis.reason.agentTimeout",
  agent_unreachable: "diagnosis.reason.agentUnreachable",
  agent_bad_response: "diagnosis.reason.agentBadResponse",
  UNSUPPORTED: "diagnosis.reason.unsupported",
};

const PROBE_ERROR_KEY: Record<string, MessageKey> = {
  invalid_ip: "diagnosis.probeError.invalidIp",
  invalid_port: "diagnosis.probeError.invalidPort",
  timeout: "diagnosis.probeError.timeout",
  spawn_failed: "diagnosis.probeError.spawnFailed",
  io_error: "diagnosis.probeError.ioError",
};

export function DiagnosisPanel({ nodeName, deps, onClose }: Props) {
  const t = useT();
  const diagnosis = useNodeDiagnosis(deps);
  const dialogRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const firstRenderRef = useRef(true);

  useFocusTrap(true, dialogRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 旧动作按钮消失后，焦点跟着新的主按钮；没有下一步就回到关闭。
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    if (diagnosis.phase === "confirming") {
      cancelRef.current?.focus();
    } else if (diagnosis.action !== null) {
      actionRef.current?.focus();
    } else {
      closeRef.current?.focus();
    }
  }, [diagnosis.action, diagnosis.phase]);

  const conclusionText = (conclusion: DiagnosisConclusion): ReactNode => {
    switch (conclusion.kind) {
      case "connectivity-pending":
        return t("diagnosis.connectivity.pending");
      case "connectivity-ok": {
        const ms = conclusion.viaTcp ? conclusion.tcpMs : conclusion.icmpMs;
        return (
          <>
            {conclusion.viaTcp
              ? t("diagnosis.connectivity.tcpOk")
              : t("diagnosis.connectivity.icmpOk")}
            {ms !== null ? (
              <>
                {" · "}
                <span className="num">{ms}</span> ms
              </>
            ) : null}
          </>
        );
      }
      case "unreachable":
        return t("diagnosis.connectivity.unreachable");
      case "service-down":
        return t("diagnosis.connectivity.serviceDown");
      case "probe-error":
        return t(
          PROBE_ERROR_KEY[conclusion.code ?? ""] ?? "diagnosis.probeError.generic",
        );
      case "local-network":
        return t("diagnosis.connectivity.localNetwork");
      case "config-pending":
        return t("diagnosis.config.pending");
      case "config-control-plane":
        return t("diagnosis.config.controlPlane");
      case "config-recovered":
        return conclusion.changed
          ? t("diagnosis.config.recovered")
          : t("diagnosis.config.recoveredNoChange");
      case "config-failed":
        return conclusion.changed
          ? t("diagnosis.config.stillDown")
          : t("diagnosis.config.stillDownNoChange");
      case "config-applied-idle":
        return t("diagnosis.config.appliedIdle");
      case "config-unchanged":
        return t("diagnosis.config.unchanged");
      case "rotate-pending":
        return t("diagnosis.rotate.pending");
      case "rotate-recovered":
        return t("diagnosis.rotate.recovered");
      case "rotate-reconnect-failed":
        return t("diagnosis.rotate.reconnectFailed");
      case "rotate-still-failed":
        return t("diagnosis.rotate.stillFailed");
      case "rotate-applied-idle":
        return t("diagnosis.rotate.appliedIdle");
      case "rotate-failed":
        return conclusion.reason
          ? t("diagnosis.rotate.failed", {
              reason: t(
                ROTATE_REASON_KEY[conclusion.reason] ??
                  "diagnosis.reason.unknown",
              ),
            })
          : t("diagnosis.rotate.failedNoReason");
      case "ai-handed":
        return t("diagnosis.ai.handed");
    }
  };

  const action = diagnosis.action;

  return (
    <div className="quit-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="quit-dialog diagnosis"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diagnosis-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="quit-dialog__head">
          <h2 id="diagnosis-title" className="quit-dialog__title">
            {t("diagnosis.title", { name: nodeName })}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="quit-dialog__close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </header>

        {diagnosis.steps.length === 0 ? (
          <p className="diagnosis__intro">{t("diagnosis.intro")}</p>
        ) : (
          <ol className="diagnosis__steps" aria-live="polite">
            {diagnosis.steps.map((step, index) => (
              <li key={`${step.id}-${index}`} className="diagnosis__step">
                <span
                  className={`diagnosis__status diagnosis__status--${step.status}`}
                  role="img"
                  aria-label={t(STATUS_LABEL[step.status])}
                >
                  {step.status === "passed"
                    ? "✓"
                    : step.status === "failed"
                      ? "✕"
                      : "…"}
                </span>
                <div>
                  <p className="diagnosis__step-title">{t(STEP_TITLE[step.id])}</p>
                  <p className="diagnosis__conclusion">
                    {conclusionText(step.conclusion)}
                  </p>
                  {index === diagnosis.steps.length - 1 && action !== null ? (
                    <div className="diagnosis__main">
                      <button
                        ref={actionRef}
                        type="button"
                        className={`btn quit-dialog__btn ${
                          DANGER_ACTIONS.has(action)
                            ? "btn--danger-ghost"
                            : "btn--primary"
                        }`}
                        onClick={diagnosis.run}
                      >
                        {t(ACTION_LABEL[action])}
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}

        {diagnosis.phase === "confirming" ? (
          <div className="diagnosis__confirm">
            <p className="diagnosis__confirm-text">{t("diagnosis.rotate.confirm")}</p>
            <div className="diagnosis__confirm-actions">
              <button
                ref={cancelRef}
                type="button"
                className="btn btn--ghost quit-dialog__btn"
                onClick={diagnosis.cancelReset}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn--danger-ghost quit-dialog__btn"
                onClick={diagnosis.confirmReset}
              >
                {t("diagnosis.rotate.confirmAction")}
              </button>
            </div>
          </div>
        ) : null}

        {diagnosis.steps.length === 0 && action !== null ? (
          <div className="diagnosis__main diagnosis__main--idle">
            <button
              ref={actionRef}
              type="button"
              className={`btn quit-dialog__btn ${
                DANGER_ACTIONS.has(action) ? "btn--danger-ghost" : "btn--primary"
              }`}
              onClick={diagnosis.run}
            >
              {t(ACTION_LABEL[action])}
            </button>
          </div>
        ) : null}

        <div className="quit-dialog__actions">
          <button
            type="button"
            className="btn btn--ghost quit-dialog__btn"
            onClick={onClose}
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
