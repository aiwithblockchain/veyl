import { t } from "../i18n";

/**
 * 设置页「咨询 AI」的用户提示词：带当前分区的事实，让 AI 直接就这一区开口。
 * 分区名与事实串都由调用方按界面语言拼好传入。
 */
export function settingsConsultPrompt(section: string, facts: string): string {
  return t("settings.consult.prompt", { section, facts });
}
