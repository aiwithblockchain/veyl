import type { AgentBridge } from "../agent/bridge";
import { getLanguageEpoch, setLanguage } from "./index";

/**
 * 启动时读一次界面语言。读不到（旧后端、存储未就绪）就保持中文默认，不打断首屏。
 * 接口只取 appLanguageGet，测试里传一个最小桩即可。
 */
export async function initLanguage(
  bridge: Pick<AgentBridge, "appLanguageGet">,
): Promise<void> {
  const startedAt = getLanguageEpoch();
  try {
    const { resolved } = await bridge.appLanguageGet();
    // 读库期间用户已经手动切过：以用户的选择为准，丢弃这次结果。
    if (getLanguageEpoch() !== startedAt) return;
    setLanguage(resolved === "en" ? "en" : "zh");
  } catch {
    // 保持默认语言。
  }
}
