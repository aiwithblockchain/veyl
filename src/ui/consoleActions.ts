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
      body: "右边我会问你两个问题：你打算怎么用它，以及你会不会自己设置代理。回答完我就生成配置，点一下就能连上。",
      steps: null,
    };
  }
  if (mode === "ai-ready") {
    return {
      title: "说一句你要访问什么，我来把网络配好。",
      body: null,
      steps: [
        "告诉我你平时要访问哪些网站或应用。",
        "我按你的情况生成一套配置。",
        "点一下「启动 VPN」，就连上了。",
      ],
    };
  }
  return {
    title: "先新建一套配置。",
    body: "填好节点后，点上面的按钮就能启动。",
    steps: null,
  };
}

export function runZeroConfigPrimaryAction(
  mode: ZeroConfigMode,
  handlers: { onAskAi: () => void; onNewConfig: () => void },
): void {
  if (mode === "ai-ready") handlers.onAskAi();
  else if (mode === "manual") handlers.onNewConfig();
}
