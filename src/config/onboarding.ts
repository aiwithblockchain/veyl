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

/**
 * 零配置时右栏必须摆到用户面前——会话里是不是已经有开场白不影响这一点。
 * 本次运行内手动关过就不替他打开；下次启动仍是零配置会再展开一次。
 */
export function shouldOpenPanelForEmptyConfigs(input: {
  aiReady: boolean;
  loading: boolean;
  configCount: number;
  closedThisRun: boolean;
}): boolean {
  return (
    input.aiReady &&
    !input.loading &&
    input.configCount === 0 &&
    !input.closedThisRun
  );
}

/** 首启页只在没有可用 AI 时出现；AI 是必需路径，不允许跳过。 */
export function shouldShowOnboarding(input: OnboardingInput): boolean {
  return !isAiReady(input);
}
