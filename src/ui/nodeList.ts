import type { NodeProbeResult } from "../agent/bridge";
import type { NodeSummary } from "../agent/protocol";

/** 延迟结果的新鲜度：`checked_at` 起 10 分钟内算新鲜（node-list.md §7.3）。 */
export const PROBE_FRESH_MS = 10 * 60 * 1000;

export const NODE_SORT_KEY = "veyl.nodeSort";

export type NodeSort = "manual" | "latency";

export type ProbeTone = "muted" | "ok" | "warn" | "err";

export type ProbeKind =
  | "untested"
  | "preparing"
  | "probing"
  | "ok"
  | "stale"
  | "timeout"
  | "unreachable";

export interface ProbeBadge {
  kind: ProbeKind;
  label: string;
  tone: ProbeTone;
  /** 「有缓存但仍在跑」时徽标左侧的旧值；没有旧结果时为 null。 */
  previous: string | null;
  /** 行尾时间列；未测 / 测速中时按规格给文字或留空。 */
  time: string | null;
}

/** 排序模式是视图偏好，读不到就回默认的「手动」。 */
export function readNodeSort(storage: Pick<Storage, "getItem"> | null): NodeSort {
  try {
    return storage?.getItem(NODE_SORT_KEY) === "latency" ? "latency" : "manual";
  } catch {
    return "manual";
  }
}

export function writeNodeSort(
  storage: Pick<Storage, "setItem"> | null,
  sort: NodeSort,
): void {
  try {
    storage?.setItem(NODE_SORT_KEY, sort);
  } catch {
    // 存不了就只在本次会话里记住。
  }
}

export function toggleNodeSort(sort: NodeSort): NodeSort {
  return sort === "latency" ? "manual" : "latency";
}

export function formatLatency(ms: number | null): string {
  return ms === null ? "—" : `${Math.round(ms)} 毫秒`;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前。无效时间返回空串。 */
export function ageLabel(checkedAt: number, now: number): string {
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return "";
  const diff = Math.max(0, now - checkedAt);
  if (diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function isFresh(checkedAt: number, now: number): boolean {
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return false;
  return Math.max(0, now - checkedAt) <= PROBE_FRESH_MS;
}

/** 单条结果来自真实探测还是仅端口可达；缓存跨批次混合时按各自的值算。 */
export function probeMethodOf(entry: NodeProbeResult | undefined): "clash" | "tcp" {
  return entry?.probe_method === "clash_delay" ? "clash" : "tcp";
}

/** 同一可见集合里同时存在两种探测方式时，行内才需要写明「可用 / 可达」。 */
export function hasMixedProbeMethods(
  nodes: NodeSummary[],
  results: Record<string, NodeProbeResult | undefined>,
): boolean {
  let clash = false;
  let tcp = false;
  for (const node of nodes) {
    const entry = results[node.node_id];
    if (!entry?.reachable) continue;
    if (probeMethodOf(entry) === "clash") clash = true;
    else tcp = true;
    if (clash && tcp) return true;
  }
  return false;
}

/**
 * 行尾延迟徽标的五态。
 * probing = 该行正在被这一批重测；有旧结果时降级成 `上次 38 毫秒`，
 * 避免「有缓存但仍在跑」看起来像「已测完」。
 */
export function probeBadge(
  entry: NodeProbeResult | undefined,
  now: number,
  probing = false,
  preparing = false,
): ProbeBadge {
  if (preparing) {
    // 临时运行时还在起：旧缓存不能冒充这一批的数字，整表统一显示准备态。
    return {
      kind: "preparing",
      label: "准备中",
      tone: "muted",
      previous: null,
      time: null,
    };
  }
  if (probing) {
    const previous =
      entry && entry.reachable && entry.latency_ms !== null
        ? `上次 ${formatLatency(entry.latency_ms)}`
        : null;
    return { kind: "probing", label: "测速中", tone: "muted", previous, time: "测速中" };
  }
  if (!entry) {
    return { kind: "untested", label: "未测", tone: "muted", previous: null, time: null };
  }
  if (!entry.reachable) {
    // 失败原因不可区分时统一按超时，不猜「连不上」。
    const code = entry.error?.code ?? "";
    const kind: ProbeKind = !code || /timeout/i.test(code) ? "timeout" : "unreachable";
    return {
      kind,
      label: kind === "timeout" ? "超时" : "连不上",
      tone: kind === "timeout" ? "warn" : "err",
      previous: null,
      time: null,
    };
  }
  if (entry.latency_ms === null) {
    return {
      kind: "ok",
      label: "可达",
      tone: "ok",
      previous: null,
      time: ageLabel(entry.checked_at, now) || null,
    };
  }
  const age = ageLabel(entry.checked_at, now);
  const fresh = isFresh(entry.checked_at, now);
  return {
    kind: fresh ? "ok" : "stale",
    label: fresh || !age
      ? formatLatency(entry.latency_ms)
      : `${formatLatency(entry.latency_ms)} · ${age}`,
    tone: fresh ? "ok" : "muted",
    previous: null,
    time: age || null,
  };
}

/** 名称与地址匹配，忽略大小写；空查询返回原数组。 */
export function filterNodes(nodes: NodeSummary[], query: string): NodeSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.filter(
    (node) =>
      node.name.toLowerCase().includes(needle) ||
      node.server.toLowerCase().includes(needle),
  );
}

function latencyOf(entry: NodeProbeResult | undefined): number {
  return entry && entry.reachable && entry.latency_ms !== null
    ? entry.latency_ms
    : Number.POSITIVE_INFINITY;
}

/**
 * 延迟模式：新鲜可用 → 过期可用 → 未测 → 超时/连不上；同档按延迟、再按原顺序。
 * 手动模式永远保持配置内顺序，测速结果不改顺序。
 */
export function sortNodeRows(
  nodes: NodeSummary[],
  results: Record<string, NodeProbeResult | undefined>,
  sort: NodeSort,
  now: number,
): NodeSummary[] {
  if (sort === "manual") return nodes;
  const bucket = (node: NodeSummary): number => {
    const entry = results[node.node_id];
    if (!entry) return 2;
    if (!entry.reachable) return 3;
    return isFresh(entry.checked_at, now) ? 0 : 1;
  };
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const bucketDiff = bucket(a.node) - bucket(b.node);
      if (bucketDiff !== 0) return bucketDiff;
      const latencyDiff =
        latencyOf(results[a.node.node_id]) - latencyOf(results[b.node.node_id]);
      if (Number.isFinite(latencyDiff) && latencyDiff !== 0) return latencyDiff;
      return a.index - b.index;
    })
    .map((item) => item.node);
}

export function lastCheckedAt(
  nodes: NodeSummary[],
  results: Record<string, NodeProbeResult | undefined>,
): number {
  let latest = 0;
  for (const node of nodes) {
    const checkedAt = results[node.node_id]?.checked_at ?? 0;
    if (Number.isFinite(checkedAt) && checkedAt > latest) latest = checkedAt;
  }
  return latest;
}

/**
 * 汇总行：共 23 个 · 18 个可用 · 3 分钟前测过。
 * 可用 / 可达按每一行自己的探测方式分别计数；缓存跨批次混合时也不会算错。
 */
export function probeSummary(
  nodes: NodeSummary[],
  results: Record<string, NodeProbeResult | undefined>,
  now: number,
  fallbackMethod?: "tcp" | "clash",
): string {
  const total = nodes.length;
  const probed = nodes.filter((node) => results[node.node_id]);
  const reachable = probed.filter((node) => results[node.node_id]?.reachable);
  const clash = reachable.filter(
    (node) => probeMethodOf(results[node.node_id]) === "clash",
  ).length;
  const tcp = reachable.length - clash;
  const parts = [`共 ${total} 个`];
  if (probed.length > 0) {
    if (reachable.length === 0 && probed.length === total) {
      parts.push("都没测通");
      return parts.join(" · ");
    }
    if (clash > 0) parts.push(`${clash} 个可用`);
    if (tcp > 0) parts.push(`${tcp} 个可达`);
    if (clash === 0 && tcp === 0) {
      // 只测了一部分且都失败：仍要说清是 0 个可用还是 0 个可达。
      const fallback =
        fallbackMethod ??
        (probed.length > 0 ? probeMethodOf(results[probed[0].node_id]) : "clash");
      parts.push(`0 个${fallback === "tcp" ? "可达" : "可用"}`);
    }
    const checkedAt = lastCheckedAt(nodes, results);
    const age = ageLabel(checkedAt, now);
    if (age) parts.push(`${age}测过`);
  }
  return parts.join(" · ");
}

/** 批次在飞时正在被探测的节点：最多 6 个，按队列补充。 */
export function nextProbing(
  probing: ReadonlySet<string>,
  queue: string[],
  concurrency = 6,
): { probing: Set<string>; queue: string[] } {
  const next = new Set(probing);
  const rest = [...queue];
  while (next.size < concurrency && rest.length > 0) {
    next.add(rest.shift() as string);
  }
  return { probing: next, queue: rest };
}
