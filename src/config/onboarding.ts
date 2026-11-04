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

/** 首启第一轮只在这四个条件同时成立时触发；「已有消息」保证只发一次。 */
export function shouldKickOffFirstRun(input: {
  aiReady: boolean;
  hasEverConnected: boolean;
  configCount: number;
  messageCount: number;
}): boolean {
  return (
    input.aiReady &&
    !input.hasEverConnected &&
    input.configCount === 0 &&
    input.messageCount === 0
  );
}

/** 首启页只在「没有可用 AI 且用户也没选择过不用 AI」时出现。 */
export function shouldShowOnboarding(input: OnboardingInput): boolean {
  return !isAiReady(input) && !input.skipped;
}
