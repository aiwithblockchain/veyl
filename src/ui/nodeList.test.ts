import { describe, expect, it } from "vitest";
import type { NodeProbeData, NodeSummary } from "../agent/protocol";
import {
  ageLabel,
  filterNodes,
  formatLatency,
  hasMixedProbeMethods,
  isFresh,
  probeBadge,
  probeSummary,
  readNodeSort,
  sortNodeRows,
  toggleNodeSort,
  writeNodeSort,
} from "./nodeList";

const NOW = Date.parse("2026-11-06T10:00:00Z");

function node(id: string, name: string, server = `${id}.example.com`): NodeSummary {
  return {
    node_id: id,
    name,
    server,
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "seed",
    created_at: 0,
  };
}

function probe(
  nodeId: string,
  latency: number | null,
  over: Partial<NodeProbeData> = {},
): NodeProbeData {
  return {
    node_id: nodeId,
    reachable: latency !== null,
    latency_ms: latency,
    probe_method: "tcp",
    checked_at: NOW - 60_000,
    error: null,
    ...over,
  };
}

const NODES = [node("a", "东京 01", "203.0.113.1"), node("b", "大阪 02"), node("c", "洛杉矶 01")];

describe("排序偏好", () => {
  it("只认 manual / latency，其它值和不存在的存储回默认", () => {
    const store = (value: string | null) => ({ getItem: () => value });
    expect(readNodeSort(store("latency"))).toBe("latency");
    expect(readNodeSort(store("manual"))).toBe("manual");
    expect(readNodeSort(store("nonsense"))).toBe("manual");
    expect(readNodeSort(null)).toBe("manual");
  });

  it("切换与写回", () => {
    const saved: string[] = [];
    writeNodeSort({ setItem: (_key, value) => void saved.push(value) }, "latency");
    expect(saved).toEqual(["latency"]);
    expect(toggleNodeSort("manual")).toBe("latency");
    expect(toggleNodeSort("latency")).toBe("manual");
  });
});

describe("过滤", () => {
  it("匹配名称与地址，忽略大小写，不修改原数组", () => {
    const filtered = filterNodes(NODES, "203.0.113.1");
    expect(filtered.map((item) => item.node_id)).toEqual(["a"]);
    expect(filterNodes(NODES, "大阪").map((item) => item.node_id)).toEqual(["b"]);
    expect(filterNodes(NODES, "")).toEqual(NODES);
    expect(NODES).toHaveLength(3);
  });
});

describe("延迟徽标五态", () => {
  it("未测 / 测速中 / 可用 / 过期 / 超时 / 连不上", () => {
    expect(probeBadge(undefined, NOW)).toMatchObject({ kind: "untested", label: "未测" });
    expect(probeBadge(undefined, NOW, true)).toMatchObject({
      kind: "probing",
      label: "测速中",
    });
    expect(probeBadge(probe("a", 38), NOW)).toMatchObject({
      kind: "ok",
      label: "38 毫秒",
      tone: "ok",
      time: "1 分钟前",
    });
    expect(probeBadge(probe("a", 38, { checked_at: NOW - 12 * 60_000 }), NOW)).toMatchObject({
      kind: "stale",
      label: "38 毫秒 · 12 分钟前",
      tone: "muted",
    });
    expect(
      probeBadge(
        probe("a", null, { error: { code: "PROBE_TIMEOUT", message: "超时" } }),
        NOW,
      ),
    ).toMatchObject({ kind: "timeout", label: "超时", tone: "warn" });
    expect(
      probeBadge(
        probe("a", null, { error: { code: "CONNECT_FAILED", message: "拒绝" } }),
        NOW,
      ),
    ).toMatchObject({ kind: "unreachable", label: "连不上", tone: "err" });
    // 未知失败原因：不猜，按超时处理。
    expect(probeBadge(probe("a", null, { error: null }), NOW)).toMatchObject({
      kind: "timeout",
      label: "超时",
    });
    // 后端只给 reachable 不给延迟：仍算可用，不伪造数字。
    expect(probeBadge(probe("a", null, { reachable: true }), NOW)).toMatchObject({
      kind: "ok",
      label: "可达",
    });
  });

  it("准备阶段整表显示准备中，不用旧缓存冒充本批数字", () => {
    expect(probeBadge(probe("a", 38), NOW, false, true)).toMatchObject({
      kind: "preparing",
      label: "准备中",
      previous: null,
      time: null,
    });
  });

  it("有缓存但仍在跑：旧值降级成「上次」，时间列显示测速中", () => {
    const badge = probeBadge(probe("a", 38), NOW, true);
    expect(badge).toMatchObject({
      kind: "probing",
      label: "测速中",
      previous: "上次 38 毫秒",
      time: "测速中",
    });
  });
});

describe("新鲜度", () => {
  it("10 分钟内算新鲜", () => {
    expect(isFresh(NOW - 10 * 60_000, NOW)).toBe(true);
    expect(isFresh(NOW - 10 * 60_000 - 1, NOW)).toBe(false);
    expect(isFresh(0, NOW)).toBe(false);
  });

  it("相对时间兜底", () => {
    expect(ageLabel(0, NOW)).toBe("");
    expect(ageLabel(NOW - 20_000, NOW)).toBe("刚刚");
    expect(ageLabel(NOW - 3 * 60_000, NOW)).toBe("3 分钟前");
    expect(ageLabel(NOW - 90 * 60_000, NOW)).toBe("1 小时前");
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(38.4)).toBe("38 毫秒");
  });
});

describe("延迟排序", () => {
  it("新鲜可用 → 过期可用 → 未测 → 超时；当前节点不置顶", () => {
    const rows = sortNodeRows(
      NODES,
      {
        a: probe("a", 90, { checked_at: NOW - 12 * 60_000 }),
        b: probe("b", 30),
        c: probe("c", null, { error: { code: "PROBE_TIMEOUT", message: "" } }),
      },
      "latency",
      NOW,
    );
    expect(rows.map((item) => item.node_id)).toEqual(["b", "a", "c"]);
  });

  it("手动模式永远保持配置顺序，且不修改原数组", () => {
    const rows = sortNodeRows(NODES, { c: probe("c", 10) }, "manual", NOW);
    expect(rows.map((item) => item.node_id)).toEqual(["a", "b", "c"]);
    expect(NODES.map((item) => item.node_id)).toEqual(["a", "b", "c"]);
  });

  it("同档按延迟，再按原顺序；排序不改变当前节点属于哪一行", () => {
    const rows = sortNodeRows(
      NODES,
      { a: probe("a", 50), b: probe("b", 20), c: probe("c", 50) },
      "latency",
      NOW,
    );
    expect(rows.map((item) => item.node_id)).toEqual(["b", "a", "c"]);
    expect(rows.some((item) => item.node_id === "a")).toBe(true);
  });
});

describe("汇总", () => {
  it("总数、可用数与最近测速时间；按每行自己的方式计数", () => {
    expect(probeSummary(NODES, {}, NOW)).toBe("共 3 个");
    const tcp = {
      a: probe("a", 38),
      b: probe("b", 120, { checked_at: NOW - 3 * 60_000 }),
      c: probe("c", null, { error: { code: "PROBE_TIMEOUT", message: "" } }),
    };
    expect(probeSummary(NODES, tcp, NOW)).toBe(
      "共 3 个 · 2 个可达 · 1 分钟前测过",
    );
    const clash = {
      a: probe("a", 38, { probe_method: "clash_delay" }),
      b: probe("b", 120, { probe_method: "clash_delay", checked_at: NOW - 3 * 60_000 }),
      c: probe("c", null, { probe_method: "clash_delay", error: { code: "PROBE_TIMEOUT", message: "" } }),
    };
    expect(probeSummary(NODES, clash, NOW)).toBe(
      "共 3 个 · 2 个可用 · 1 分钟前测过",
    );
  });

  it("缓存跨批次混合时分别计数，不把旧 tcp 结果算成可用", () => {
    const results = {
      a: probe("a", 38, { probe_method: "clash_delay" }),
      b: probe("b", 60, { probe_method: "tcp" }),
      c: probe("c", null, { error: { code: "PROBE_TIMEOUT", message: "" } }),
    };
    expect(probeSummary(NODES, results, NOW, "clash")).toBe(
      "共 3 个 · 1 个可用 · 1 个可达 · 1 分钟前测过",
    );
    expect(hasMixedProbeMethods(NODES, results)).toBe(true);
    expect(
      hasMixedProbeMethods(NODES, {
        a: probe("a", 38, { probe_method: "clash_delay" }),
        b: probe("b", 60, { probe_method: "clash_delay" }),
      }),
    ).toBe(false);
  });

  it("全部失败时写「都没测通」", () => {
    expect(
      probeSummary(
        NODES,
        {
          a: probe("a", null, { error: { code: "PROBE_TIMEOUT", message: "" } }),
          b: probe("b", null, { error: { code: "PROBE_TIMEOUT", message: "" } }),
          c: probe("c", null, { error: { code: "PROBE_TIMEOUT", message: "" } }),
        },
        NOW,
      ),
    ).toBe("共 3 个 · 都没测通");
  });
});
