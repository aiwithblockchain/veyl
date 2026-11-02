import type { ApprovalDecision, ApprovalRequestedPayload, ApprovalScope } from "../agent/protocol";

interface Props {
  request: ApprovalRequestedPayload;
  decision?: ApprovalDecision;
  onDecide: (decision: ApprovalDecision, scope: ApprovalScope) => void;
}

const RISK_LABEL = { low: "低风险", medium: "中风险", high: "高风险" } as const;

export function ApprovalCard({ request, decision, onDecide }: Props) {
  const resolved = decision !== undefined;
  const sessionScoped = request.scope === "session";

  return (
    <div className={`approval-card approval-card--${request.risk} ${resolved ? "is-resolved" : ""}`}>
      <div className="approval-card__head">
        <span className="approval-card__badge" aria-hidden />
        <span className="approval-card__title">需要你的确认</span>
        <span className="approval-card__risk">{RISK_LABEL[request.risk]}</span>
        <span className="approval-card__tool">{request.tool}</span>
      </div>

      <p className="approval-card__summary">{request.summary}</p>

      {request.args_preview ? (
        <code className="approval-card__args">{JSON.stringify(request.args_preview)}</code>
      ) : null}

      {sessionScoped ? (
        <p className="approval-card__scope">仅对当前会话有效，新会话会重新确认。</p>
      ) : null}

      {resolved ? (
        <div className={`approval-card__result ${decision === "deny" ? "is-deny" : ""}`}>
          {decision === "deny" ? "已拒绝" : sessionScoped ? "已允许（本会话内不再询问）" : "已允许"}
        </div>
      ) : (
        <div className="approval-card__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onDecide("allow", request.scope)}
          >
            {sessionScoped ? "允许（本会话内不再询问）" : "允许"}
          </button>
          <button
            type="button"
            className="btn btn--danger-ghost"
            onClick={() => onDecide("deny", request.scope)}
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}
