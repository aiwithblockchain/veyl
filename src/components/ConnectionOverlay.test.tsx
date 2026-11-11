/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyRuntimeView } from "../agent/bridge";
import type { RuntimeView } from "../agent/protocol";
import { ConnectionOverlay, SLOW_AFTER_MS, connectionStage } from "./ConnectionOverlay";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function runtime(over: Partial<RuntimeView> = {}): RuntimeView {
  return { ...emptyRuntimeView(), ...over };
}

function health(over: Partial<RuntimeView["health"]> = {}): RuntimeView["health"] {
  return { ...emptyRuntimeView().health, ...over };
}

function renderOverlay(
  props: Partial<Parameters<typeof ConnectionOverlay>[0]> = {},
) {
  const base = {
    connection: "starting" as const,
    preparingHelper: false,
    runtime: runtime(),
    connectMode: null,
    ...props,
  };
  const utils = render(<ConnectionOverlay {...base} />);
  return {
    ...utils,
    rerenderOverlay: (next: Partial<Parameters<typeof ConnectionOverlay>[0]>) =>
      utils.rerender(<ConnectionOverlay {...base} {...next} />),
  };
}

describe("connectionStage 阶段映射", () => {
  it("准备后台组件先于授权出现", () => {
    expect(
      connectionStage({
        connection: "starting",
        preparingHelper: true,
        runtime: runtime(),
        connectMode: null,
      }),
    ).toMatchObject({
      kind: "prepare_helper",
      title: "正在准备后台组件",
      caption: "系统会请求一次授权。",
    });
  });

  it("查后台组件优先于残留的健康快照", () => {
    const stage = connectionStage({
      connection: "starting",
      preparingHelper: false,
      checkingHelper: true,
      // 上一次连接留下的出口信息，不能被当成这次已经在确认出口。
      runtime: runtime({
        health: health({ process: true, clash_api: true, data_plane: true, exit_ip: "203.0.113.9" }),
      }),
      connectMode: "tun",
    });
    expect(stage).toMatchObject({
      kind: "prepare",
      title: "正在准备连接",
      caption: "正在检查后台组件。",
    });
  });

  it("连接按健康快照推进：准备 → 建立 → 确认出口", () => {
    const stub = {
      connection: "starting" as const,
      preparingHelper: false,
      connectMode: null,
    };
    expect(
      connectionStage({ ...stub, runtime: runtime({ health: health({ process: false }) }) }),
    ).toMatchObject({ kind: "prepare", title: "正在准备连接" });
    expect(
      connectionStage({
        ...stub,
        runtime: runtime({ health: health({ process: true, clash_api: true }) }),
      }),
    ).toMatchObject({ kind: "connect", title: "正在建立连接" });
    expect(
      connectionStage({
        ...stub,
        runtime: runtime({
          health: health({ process: true, clash_api: true, data_plane: true }),
        }),
      }),
    ).toMatchObject({ kind: "verify", title: "正在确认出口" });
  });

  it("断开按运行时状态分段，TUN 才提示会更久", () => {
    expect(
      connectionStage({
        connection: "stopping",
        preparingHelper: false,
        runtime: runtime({ state: "running" }),
        connectMode: "tun",
      }),
    ).toMatchObject({
      kind: "disconnect",
      title: "正在断开连接",
      caption: "使用「全部流量」时通常会久一些。",
    });
    expect(
      connectionStage({
        connection: "stopping",
        preparingHelper: false,
        runtime: runtime({ state: "stopping" }),
        connectMode: "tun",
      }),
    ).toMatchObject({ kind: "finish", title: "正在收尾" });
  });

  it("失败后重新连接：运行时还没离开 failed 也立刻显示准备阶段", () => {
    expect(
      connectionStage({
        connection: "starting",
        preparingHelper: false,
        runtime: runtime({ state: "failed" }),
        connectMode: null,
      }),
    ).toMatchObject({ kind: "prepare", title: "正在准备连接" });
  });

  it("没有新的连接动作时，失败与回到 idle 都不显示遮罩", () => {
    expect(
      connectionStage({
        connection: "idle",
        preparingHelper: false,
        runtime: runtime({ state: "failed" }),
        connectMode: null,
      }),
    ).toBeNull();
    expect(
      connectionStage({
        connection: "stopping",
        preparingHelper: false,
        runtime: runtime({ state: "idle" }),
        connectMode: null,
      }),
    ).toBeNull();
  });
});

describe("ConnectionOverlay 渲染与释放", () => {
  it("失败后点重连，运行时还停在 failed 也会立即显示遮罩", () => {
    renderOverlay({
      connection: "starting",
      runtime: runtime({ state: "failed" }),
    });

    expect(screen.getByText("正在准备连接")).toBeTruthy();
  });

  it("连接中显示阶段，焦点落在状态卡片上", () => {
    const { container } = renderOverlay({
      runtime: runtime({ health: health({ process: true, clash_api: true }) }),
    });

    expect(screen.getByText("正在建立连接")).toBeTruthy();
    expect(screen.getByText("正在连接节点。")).toBeTruthy();

    const dialog = container.querySelector(".connection-overlay");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(
      container.querySelector(".connection-overlay__card"),
    );
  });

  it("成功：状态转到已连接后释放", () => {
    const { rerenderOverlay } = renderOverlay();
    expect(screen.getByText("正在准备连接")).toBeTruthy();
    expect(screen.getByText("正在启动后台组件。")).toBeTruthy();

    rerenderOverlay({ connection: "connected", runtime: runtime({ state: "running" }) });
    expect(screen.queryByText("正在准备连接")).toBeNull();
  });

  it("失败：连接状态回到 idle 后释放，交给失败卡", () => {
    const { rerenderOverlay } = renderOverlay();
    // 运行时事件是 failed 时，useVpnSession 同步把 connection 收回 idle；
    // 两者一起更新，遮罩才让位给失败卡。
    rerenderOverlay({ connection: "idle", runtime: runtime({ state: "failed" }) });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("超时：状态回到 idle 后释放", () => {
    const { rerenderOverlay } = renderOverlay();
    rerenderOverlay({ connection: "idle", runtime: runtime({ state: "idle" }) });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("外部状态变化：会话被打断回到 idle 时释放", () => {
    const { rerenderOverlay } = renderOverlay();
    // 别处断开：连接状态先回到 idle。
    rerenderOverlay({ connection: "idle", runtime: runtime({ state: "running" }) });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("断开中显示两段，完成后释放", () => {
    const { rerenderOverlay } = renderOverlay({
      connection: "stopping",
      connectMode: "tun",
      runtime: runtime({ state: "running" }),
    });
    expect(screen.getByText("正在断开连接")).toBeTruthy();
    expect(screen.getByText("使用「全部流量」时通常会久一些。")).toBeTruthy();

    rerenderOverlay({
      connection: "stopping",
      runtime: runtime({ state: "stopping" }),
    });
    expect(screen.getByText("正在收尾")).toBeTruthy();
    expect(screen.getByText("正在停止后台组件并做收尾。")).toBeTruthy();

    rerenderOverlay({ connection: "idle", runtime: runtime({ state: "idle" }) });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("超过 10 秒换成等待更久的说明，不释放", () => {
    vi.useFakeTimers();
    renderOverlay();
    expect(screen.getByText("正在准备连接")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(SLOW_AFTER_MS);
    });

    expect(
      screen.getByText("第一次连接需要准备一会儿，可能要半分钟。还在连，请稍候。"),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("断开超时换成「还在断开」", () => {
    vi.useFakeTimers();
    renderOverlay({
      connection: "stopping",
      runtime: runtime({ state: "running" }),
    });

    act(() => {
      vi.advanceTimersByTime(SLOW_AFTER_MS);
    });

    expect(screen.getByText("还在断开，请稍候。")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("准备后台组件时遮罩显示同一句授权说明", () => {
    renderOverlay({ preparingHelper: true });
    expect(screen.getByText("正在准备后台组件")).toBeTruthy();
    expect(screen.getByText("系统会请求一次授权。")).toBeTruthy();
    expect(screen.queryByText("正在准备连接")).toBeNull();
  });

  it("运行时进程起来后，授权阶段让位给建立连接", () => {
    expect(
      connectionStage({
        connection: "starting",
        preparingHelper: true,
        runtime: runtime({ health: health({ process: true, clash_api: true }) }),
        connectMode: null,
      }),
    ).toMatchObject({ kind: "connect", title: "正在建立连接" });
  });
});
