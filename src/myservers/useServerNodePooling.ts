import { useEffect, useRef } from "react";
import type { MyServer, MyServerCredentialNode } from "../agent/bridge";
import type { ActionResult, VpnConnectionState } from "../config/useVpnSession";

interface Args {
  servers: MyServer[];
  connection: VpnConnectionState;
  credentials: (serverId: string) => Promise<MyServerCredentialNode>;
  attach: (nodeIds: string[]) => Promise<ActionResult>;
}

/** 取凭据失败后的冷却：开通期快照轮询会反复带着同一台服务器进来。 */
const CREDENTIAL_RETRY_COOLDOWN_MS = 10_000;
/** attach 失败后的冷却：用户可能一直连着，也要在同一个 idle 周期里再试一次。 */
const ATTACH_RETRY_COOLDOWN_MS = 10_000;

function isReady(state: MyServer["state"]): boolean {
  // 生产控制面结算时写 active（cloudflare/control-plane/src/servers.ts：UPDATE 同时写
  // state='active' 与 node_id）；healthy 目前只出现在 mock 与历史数据里。两种都接受。
  return state === "healthy" || state === "active";
}

/**
 * 服务器就绪后静默把节点送进全局池：详情页不再有连接入口，没人取凭据了。
 * 全程不发提示；已连接时排队等 idle 再绑，避免 node_attach 触发 runtime_rebuild。
 */
export function useServerNodePooling({
  servers,
  connection,
  credentials,
  attach,
}: Args): void {
  // 在途 / 待绑 / 已绑都用 ref：入队后重渲染会重跑 effect，用 state 会成环。
  const requested = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const queued = useRef(new Set<string>());
  const attached = useRef(new Set<string>());
  /** 本会话已经塞进过待绑队列的 node_id：同一会话的快照轮询不再重复塞。 */
  const sentThisSession = useRef(new Set<string>());
  /** 每台服务器/每组节点只 warn 一次：控制面长时间不可达时不刷屏。 */
  const warned = useRef(new Set<string>());

  const warnOnce = (key: string, ...args: unknown[]) => {
    if (warned.current.has(key)) return;
    warned.current.add(key);
    console.warn("[server-pooling]", ...args);
  };
  const cooldownUntil = useRef(new Map<string, number>());
  /** attach 失败后等冷却再试；不依赖 effect 重跑，用户一直 idle 也能自愈。 */
  const flushing = useRef(false);
  const waitingToFlush = useRef(false);
  const attachTimer = useRef<number | null>(null);
  const scanTimer = useRef<{ at: number; id: number } | null>(null);

  const serversRef = useRef(servers);
  serversRef.current = servers;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const credentialsRef = useRef(credentials);
  credentialsRef.current = credentials;
  const attachRef = useRef(attach);
  attachRef.current = attach;

  const clearAttachTimer = () => {
    if (attachTimer.current === null) return;
    window.clearTimeout(attachTimer.current);
    attachTimer.current = null;
  };

  const clearScanTimer = () => {
    if (scanTimer.current === null) return;
    window.clearTimeout(scanTimer.current.id);
    scanTimer.current = null;
  };

  const scheduleFlush = () => {
    if (attachTimer.current !== null) return;
    attachTimer.current = window.setTimeout(() => {
      attachTimer.current = null;
      waitingToFlush.current = false;
      flushRef.current();
    }, ATTACH_RETRY_COOLDOWN_MS);
  };

  /** 冷却到期时直接再扫一遍：没有新快照也能重试。 */
  const scheduleScan = () => {
    const now = Date.now();
    let earliest = now + CREDENTIAL_RETRY_COOLDOWN_MS;
    for (const server of serversRef.current) {
      if (!isReady(server.state) || server.node_id !== null) continue;
      if (requested.current.has(server.server_id)) continue;
      const until = cooldownUntil.current.get(server.server_id);
      if (until !== undefined && until > now) earliest = Math.min(earliest, until);
    }
    if (scanTimer.current !== null && scanTimer.current.at <= earliest) return;
    if (scanTimer.current !== null) window.clearTimeout(scanTimer.current.id);
    const id = window.setTimeout(() => {
      scanTimer.current = null;
      scanRef.current();
    }, Math.max(0, earliest - now));
    scanTimer.current = { at: earliest, id };
  };

  const flush = () => {
    if (connectionRef.current !== "idle") return;
    if (flushing.current || waitingToFlush.current || queued.current.size === 0) return;
    const nodeIds = [...queued.current];
    flushing.current = true;
    void Promise.resolve(attachRef.current(nodeIds))
      .then((result) => {
        if (!result.ok) {
          warnOnce(
            `attach:${nodeIds.join(",")}`,
            "节点进池失败，稍后重试",
            nodeIds,
            result.message,
          );
          waitingToFlush.current = true;
          scheduleFlush();
          return;
        }
        clearAttachTimer();
        for (const nodeId of nodeIds) {
          queued.current.delete(nodeId);
          attached.current.add(nodeId);
        }
      })
      .catch((error) => {
        warnOnce(`attach:${nodeIds.join(",")}`, "节点进池失败，稍后重试", nodeIds, error);
        waitingToFlush.current = true;
        scheduleFlush();
      })
      .finally(() => {
        flushing.current = false;
        // 冲刷期间新入队的节点（例如另一台服务器此刻才取回凭据）不能被晾在队列里。
        if (queued.current.size > 0) flushRef.current();
      });
  };

  const scan = () => {
    const now = Date.now();
    for (const server of serversRef.current) {
      if (!isReady(server.state)) continue;
      if (server.node_id !== null) {
        // 已经取过凭据的机器（含重启前绑失败的）：没绑过就入队；重复 attach 幂等。
        if (attached.current.has(server.node_id)) continue;
        if (sentThisSession.current.has(server.node_id)) continue;
        sentThisSession.current.add(server.node_id);
        queued.current.add(server.node_id);
        continue;
      }
      if (requested.current.has(server.server_id)) continue;
      if (inFlight.current.has(server.server_id)) continue;
      if ((cooldownUntil.current.get(server.server_id) ?? 0) > now) {
        scheduleScan();
        continue;
      }
      inFlight.current.add(server.server_id);
      void Promise.resolve(credentialsRef.current(server.server_id))
        .then((node) => {
          requested.current.add(server.server_id);
          cooldownUntil.current.delete(server.server_id);
          if (node.node_id && !attached.current.has(node.node_id)) {
            queued.current.add(node.node_id);
            sentThisSession.current.add(node.node_id);
          }
          flushRef.current();
        })
        .catch((error) => {
          // 静默重试：冷却期内不再打这条失败请求；冷却到期由定时器自己扫回来。
          cooldownUntil.current.set(
            server.server_id,
            Date.now() + CREDENTIAL_RETRY_COOLDOWN_MS,
          );
          warnOnce(
            `credentials:${server.server_id}`,
            "取凭据失败，稍后重试",
            server.server_id,
            error,
          );
          scheduleScan();
        })
        .finally(() => {
          inFlight.current.delete(server.server_id);
        });
    }
    flushRef.current();
  };

  const scanRef = useRef(scan);
  scanRef.current = scan;
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    if (connection !== "idle") {
      // 离开 idle：允许下一次回到 idle 时立即重试。
      waitingToFlush.current = false;
      clearAttachTimer();
    }
    // 扫描照常跑：已连接时也要先把凭据取回来入队，只是不 attach。
    scanRef.current();
  }, [servers, connection]);

  useEffect(
    () => () => {
      clearAttachTimer();
      clearScanTimer();
    },
    [],
  );
}
