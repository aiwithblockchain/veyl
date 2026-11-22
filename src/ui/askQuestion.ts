import { en } from "../i18n/en";

/** 与后端约定的逐字回答：不算选择，只请 AI 解释这道题的选项含义。 */
export const EXPLAIN_ANSWER = "解释这个设置的含义";

/** 中英两种固定回答都认：英文界面回传英文，老会话里可能还是中文。 */
const EXPLAIN_ANSWERS = new Set([EXPLAIN_ANSWER, en["ask.explain"]]);

export function isExplainAnswer(value: string): boolean {
  return EXPLAIN_ANSWERS.has(value.trim());
}
