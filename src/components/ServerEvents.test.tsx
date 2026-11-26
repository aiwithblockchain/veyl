/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServer, MyServerEvent, MyServerEvents } from "../agent/bridge";
import { setLanguage } from "../i18n";
import { ServerEvents } from "./ServerEvents";

function server(over: Partial<MyServer> = {}): MyServer {
  return {
    server_id: "srv_1",
    name: "新加坡 1 · DigitalOcean",
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    state: "healthy",
    created_at: new Date(0).toISOString(),
    ip: "45.76.20.100",
    port: 8388,
    node_id: "nd_control_1",
    local_node_id: "local_node_1",
    hourly_usd: 0.00893,
    monthly_usd: 6,
    daily_price_cents: 30,
    paid_until: new Date(86_400_000).toISOString(),
    billing_state: "active",
    grace_ends_at: null,
    transfer_gib: 1000,
    traffic_used_bytes: 0,
    traffic_limit_bytes: 0,
    traffic_reset_at: "",
    traffic_state: "ok",
    failure: null,
    ...over,
  };
}

function bridgeWith(
  impl: (serverId: string) => Promise<MyServerEvents>,
): AgentBridge & { myServerEvents: ReturnType<typeof vi.fn> } {
  return { myServerEvents: vi.fn(impl) } as unknown as AgentBridge & {
    myServerEvents: ReturnType<typeof vi.fn>;
  };
}

const NOW = new Date();
const AT = new Date(NOW.getFullYear(), 10, 24, 14, 32).getTime();

function event(over: Partial<MyServerEvent> & Pick<MyServerEvent, "code">): MyServerEvent {
  return { at: AT, ...over };
}

const HEALTHY: MyServerEvents = {
  events: [
    event({ code: "activated", at: AT + 3000, version: "1.14.4" }),
    event({ code: "verify.started", at: AT + 2000 }),
    event({ code: "install.started", at: AT + 1000 }),
    event({ code: "machine.created" }),
    event({ code: "order.confirmed" }),
  ],
  has_more: false,
};

afterEach(() => {
  cleanup();
  setLanguage("zh");
});

describe("创建记录", () => {
  it("就绪默认收起：标题行给条数，面板 hidden，收起也取过一次", async () => {
    const bridge = bridgeWith(async () => HEALTHY);
    render(<ServerEvents bridge={bridge} server={server({ state: "active" })} />);

    const toggle = screen.getByRole("button", { name: /创建记录/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await screen.findByText("5 条");
    const panel = document.querySelector<HTMLElement>(".myservers__events-panel");
    expect(panel?.hidden).toBe(true);
    expect(toggle.getAttribute("aria-controls")).toBe(panel?.id);
    expect(bridge.myServerEvents).toHaveBeenCalledWith("srv_1");
  });

  it("失败默认展开：失败、销毁、退款与折叠次数都在，时间是同年格式", async () => {
    const bridge = bridgeWith(async () => ({
      events: [
        event({ code: "refunded", amount_cents: 30 }),
        event({ code: "destroyed", reason: "install_failed" }),
        event({ code: "install.failed", count: 2 }),
        event({ code: "machine.created" }),
      ],
      has_more: false,
    }));
    render(
      <ServerEvents
        bridge={bridge}
        server={server({ state: "error", billing_state: "pending", failure: null })}
      />,
    );

    expect(
      screen.getByRole("button", { name: /创建记录/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    await screen.findByText("已退回 $0.30");
    expect(screen.getByText("服务器已销毁")).toBeTruthy();
    const folded = screen.getByText(/安装服务端失败/);
    expect(folded.textContent).toBe("安装服务端失败（2 次）");
    expect(folded.querySelector(".myservers__event-meta")?.textContent).toBe(
      "（2 次）",
    );
    expect(document.querySelector(".myservers__events-list")?.tagName).toBe("OL");
    expect(screen.getAllByText("11-24 14:32").length).toBe(4);
  });

  it("空：写一句说明，不给动作", async () => {
    const bridge = bridgeWith(async () => ({ events: [], has_more: false }));
    render(<ServerEvents bridge={bridge} server={server({ state: "error" })} />);

    await screen.findByText("这台服务器没有留下创建记录。");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.getByText("0 条")).toBeTruthy();
  });

  it("读取失败只影响这一块：给重试，重试成功后渲染列表", async () => {
    const bridge = bridgeWith(
      vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue({ events: [event({ code: "machine.created" })], has_more: false }),
    );
    render(<ServerEvents bridge={bridge} server={server({ state: "error" })} />);

    const alert = await screen.findByText("读不到创建记录。");
    expect(alert.closest("[role='alert']")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("机器已创建");
  });

  it("没有 count 字段时不渲染次数，也不崩", async () => {
    const bridge = bridgeWith(async () => ({
      events: [{ at: AT, code: "machine.created" }],
      has_more: false,
    }));
    render(<ServerEvents bridge={bridge} server={server({ state: "error" })} />);

    const line = await screen.findByText("机器已创建");
    expect(line.textContent).toBe("机器已创建");
  });

  it("版本作次要片段：同一行用 · 分隔并套等宽", async () => {
    const bridge = bridgeWith(async () => ({
      events: [event({ code: "activated", version: "1.14.4" })],
      has_more: false,
    }));
    render(<ServerEvents bridge={bridge} server={server({ state: "error" })} />);

    const line = await screen.findByText(/已开通，开始计费/);
    expect(line.textContent).toBe("已开通，开始计费 · 1.14.4");
    expect(line.querySelector(".myservers__event-meta")?.className).toContain("num");
  });

  it("超过 50 条：底部说明只显示最近 50 条", async () => {
    const bridge = bridgeWith(async () => ({
      events: [event({ code: "machine.created" })],
      has_more: true,
    }));
    render(<ServerEvents bridge={bridge} server={server({ state: "error" })} />);

    await screen.findByText("只显示最近 50 条。");
  });

  it("展开与收起：收起后面板 hidden，展开回来用缓存不重取", async () => {
    const bridge = bridgeWith(async () => HEALTHY);
    render(<ServerEvents bridge={bridge} server={server({ state: "active" })} />);

    const toggle = screen.getByRole("button", { name: /创建记录/ });
    await screen.findByText("5 条");
    fireEvent.click(toggle);
    await screen.findByText(/已开通，开始计费/);
    fireEvent.click(toggle);
    expect(
      document.querySelector<HTMLElement>(".myservers__events-panel")?.hidden,
    ).toBe(true);
    const calls = bridge.myServerEvents.mock.calls.length;
    fireEvent.click(toggle);
    await screen.findByText(/已开通，开始计费/);
    expect(
      document.querySelector<HTMLElement>(".myservers__events-panel")?.hidden,
    ).toBe(false);
    expect(bridge.myServerEvents.mock.calls.length).toBe(calls);
  });

  it("开通中且展开：每 5 秒重取一次", async () => {
    vi.useFakeTimers();
    const bridge = bridgeWith(async () => HEALTHY);
    render(<ServerEvents bridge={bridge} server={server({ state: "installing" })} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bridge.myServerEvents).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(bridge.myServerEvents).toHaveBeenCalledTimes(2);
    cleanup();
    vi.useRealTimers();
  });

  it("离开开通中：立刻再取一次、1 秒后补取，之后不再轮询（healthy / error 都覆盖）", async () => {
    vi.useFakeTimers();
    for (const settled of ["healthy", "error"] as const) {
      const bridge = bridgeWith(async () => HEALTHY);
      const view = render(
        <ServerEvents bridge={bridge} server={server({ state: "installing" })} />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(bridge.myServerEvents).toHaveBeenCalledTimes(1);

      // 状态落定（含失败）：绕过节流立刻取，1 秒后补取一次（审计可能晚落库）。
      view.rerender(
        <ServerEvents bridge={bridge} server={server({ state: settled })} />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(bridge.myServerEvents).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(bridge.myServerEvents).toHaveBeenCalledTimes(3);

      // 5 秒轮询已经停了：再等也不会多取。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(bridge.myServerEvents).toHaveBeenCalledTimes(3);
      view.unmount();
      cleanup();
    }
    vi.useRealTimers();
  });

  it("本来就没有记录时后台失败：只显示错误行，不叠加空态", async () => {
    vi.useFakeTimers();
    const bridge = bridgeWith(async () => ({ events: [], has_more: false }));
    bridge.myServerEvents
      .mockResolvedValueOnce({ events: [], has_more: false })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ events: [], has_more: false });
    render(<ServerEvents bridge={bridge} server={server({ state: "installing" })} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("这台服务器没有留下创建记录。")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText("读不到创建记录。")).toBeTruthy();
    expect(screen.queryByText("这台服务器没有留下创建记录。")).toBeNull();
    cleanup();
    vi.useRealTimers();
  });

  it("后台刷新失败：保留已加载的列表，只加一行提示", async () => {
    vi.useFakeTimers();
    const bridge = bridgeWith(async () => HEALTHY);
    bridge.myServerEvents
      .mockResolvedValueOnce(HEALTHY)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(HEALTHY);
    render(<ServerEvents bridge={bridge} server={server({ state: "installing" })} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("5 条")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText("读不到创建记录。")).toBeTruthy();
    // 旧列表还在，没有被错误行盖掉。
    expect(screen.getByText("5 条")).toBeTruthy();
    expect(document.querySelectorAll(".myservers__event").length).toBe(5);
    cleanup();
    vi.useRealTimers();
  });

  it("英文条数单数用 entry", async () => {
    setLanguage("en");
    const bridge = bridgeWith(async () => ({
      events: [event({ code: "machine.created" })],
      has_more: false,
    }));
    render(<ServerEvents bridge={bridge} server={server({ state: "error" })} />);
    await screen.findByText("1 entry");
    expect(screen.queryByText("1 entries")).toBeNull();
  });

  it("命令不可用（老 Host）：显示读取失败与重试，不静默消失", async () => {
    render(
      <ServerEvents bridge={{} as AgentBridge} server={server({ state: "error" })} />,
    );
    expect(await screen.findByText("读不到创建记录。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });
});
