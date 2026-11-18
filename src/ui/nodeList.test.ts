import { describe, expect, it } from "vitest";
import type { NodeSummary } from "../agent/protocol";
import { displayNodeNames, formatLatency, nextProbing } from "./nodeList";

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

describe("延迟文本与探测队列", () => {
  it("延迟统一「N 毫秒」，没有数字用破折号", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(38.4)).toBe("38 毫秒");
  });

  it("探测队列最多 6 个在飞，其余按顺序排队", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const first = nextProbing(new Set(), ids, 6);
    expect([...first.probing]).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(first.queue).toEqual(["g", "h"]);

    // 一个完成腾出名额后才补下一个。
    const active = new Set(first.probing);
    active.delete("a");
    const next = nextProbing(active, first.queue, 6);
    expect(next.probing.has("g")).toBe(true);
    expect(next.probing.size).toBe(6);
    expect(next.queue).toEqual(["h"]);
  });
});

describe("节点显示名", () => {
  it("免费节点按国家 + 序号显示，自建节点保持原名", () => {
    expect(
      displayNodeNames([
        node("a", "meshflux69 [美国]"),
        node("b", "meshflux10 [美国2]"),
        { ...node("c", "新加坡 01"), source: "manual" },
      ]),
    ).toEqual(["美国 01", "美国 02", "新加坡 01"]);
  });

  it("没有括号的免费节点不动；不同国家各自编号", () => {
    expect(displayNodeNames([node("a", "meshflux69")])).toEqual([
      "meshflux69",
    ]);
    expect(
      displayNodeNames([
        node("a", "meshflux69 [美国]"),
        node("b", "meshflux10 [日本]"),
        node("c", "meshflux1 [美国2]"),
      ]),
    ).toEqual(["美国 01", "日本 01", "美国 02"]);
  });
});
