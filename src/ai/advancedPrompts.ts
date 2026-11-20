import type { ConfigConnectMode, ConfigRouteMode } from "../agent/protocol";

/**
 * 高级设置项的「问 AI」提示词。前缀逐字固定（veyl-ui skill §5），
 * 不要在这里改写措辞或追加教程。
 */
export function advancedPrompt(field: string, value: string): string {
  return `我在 Veyl 的高级设置里调整「${field}」。当前值是 ${value}。
请用三句话说明：这项设置实际改变了什么、什么时候该改、改错会有什么后果。
不要给通用教程，只说这个设置本身。`;
}

/** 连接页两个 chip 的「问 AI」：把当前值和固定问题一起交给 AI。 */
export function modeScopePrompt(
  mode: ConfigConnectMode,
  scope: ConfigRouteMode | null,
): string {
  const modeLabel = mode === "tun" ? "Tun 模式" : "Proxy 模式";
  const scopeLabel = scope === "proxy_all" ? "全局" : "智能";
  return `我在 Veyl 的连接页看接管方式和流量范围。当前是「${modeLabel}」+「${scopeLabel}」。
请用不超过四句话说明：接管方式两句（改了什么、什么时候该改），流量范围两句（智能只让需要的流量走、全局全部走）。
不要给通用教程，只说这两个开关本身。`;
}

export const ADVANCED_FIELDS = {
  apiProtocol: "API 类型与 Base URL",
  model: "模型选择",
} as const;

/**
 * 「在手机上使用」弹层的「问 AI」：逐字固定（v3.2），只讲格式选择与安装/导入。
 * 改动等同于改产品文案，需走设计与 PM。
 */
export const mobileExportPrompt = `我在 Veyl 的「在手机上使用」里，准备把节点装到手机上。
请只讲两点：如果手机上已经有能导入的客户端，先选对应的导入格式（sing-box / Clash），再用它扫 Veyl 的二维码；没有的话，从列表里挑一个装（sing-box 在 iPhone 上需要大陆以外的 Apple 账号），装好后用同样的方式导入。
不要给通用教程，只说这两点。`;
