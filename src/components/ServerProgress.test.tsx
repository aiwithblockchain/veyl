/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServer } from "../agent/bridge";
import { ServerProgress } from "./ServerProgress";

function server(over: Partial<MyServer> = {}): MyServer {
  return {
    server_id: "srv_1",
    name: "新加坡 1 · DigitalOcean",
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    state: "installing",
    created_at: new Date(0).toISOString(),
    ip: "45.76.20.100",
    port: 8388,
    node_id: null,
    local_node_id: null,
    hourly_usd: 0.00893,
    monthly_usd: 6,
    daily_price_cents: 20,
    paid_until: null,
    billing_state: "pending",
    grace_ends_at: null,
    transfer_gib: 1000,
    failure: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function currentSegment(container: HTMLElement): number {
  const segments = [
    ...container.querySelectorAll(".myservers__bar span"),
  ];
  return segments.findIndex((segment) =>
    segment.classList.contains("is-current"),
  );
}

describe("四段进度条", () => {
  it("不再渲染四段阶段词列表，进度条仍是 4 段", () => {
    const { container } = render(
      <ServerProgress server={server({ state: "installing" })} />,
    );

    expect(container.querySelector(".myservers__steps")).toBeNull();
    expect(container.querySelectorAll(".myservers__bar span")).toHaveLength(4);
  });

  it("installing 时四段与阶段一一对应：前两段已完成，第三段当前，第四段未到", () => {
    const { container } = render(
      <ServerProgress server={server({ state: "installing" })} />,
    );

    const segments = [
      ...container.querySelectorAll(".myservers__bar span"),
    ];
    expect(segments).toHaveLength(4);
    expect(segments[0].classList.contains("is-done")).toBe(true);
    expect(segments[1].classList.contains("is-done")).toBe(true);
    expect(segments[2].classList.contains("is-current")).toBe(true);
    expect(segments[3].className).toBe("");
  });

  it("creating 时只有第一段是当前段，其余三段都没有已完成", () => {
    const { container } = render(
      <ServerProgress server={server({ state: "creating" })} />,
    );

    const segments = [
      ...container.querySelectorAll(".myservers__bar span"),
    ];
    expect(segments).toHaveLength(4);
    expect(segments[0].classList.contains("is-current")).toBe(true);
    expect(
      segments.slice(1).some((segment) => segment.classList.contains("is-done")),
    ).toBe(false);
  });

  it("逐级推进：每格按真实状态亮起，最多等一格停留时间", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <ServerProgress server={server({ state: "creating" })} />,
    );
    expect(currentSegment(container)).toBe(0);

    rerender(<ServerProgress server={server({ state: "booting" })} />);
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(currentSegment(container)).toBe(1);
    expect(container.querySelector(".myservers__progress")).not.toBeNull();
  });

  it("booting 直接变可用：不跳格，安装与检查各停 ≥800ms 后才进完成态", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <ServerProgress server={server({ state: "booting" })} />,
    );
    expect(currentSegment(container)).toBe(1);

    // 真机上安装 + 验证可能只有几秒：一次跨两格也只能一格一格亮。
    rerender(
      <ServerProgress
        server={server({
          state: "active",
          created_at: new Date(0).toISOString(),
          ready_at: new Date(4000).toISOString(),
        })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(799);
    });
    expect(currentSegment(container)).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(currentSegment(container)).toBe(2);

    act(() => {
      vi.advanceTimersByTime(799);
    });
    expect(currentSegment(container)).toBe(2);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(currentSegment(container)).toBe(3);
    // 最后一格先亮过，完成态不在同一帧出现。
    expect(container.querySelector(".myservers__progress")).not.toBeNull();
    expect(container.querySelector(".myservers__bar")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    // 就绪后整块不再渲染：状态词在头部，不再重复「已开通 · 用了 X」。
    expect(container.querySelector(".myservers__progress")).toBeNull();
  });

  it("换服务器：游标落在该台当前格，不播入场动画；已就绪的直接是完成态", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <ServerProgress server={server({ server_id: "srv_a", state: "installing" })} />,
    );
    expect(currentSegment(container)).toBe(2);

    // 换到一台刚创建的：直接落在第一格，不补动画。
    rerender(
      <ServerProgress server={server({ server_id: "srv_b", state: "creating" })} />,
    );
    expect(currentSegment(container)).toBe(0);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(currentSegment(container)).toBe(0);

    // 换到一台已就绪的：直接不渲染进度块，不逐格补。
    rerender(
      <ServerProgress
        server={server({
          server_id: "srv_c",
          state: "healthy",
          created_at: new Date(0).toISOString(),
          ready_at: new Date(2000).toISOString(),
        })}
      />,
    );
    expect(container.querySelector(".myservers__progress")).toBeNull();
    expect(currentSegment(container)).toBe(-1);
  });

  it("状态回退：游标不倒退、不重放", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <ServerProgress server={server({ state: "installing" })} />,
    );
    expect(currentSegment(container)).toBe(2);

    // 迟到的旧快照：画面停在这一格，也不排任何补格动画。
    rerender(<ServerProgress server={server({ state: "booting" })} />);
    expect(currentSegment(container)).toBe(2);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(currentSegment(container)).toBe(2);

    // 已经完成后再收到旧快照：完成态不撤回。
    rerender(
      <ServerProgress
        server={server({
          state: "active",
          created_at: new Date(0).toISOString(),
          ready_at: new Date(3000).toISOString(),
        })}
      />,
    );
    // 从安装那一格补到最后一格，再切完成态。
    act(() => {
      vi.advanceTimersByTime(1);
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector(".myservers__progress")).toBeNull();
    rerender(<ServerProgress server={server({ state: "booting" })} />);
    // 完成态不撤回：迟到的旧快照也不会把进度块放回来。
    expect(container.querySelector(".myservers__progress")).toBeNull();
  });
});

describe("整机 15 分钟边界", () => {
  it("满 15 分钟：出现超时提示，阶段提示同时保留", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 15, 0) });
    const now = Date.now();
    const { container } = render(
      <ServerProgress
        server={server({
          state: "installing",
          created_at: new Date(now - 15 * 60_000).toISOString(),
          installing_at: new Date(now - 4 * 60_000).toISOString(),
        })}
      />,
    );

    const notes = [
      ...container.querySelectorAll(".myservers__progress-note"),
    ];
    expect(notes).toHaveLength(2);
    expect(notes[0].textContent).toContain("这一步已经 4 分钟");
    expect(notes[1].classList.contains("is-timeout")).toBe(true);
    expect(notes[1].textContent).toContain("安装超时，可以销毁重建");
  });

  it("未满 15 分钟不出现超时提示", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 0, 0) });
    const now = Date.now();
    const { container } = render(
      <ServerProgress
        server={server({
          state: "booting",
          created_at: new Date(now - 14 * 60_000).toISOString(),
        })}
      />,
    );

    expect(
      container.querySelector(".myservers__progress-note.is-timeout"),
    ).toBeNull();
  });

  it("跨过 15 分钟自动改判，不需要重新进入详情", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 0, 0) });
    const now = Date.now();
    const { container } = render(
      <ServerProgress
        server={server({
          state: "booting",
          created_at: new Date(now - 14 * 60_000 - 59_000).toISOString(),
        })}
      />,
    );
    expect(container.querySelector(".is-timeout")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector(".is-timeout")).not.toBeNull();
  });
});

describe("阶段说明按阶段给", () => {
  const recent = () => new Date(Date.now() - 10_000).toISOString();

  it("四个阶段各渲染自己的句子", () => {
    const cases = [
      ["creating", "正在创建云服务器，通常 1–2 分钟。"],
      ["booting", "服务器已创建，正在启动，通常 30–60 秒。"],
      ["installing", "正在下载节点程序并启动服务，通常 2–4 分钟。"],
      ["verifying", "正在检查节点是否可用，通常 1–2 分钟。"],
    ] as const;

    for (const [state, note] of cases) {
      const view = render(
        <ServerProgress server={server({ state, created_at: recent() })} />,
      );
      expect(
        view.container.querySelector(".myservers__progress-note")?.textContent,
      ).toBe(note);
      view.unmount();
    }
  });

  it("installing 有版本号：版本句后接固定时长", () => {
    const { container } = render(
      <ServerProgress
        server={server({
          state: "installing",
          created_at: recent(),
          singbox_version: "1.14.4",
        })}
      />,
    );
    expect(
      container.querySelector(".myservers__progress-note")?.textContent,
    ).toBe("正在安装 sing-box 1.14.4，通常 2–4 分钟。");
  });

  it("阶段超时优先于阶段句与版本句", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 5, 0) });
    const startedAt = new Date(Date.now() - 4 * 60_000).toISOString();
    const { container } = render(
      <ServerProgress
        server={server({
          state: "installing",
          created_at: startedAt,
          installing_at: startedAt,
          singbox_version: "1.14.4",
        })}
      />,
    );

    expect(
      container.querySelector(".myservers__progress-note")?.textContent,
    ).toBe("这一步已经 4 分钟，还在继续。");
    expect(container.textContent).not.toContain("sing-box");
  });
});
