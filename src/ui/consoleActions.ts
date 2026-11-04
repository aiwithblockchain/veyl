/** 零配置入口的三种处境：刚引导完 / 已配 AI 直接进来 / 不用 AI。 */
export type ZeroConfigMode = "just-onboarded" | "ai-ready" | "manual";
export type ZeroConfigAction = "ask-ai" | "new-config";

export function zeroConfigMode(
  aiReady: boolean,
  justOnboarded: boolean,
): ZeroConfigMode {
  if (!aiReady) return "manual";
  return justOnboarded ? "just-onboarded" : "ai-ready";
}

export function zeroConfigActions(mode: ZeroConfigMode): ZeroConfigAction[] {
  if (mode === "ai-ready") return ["ask-ai", "new-config"];
  return ["new-config"];
}

export interface ZeroConfigContent {
  title: string;
  body: string | null;
  steps: string[] | null;
}

export function zeroConfigContent(mode: ZeroConfigMode): ZeroConfigContent {
  if (mode === "just-onboarded") {
    return {
      title: "已经配好了。",
      body: "右边的对话已经开始了。回答两个问题，我就生成配置。",
      steps: null,
    };
  }
  if (mode === "ai-ready") {
    return {
      title: "说一句，我来把网络配好。",
      body: null,
      steps: [
        "告诉我你要访问的网站或应用。",
        "我按你的情况生成配置。",
        "点顶部的「启动 VPN」就连上。",
      ],
    };
  }
  return {
    title: "先新建一套配置。",
    body: "建好后，点顶部的「启动 VPN」就能连上。",
    steps: null,
  };
}

/**
 * 只表示「主按钮被点了」：onAskAi 会打开右栏并给焦点，
 * 具体要不要发消息由 App 的 handleAskAiFromConsole 判断。
 */
export function runZeroConfigPrimaryAction(
  mode: ZeroConfigMode,
  handlers: { onAskAi: () => void; onNewConfig: () => void },
): void {
  if (mode === "ai-ready") handlers.onAskAi();
  else if (mode === "manual") handlers.onNewConfig();
}

/** 会话空闲时才补发「帮我配一下网络」；正在请求或有未答问题时只给焦点。 */
export function shouldSendZeroConfigAsk(input: {
  requesting: boolean;
  hasActiveRequest: boolean;
  hasPendingQuestion: boolean;
}): boolean {
  return (
    !input.requesting && !input.hasActiveRequest && !input.hasPendingQuestion
  );
}
