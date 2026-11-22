import type { LlmProvider } from "../agent/bridge";
import { isLocalEndpoint } from "../agent/bridge";

/** 首启判定只看服务商目录里当前 active 的服务商。 */
export interface OnboardingInput {
  providers: {
    providers: Array<Pick<LlmProvider, "providerId" | "hasKey" | "baseUrl">>;
    activeProviderId: string | null;
  } | null;
}

/** 有 Key，或指向本机端点（Ollama 等）的服务商就能用。 */
export function providerUsable(
  provider: Pick<LlmProvider, "hasKey" | "baseUrl">,
): boolean {
  return provider.hasKey === true || isLocalEndpoint(provider.baseUrl);
}

/**
 * 与后端 has_credentials() 同语义：只看当前 active 服务商是否可用。
 * 内置服务商默认就是 active，但它不代表用户配过，不能看 activeProviderId 是否存在。
 */
export function isAiReady(
  input: Pick<OnboardingInput, "providers">,
): boolean {
  const activeProvider = input.providers
    ? input.providers.providers.find(
        (provider) => provider.providerId === input.providers?.activeProviderId,
      )
    : undefined;
  return activeProvider ? providerUsable(activeProvider) : false;
}

/** 用户点过「不用 AI」的标记；只决定下次启动还弹不弹首启。 */
export const ONBOARDING_SKIPPED_KEY = "veyl.onboarding.skipped";

/** 首启页只在没有可用 AI 且用户没跳过时出现。 */
export function shouldShowOnboarding(
  input: OnboardingInput,
  skipped: boolean,
): boolean {
  return !skipped && !isAiReady(input);
}
