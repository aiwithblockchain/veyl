/** 创建失败时「AI 定位」的固定前缀（ai-first-product.md §新建节点 失败处理）。 */
export const SERVER_FAILURE_ASK =
  "这台服务器创建失败了。请读取这次失败的结构化信息，说明卡在哪一步、能不能重试，只给一个我能点的动作，不要猜，也不要让我上传日志。";

/** 连接失败时「让 AI 检查」的固定前缀（ai-first-product.md §连接失败时的诊断）。 */
export const CONNECT_DIAG_ASK =
  "连接失败了。请先跑一次诊断，按清单逐项说明，只给一个能点的动作，不要猜。";
