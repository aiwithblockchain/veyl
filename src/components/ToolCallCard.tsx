import { useState } from "react";
import type { NextAction } from "../agent/protocol";
import type { ToolCall } from "../state/chatStore";
import { copyText } from "../ui/clipboard";
import { useT } from "../i18n";
import {
  DURATION_THRESHOLD_MS,
  changedLabel,
  exactDuration,
  factsFromArgs,
  shortDuration,
  toolCopy,
} from "./toolDisplay";
import type { ToolDisplayAction } from "./toolDisplay";

/** 动作失败时由调用方给一句就地提示；成功返回空对象。 */
export interface DisplayActionOutcome {
  message?: string;
  /** copy_only 兜底：邮件正文（契约 §7.12），用于「复制正文」。 */
  copyBody?: string;
}

export function ToolCallCard({
  call,
  onNextAction,
  onDisplayAction,
}: {
  call: ToolCall;
  onNextAction: (action: NextAction) => void;
  onDisplayAction?: (action: ToolDisplayAction) => Promise<DisplayActionOutcome>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [techOpen, setTechOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [actionOutcome, setActionOutcome] = useState<DisplayActionOutcome | null>(null);
  const copy = toolCopy(call.tool);
  const failed = call.state === "error";
  const running = call.state === "running";

  // 后端 display.facts 优先；缺失时只用参数里的名称，绝不显示 id。
  const facts =
    call.display?.facts?.length
      ? call.display.facts
      : factsFromArgs(call.argsPreview);
  const actions = call.display?.actions ?? [];
  const hasTech =
    call.argsPreview !== undefined ||
    call.result !== undefined ||
    call.errorCode != null;
  const hasBody =
    failed ||
    facts.length > 0 ||
    call.durationMs !== undefined ||
    call.source === "ui" ||
    hasTech;
  const showDuration =
    !running && call.durationMs !== undefined && call.durationMs >= DURATION_THRESHOLD_MS;

  const text = running ? copy.running : failed ? copy.failed : copy.done;

  const changed = call.display?.changed ?? null;
  const nextAction = call.nextActions[0];

  const runDisplayAction = async (action: ToolDisplayAction) => {
    if (!onDisplayAction || actionPending) return;
    setActionPending(true);
    setActionOutcome(null);
    try {
      const outcome = await onDisplayAction(action);
      setActionOutcome(outcome);
    } catch {
      setActionOutcome({ message: t("tool.action.openFailed") });
    } finally {
      setActionPending(false);
    }
  };

  const copyReportBody = async () => {
    const body = actionOutcome?.copyBody;
    if (!body) return;
    const ok = await copyText(body);
    setActionOutcome((previous) =>
      previous
        ? {
            ...previous,
            message: ok
              ? t("tool.action.bodyCopied")
              : t("tool.action.copyFailed"),
          }
        : previous,
    );
  };

  const actionButton = (action: ToolDisplayAction) => (
    <button
      key={`${action.kind}-${action.reportId}`}
      type="button"
      className="chip chip--small"
      disabled={!action.reportId || actionPending}
      onClick={() => void runDisplayAction(action)}
    >
      {action.kind === "reveal_report_dir"
        ? t("tool.action.reveal")
        : t("tool.action.compose")}
    </button>
  );

  return (
    <div className={`tool-line tool-line--${call.state}`}>
      <div className="tool-line__head">
      <button
        type="button"
        className="tool-line__row"
        aria-expanded={open}
        disabled={!hasBody}
        onClick={() => setOpen((value) => !value)}
      >
        <StateIcon state={call.state} />
        <span className="tool-line__text">{text}</span>
        <span className="sr-only">
          {running
            ? t("tool.status.running")
            : failed
              ? t("tool.status.failed")
              : t("tool.status.done")}
        </span>
        {showDuration ? (
          <span className="tool-line__duration">
            {t("tool.duration.short", { value: shortDuration(call.durationMs!) })}
          </span>
        ) : null}
        {hasBody ? (
          <span className={`tool-line__chevron ${open ? "is-open" : ""}`} aria-hidden>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 4 4 4-4 4" />
            </svg>
          </span>
        ) : null}
      </button>
      {actions.length > 0 ? (
        <div className="tool-line__actions tool-line__actions--header">
          {actions.map(actionButton)}
        </div>
      ) : null}
      </div>

      {actionOutcome?.message ? (
        <p className="tool-line__hint" role="status">
          {actionOutcome.message}
        </p>
      ) : null}
      {actionOutcome?.copyBody ? (
        <div className="tool-line__actions tool-line__actions--header">
          <button
            type="button"
            className="chip chip--small"
            onClick={() => void copyReportBody()}
          >
            {t("tool.action.copyBody")}
          </button>
        </div>
      ) : null}

      {open && hasBody ? (
        <div className="tool-line__body">
          {failed ? (
            <dl className="tool-line__facts">
              <FactRow label={t("tool.body.what")} value={copy.failed} />
              <FactRow
                label={t("tool.body.changed")}
                value={changedLabel(changed, copy.readOnly)}
              />
              <FactRow
                label={t("tool.body.next")}
                value={nextAction?.label ?? copy.advice}
              />
            </dl>
          ) : (
            <dl className="tool-line__facts">
              {facts.map((fact, index) => (
                <FactRow
                  key={`${fact.label}-${index}`}
                  label={fact.label}
                  value={fact.value}
                  mono={fact.mono}
                />
              ))}
              {call.durationMs !== undefined ? (
                <FactRow label={t("tool.body.duration")} value={exactDuration(call.durationMs)} />
              ) : null}
              {call.source === "ui" ? (
                <FactRow label={t("tool.body.source")} value={t("tool.body.fromSettings")} />
              ) : null}
            </dl>
          )}

          {call.nextActions.length > 0 ? (
            <div className="tool-line__actions">
              {call.nextActions.map((action) => (
                <button
                  key={`${action.tool}-${action.label}`}
                  type="button"
                  className="chip chip--small"
                  onClick={() => onNextAction(action)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}

          {hasTech ? (
            <>
              <button
                type="button"
                className="tool-line__tech"
                aria-expanded={techOpen}
                onClick={() => setTechOpen((value) => !value)}
              >
                {t("tool.tech.title")}
              </button>
              {techOpen ? (
                <dl className="tool-line__tech-body">
                  <FactRow label={t("tool.tech.tool")} value={call.tool} mono />
                  {call.argsPreview !== undefined ? (
                    <FactRow
                      label={t("tool.tech.args")}
                      value={JSON.stringify(call.argsPreview, null, 2)}
                      mono
                    />
                  ) : null}
                  <FactRow
                    label={t("tool.tech.result")}
                    value={call.result ?? (running ? t("tool.tech.waiting") : t("tool.tech.noSummary"))}
                    mono
                  />
                  {call.errorCode ? (
                    <FactRow label={t("tool.tech.errorCode")} value={call.errorCode} mono />
                  ) : null}
                  {call.durationMs !== undefined ? (
                    <FactRow label={t("tool.tech.duration")} value={exactDuration(call.durationMs)} mono />
                  ) : null}
                </dl>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 连续 ≥3 条成功合并成一行；失败与进行中永不并入。 */
export function ToolCallGroup({
  calls,
  onNextAction,
  onDisplayAction,
}: {
  calls: ToolCall[];
  onNextAction: (action: NextAction) => void;
  onDisplayAction?: (action: ToolDisplayAction) => Promise<DisplayActionOutcome>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-group">
      <button
        type="button"
        className="tool-line__row tool-group__row"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <StateIcon state="ok" />
        <span className="tool-line__text">
          {t("tool.group.done", { count: calls.length })}
        </span>
        <span className="sr-only">{t("tool.status.done")}</span>
        <span className={`tool-line__chevron ${open ? "is-open" : ""}`} aria-hidden>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 4 4 4-4 4" />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="tool-group__body">
          {calls.map((call) => (
            <ToolCallCard
              key={call.id}
              call={call}
              onNextAction={onNextAction}
              onDisplayAction={onDisplayAction}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FactRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="tool-line__fact">
      {label ? <dt>{label}</dt> : <dt className="is-empty" aria-hidden />}
      <dd className={mono ? "is-mono" : undefined}>{value}</dd>
    </div>
  );
}

function StateIcon({ state }: { state: ToolCall["state"] }) {
  if (state === "running") {
    return (
      <span className="tool-line__icon is-running" aria-hidden>
        <svg className="tool-line__spinner" viewBox="0 0 16 16" width="14" height="14">
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray="26"
            strokeDashoffset="9"
          />
        </svg>
      </span>
    );
  }
  if (state === "ok") {
    return (
      <span className="tool-line__icon is-ok" aria-hidden>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3.5 8.5 3 3 6-7" />
        </svg>
      </span>
    );
  }
  return (
    <span className="tool-line__icon is-error" aria-hidden>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 4.8v4.1" />
        <circle cx="8" cy="11.3" r="0.9" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}
