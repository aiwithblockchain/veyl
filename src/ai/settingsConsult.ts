import { t } from "../i18n";

/**
 * 设置页「咨询 AI」的用户提示词：不再塞整份设置快照，让 AI 先读产品文档的设置部分，
 * 再问用户想咨询哪个模块。分区名由调用方按界面语言传入。
 */
export function settingsConsultPrompt(section: string): string {
  return t("settings.consult.prompt", { section });
}
