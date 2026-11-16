import type { DeepSeekKeyState, LlmProvider } from "../agent/bridge";
import { isLocalEndpoint } from "../agent/bridge";

/** 首启判定只关心本机 Key 与服务商目录。 */
export interface OnboardingInput {
  key: Pick<DeepSeekKeyState, "masked"> | null;
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
 * 内置服务商默认就是 active，但它不代表用户配过。
 * 判断「能不能用」必须看当前服务商是否可用，不能看 activeProviderId 是否存在。
 */
export function isAiReady(
  input: Pick<OnboardingInput, "key" | "providers">,
): boolean {
  const activeProvider = input.providers
    ? input.providers.providers.find(
        (provider) => provider.providerId === input.providers?.activeProviderId,
      )
    : undefined;
  return (
    (input.key?.masked ?? null) !== null ||
    (activeProvider ? providerUsable(activeProvider) : false)
  );
}

/** 首启页只在没有可用 AI 时出现；AI 是必需路径，不允许跳过。 */
export function shouldShowOnboarding(input: OnboardingInput): boolean {
  return !isAiReady(input);
}
