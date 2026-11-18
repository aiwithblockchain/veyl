import type { NodeSummary } from "../agent/protocol";

export function formatLatency(ms: number | null): string {
  return ms === null ? "—" : `${Math.round(ms)} 毫秒`;
}

/**
 * 免费节点原始名带供应商与括号地区（`meshflux69 [美国]`），用户没法据此选择。
 * 界面按「国家 + 同国序号」显示（`美国 01` / `美国 02`），原名只进 title 与日志。
 * 自建节点已经是「新加坡 01」这类名字，保持原样。
 */
export function displayNodeNames(
  nodes: ReadonlyArray<Pick<NodeSummary, "name" | "source">>,
): string[] {
  const counters = new Map<string, number>();
  return nodes.map((node) => {
    if (node.source !== "seed") return node.name;
    const match = /\[([^\]]+)\]/.exec(node.name);
    if (!match) return node.name;
    // 「美国2」与「美国」是同一个国家，序号连续编。
    const country = match[1].replace(/\d+$/, "").trim();
    if (!country) return node.name;
    const next = (counters.get(country) ?? 0) + 1;
    counters.set(country, next);
    return `${country} ${String(next).padStart(2, "0")}`;
  });
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
