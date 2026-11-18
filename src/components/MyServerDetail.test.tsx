/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServer } from "../agent/bridge";
import { DESTROY_RETRY_MS, MyServerDetail } from "./MyServerDetail";

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
    hourly_usd: 0.00893,
    monthly_usd: 6,
    daily_price_cents: 20,
    paid_until: new Date(86_400_000).toISOString(),
    billing_state: "active",
    grace_ends_at: null,
    transfer_gib: 1000,
    failure: null,
    ...over,
  };
}

function renderDetail(
  over: Partial<MyServer> = {},
  onGone = vi.fn(),
  onUseServer: (server: MyServer) => void | Promise<void> = vi.fn(),
  onAiLocate?: (serverId: string) => void,
  connectedHere = false,
  onDisconnect?: () => void,
) {
  const destroy = vi.fn(async (id: string) =>
    server({ server_id: id, state: "destroyed" }),
  );
  const onCreateAnother = vi.fn();
  const view = render(
    <MyServerDetail
      bridge={{ myServerDestroy: destroy } as unknown as AgentBridge}
      server={server(over)}
      regionLabel="新加坡 1"
      connectedHere={connectedHere}
      onAiLocate={onAiLocate}
      onDisconnect={onDisconnect}
      onCreateAnother={onCreateAnother}
      onUseServer={onUseServer}
      onChanged={() => {}}
      onRebuilt={() => {}}
      onGone={onGone}
    />,
  );
  return { destroy, onCreateAnother, onUseServer, onGone, unmount: view.unmount };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("服务器详情", () => {
  it("费用按日价与本期有效期展示，不出现时价", () => {
    // 固定「现在」，paid_until 用相对它算出的未来日期，避免写死的日期过期变红。
    vi.useFakeTimers({ now: new Date(2026, 10, 17, 9, 0, 0) });
    renderDetail({
      daily_price_cents: 20,
      paid_until: new Date(2026, 11, 15, 12, 0, 0).toISOString(),
    });

    const detail = document.querySelector(".myservers__detail");
    expect(detail?.textContent).toContain("每天 $0.20 · 本期有效至 2026-12-15");
    expect(detail?.textContent).not.toContain("/小时");
  });

  it("active 但 paid_until 已过去：提示下一轮扣费顺延", () => {
    renderDetail({
      daily_price_cents: 20,
      paid_until: new Date(Date.now() - 86_400_000).toISOString(),
      billing_state: "active",
      grace_ends_at: null,
    });

    expect(document.querySelector(".myservers__facts")?.textContent).toContain(
      "每天 $0.20 · 本期已到期，下一轮扣费顺延",
    );
  });

  it("past_due 显示宽限剩余天数", () => {
    renderDetail({
      billing_state: "past_due",
      grace_ends_at: new Date(Date.now() + 2.5 * 86_400_000).toISOString(),
    });

    expect(document.querySelector(".myservers__billing")?.textContent).toContain(
      "宽限还剩 3 天",
    );
  });

  it("expired 说明停机不再产生费用，不再显示宽限天数", () => {
    renderDetail({
      billing_state: "expired",
      grace_ends_at: new Date(Date.now() - 86_400_000).toISOString(),
    });

    const copy = document.querySelector(".myservers__billing")?.textContent ?? "";
    expect(copy).toContain("服务已停用");
    expect(copy).toContain("停机期间不再产生费用");
    expect(copy).toContain("充值后自动补扣");
    expect(copy).not.toContain("宽限还剩");
  });

  it("没建成且已退款：费用行写已退回，不写本期有效至，也没有流量行", () => {
    renderDetail({
      state: "error",
      paid_until: new Date(Date.now() + 86_400_000).toISOString(),
      charged_cents: 30,
      refunded_cents: 30,
    });

    const facts = document.querySelector(".myservers__facts");
    expect(facts?.textContent).toContain("已退回 $0.30");
    expect(facts?.textContent).not.toContain("本期有效至");
    expect(screen.queryByText("流量")).toBeNull();
  });

  it("没建成但旧 Host 不返回扣费字段：写费用信息暂时读不到，不冒充没扣费", () => {
    renderDetail({
      state: "error",
      charged_cents: undefined,
      refunded_cents: undefined,
    });

    const facts = document.querySelector(".myservers__facts");
    expect(facts?.textContent).toContain("费用信息暂时读不到");
    expect(facts?.textContent).not.toContain("本次没有扣费");
    expect(facts?.textContent).not.toContain("本期有效至");
    expect(screen.queryByText("流量")).toBeNull();
  });

  it("没建成且一分没扣：费用行写本次没有扣费", () => {
    renderDetail({
      state: "error",
      charged_cents: 0,
      refunded_cents: 0,
    });

    const facts = document.querySelector(".myservers__facts");
    expect(facts?.textContent).toContain("本次没有扣费");
    expect(facts?.textContent).not.toContain("本期有效至");
    expect(screen.queryByText("流量")).toBeNull();
  });

  it("没建成已扣费但还没退：费用行写退款处理中", () => {
    renderDetail({
      state: "error",
      charged_cents: 30,
      refunded_cents: 0,
    });

    const facts = document.querySelector(".myservers__facts");
    expect(facts?.textContent).toContain("已扣 $0.30，退款处理中");
    expect(facts?.textContent).not.toContain("本期有效至");
    expect(screen.queryByText("流量")).toBeNull();
  });

  it("可用机器照旧显示本期有效至与流量", () => {
    renderDetail({
      state: "healthy",
      paid_until: new Date(Date.now() + 86_400_000).toISOString(),
      transfer_gib: 1000,
    });

    const facts = document.querySelector(".myservers__facts");
    expect(facts?.textContent).toContain("本期有效至");
    expect(screen.getByText("流量")).toBeTruthy();
  });

  it("流量额度为 0 时整行不显示", () => {
    renderDetail({ transfer_gib: 0 });

    expect(screen.queryByText("流量")).toBeNull();
    expect(document.querySelector(".myservers__detail")?.textContent).not.toContain(
      "不限量",
    );
  });

  it("建机进度显示已等待，状态推进不重置，就绪后消失", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 0, 0) });
    const props = {
      bridge: {} as AgentBridge,
      regionLabel: "新加坡 1",
      onCreateAnother: vi.fn(),
      onUseServer: vi.fn(),
      onChanged: () => {},
      onRebuilt: () => {},
      onGone: vi.fn(),
    };
    const view = render(
      <MyServerDetail {...props} server={server({ state: "creating" })} />,
    );
    expect(screen.getByText("已等待 0 秒")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(80_000);
    });
    expect(screen.getByText("已等待 1 分 20 秒")).toBeTruthy();

    // 状态推进（同一台机器）不重置计时。
    view.rerender(
      <MyServerDetail {...props} server={server({ state: "booting" })} />,
    );
    expect(screen.getByText("已等待 1 分 20 秒")).toBeTruthy();

    // 就绪后进度区整个消失。
    view.rerender(
      <MyServerDetail {...props} server={server({ state: "healthy" })} />,
    );
    expect(screen.queryByText(/已等待/)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("流量行只留额度一个事实，不带括号补充", () => {
    renderDetail({ transfer_gib: 1000 });

    expect(screen.getByText("每月 1000 GB 出站")).toBeTruthy();
    expect(screen.queryByText(/共用额度|同账户/)).toBeNull();
  });

  it("可用时主按钮不要求控制面 node_id，点击交回服务器", () => {
    const { onUseServer } = renderDetail({ node_id: null, state: "healthy" });

    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    expect(onUseServer).toHaveBeenCalledWith(
      expect.objectContaining({ server_id: "srv_1" }),
    );
  });

  it("连接的就是这台时主按钮是断开", () => {
    const onDisconnect = vi.fn();
    renderDetail({}, vi.fn(), vi.fn(), undefined, true, onDisconnect);
    fireEvent.click(screen.getByRole("button", { name: "断开" }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("取凭据在途时按钮禁用，连点只发一次", async () => {
    let release: () => void = () => {};
    const onUseServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderDetail({}, vi.fn(), onUseServer);
    const button = screen.getByRole("button", { name: "连接" });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(onUseServer).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      release();
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("卸载时清理销毁重试计时器", () => {
    vi.useFakeTimers();
    const { unmount } = renderDetail({ state: "destroying" });

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("销毁中先显示进度；超过 60 秒允许重试销毁", async () => {
    vi.useFakeTimers();
    const { destroy } = renderDetail({ state: "destroying" });

    expect(screen.getByText("正在销毁…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试销毁" })).toBeNull();

    act(() => {
      vi.advanceTimersByTime(DESTROY_RETRY_MS);
    });

    fireEvent.click(screen.getByRole("button", { name: "重试销毁" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认销毁" }));
    });
    expect(destroy).toHaveBeenCalledWith("srv_1", true);
  });

  it("失败态给 AI 定位；事实行有规格与可复制 IP；销毁文案对齐", async () => {
    const onAiLocate = vi.fn();
    renderDetail(
      {
        state: "error",
        failure: { stage: "installing", code: "install_failed", message: "装环境失败。", retryable: true },
      },
      vi.fn(),
      vi.fn(),
      onAiLocate,
    );

    fireEvent.click(await screen.findByRole("button", { name: "AI 定位" }));
    expect(onAiLocate).toHaveBeenCalledWith("srv_1");
    // 设计：详情不显示规格与 IP。
    expect(screen.queryByText("1 核 · 1 GB")).toBeNull();
    expect(screen.queryByText("45.76.20.100")).toBeNull();
    expect(screen.getByRole("button", { name: "重新建一台" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "销毁" }));
    expect(
      screen.getByText(/销毁后不再产生新费用。未用完的整天退回余额/),
    ).toBeTruthy();
  });
});
