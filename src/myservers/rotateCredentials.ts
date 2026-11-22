import type { AgentBridge, NodeRotateCredentialsResult } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";

/** Host 的 `node_rotate_credentials` 返回值（与 be-desktop 约定的形状）。 */
export type RotateCredentialsResult = NodeRotateCredentialsResult;

export type RotateCredentialsReason =
  | "agent_token_unavailable"
  | "agent_tls_untrusted"
  | "agent_token_rejected"
  | "agent_tool_failed"
  | "agent_timeout"
  | "agent_unreachable"
  | "agent_bad_response"
  | "UNSUPPORTED";

const REASONS = new Set<string>([
  "agent_token_unavailable",
  "agent_tls_untrusted",
  "agent_token_rejected",
  "agent_tool_failed",
  "agent_timeout",
  "agent_unreachable",
  "agent_bad_response",
  "UNSUPPORTED",
]);

/** 详情页唯一的调用点：Host 换实现只需要提供 `nodeRotateCredentials`。 */
export async function rotateNodeCredentials(
  bridge: AgentBridge,
  serverId: string,
): Promise<RotateCredentialsResult> {
  const command = bridge.nodeRotateCredentials;
  if (!command) {
    throw { code: "UNSUPPORTED", message: "", retryable: false };
  }
  return command.call(bridge, serverId);
}

/** 失败原因：后端可能把它放在 details.reason、message 或 code 里。 */
export function rotateFailureReason(error: unknown): RotateCredentialsReason | null {
  const problem = toBridgeError(error);
  const candidates = [problem.details?.reason, problem.message, problem.code];
  for (const value of candidates) {
    if (typeof value === "string" && REASONS.has(value)) {
      return value as RotateCredentialsReason;
    }
  }
  return null;
}
