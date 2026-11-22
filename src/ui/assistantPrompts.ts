import { t } from "../i18n";
import type {
  ConnectionDiagnosisContext,
  DiagnosisContext,
} from "../myservers/useNodeDiagnosis";

/** 界面代用户发给 AI 的固定问题；调用方用函数，按界面语言取词。 */

/** 创建失败时「AI 定位」的固定前缀（ai-first-product.md §新建节点 失败处理）。 */
export function serverFailureAsk(): string {
  return t("assistant.prompt.serverFailure");
}

/** 连接失败「智能诊断」交给 AI：带连接失败清单，不含地址、端口与凭据。 */
export function connectDiagnosisAsk(context: ConnectionDiagnosisContext): string {
  return t("assistant.prompt.connectDiagnosis", {
    context: JSON.stringify(context, null, 2),
  });
}

/** 节点行「测不通问AI」：带节点名，先试智能恢复，再谈销毁重建。 */
export function nodeUnreachableAsk(nodeName: string): string {
  return t("assistant.prompt.nodeUnreachable", { name: nodeName });
}

/** 诊断面板「去问 AI」：带上本次收集的结构化清单；不含密码、令牌与完整链接。 */
export function nodeDiagnosisAsk(context: DiagnosisContext): string {
  return t("assistant.prompt.nodeDiagnosis", {
    context: JSON.stringify(context, null, 2),
  });
}
