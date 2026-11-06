/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigDetail, NodeProbeData, NodeSummary } from "../agent/protocol";
import type { NodeProbesController } from "../config/useNodeProbes";
import { NodeSheet } from "./NodeSheet";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function activeRun(over: Partial<{ done: number; total: number; runId: string; ignored: number }> = {}) {
  return {
    runId: over.runId ?? "run-1",
    configId: "cfg-1",
    done: over.done ?? 2,
    total: over.total ?? 3,
    startedAt: 0,
    phase: "probing" as const,
    method: "tcp" as const,
    ignored: over.ignored ?? 0,
  };
}

function node(id: string, name: string): NodeSummary {
  return {
    node_id: id,
    name,
    server: `${id}.example.com`,
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "seed",
    created_at: 0,
  };
}

function makeConfig(count = 3, current = "n1"): ConfigDetail {
  const nodes = Array.from({ length: count }, (_, index) =>
    node(`n${index + 1}`, index === 1 ? "大阪 02" : `东京 ${String(index + 1).padStart(2, "0")}`),
  );
  return {
    config_id: "cfg-1",
    name: "公司",
    connect_mode: "system_proxy",
    routing_mode: "direct",
    node_count: nodes.length,
    listen_port: 2080,
    is_active: true,
    current_node_id: current,
    created_at: 0,
    updated_at: 0,
    last_used_at: null,
    nodes,
    dns: { mode: "auto", local: [], remote: [] },
    tun_excludes: [],
    layout: null,
  } as ConfigDetail;
}

function probe(nodeId: string, latency: number | null, over: Partial<NodeProbeData> = {}): NodeProbeData {
  return {
    node_id: nodeId,
    reachable: latency !== null,
    latency_ms: latency,
    probe_method: "tcp",
    checked_at: Date.now() - 60_000,
    error: null,
    ...over,
  };
}

function controller(over: Partial<NodeProbesController> = {}): NodeProbesController {
  return {
    results: {},
    run: null,
    probing: new Set<string>(),
    finished: null,
    notice: null,
    available: true,
    loadSnapshot: vi.fn(async () => {}),
    start: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => {}),
    clearNotice: vi.fn(),
    ...over,
  };
}

const noop = () => {};

async function settleSwitch() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

describe("节点面板", () => {
  it("搜索与排序只改变视图，不发起切换", () => {
    const onSwitch = vi.fn(async () => ({ ok: true }));
    const probes = controller({
      results: { n1: probe("n1", 38), n2: probe("n2", 12) },
    });
    render(
      <NodeSheet
        open
        config={makeConfig(10)}
        probes={probes}
        onClose={noop}
        onSwitch={onSwitch}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "排序：手动" }));
    fireEvent.change(screen.getByLabelText("搜索节点"), { target: { value: "大阪" } });

    expect(onSwitch).not.toHaveBeenCalled();
    expect(screen.getByText("大阪 02")).toBeTruthy();
    expect(screen.queryByText("东京 03")).toBeNull();
    expect(document.querySelector(".node-row.is-current")).toBeNull();

    fireEvent.change(screen.getByLabelText("搜索节点"), { target: { value: "" } });
    // 当前节点没有因为过滤 / 排序被切换，清空搜索后仍在原行。
    expect(document.querySelector(".node-row.is-current")?.textContent).toContain("东京 01");
    expect(screen.getAllByText("当前")).toHaveLength(1);
  });

  it("点一行立即切换，面板不关，当前标记随后移动", async () => {
    vi.useFakeTimers();
    const onSwitch = vi.fn(async () => ({ ok: true }));
    const config = makeConfig();
    const probes = controller();
    const { rerender } = render(
      <NodeSheet open config={config} probes={probes} onClose={noop} onSwitch={onSwitch} />,
    );

    const row = Array.from(document.querySelectorAll<HTMLElement>(".node-row")).find((el) =>
      el.textContent?.includes("大阪 02"),
    );
    fireEvent.click(row!);
    expect(onSwitch).toHaveBeenCalledWith("n2");
    expect(document.querySelector("#node-sheet")).not.toBeNull();
    expect(screen.getByText("切换中…")).toBeTruthy();

    await settleSwitch();
    expect(document.querySelector("#node-sheet")).not.toBeNull();

    rerender(
      <NodeSheet
        open
        config={{ ...config, current_node_id: "n2" }}
        probes={probes}
        onClose={noop}
        onSwitch={onSwitch}
      />,
    );
    const current = document.querySelector(".node-row.is-current");
    expect(current?.textContent).toContain("大阪 02");
    expect(screen.getAllByText("当前")).toHaveLength(1);
  });

  it("切换失败时当前节点不变，行内给一句原因", async () => {
    vi.useFakeTimers();
    const onSwitch = vi.fn(async () => ({ ok: false, message: "切换节点失败" }));
    render(
      <NodeSheet
        open
        config={makeConfig()}
        probes={controller()}
        onClose={noop}
        onSwitch={onSwitch}
      />,
    );

    const row = Array.from(document.querySelectorAll<HTMLElement>(".node-row")).find((el) =>
      el.textContent?.includes("大阪 02"),
    );
    fireEvent.click(row!);
    await settleSwitch();

    expect(screen.getByText("没切成，还在原来的节点", { selector: ".node-row__error" })).toBeTruthy();
    expect(document.querySelector(".node-row.is-current")?.textContent).toContain("东京 01");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("批次中重开面板：恢复进度与停止按钮，有缓存的行不显示成已完成", () => {
    const probes = controller({
      results: { n2: probe("n2", 38) },
      run: { runId: "run-1", configId: "cfg-1", done: 12, total: 23, startedAt: 0, phase: "probing", method: "tcp", ignored: 0 },
      probing: new Set(["n2"]),
    });
    render(
      <NodeSheet
        open
        config={makeConfig()}
        probes={probes}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );

    expect(screen.getByText("正在测速 12/23")).toBeTruthy();
    expect(screen.getByRole("button", { name: "停止测速" })).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("12");

    const row = document.querySelector('[data-node-id="n2"]');
    expect(row?.textContent).toContain("测速中");
    expect(row?.textContent).toContain("上次 38 毫秒");
    expect(row?.querySelector(".node-badge")?.textContent).toBe("测速中");
  });

  it("准备阶段显示「正在准备测速…」，不显示 0/N 或已测完", () => {
    render(
      <NodeSheet
        open
        config={makeConfig()}
        probes={controller({
          results: { n2: probe("n2", 38) },
          run: {
            runId: "run-1",
            configId: "cfg-1",
            done: 0,
            total: 3,
            startedAt: 0,
            phase: "preparing",
            method: "tcp",
            ignored: 0,
          },
        })}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );

    expect(screen.getByText("正在准备测速…")).toBeTruthy();
    expect(screen.queryByText(/0\/3/)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("button", { name: "停止测速" })).toBeTruthy();
    // 准备阶段旧缓存不能冒充本批数字：整表显示准备态。
    expect(screen.getAllByText("准备中")).toHaveLength(3);
    expect(screen.queryByText("38 毫秒")).toBeNull();
  });

  it("停止测速调用取消，不切换节点", async () => {
    const cancel = vi.fn(async () => {});
    const onSwitch = vi.fn(async () => ({ ok: true }));
    render(
      <NodeSheet
        open
        config={makeConfig()}
        probes={controller({
          run: { runId: "run-1", configId: "cfg-1", done: 2, total: 3, startedAt: 0, phase: "probing", method: "tcp", ignored: 0 },
          cancel,
        })}
        onClose={noop}
        onSwitch={onSwitch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "停止测速" }));
    await act(async () => {});
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("未知结果与异常进度不会把界面画坏", () => {
    render(
      <NodeSheet
        open
        config={makeConfig()}
        probes={controller({
          results: {
            // 没有 error 的失败结果：按超时兜底，不猜原因。
            n1: probe("n1", null, { error: null, probe_method: "weird" as never }),
          },
          run: { runId: "run-1", configId: "cfg-1", done: 99, total: 3, startedAt: 0, phase: "probing", method: "tcp", ignored: 0 },
        })}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    const current = document.querySelector(".node-row.is-current");
    expect(current?.textContent).toContain("超时");
    expect(screen.getByText("正在测速 3/3")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
  });

  it("运行中把搜索过滤到 0 条，停止入口仍在", () => {
    render(
      <NodeSheet
        open
        config={makeConfig(10)}
        probes={controller({ run: activeRun({ done: 4, total: 10 }) })}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    fireEvent.change(screen.getByLabelText("搜索节点"), {
      target: { value: "没有这个节点" },
    });
    expect(screen.getByText("没有匹配的节点")).toBeTruthy();
    expect(screen.getByRole("button", { name: "停止测速" })).toBeTruthy();
  });

  it("有搜索时按钮恢复「测这 N 个」并只传过滤后的 id", async () => {
    const start = vi.fn(async () => ({ ok: true }));
    const config = makeConfig(10);
    render(
      <NodeSheet
        open
        config={config}
        probes={controller({ results: { n2: probe("n2", 38) }, start })}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    fireEvent.change(screen.getByLabelText("搜索节点"), {
      target: { value: "大阪" },
    });
    expect(screen.getByRole("button", { name: "测这 1 个" })).toBeTruthy();
    expect(
      screen.getByText(/^共 1 个 · 1 个可达/, {
        selector: ".node-sheet__summary-text",
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "测这 1 个" }));
    await act(async () => {});
    expect(start).toHaveBeenCalledWith("cfg-1", ["n2"]);
  });

  it("无搜索时保持「全部测速」且不传 nodeIds", async () => {
    const start = vi.fn(async () => ({ ok: true }));
    render(
      <NodeSheet
        open
        config={makeConfig(10)}
        probes={controller({ start })}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(screen.getByRole("button", { name: "全部测速" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部测速" }));
    await act(async () => {});
    expect(start).toHaveBeenCalledWith("cfg-1", undefined);
  });

  it("过滤为空时不显示批量按钮", () => {
    render(
      <NodeSheet
        open
        config={makeConfig(10)}
        probes={controller()}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    fireEvent.change(screen.getByLabelText("搜索节点"), {
      target: { value: "没有这个节点" },
    });
    expect(screen.queryByRole("button", { name: /测这|全部测速/ })).toBeNull();
  });

  it("探测方式混合时行内写明可用/可达，方式一致时只说一次", () => {
    const { rerender } = render(
      <NodeSheet
        open
        config={makeConfig()}
        probes={controller({
          results: {
            n1: probe("n1", 38, { probe_method: "clash_delay" }),
            n2: probe("n2", 60),
          },
        })}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(
      document.querySelector('[data-node-id="n1"] .node-badge')?.textContent,
    ).toBe("可用 38 毫秒");
    expect(
      document.querySelector('[data-node-id="n2"] .node-badge')?.textContent,
    ).toBe("可达 60 毫秒");
    expect(
      screen.getByText(/^共 3 个 · 1 个可用 · 1 个可达/, {
        selector: ".node-sheet__summary-text",
      }),
    ).toBeTruthy();

    rerender(
      <NodeSheet
        open
        config={makeConfig()}
        probes={controller({
          results: {
            n1: probe("n1", 38, { probe_method: "clash_delay" }),
            n2: probe("n2", 60, { probe_method: "clash_delay" }),
          },
        })}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(
      document.querySelector('[data-node-id="n1"] .node-badge')?.textContent,
    ).toBe("38 毫秒");
    expect(
      screen.getByText(/^共 3 个 · 2 个可用/, {
        selector: ".node-sheet__summary-text",
      }),
    ).toBeTruthy();
  });

  it("切换中重复点击与关闭后重开都不会发出第二次切换", async () => {
    vi.useFakeTimers();
    const gate = deferred<{ ok: boolean }>();
    const onSwitch = vi.fn(() => gate.promise);
    const config = makeConfig();
    const probes = controller();
    const { rerender } = render(
      <NodeSheet open config={config} probes={probes} onClose={noop} onSwitch={onSwitch} />,
    );

    const row = (name: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(".node-row")).find((el) =>
        el.textContent?.includes(name),
      )!;
    fireEvent.click(row("大阪 02"));
    fireEvent.click(row("东京 03"));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledWith("n2");

    rerender(
      <NodeSheet open={false} config={config} probes={probes} onClose={noop} onSwitch={onSwitch} />,
    );
    rerender(
      <NodeSheet open config={config} probes={probes} onClose={noop} onSwitch={onSwitch} />,
    );
    fireEvent.click(row("东京 03"));
    expect(onSwitch).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(400);
    });
  });

  it("输入法组合中不响应 Esc、↓ 与 Enter", () => {
    const onClose = vi.fn();
    const onSwitch = vi.fn(async () => ({ ok: true }));
    render(
      <NodeSheet
        open
        config={makeConfig(10)}
        probes={controller()}
        onClose={onClose}
        onSwitch={onSwitch}
      />,
    );
    const search = screen.getByLabelText("搜索节点");
    const list = document.querySelector(".node-sheet__list") as HTMLElement;

    fireEvent.keyDown(document, { key: "Escape", keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();

    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown", keyCode: 229 });
    expect(document.activeElement).toBe(search);

    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter", keyCode: 229 });
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("FLIP 动画期间滚动/搜索不会把交互永久锁死", async () => {
    vi.useFakeTimers();
    localStorage.setItem("veyl.nodeSort", "latency");
    const onSwitch = vi.fn(async () => ({ ok: true }));
    const config = makeConfig(10);
    const probes = controller({ run: activeRun({ done: 3, total: 10 }) });
    const { rerender } = render(
      <NodeSheet open config={config} probes={probes} onClose={noop} onSwitch={onSwitch} />,
    );

    // 批次结束 → 延迟模式排一次队；指针不在列表上，立即开始动画。
    rerender(
      <NodeSheet
        open
        config={config}
        probes={controller()}
        onClose={noop}
        onSwitch={onSwitch}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const list = document.querySelector(".node-sheet__list") as HTMLElement;
    expect(list.getAttribute("aria-busy")).toBe("true");

    // 动画未结束时滚动与搜索会重跑 layout effect；busy 仍必须能解除。
    fireEvent.scroll(list, { target: { scrollTop: 40 } });
    fireEvent.change(screen.getByLabelText("搜索节点"), {
      target: { value: "东京" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(220);
    });
    expect(list.getAttribute("aria-busy")).toBe("false");

    fireEvent.change(screen.getByLabelText("搜索节点"), {
      target: { value: "" },
    });
    const target = Array.from(document.querySelectorAll<HTMLElement>(".node-row")).find((el) =>
      el.textContent?.includes("大阪 02"),
    );
    if (target) fireEvent.click(target);
    expect(onSwitch).toHaveBeenCalled();
  });

  it("指针停在列表上时推迟重排，离开后才动画", async () => {
    vi.useFakeTimers();
    localStorage.setItem("veyl.nodeSort", "latency");
    const config = makeConfig();
    const row = { run: activeRun() };
    const { rerender } = render(
      <NodeSheet
        open
        config={config}
        probes={controller(row)}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    const list = document.querySelector(".node-sheet__list") as HTMLElement;
    fireEvent.pointerMove(list);

    rerender(
      <NodeSheet
        open
        config={config}
        probes={controller()}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(list.getAttribute("aria-busy")).toBe("false");

    fireEvent.pointerOut(list);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(list.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(220);
    });
    expect(list.getAttribute("aria-busy")).toBe("false");
  });

  it("子集里已不存在的节点只是跳过，不报错", () => {
    render(
      <NodeSheet
        open
        config={makeConfig()}
        probes={controller({ run: activeRun({ ignored: 2 }) })}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(screen.getByText("已跳过 2 个已不存在的节点")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "停止测速" })).toBeTruthy();
  });

  it("别的配置的「已停止」不会串到当前面板", () => {
    render(
      <NodeSheet
        open
        config={makeConfig()}
        probes={controller({
          notice: { configId: "cfg-2", text: "已停止 · 已测 1/2" },
        })}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(screen.queryByText(/已停止/)).toBeNull();
  });

  it("批量能力不可用时隐藏测速入口", () => {
    render(
      <NodeSheet
        open
        config={makeConfig(10)}
        probes={controller({ available: false })}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(screen.queryByRole("button", { name: "全部测速" })).toBeNull();
  });

  it("超过 60 行只渲染可视区，滚到底能看到最后一行", () => {
    const nodes = Array.from({ length: 100 }, (_, index) =>
      node(`n${index + 1}`, `节点 ${String(index + 1).padStart(3, "0")}`),
    );
    render(
      <NodeSheet
        open
        config={{ ...makeConfig(1), nodes, node_count: nodes.length }}
        probes={controller()}
        onClose={noop}
        onSwitch={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(document.querySelectorAll(".node-row").length).toBeLessThan(100);
    expect(document.querySelectorAll(".node-row").length).toBeGreaterThan(0);

    const list = document.querySelector(".node-sheet__list") as HTMLElement;
    fireEvent.scroll(list, { target: { scrollTop: 94 * 44 } });
    expect(
      Array.from(document.querySelectorAll(".node-row")).some((row) =>
        row.textContent?.includes("节点 100"),
      ),
    ).toBe(true);
  });
});
