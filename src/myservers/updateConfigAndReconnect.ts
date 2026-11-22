/**
 * 「先更新配置」的共用流程：取凭据 → 需要时 stop → start → 调用方再重测/重读。
 *
 * 只有「隧道在跑，且跑的就是这台节点」才重启：运行的是别的节点时重启既不必要，
 * 也会打断用户当前的连接。
 */
export interface UpdateConfigOptions {
  /** 取回最新端口；失败时抛错。 */
  fetchPort: () => Promise<number>;
  tunnelRunning: boolean;
  /** 正在运行的本地节点 id（nd_…）；没在跑为 null。 */
  runningNodeId: string | null;
  /** 这台节点的本地 id；取不到时为 null（只取凭据，不重启）。 */
  nodeId: string | null;
  reconnect: () => Promise<boolean>;
}

export interface UpdateConfigOutcome {
  port: number;
  /** 是否真的做了 stop → start。 */
  reconnected: boolean;
  /** stop → start 是否成功；没触发时为 true。 */
  reconnectOk: boolean;
}

export async function updateConfigAndReconnect(
  options: UpdateConfigOptions,
): Promise<UpdateConfigOutcome> {
  const port = await options.fetchPort();
  const shouldReconnect =
    options.tunnelRunning &&
    options.nodeId !== null &&
    options.runningNodeId === options.nodeId;
  if (!shouldReconnect) {
    return { port, reconnected: false, reconnectOk: true };
  }
  const reconnectOk = await options.reconnect();
  return { port, reconnected: true, reconnectOk };
}
