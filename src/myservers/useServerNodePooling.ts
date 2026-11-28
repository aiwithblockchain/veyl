import { useEffect, useRef } from "react";
import type { MyServer, MyServerCredentialNode } from "../agent/bridge";
import type { ActionResult, VpnConnectionState } from "../config/useVpnSession";

interface Args {
  servers: MyServer[];
  connection: VpnConnectionState;
  /** 当前配置里已有的节点 id：已在池里的不再入队，避免无谓 attach 与残留队列。 */
  configuredNodeIds?: ReadonlySet<string>;
  credentials: (serverId: string) => Promise<MyServerCredentialNode>;
  attach: (nodeIds: string[]) => Promise<ActionResult>;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/**
 * attach 报 `node_not_found` 时队列里混进了已删除的节点 id：整批会一直失败。
 * 只保留仍在活跃服务器上、或已进入配置的 id；其余剔除后重试。
 */
export function pruneQueuedNodes(
  queued: Iterable<string>,
  alive: ReadonlySet<string>,
  configured: ReadonlySet<string>,
): string[] {
  return [...queued].filter((id) => alive.has(id) || configured.has(id));
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
  configuredNodeIds = EMPTY_IDS,
  credentials,
  attach,
}: Args): void {
  // 在途 / 待绑 / 已绑都用 ref：入队后重渲染会重跑 effect，用 state 会成环。
  /** 本会话已成功取过凭据的 server_id：旧 Host 不返回 local_node_id 时也不会每 10 秒重复取。 */
  const credentialedThisSession = useRef(new Set<string>());
  /** 本会话取回的 server_id → 本地节点 id：服务器的 local_node_id 还没刷新时也能认出队列里的 id。 */
  const fetchedNodeId = useRef(new Map<string, string>());
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
  const configuredNodeIdsRef = useRef(configuredNodeIds);
  configuredNodeIdsRef.current = configuredNodeIds;
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
      // 到期时可能已经连回去了：保留队列和等待标志，回到 idle 的 effect 会再冲一次。
      if (connectionRef.current !== "idle") return;
      waitingToFlush.current = false;
      flushRef.current();
    }, ATTACH_RETRY_COOLDOWN_MS);
  };

  /** 冷却到期时直接再扫一遍：没有新快照也能重试。 */
  const scheduleScan = () => {
    const now = Date.now();
    let earliest = now + CREDENTIAL_RETRY_COOLDOWN_MS;
    for (const server of serversRef.current) {
      if (!isReady(server.state) || server.local_node_id !== null) continue;
      if (credentialedThisSession.current.has(server.server_id)) continue;
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

  /**
   * 当前仍值得保留的节点 id：ready 服务器的本地节点 id、本会话取回的节点 id，
   * 以及已在配置里的 id。服务器销毁、换机后，旧 id 会自动不在这里。
   * 只用本地 id（`local_node_id` / 凭据返回的 id），不用控制面 `node_id`：
   * 后者可能在本地节点行已删后残留，把死 id 一直算成「存活」。
   */
  const aliveNodeIds = (): Set<string> => {
    const alive = new Set<string>();
    for (const server of serversRef.current) {
      if (isReady(server.state) && server.local_node_id) {
        alive.add(server.local_node_id);
        // 列表给出的本地 id 是权威值：同 server_id 换了节点后，凭据缓存的旧 id 不能继续算存活。
        fetchedNodeId.current.delete(server.server_id);
      }
    }
    for (const server of serversRef.current) {
      if (!isReady(server.state) || server.local_node_id) continue;
      const fetched = fetchedNodeId.current.get(server.server_id);
      if (fetched) alive.add(fetched);
    }
    // 服务器离开 ready / 列表：旧凭据结果不能继续占着队列，也允许它回来时重新取凭据。
    for (const [serverId] of [...fetchedNodeId.current]) {
      const server = serversRef.current.find((item) => item.server_id === serverId);
      if (server && isReady(server.state)) continue;
      fetchedNodeId.current.delete(serverId);
      credentialedThisSession.current.delete(serverId);
    }
    return alive;
  };

  /** 本批 attach 报 `node_not_found`：作废这些节点对应的凭据缓存，下一次扫描重新取。 */
  const invalidateFetched = (nodeIds: string[]) => {
    const sent = new Set(nodeIds);
    let invalidated = false;
    for (const [serverId, nodeId] of [...fetchedNodeId.current]) {
      if (!sent.has(nodeId)) continue;
      fetchedNodeId.current.delete(serverId);
      credentialedThisSession.current.delete(serverId);
      cooldownUntil.current.delete(serverId);
      invalidated = true;
    }
    return invalidated;
  };

  /** 每次 attach 前都先清一遍队列：死 id 不能拖垮整批。 */
  const pruneQueue = () => {
    // 即使队列为空也要跑一次：aliveNodeIds 顺带清掉离开 ready/列表的凭据缓存。
    const alive = aliveNodeIds();
    if (queued.current.size === 0) return;
    const keep = new Set(
      pruneQueuedNodes(queued.current, alive, configuredNodeIdsRef.current),
    );
    for (const nodeId of [...queued.current]) {
      if (configuredNodeIdsRef.current.has(nodeId)) {
        // 已经在配置里：不需要再 attach，也不该占着队列。
        queued.current.delete(nodeId);
        sentThisSession.current.delete(nodeId);
        attached.current.add(nodeId);
        continue;
      }
      if (keep.has(nodeId)) continue;
      queued.current.delete(nodeId);
      sentThisSession.current.delete(nodeId);
    }
  };

  const flush = () => {
    if (connectionRef.current !== "idle") return;
    if (flushing.current || waitingToFlush.current || queued.current.size === 0) return;
    pruneQueue();
    if (queued.current.size === 0) return;
    const nodeIds = [...queued.current];
    flushing.current = true;
    void Promise.resolve(attachRef.current(nodeIds))
      .then((result) => {
        if (!result.ok) {
          if (result.reason === "node_not_found") {
            // 队列里混进了已删除的节点：整批 attach 会一直 NOT_FOUND，
            // 新节点就永远进不了配置。作废这批 id 对应的凭据缓存（同 server_id
            // 换节点后必须能拿到新 id），剔除死 id，只重试仍有效的。
            const invalidated = invalidateFetched(nodeIds);
            pruneQueue();
            waitingToFlush.current = false;
            if (queued.current.size === 0) {
              // 没有可重试的 id 了：按冷却重新取凭据，新 id 才有机会进来。
              if (invalidated) scheduleScan();
              return;
            }
            waitingToFlush.current = true;
            scheduleFlush();
            return;
          }
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
    // 服务器列表可能刚删掉一台：先把死 id 从队列里清掉，再决定要绑什么。
    pruneQueue();
    const now = Date.now();
    for (const server of serversRef.current) {
      if (!isReady(server.state)) continue;
      // 入池判据是「本地是否已有节点行」：控制面 node_id 结算时就有，但不代表本地行已落地；
      // 首次签发时两者同值（nodes.id = nd_…），只有控制面重签发后才可能不同。attach 用本地行的 id。
      const localNodeId = server.local_node_id ?? null;
      if (localNodeId !== null) {
        // 已经在配置里：没有需要绑的；也避免 app 重启后把池里的旧节点再入队。
        if (configuredNodeIdsRef.current.has(localNodeId)) {
          attached.current.add(localNodeId);
          continue;
        }
        // 本地已经有节点行（含重启前绑失败的）：没绑过就入队；重复 attach 幂等。
        if (attached.current.has(localNodeId)) continue;
        if (sentThisSession.current.has(localNodeId)) continue;
        sentThisSession.current.add(localNodeId);
        queued.current.add(localNodeId);
        continue;
      }
      // 列表里的 local_node_id 还没刷新，但本会话已经取回过节点：用取回的 id 补绑，
      // 避免状态抖动把刚拿到的节点永久搁置。
      const fetched = fetchedNodeId.current.get(server.server_id);
      if (fetched) {
        if (configuredNodeIdsRef.current.has(fetched)) {
          attached.current.add(fetched);
          continue;
        }
        if (attached.current.has(fetched)) continue;
        if (sentThisSession.current.has(fetched)) continue;
        sentThisSession.current.add(fetched);
        queued.current.add(fetched);
        continue;
      }
      if (credentialedThisSession.current.has(server.server_id)) continue;
      if (inFlight.current.has(server.server_id)) continue;
      if ((cooldownUntil.current.get(server.server_id) ?? 0) > now) {
        scheduleScan();
        continue;
      }
      inFlight.current.add(server.server_id);
      void Promise.resolve(credentialsRef.current(server.server_id))
        .then((node) => {
          credentialedThisSession.current.add(server.server_id);
          cooldownUntil.current.delete(server.server_id);
          if (node.node_id) {
            fetchedNodeId.current.set(server.server_id, node.node_id);
          }
          if (
            node.node_id &&
            !attached.current.has(node.node_id) &&
            !configuredNodeIdsRef.current.has(node.node_id)
          ) {
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
  /** 上一次 effect 时是否在 idle：只有「刚回到 idle」才重置重试状态，冷却期内不抢跑。 */
  const wasIdle = useRef(connection === "idle");

  useEffect(() => {
    const idle = connection === "idle";
    const enteredIdle = idle && !wasIdle.current;
    wasIdle.current = idle;
    // 离开 idle 刻意不取消 attach 定时器：让它到期时自己看到非 idle、保留等待标志，
    // 这样「连接期间到期」不会发 attach，「回到 idle」的那次 effect 再重置并立即冲刷。
    if (enteredIdle) {
      waitingToFlush.current = false;
      clearAttachTimer();
    }
    // 扫描照常跑：队列里只要有东西，scan 末尾的 flush 就会发出去。
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
