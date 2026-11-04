import type { DeepSeekKeyState, LlmProvider } from "../agent/bridge";

/** 首启判定只关心这三样：本机 Key、服务商目录、用户是否明确选择过不用 AI。 */
export interface OnboardingInput {
  key: Pick<DeepSeekKeyState, "masked"> | null;
  providers: {
    providers: Array<Pick<LlmProvider, "providerId" | "hasKey">>;
    activeProviderId: string | null;
  } | null;
  skipped: boolean;
}

/**
 * 内置服务商默认就是 active，但它不代表用户配过。
 * 判断「能不能用」必须看当前服务商有没有 Key，不能看 activeProviderId 是否存在。
 */
export function isAiReady(
  input: Pick<OnboardingInput, "key" | "providers">,
): boolean {
  const activeProvider = input.providers
    ? input.providers.providers.find(
        (provider) => provider.providerId === input.providers?.activeProviderId,
      )
    : undefined;
  return (input.key?.masked ?? null) !== null || activeProvider?.hasKey === true;
}

/** 首启自动发起的第一轮（hidden 消息，不显示成用户气泡）。 */
export const FIRST_RUN_KICKOFF = "我是第一次用，帮我配一下网络。";

/**
 * 首启第一轮只在「有可用 AI、启动历史已加载、当前会话历史已加载、
 * 没有配置、会话为空」时触发；「已有消息」也保证它只发一次。
 * 不要求「从没连过」——删光配置的老用户同样需要 AI 重建。
 */
export function shouldKickOffFirstRun(input: {
  aiReady: boolean;
  historyReady: boolean;
  sessionHistoryLoaded: boolean;
  configCount: number;
  messageCount: number;
}): boolean {
  return (
    input.aiReady &&
    input.historyReady &&
    input.sessionHistoryLoaded &&
    input.configCount === 0 &&
    input.messageCount === 0
  );
}

/** 首启页只在「没有可用 AI 且用户也没选择过不用 AI」时出现。 */
export function shouldShowOnboarding(input: OnboardingInput): boolean {
  return !isAiReady(input) && !input.skipped;
}
