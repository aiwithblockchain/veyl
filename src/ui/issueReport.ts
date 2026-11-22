/**
 * 问题报告的开场指令（docs/design/issue-report.md §8）。
 * 以 `hidden: true` 发送：系统触发，不是用户说的话，不落成用户气泡。
 * 披露句必须由助手在回复里逐字说出，用户要看得见。
 */
import { t } from "../i18n";
import { zh } from "../i18n/zh";

/** 兼容旧调用点；按界面语言取词请用 issueReportOpening()。 */
export const ISSUE_REPORT_OPENING = zh["issueReport.opening"];

export function issueReportOpening(): string {
  return t("issueReport.opening");
}
