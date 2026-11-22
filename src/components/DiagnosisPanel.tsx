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
  /** 上层还有告警弹层时暂停焦点陷阱，让告警能拿到焦点。 */
  trapPaused?: boolean;
}

const STEP_TITLE: Record<DiagnosisStepId, MessageKey> = {
  connectivity: "diagnosis.step.connectivity",
  config: "diagnosis.step.config",
  rotate: "diagnosis.step.rotate",
  retest: "diagnosis.step.retest",
  ai: "diagnosis.step.ai",
};

/** connection 档同一步骤名不同：这一档的 config 步骤是本地「运行态与配置」。 */
const CONNECTION_STEP_TITLE: Partial<Record<DiagnosisStepId, MessageKey>> = {
  config: "diagnosis.step.runtimeConfig",
};

const ACTION_LABEL: Record<DiagnosisAction, MessageKey> = {
  start: "diagnosis.action.start",
  updateConfig: "diagnosis.action.updateConfig",
  resetPort: "diagnosis.action.resetPort",
  retest: "diagnosis.action.retest",
  askAi: "diagnosis.action.askAi",
  goServers: "diagnosis.action.goServers",
  openSettings: "diagnosis.action.openSettings",
  changeNode: "diagnosis.action.changeNode",
  reconnect: "diagnosis.action.reconnect",
};

const STATUS_LABEL: Record<DiagnosisStep["status"], MessageKey> = {
  running: "diagnosis.status.running",
  passed: "diagnosis.status.passed",
  failed: "diagnosis.status.failed",
  unknown: "diagnosis.status.unknown",
  skipped: "diagnosis.status.skipped",
};

/** untested 的 Host 原因：常见的几种给人话，其余走通用语。 */
const UNTESTED_REASON_KEY: Record<string, MessageKey> = {
  connection_busy: "diagnosis.untested.connectionBusy",
  clash_unavailable: "diagnosis.untested.clashUnavailable",
  node_not_in_config: "diagnosis.untested.nodeNotInConfig",
  node_not_in_running_config: "diagnosis.untested.nodeNotInRunningConfig",
  no_credentials: "diagnosis.untested.noCredentials",
  runtime_missing: "diagnosis.untested.runtimeMissing",
  runtime_failed: "diagnosis.untested.runtimeFailed",
  runtime_timeout: "diagnosis.untested.runtimeTimeout",
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

export function DiagnosisPanel({
  nodeName,
  deps,
  onClose,
  trapPaused = false,
}: Props) {
  const t = useT();
  const diagnosis = useNodeDiagnosis(deps);
  const isConnection = deps.profile === "connection";
  const dialogRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const firstRenderRef = useRef(true);

  useFocusTrap(!trapPaused, dialogRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (trapPaused) return;
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, trapPaused]);

  // 旧动作按钮消失后，焦点跟着新的主按钮；没有下一步就回到关闭。
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    if (trapPaused) return;
    if (diagnosis.phase === "confirming") {
      cancelRef.current?.focus();
    } else if (diagnosis.action !== null) {
      actionRef.current?.focus();
    } else {
      closeRef.current?.focus();
    }
  }, [diagnosis.action, diagnosis.phase, trapPaused]);

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
        return t(
          isConnection
            ? "diagnosis.connection.serviceDown"
            : "diagnosis.connectivity.serviceDown",
        );
      case "probe-error":
        return t(
          PROBE_ERROR_KEY[conclusion.code ?? ""] ?? "diagnosis.probeError.generic",
        );
      case "local-network":
        return t(
          isConnection
            ? "diagnosis.connection.localNetwork"
            : "diagnosis.connectivity.localNetwork",
        );
      case "config-pending":
        return t("diagnosis.config.pending");
      case "config-control-plane":
        return t("diagnosis.config.controlPlane");
      case "config-timeout":
        return t("diagnosis.config.timeout");
      case "config-untested": {
        const key = conclusion.reason
          ? UNTESTED_REASON_KEY[conclusion.reason]
          : undefined;
        return key
          ? t("diagnosis.config.untestedReason", { reason: t(key) })
          : t("diagnosis.config.untested");
      }
      case "config-reconnect-failed":
        return t("diagnosis.config.reconnectFailed");
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
      case "rotate-timeout":
        return t("diagnosis.rotate.timeout");
      case "rotate-untested": {
        const key = conclusion.reason
          ? UNTESTED_REASON_KEY[conclusion.reason]
          : undefined;
        return key
          ? t("diagnosis.rotate.untestedReason", { reason: t(key) })
          : t("diagnosis.rotate.untested");
      }
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
      case "runtime-helper-blocked":
        return t("diagnosis.connection.helperBlocked");
      case "config-node-missing":
        return t("diagnosis.connection.configNodeMissing");
      case "config-invalid":
        return t("diagnosis.connection.configInvalid");
      case "server-unreachable":
        return t("diagnosis.connection.serverUnreachable");
      case "probe-untested": {
        const key = conclusion.reason
          ? UNTESTED_REASON_KEY[conclusion.reason]
          : undefined;
        return key
          ? t("diagnosis.connection.probeUntestedReason", { reason: t(key) })
          : t("diagnosis.connection.probeUntested");
      }
      case "runtime-error":
        return t("diagnosis.connection.runtimeError");
      case "connection-undetermined":
        return t("diagnosis.connection.undetermined");
      case "probe-ok":
        return t("diagnosis.connection.probeOk");
      case "skipped":
        return t("diagnosis.connectivity.skipped");
    }
  };

  const action = diagnosis.action;
  // 只有隧道正跑着这台节点时，重置才会断开当前连接；其余情况只说会重启节点。
  const willDisconnect = deps.isTunnelRunning();

  return (
    <div
      className="quit-backdrop diagnosis-backdrop"
      onMouseDown={onClose}
    >
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
            {nodeName
              ? t("diagnosis.title", { name: nodeName })
              : t("diagnosis.titlePlain")}
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
                      : step.status === "skipped"
                        ? "–"
                        : step.status === "unknown"
                          ? "?"
                          : "…"}
                </span>
                <div>
                  <p className="diagnosis__step-title">
                    {t(
                      (isConnection && CONNECTION_STEP_TITLE[step.id]) ||
                        STEP_TITLE[step.id],
                    )}
                  </p>
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
                      {diagnosis.retestProbe && action !== "retest" ? (
                        <button
                          type="button"
                          className="btn btn--ghost quit-dialog__btn"
                          onClick={diagnosis.retestProbe}
                        >
                          {t("diagnosis.action.retest")}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}

        {diagnosis.phase === "confirming" ? (
          <div className="diagnosis__confirm">
            <p className="diagnosis__confirm-text">
              {t(
                willDisconnect
                  ? "diagnosis.rotate.confirm"
                  : "diagnosis.rotate.confirmIdle",
              )}
            </p>
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
