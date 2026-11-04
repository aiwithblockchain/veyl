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

/** 首启页只在「没有可用 AI 且用户也没选择过不用 AI」时出现。 */
export function shouldShowOnboarding(input: OnboardingInput): boolean {
  return !isAiReady(input) && !input.skipped;
}
