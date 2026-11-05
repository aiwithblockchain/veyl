/** 零配置入口的处境：刚引导完（等 AI 问）/ 刚引导完但 AI 停了 / 已配 AI 直接进来 / 不用 AI。 */
export type ZeroConfigMode =
  | "just-onboarded"
  | "just-onboarded-stopped"
  | "ai-ready"
  | "manual";

/** 最后一条 assistant 消息的纯文本；没有 assistant 消息时返回 null。 */
export function lastAssistantTextOf(
  messages: Array<{
    role: string;
    items?: Array<{ kind: string; content?: string }>;
  }>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.items) continue;
    return message.items
      .map((item) => (item.kind === "text" ? item.content ?? "" : ""))
      .join("");
  }
  return null;
}

/** 末尾是问句（中文或英文问号）说明 AI 还在等用户打字。 */
function endsWithQuestion(text: string | null): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return false;
  return /[?？]$/.test(trimmed);
}

/** 请求已结束（无请求中、无流式、无未答问题）且对话里已有内容，并且 AI 不是在等用户输入。 */
export function shouldSettleZeroConfig(input: {
  requesting: boolean;
  hasActiveRequest: boolean;
  hasPendingQuestion: boolean;
  messageCount: number;
  lastAssistantText: string | null;
}): boolean {
  return (
    !input.requesting &&
    !input.hasActiveRequest &&
    !input.hasPendingQuestion &&
    input.messageCount > 0 &&
    !endsWithQuestion(input.lastAssistantText)
  );
}

export function zeroConfigMode(
  aiReady: boolean,
  justOnboarded: boolean,
  settled = false,
): ZeroConfigMode {
  if (!aiReady) return "manual";
  if (!justOnboarded) return "ai-ready";
  return settled ? "just-onboarded-stopped" : "just-onboarded";
}

export interface ZeroConfigStep {
  title: string;
  detail: string;
}

export interface ZeroConfigContent {
  title: string;
  body: string | null;
  steps: ZeroConfigStep[] | null;
  primaryLabel: string | null;
}

export function zeroConfigContent(mode: ZeroConfigMode): ZeroConfigContent {
  if (mode === "just-onboarded") {
    return {
      title: "先配一条线路",
      body: "右边的助手正在问你要用在哪，回答完就生成配置。",
      steps: [
        { title: "告诉助手你要访问什么", detail: "网页，或者桌面软件。" },
        { title: "我按你的情况生成配置", detail: "自动选好节点和连接方式。" },
        { title: "点「启动 VPN」", detail: "之后随时可以换节点。" },
      ],
      primaryLabel: null,
    };
  }
  if (mode === "just-onboarded-stopped") {
    return {
      title: "还没配好。",
      body: "可以让我再问一次。",
      steps: null,
      primaryLabel: "继续帮我配",
    };
  }
  if (mode === "ai-ready") {
    return {
      title: "先配一条线路",
      body: null,
      steps: [
        { title: "告诉助手你要访问什么", detail: "网页，或者桌面软件。" },
        { title: "我按你的情况生成配置", detail: "自动选好节点和连接方式。" },
        { title: "点「启动 VPN」", detail: "之后随时可以换节点。" },
      ],
      primaryLabel: "让助手帮我配",
    };
  }
  return {
    title: "先新建一套配置。",
    body: "建好后，点「启动 VPN」就能连上。",
    steps: null,
    primaryLabel: "我自己配置",
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
  if (mode === "ai-ready" || mode === "just-onboarded-stopped") {
    handlers.onAskAi();
  } else if (mode === "manual") {
    handlers.onNewConfig();
  }
}

/** 一旦本次运行内建出过配置，A 的「刚引导完」文案就不再适用。 */
export function shouldResetJustOnboarded(
  justOnboarded: boolean,
  configCount: number,
): boolean {
  return justOnboarded && configCount > 0;
}

/** 上一次发过之后没有新消息就不重复发；AI 回了新内容就允许下一轮。 */
export function isZeroConfigAskSuppressed(input: {
  asked: boolean;
  askedAtCount: number;
  messageCount: number;
}): boolean {
  return input.asked && input.messageCount <= input.askedAtCount;
}

/**
 * 会话空闲、且这一轮还没自动发过「帮我配一下网络」时才补发。
 * 点过一次之后按钮只负责打开右栏给焦点，避免重复指令。
 */
export function shouldSendZeroConfigAsk(input: {
  requesting: boolean;
  hasActiveRequest: boolean;
  hasPendingQuestion: boolean;
  alreadyAsked: boolean;
}): boolean {
  return (
    !input.alreadyAsked &&
    !input.requesting &&
    !input.hasActiveRequest &&
    !input.hasPendingQuestion
  );
}
