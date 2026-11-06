/**
 * 高级设置项的「问 AI」提示词。前缀逐字固定（veyl-ui skill §5），
 * 不要在这里改写措辞或追加教程。
 */
export function advancedPrompt(field: string, value: string): string {
  return `我在 Veyl 的高级设置里调整「${field}」。当前值是 ${value}。
请用三句话说明：这项设置实际改变了什么、什么时候该改、改错会有什么后果。
不要给通用教程，只说这个设置本身。`;
}

export const ADVANCED_FIELDS = {
  defaultSource: "测试节点",
  apiProtocol: "API 类型与 Base URL",
  model: "模型选择",
} as const;
