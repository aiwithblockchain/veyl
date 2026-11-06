/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_EVENTS } from "./protocol";
import type { AgentEvent } from "./protocol";
import { MockAgentBridge } from "./mockAgent";

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

function harness() {
  const bridge = new MockAgentBridge();
  const events: AgentEvent[] = [];
  bridge.subscribe((event) => events.push(event));
  bridge.registerProbeNodes("cfg-1", ["n1", "n2", "n3"]);
  return { bridge, events };
}

describe("mock 批量测速子集", () => {
  it("只测传入的子集，未知 id 放进 ignored", async () => {
    vi.useFakeTimers();
    const { bridge, events } = harness();
    const run = await bridge.nodeProbeAll("cfg-1", ["n1", "ghost"]);
    expect(run).toMatchObject({ total: 1, ignoredNodeIds: ["ghost"] });

    await vi.advanceTimersByTimeAsync(2000);
    const progress = events.filter((event) => event.name === AGENT_EVENTS.nodeProbeProgress);
    const results = progress
      .map((event) => (event.payload as { result: { node_id: string } | null }).result)
      .filter((item): item is { node_id: string } => item !== null);
    expect(results.map((item) => item.node_id)).toEqual(["n1"]);

    const finished = events.find((event) => event.name === AGENT_EVENTS.nodeProbeFinished);
    expect(finished?.payload).toMatchObject({ total: 1, cancelled: false });
  });

  it("空子集与全部节点都为空时都算 no_nodes", async () => {
    vi.useFakeTimers();
    const { bridge } = harness();
    await expect(bridge.nodeProbeAll("cfg-1", [])).rejects.toMatchObject({
      details: { reason: "no_nodes" },
    });
    await expect(bridge.nodeProbeAll("cfg-2")).rejects.toMatchObject({
      details: { reason: "no_nodes" },
    });
  });

  it("不传 nodeIds 时测全部登记节点", async () => {
    vi.useFakeTimers();
    const { bridge } = harness();
    const run = await bridge.nodeProbeAll("cfg-1");
    expect(run).toMatchObject({ total: 3, ignoredNodeIds: [] });
  });
});
