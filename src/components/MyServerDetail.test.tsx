/** @vitest-environment jsdom */
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServer, MyServerState } from "../agent/bridge";
import { setLanguage } from "../i18n";
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
    local_node_id: "local_node_1",
    hourly_usd: 0.00893,
    monthly_usd: 6,
    daily_price_cents: 20,
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

function renderDetail(
  over: Partial<MyServer> = {},
  onGone = vi.fn(),
  onAiLocate?: (serverId: string) => void,
  onTopUp?: () => void,
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
      onAiLocate={onAiLocate}
      onTopUp={onTopUp}
      onCreateAnother={onCreateAnother}
      onChanged={() => {}}
      onRebuilt={() => {}}
      onGone={onGone}
      onForget={async () => {}}
    />,
  );
  return { destroy, onCreateAnother, onGone, unmount: view.unmount };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const GIB = 1024 ** 3;

describe("服务器详情", () => {
  it("健康检查失败但 node_id 还在：节点不进事实区，没有「未就绪」", () => {
    renderDetail({ state: "error", node_id: "nd_control_1" });

    expect(screen.queryByText("节点")).toBeNull();
    expect(screen.queryByText("未就绪")).toBeNull();
  });

  it("费用只按日价展示，不写本期有效期", () => {
    // 固定「现在」，paid_until 用相对它算出的未来日期，避免写死的日期过期变红。
    vi.useFakeTimers({ now: new Date(2026, 10, 17, 9, 0, 0) });
    renderDetail({
      daily_price_cents: 20,
      paid_until: new Date(2026, 11, 15, 12, 0, 0).toISOString(),
    });

    const detail = document.querySelector(".myservers__detail");
    expect(detail?.textContent).toContain("每天 $0.20");
    expect(detail?.textContent).not.toContain("本期有效至");
    expect(detail?.textContent).not.toContain("/小时");
  });

  it("active 但 paid_until 已过去：说「本期已过，服务正常」，不说到期", () => {
    renderDetail({
      daily_price_cents: 20,
      paid_until: new Date(Date.now() - 86_400_000).toISOString(),
      billing_state: "active",
      grace_ends_at: null,
    });

    expect(document.querySelector(".myservers__facts")?.textContent).toContain(
      "每天 $0.20 · 本期已过，服务正常",
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

  it("进行中的详情标题用长词，与步骤词一致，不出现左栏短词", () => {
    renderDetail({ state: "installing" });

    const state = document.querySelector(".myservers__state");
    expect(state?.textContent).toContain("安装服务端");
    expect(state?.textContent).not.toContain("安装中");
    expect(document.body.textContent).not.toContain("安装中");
  });

  it("past_due 的标题词与左栏同源：写「已欠费」，点是 warn", () => {
    renderDetail({
      state: "active",
      billing_state: "past_due",
      grace_ends_at: new Date(Date.now() + 2.5 * 86_400_000).toISOString(),
    });

    const state = document.querySelector(".myservers__state");
    expect(state?.textContent).toContain("已欠费");
    expect(state?.classList.contains("is-warn")).toBe(true);
    expect(state?.querySelector(".led")?.classList.contains("is-warn")).toBe(
      true,
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

  it("可用机器只显示日价与流量", () => {
    renderDetail({
      state: "healthy",
      daily_price_cents: 20,
      paid_until: new Date(Date.now() + 86_400_000).toISOString(),
      transfer_gib: 1000,
    });

    const facts = document.querySelector(".myservers__facts");
    expect(facts?.textContent).toContain("每天 $0.20");
    expect(facts?.textContent).not.toContain("本期有效至");
    expect(screen.getByText("流量")).toBeTruthy();
  });

  it("待开通（billing_state=pending）：事实区只有地区与流量，不写费用行", () => {
    renderDetail({
      state: "verifying",
      billing_state: "pending",
      paid_until: null,
      transfer_gib: 1000,
    });

    const facts = document.querySelector(".myservers__facts");
    expect(facts?.textContent).not.toContain("创建中，开通后开始计费");
    expect(facts?.textContent).not.toContain("费用");
    expect(screen.queryByText("节点")).toBeNull();
    expect(screen.getByText("流量")).toBeTruthy();
  });

  it("就绪且已计费：节点与费用两行同时出现", () => {
    renderDetail({
      state: "healthy",
      billing_state: "active",
      daily_price_cents: 20,
      transfer_gib: 1000,
    });

    const labels = [...document.querySelectorAll(".myservers__facts dt")].map(
      (dt) => dt.textContent,
    );
    expect(labels).toContain("节点");
    expect(labels).toContain("费用");
    const facts = document.querySelector(".myservers__facts");
    expect(facts?.textContent).toContain("已就绪");
    expect(facts?.textContent).toContain("每天 $0.20");
  });

  it("分区顺序固定：状态块 → 事实块 → 危险块", () => {
    for (const state of ["healthy", "installing", "error"] as const) {
      renderDetail({ state });
      const children = [
        ...(document.querySelector(".myservers__detail")?.children ?? []),
      ].map((node) => node.className);
      expect(children[0]).toContain("myservers__block");
      expect(children[1]).toContain("myservers__facts");
      expect(children[2]).toContain("myservers__footer");
      expect(children).toHaveLength(3);
      cleanup();
    }
  });

  it("创建时间在事实区：本地日 + 时分；不再有创建记录块", () => {
    renderDetail({
      created_at: new Date(2026, 10, 26, 14, 3, 0).toISOString(),
    });

    expect(screen.getByText("创建于")).toBeTruthy();
    expect(screen.getByText("11月26日 14:03")).toBeTruthy();
    expect(screen.queryByText("创建记录")).toBeNull();
    expect(document.querySelector(".myservers__events")).toBeNull();
  });

  it("就绪后扣费余额不够：写明没开通没扣费，给去充值与重新建一台", () => {
    const onTopUp = vi.fn();
    renderDetail(
      {
        state: "error",
        billing_state: "pending",
        paid_until: null,
        // 即使 Host 给了数字，这笔也没扣，不能写退款处理中。
        charged_cents: 30,
        refunded_cents: 0,
        failure: {
          stage: "verifying",
          code: "settle_insufficient",
          message: "余额不足。",
          retryable: true,
        },
      },
      vi.fn(),
      undefined,
      onTopUp,
    );

    expect(
      screen.getByText("服务器没开通，本次没有扣费。"),
    ).toBeTruthy();
    const facts = document.querySelector(".myservers__facts");
    expect(facts?.textContent).toContain("本次没有扣费");
    expect(facts?.textContent).not.toContain("退款处理中");
    fireEvent.click(screen.getByRole("button", { name: "去充值" }));
    expect(onTopUp).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "重新建一台" })).toBeTruthy();
  });

  it("结算失败：重新建一台为次、去充值为主，且不给 AI 定位", () => {
    const onTopUp = vi.fn();
    const onAiLocate = vi.fn();
    renderDetail(
      {
        state: "error",
        billing_state: "pending",
        paid_until: null,
        charged_cents: 30,
        refunded_cents: 0,
        failure: {
          stage: "verifying",
          code: "settle_insufficient",
          message: "余额不足。",
          retryable: true,
        },
      },
      vi.fn(),
      onAiLocate,
      onTopUp,
    );

    const group = document.querySelector(
      ".myservers__footer > .myservers__actions",
    ) as HTMLElement;
    const buttons = [...group.querySelectorAll("button")].map(
      (button) => button.textContent,
    );
    expect(buttons).toEqual(["重新建一台", "去充值"]);
    expect(group.querySelector(".btn--primary")?.textContent).toBe("去充值");
    expect(
      group.querySelector(".btn--ghost")?.classList.contains("btn--danger-ghost"),
    ).toBe(false);
    // AI 定位只属于建机失败，结算失败不给。
    expect(screen.queryByRole("button", { name: "AI 定位" })).toBeNull();
    expect(onAiLocate).not.toHaveBeenCalled();
  });

  it("四种创建中状态：不渲染销毁，只留进度块", () => {
    for (const state of ["creating", "booting", "installing", "verifying"] as const) {
      renderDetail({ state });
      expect(screen.queryByRole("button", { name: /销毁/ }), state).toBeNull();
      expect(document.querySelector(".myservers__progress")).toBeTruthy();
      cleanup();
    }
  });

  it("已销毁：不给销毁，右侧只保留重新购买", () => {
    renderDetail({ state: "gone" });

    expect(screen.queryByRole("button", { name: /销毁/ })).toBeNull();
    const rebuy = screen.getByRole("button", { name: "重新购买" });
    expect(rebuy.classList.contains("btn--primary")).toBe(true);
  });

  it("已销毁且已停用：右侧只有重新购买一个主按钮，不给去充值", () => {
    const onTopUp = vi.fn();
    renderDetail(
      { state: "gone", billing_state: "expired" },
      vi.fn(),
      undefined,
      onTopUp,
    );

    const footer = document.querySelector(".myservers__footer") as HTMLElement;
    const primaries = footer.querySelectorAll(".btn--primary");
    expect(primaries).toHaveLength(1);
    expect(primaries[0].textContent).toBe("重新购买");
    expect(screen.queryByRole("button", { name: "去充值" })).toBeNull();
  });

  it("停机中与已销毁：事实区只剩地区与创建时间", () => {
    for (const state of ["destroying", "gone"] as const) {
      renderDetail({ state });
      const labels = [
        ...document.querySelectorAll(".myservers__facts dt"),
      ].map((dt) => dt.textContent);
      expect(labels).toEqual(["地区", "创建于"]);
      cleanup();
    }
  });

  it("欠费 / 停用：右侧给去充值主按钮，销毁仍在左", () => {
    const onTopUp = vi.fn();
    renderDetail(
      {
        billing_state: "past_due",
        grace_ends_at: new Date(Date.now() + 2.5 * 86_400_000).toISOString(),
      },
      vi.fn(),
      undefined,
      onTopUp,
    );

    const footer = document.querySelector(".myservers__footer") as HTMLElement;
    expect(
      footer.querySelector(".myservers__danger .btn--danger-ghost"),
    ).not.toBeNull();
    expect(
      footer.querySelector(".myservers__actions .btn--primary")?.textContent,
    ).toBe("去充值");
    fireEvent.click(screen.getByRole("button", { name: "去充值" }));
    expect(onTopUp).toHaveBeenCalledTimes(1);
  });

  it("云服务商侧已删除的欠费机器：不给去充值，也不报日价", () => {
    renderDetail(
      {
        billing_state: "past_due",
        provider_gone: true,
        grace_ends_at: new Date(Date.now() + 2.5 * 86_400_000).toISOString(),
      },
      vi.fn(),
      undefined,
      vi.fn(),
    );

    // 结算不会再跑，充值救不回来；费用行改写「已删除，不再扣费」。
    expect(screen.queryByRole("button", { name: "去充值" })).toBeNull();
    expect(document.body.textContent).toContain("云服务商已删除，不再扣费");
    // 标题词与提示都点明「已从云服务商删除」，不是可用。
    expect(document.querySelector(".myservers__state")?.textContent).toContain(
      "云服务商已删除",
    );
    expect(document.body.textContent).toContain("销毁后即可从列表移除");
    // 欠费提示与「去充值」都让位给「已删除」：充值救不回来，两个提示会互相否定。
    expect(document.body.textContent).not.toContain("最近一次扣费没成功");
  });

  it("进度条报步骤：1–4 与阶段名，另有 sr-only 第 N 步", () => {
    renderDetail({ state: "installing" });

    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemin")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("4");
    expect(bar.getAttribute("aria-valuenow")).toBe("3");
    expect(bar.getAttribute("aria-label")).toContain("安装");
    expect(screen.getByText("第 3 步，共 4 步")).toBeTruthy();
  });

  it("其它建机失败仍走退款文案，不给去充值", () => {
    renderDetail({
      state: "error",
      charged_cents: 30,
      refunded_cents: 0,
      failure: {
        stage: "installing",
        code: "install_failed",
        message: "装环境失败。",
        retryable: true,
      },
    });

    expect(
      document.querySelector(".myservers__facts")?.textContent,
    ).toContain("已扣 $0.30，退款处理中");
    // 后端 message 只进日志：界面按失败码取句。
    expect(screen.getByText("装机失败。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "去充值" })).toBeNull();
  });

  it("额度为 0：说「额度未知」，不写「已释放 0 GB」或「不限量」", () => {
    renderDetail({ transfer_gib: 0 });

    const dd = screen.getByText(/已用 0 GiB/).closest("dd");
    expect(dd?.textContent).toContain("额度未知");
    expect(dd?.textContent).not.toMatch(/已释放|不限量/);
  });

  it("建机进度显示已等待，状态推进不重置，就绪后消失", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 0, 0) });
    const created_at = new Date(2026, 10, 18, 10, 0, 0).toISOString();
    const props = {
      bridge: {} as AgentBridge,
      regionLabel: "新加坡 1",
      onCreateAnother: vi.fn(),
      onChanged: () => {},
      onRebuilt: () => {},
      onGone: vi.fn(),
      onForget: vi.fn(async () => {}),
    };
    const view = render(
      <MyServerDetail
        {...props}
        server={server({ state: "creating", created_at })}
      />,
    );
    expect(screen.getByText("已等待 0 秒")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(80_000);
    });
    expect(screen.getByText("已等待 1 分 20 秒")).toBeTruthy();

    // 状态推进（同一台机器）不重置计时；同一屏状态词统一用 STATE_LABEL。
    view.rerender(
      <MyServerDetail
        {...props}
        server={server({ state: "booting", created_at })}
      />,
    );
    expect(screen.getByText("已等待 1 分 20 秒")).toBeTruthy();
    expect(
      document.querySelector(".myservers__progress-head")?.textContent,
    ).toContain("等待开机");
    expect(document.body.textContent).not.toContain("正在开机");

    // 就绪后进度块整块不再渲染：不再计时，状态词由头部接管。
    view.rerender(
      <MyServerDetail
        {...props}
        server={server({ state: "healthy", created_at })}
      />,
    );
    // 跨格的状态逐格补齐（每格 ≥800ms），补齐后才切完成态。
    act(() => {
      vi.advanceTimersByTime(800);
    });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText(/已等待/)).toBeNull();
    // 就绪后整块进度不渲染：状态词「已开通」在头部，不再重复建机耗时。
    expect(screen.queryByRole("group", { name: "建机进度" })).toBeNull();
    expect(document.querySelector(".myservers__progress")).toBeNull();
    expect(document.querySelector(".myservers__steps")).toBeNull();
  });

  it("重进详情不从零算：整机时间以 created_at 为基准", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 0, 0) });
    renderDetail({
      state: "installing",
      created_at: new Date(2026, 10, 18, 9, 55, 0).toISOString(),
      installing_at: new Date(2026, 10, 18, 9, 56, 0).toISOString(),
    });

    // 整机已经过去 5 分钟，不因为刚打开详情而从 0 开始。
    expect(screen.getByText("已等待 5 分 0 秒")).toBeTruthy();
    // 阶段提示仍按阶段时间戳解释卡在哪一步。
    expect(
      document.querySelector(".myservers__progress-note")?.textContent,
    ).toContain("这一步已经 4 分钟");
  });

  it("booting 没有阶段时间戳：整机时间仍从 created_at 起算", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 0, 0) });
    renderDetail({
      state: "booting",
      created_at: new Date(2026, 10, 18, 9, 57, 0).toISOString(),
    });

    expect(screen.getByText("已等待 3 分 0 秒")).toBeTruthy();
  });

  it("整机满 15 分钟：改判安装超时，阶段提示保留，仍不给销毁", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 15, 0) });
    renderDetail({
      state: "installing",
      created_at: new Date(2026, 10, 18, 10, 0, 0).toISOString(),
      installing_at: new Date(2026, 10, 18, 10, 1, 0).toISOString(),
    });

    const timeout = document.querySelector(
      ".myservers__progress-note.is-timeout",
    );
    expect(timeout?.textContent).toContain("安装超时；创建会自动完成或失败。");
    // 阶段提示仍在：解释卡在哪一步。
    expect(
      document.querySelector(".myservers__progress-note")?.textContent,
    ).toBe("这一步已经 14 分钟，还在继续。");
    expect(screen.queryByRole("button", { name: /销毁/ })).toBeNull();
  });

  it("切换服务器后计时按新服务器的时间重算", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 0, 0) });
    const props = {
      bridge: {} as AgentBridge,
      regionLabel: "新加坡 1",
      onCreateAnother: vi.fn(),
      onChanged: () => {},
      onRebuilt: () => {},
      onGone: vi.fn(),
      onForget: vi.fn(async () => {}),
    };
    const view = render(
      <MyServerDetail
        {...props}
        server={server({
          state: "creating",
          created_at: new Date(2026, 10, 18, 9, 59, 0).toISOString(),
        })}
      />,
    );
    expect(screen.getByText("已等待 1 分 0 秒")).toBeTruthy();

    view.rerender(
      <MyServerDetail
        {...props}
        server={server({
          server_id: "srv_2",
          state: "creating",
          created_at: new Date(2026, 10, 18, 9, 59, 50).toISOString(),
        })}
      />,
    );
    expect(screen.getByText("已等待 10 秒")).toBeTruthy();
  });

  it("已等待满一小时按小时显示", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 12, 0, 0) });
    renderDetail({
      state: "installing",
      created_at: new Date(2026, 10, 18, 10, 0, 0).toISOString(),
      installing_at: new Date(2026, 10, 18, 10, 0, 0).toISOString(),
    });

    expect(screen.getByText("已等待 2 小时 0 分")).toBeTruthy();
  });

  it("卸载时清掉每秒计时器", () => {
    vi.useFakeTimers();
    const { unmount } = renderDetail({ state: "creating" });

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("建机进度不显示百分比，秒数每秒更新，当前阶段在第 1 段", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 0, 0) });
    renderDetail({
      state: "creating",
      created_at: new Date(2026, 10, 18, 10, 0, 0).toISOString(),
    });

    expect(screen.queryByText(/%/)).toBeNull();
    expect(
      document.querySelector(".myservers__progress-head")?.textContent,
    ).toContain("正在建机器");
    expect(screen.getByText("已等待 0 秒")).toBeTruthy();
    expect(document.querySelector(".myservers__steps")).toBeNull();
    const segments = [...document.querySelectorAll(".myservers__bar span")];
    expect(segments).toHaveLength(4);
    expect(segments[0].classList.contains("is-current")).toBe(true);
    expect(segments[1].className).toBe("");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("已等待 1 秒")).toBeTruthy();
  });

  it("阶段超过 180 秒换成「还在继续」，没有阶段数据就不编", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 5, 0) });
    const view = renderDetail({
      state: "installing",
      installing_at: new Date(2026, 10, 18, 10, 1, 59).toISOString(),
    });
    expect(screen.getByText("这一步已经 3 分钟，还在继续。")).toBeTruthy();
    view.unmount();

    // booting 没有阶段字段：等再久也不编「已经 X 分钟」。
    const booting = renderDetail({
      state: "booting",
      created_at: new Date(2026, 10, 18, 9, 0, 0).toISOString(),
    });
    expect(
      screen.getByText("服务器已创建，正在启动，通常 30–60 秒。"),
    ).toBeTruthy();
    expect(screen.queryByText(/还在继续/)).toBeNull();
    booting.unmount();

    // installing 但 Host 还没给 installing_at：同样不显示阶段耗时、不编数。
    renderDetail({
      state: "installing",
      created_at: new Date(2026, 10, 18, 9, 0, 0).toISOString(),
      installing_at: null,
    });
    expect(
      screen.getByText("正在下载节点程序并启动服务，通常 2–4 分钟。"),
    ).toBeTruthy();
    expect(screen.queryByText(/还在继续/)).toBeNull();
    expect(screen.queryByText(/这一步已经/)).toBeNull();
  });

  it("安装中拿到 sing-box 版本就显示出来", () => {
    renderDetail({
      state: "installing",
      installing_at: new Date(Date.now() - 10_000).toISOString(),
      singbox_version: "1.14.4",
    });
    expect(
      screen.getByText("正在安装 sing-box 1.14.4，通常 2–4 分钟。"),
    ).toBeTruthy();
  });

  it("流量行只说这台已用多少，不再写每月额度", () => {
    renderDetail({
      transfer_gib: 1000,
      traffic_used_bytes: 6 * GIB,
      traffic_limit_bytes: 20 * GIB,
      traffic_state: "ok",
    });

    const dd = screen.getByText(/^已用 6 GiB/).closest("dd");
    expect(dd?.textContent).not.toMatch(
      /每月|已释放|可用|剩余|%|共用额度|同账户/,
    );
    // 空串清零点不渲染日期。
    expect(dd?.textContent).not.toContain("重置");
  });

  it("就绪详情页没有任何连接相关按钮：连接只在控制台", () => {
    for (const state of ["healthy", "active"] as const) {
      const view = renderDetail({ node_id: null, state });
      expect(screen.queryByRole("button", { name: /连接|断开/ })).toBeNull();
      const detail = document.querySelector(".myservers__detail");
      expect(detail?.querySelectorAll(".btn--primary").length).toBe(0);
      view.unmount();
    }
  });

  it("active 的详情标题写「已开通」，不写「已在使用」", () => {
    renderDetail({ state: "active" });

    expect(screen.getByText("已开通")).toBeTruthy();
    expect(screen.queryByText("已在使用")).toBeNull();
    // 就绪态不渲染进度块，也不再有「用了 X」。
    expect(document.querySelector(".myservers__progress")).toBeNull();
  });

  it("主按钮：建机中没有、失败重建、失效重购；全文没有断开", () => {
    const cases: Array<[MyServerState, string | null]> = [
      ["healthy", null],
      ["active", null],
      ["creating", null],
      ["booting", null],
      ["installing", null],
      ["verifying", null],
      ["error", "重新建一台"],
      ["gone", "重新购买"],
      ["destroying", null],
    ];

    for (const [state, label] of cases) {
      const view = renderDetail({ state });
      const detail = document.querySelector(".myservers__detail");
      expect(detail?.textContent).not.toContain("断开");
      expect(screen.queryByRole("button", { name: /连接/ })).toBeNull();
      const primaries = detail?.querySelectorAll(".btn--primary") ?? [];
      expect(primaries.length).toBeLessThanOrEqual(1);
      if (label) {
        expect(screen.getByRole("button", { name: label })).toBeTruthy();
        expect(primaries.length).toBe(1);
      } else {
        expect(primaries.length).toBe(0);
      }
      view.unmount();
    }
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

describe("服务器重命名", () => {
  function harness(
    opts: {
      initial?: Partial<MyServer>;
      rename?: (id: string, name: string) => Promise<MyServer>;
      onSaved?: (server: MyServer) => void;
    } = {},
  ) {
    const rename = vi.fn(
      opts.rename ??
        (async (_id: string, name: string) => server({ name })),
    );
    const bridge = { myServerRename: rename } as unknown as AgentBridge;
    function Harness() {
      const [current, setCurrent] = useState(server(opts.initial ?? {}));
      return (
        <MyServerDetail
          bridge={bridge}
          server={current}
          regionLabel="新加坡 1"
          onCreateAnother={vi.fn()}
          onChanged={() => {}}
          onRebuilt={() => {}}
          onGone={vi.fn()}
          onForget={async () => {}}
          onRenamed={(next) => {
            setCurrent(next);
            opts.onSaved?.(next);
          }}
        />
      );
    }
    render(<Harness />);
    return { rename };
  }

  const openEditor = () => {
    fireEvent.click(
      screen.getByRole("button", { name: "重命名 新加坡 1 · DigitalOcean" }),
    );
    return screen.getByRole("textbox", {
      name: "服务器名称",
    }) as HTMLInputElement;
  };

  it("回车提交：调用命令、详情与按钮名一起更新，焦点回铅笔", async () => {
    const { rename } = harness();
    const input = openEditor();
    // 进入编辑即全选。
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    fireEvent.change(input, { target: { value: "  东京新机  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(rename).toHaveBeenCalledWith("srv_1", "东京新机"),
    );
    expect(
      await screen.findByRole("heading", { name: "东京新机" }),
    ).toBeTruthy();
    const pencil = screen.getByRole("button", { name: "重命名 东京新机" });
    expect(document.activeElement).toBe(pencil);
  });

  it("Esc 取消：不调命令，焦点回铅笔", () => {
    const { rename } = harness();
    const input = openEditor();
    fireEvent.change(input, { target: { value: "改一半" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "服务器名称" })).toBeNull();
    expect(rename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "重命名 新加坡 1 · DigitalOcean" }),
    );
  });

  it("输入法组字中的回车不提交", () => {
    const { rename } = harness();
    const input = openEditor();
    fireEvent.change(input, { target: { value: "とうきょう" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(rename).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "服务器名称" })).toBeTruthy();
  });

  it("失焦既不提交也不退出编辑", () => {
    const { rename } = harness();
    const input = openEditor();
    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.blur(input);

    expect(rename).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "服务器名称" })).toBeTruthy();
  });

  it("校验：空、只有空格、超过 24 个字符", () => {
    const { rename } = harness();
    const input = openEditor();

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("名字不能为空。");

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain(
      "名字不能只有空格。",
    );

    fireEvent.change(input, { target: { value: "名".repeat(25) } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain(
      "名字最多 24 个字符。",
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("server-name-error");
    expect(rename).not.toHaveBeenCalled();
  });

  it("销毁中与已失效时不显示改名入口", () => {
    for (const state of ["destroying", "gone"] as const) {
      const view = renderDetail({ state });
      expect(screen.queryByRole("button", { name: /^重命名/ })).toBeNull();
      view.unmount();
    }
  });

  it("emoji 按一个字符计数：24 个 emoji 可以提交", async () => {
    const { rename } = harness();
    const input = openEditor();
    const emoji = "😀".repeat(24);

    fireEvent.change(input, { target: { value: emoji } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(rename).toHaveBeenCalledWith("srv_1", emoji));
  });

  it("保存中禁用并清空显示，失败保留输入与焦点", async () => {
    let reject: (error: unknown) => void = () => {};
    const gate = new Promise<MyServer>((_resolve, rej) => {
      reject = rej;
    });
    harness({ rename: () => gate });
    const input = openEditor();
    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // 保存中不 disabled（真实浏览器会因此丢焦点），只读且保留原值。
    await waitFor(() => {
      const current = screen.getByRole("textbox", {
        name: "服务器名称",
      }) as HTMLInputElement;
      expect(current.readOnly).toBe(true);
      expect(current.disabled).toBe(false);
      expect(current.value).toBe("新名字");
    });

    reject({ code: "NETWORK", message: "连不上。", retryable: true });

    const after = (await screen.findByRole("textbox", {
      name: "服务器名称",
    })) as HTMLInputElement;
    await waitFor(() => expect(after.readOnly).toBe(false));
    expect(after.value).toBe("新名字");
    expect(document.activeElement).toBe(after);
    expect(screen.getByRole("alert").textContent).toContain(
      "没连上服务器，检查网络后再试。",
    );
  });
});

describe("停机删除的墓碑", () => {
  function renderTombstone(over: Partial<MyServer> = {}, onForget = vi.fn(async () => {})) {
    render(
      <MyServerDetail
        bridge={{ myServerDestroy: vi.fn() } as unknown as AgentBridge}
        server={server({ state: "destroyed", billing_state: "expired", ...over })}
        regionLabel="新加坡 1"
        onCreateAnother={vi.fn()}
        onChanged={() => {}}
        onRebuilt={() => {}}
        onGone={vi.fn()}
        onForget={onForget}
      />,
    );
    return { onForget };
  }

  it("只有一句说明和一个删除入口，不提供续费 / 重建 / 销毁", () => {
    renderTombstone();

    expect(
      screen.getByText("这台机器因余额不足已停机销毁，节点不能再连接。删除后不再显示。"),
    ).toBeTruthy();
    expect(screen.getByText("已停机删除")).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    // 停机删除压过欠费词：同一台机器不说「已停用」。
    expect(screen.queryByText("已停用")).toBeNull();
    expect(screen.queryByRole("button", { name: /销毁/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /重命名/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /重新建一台|重新购买/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "建机进度" })).toBeNull();
  });

  it("二次确认后带上 server_id 与 local_node_id 去删节点", async () => {
    const { onForget } = renderTombstone();

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(onForget).toHaveBeenCalledWith("srv_1", "local_node_1"),
    );
  });

  it("墓碑没有本地节点：删除入口不可点", () => {
    renderTombstone({ local_node_id: null });

    expect(
      (screen.getByRole("button", { name: "删除" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("删除失败：详情还在，错误就地说清楚", async () => {
    const onForget = vi.fn(async () => {
      throw { code: "NETWORK", message: "连不上。", retryable: true };
    });
    renderTombstone({}, onForget);

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    const alert = await screen.findByText(/没连上服务器/);
    expect(alert.textContent).toContain("没有改动这台服务器");
    // 墓碑没被乐观移除：说明句还在，确认入口还能再点。
    expect(
      screen.getByText("这台机器因余额不足已停机销毁，节点不能再连接。删除后不再显示。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认删除" })).toBeTruthy();
  });
});

describe("事实区的 IP", () => {
  it("就绪时显示 IP 与复制按钮，不带端口", () => {
    renderDetail();

    expect(screen.getByText("IP")).toBeTruthy();
    expect(screen.getByText("45.76.20.100")).toBeTruthy();
    expect(screen.queryByText(/8388/)).toBeNull();
    expect(screen.getByRole("button", { name: "复制 IP" })).toBeTruthy();

    // 行序：地区 → IP → 节点。
    const labels = [...document.querySelectorAll(".myservers__facts dt")].map(
      (dt) => dt.textContent,
    );
    expect(labels.indexOf("地区")).toBeLessThan(labels.indexOf("IP"));
    expect(labels.indexOf("IP")).toBeLessThan(labels.indexOf("节点"));
  });

  it("建机中不渲染这一行", () => {
    renderDetail({ state: "booting" });

    expect(screen.queryByText("IP")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制 IP" })).toBeNull();
  });

  it("出错与已销毁都不占这一行", () => {
    renderDetail({ state: "error" });
    expect(screen.queryByText("IP")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制 IP" })).toBeNull();

    cleanup();
    renderDetail({ state: "destroyed" });
    expect(screen.queryByText("IP")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制 IP" })).toBeNull();
  });

  it("复制成功变「已复制」，1.5 秒后还原", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "复制 IP" }));
    await act(async () => {});
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("45.76.20.100");
    expect(
      screen.getByRole("button", { name: "复制 IP" }).textContent,
    ).toBe("已复制");

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(
      screen.getByRole("button", { name: "复制 IP" }).textContent,
    ).toBe("复制");
  });

  it("复制失败显示「复制失败」，同样 1.5 秒还原", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "复制 IP" }));
    await act(async () => {});
    expect(
      screen.getByRole("button", { name: "复制 IP" }).textContent,
    ).toBe("复制失败");

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(
      screen.getByRole("button", { name: "复制 IP" }).textContent,
    ).toBe("复制");
  });
});

describe("IP 复制在途时切服务器", () => {
  function detailElement(over: Partial<MyServer>) {
    return (
      <MyServerDetail
        bridge={{ myServerDestroy: vi.fn() } as unknown as AgentBridge}
        server={server(over)}
        regionLabel="新加坡 1"
        onCreateAnother={vi.fn()}
        onChanged={() => {}}
        onRebuilt={() => {}}
        onGone={vi.fn()}
        onForget={async () => {}}
      />
    );
  }

  it("上一台的复制结果不落到新面板上", async () => {
    let resolveCopy: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      resolveCopy = resolve;
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => pending) },
    });

    const view = render(detailElement({}));
    fireEvent.click(screen.getByRole("button", { name: "复制 IP" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("45.76.20.100");

    // 复制还没回来就换了一台。
    view.rerender(
      detailElement({ server_id: "srv_2", ip: "198.51.100.7" }),
    );
    expect(screen.getByText("198.51.100.7")).toBeTruthy();

    resolveCopy();
    await act(async () => {});

    expect(
      screen.getByRole("button", { name: "复制 IP" }).textContent,
    ).toBe("复制");
  });
});

describe("更换连接密码", () => {
  function renderRotate(
    over: Partial<MyServer> = {},
    options: {
      rotate?: (serverId: string) => Promise<{ ok: true; port: number; refreshed: boolean }>;
      destroy?: () => Promise<MyServer>;
      onChanged?: () => void;
      readOnly?: boolean;
      bridged?: boolean;
    } = {},
  ) {
    const rotate = vi.fn(
      options.rotate ??
        (async () => ({ ok: true as const, port: 32101, refreshed: true })),
    );
    const onChanged = options.onChanged ?? vi.fn();
    const bridge = {
      myServerDestroy: vi.fn(options.destroy ?? (async () => server())),
      ...(options.bridged === false ? {} : { nodeRotateCredentials: rotate }),
    } as unknown as AgentBridge;
    const element = (next: Partial<MyServer>) => (
      <MyServerDetail
        bridge={bridge}
        server={server(next)}
        regionLabel="新加坡 1"
        readOnly={options.readOnly}
        onCreateAnother={vi.fn()}
        onChanged={onChanged}
        onRebuilt={() => {}}
        onGone={vi.fn()}
        onForget={async () => {}}
      />
    );
    const view = render(element(over));
    return {
      rotate,
      onChanged,
      rerender: (next: Partial<MyServer>) => view.rerender(element(next)),
    };
  }

  it("只在 healthy / active 且节点就绪时出现", () => {
    for (const state of ["healthy", "active"] as MyServerState[]) {
      renderRotate({ state });
      const entry = screen.getByRole("button", { name: "更换连接密码" });
      expect(entry.classList.contains("btn--ghost")).toBe(true);
      expect(entry.classList.contains("btn--danger-ghost")).toBe(false);
      cleanup();
    }
    for (const state of [
      "creating",
      "booting",
      "installing",
      "verifying",
      "error",
      "destroying",
      "destroyed",
      "gone",
    ] as MyServerState[]) {
      renderRotate({ state });
      expect(screen.queryByRole("button", { name: "更换连接密码" })).toBeNull();
      cleanup();
    }
  });

  it("没有 node_id 或桥接里没有这条命令时不出现", () => {
    renderRotate({ node_id: null });
    expect(screen.queryByRole("button", { name: "更换连接密码" })).toBeNull();
    cleanup();

    renderRotate({}, { bridged: false });
    expect(screen.queryByRole("button", { name: "更换连接密码" })).toBeNull();
  });

  it("只读时不给入口", () => {
    renderRotate({}, { readOnly: true });
    expect(screen.queryByRole("button", { name: "更换连接密码" })).toBeNull();
  });

  it("点一次进就地确认，取消不调用", () => {
    const { rotate } = renderRotate();

    fireEvent.click(screen.getByRole("button", { name: "更换连接密码" }));
    expect(document.querySelector(".myservers__confirm")?.textContent).toContain(
      "更换后旧的端口和密码立刻失效",
    );
    // 确认按钮用独立文案，不和入口同名。
    expect(screen.getByRole("button", { name: "确认更换" })).toBeTruthy();
    expect(rotate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(document.querySelector(".myservers__confirm")).toBeNull();
    expect(rotate).not.toHaveBeenCalled();
  });

  it("入口消失（状态变了）时收回确认态", () => {
    const { rerender } = renderRotate();
    fireEvent.click(screen.getByRole("button", { name: "更换连接密码" }));
    expect(document.querySelector(".myservers__confirm")).not.toBeNull();

    rerender({ state: "error" });
    expect(document.querySelector(".myservers__confirm")).toBeNull();
    expect(screen.queryByRole("button", { name: "更换连接密码" })).toBeNull();
  });

  it("Esc 取消确认，不调用", () => {
    const { rotate } = renderRotate();

    fireEvent.click(screen.getByRole("button", { name: "更换连接密码" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".myservers__confirm")).toBeNull();
    expect(rotate).not.toHaveBeenCalled();
  });

  it("确认态 8 秒无操作自动收回", () => {
    vi.useFakeTimers();
    renderRotate();

    fireEvent.click(screen.getByRole("button", { name: "更换连接密码" }));
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(document.querySelector(".myservers__confirm")).toBeNull();
  });

  it("确认内交互重新计时，块外交互不算", () => {
    vi.useFakeTimers();
    renderRotate();
    fireEvent.click(screen.getByRole("button", { name: "更换连接密码" }));
    const block = () => document.querySelector(".myservers__confirm");
    expect(block()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    // 块内敲一下键：重新计时。
    fireEvent.keyDown(block() as Element, { key: "a" });
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(block()).not.toBeNull();

    // 距最后一次交互已 9 秒：收回。
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(block()).toBeNull();
  });

  it("块外的点击与按键不续时", () => {
    vi.useFakeTimers();
    renderRotate();
    fireEvent.click(screen.getByRole("button", { name: "更换连接密码" }));

    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    fireEvent.keyDown(document.body, { key: "a" });
    fireEvent.pointerDown(document.body);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(document.querySelector(".myservers__confirm")).toBeNull();
  });

  it("确认后调用一次，显示成功文案并刷新详情", async () => {
    const { rotate, onChanged } = renderRotate();

    fireEvent.click(screen.getByRole("button", { name: "更换连接密码" }));
    fireEvent.click(screen.getByRole("button", { name: "确认更换" }));
    await act(async () => {});

    expect(rotate).toHaveBeenCalledTimes(1);
    expect(rotate).toHaveBeenCalledWith("srv_1");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "已更换。手机上的配置要重新导入一次。",
    );
    expect(document.querySelector(".myservers__confirm")).toBeNull();
  });

  it("成功但本机没刷新：显示另一句，不说「已更换」", async () => {
    const { onChanged } = renderRotate({}, {
      rotate: async () => ({ ok: true as const, port: 32101, refreshed: false }),
    });

    fireEvent.click(screen.getByRole("button", { name: "更换连接密码" }));
    fireEvent.click(screen.getByRole("button", { name: "确认更换" }));
    await act(async () => {});

    expect(document.body.textContent).toContain(
      "已更换，但本机数据没刷新。请重新连接，或刷新服务器数据。",
    );
    expect(document.body.textContent).not.toContain(
      "已更换。手机上的配置要重新导入一次。",
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("失败时显示失败文案，事实区不变", async () => {
    renderRotate({}, {
      rotate: async () => {
        throw { code: "agent_unreachable", message: "", retryable: true };
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "更换连接密码" }));
    fireEvent.click(screen.getByRole("button", { name: "确认更换" }));
    await act(async () => {});

    expect(document.body.textContent).toContain(
      "没能更换。节点可能暂时连不上，稍后再试。",
    );
    const facts = document.querySelector(".myservers__facts")?.textContent ?? "";
    expect(facts).toContain("新加坡 1");
    expect(facts).toContain("每天 $0.20");
    expect(document.querySelector(".myservers__confirm")).toBeNull();
  });

  it("更换过程中按钮禁用并显示进行中文案", async () => {
    let finish: () => void = () => {};
    const pending = new Promise<{ ok: true; port: number; refreshed: boolean }>(
      (resolve) => {
        finish = () => resolve({ ok: true, port: 32101, refreshed: true });
      },
    );
    renderRotate({}, { rotate: () => pending });

    fireEvent.click(screen.getByRole("button", { name: "更换连接密码" }));
    fireEvent.click(screen.getByRole("button", { name: "确认更换" }));

    const busy = screen.getByRole("button", { name: "正在更换…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(
      (screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // 在途时 Esc 不能撤掉确认块（取消按钮已禁用）。
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".myservers__confirm")).not.toBeNull();

    await act(async () => {
      finish();
    });
    expect(document.body.textContent).toContain(
      "已更换。手机上的配置要重新导入一次。",
    );
    // 确认块卸载后焦点回到入口。
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "更换连接密码" }),
    );
  });

  it("在途时切服务器：结果不落到新面板，也不解开新面板的忙态", async () => {
    let finishRotate: () => void = () => {};
    const rotatePending = new Promise<{
      ok: true;
      port: number;
      refreshed: boolean;
    }>((resolve) => {
      finishRotate = () => resolve({ ok: true, port: 32101, refreshed: true });
    });
    let finishDestroy: (server: MyServer) => void = () => {};
    const destroyPending = new Promise<MyServer>((resolve) => {
      finishDestroy = resolve;
    });
    const { rerender } = renderRotate(
      {},
      {
        rotate: () => rotatePending,
        destroy: () => destroyPending,
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "更换连接密码" }));
    fireEvent.click(screen.getByRole("button", { name: "确认更换" }));

    // 请求还没回来就换了另一台，并在新面板上开始销毁。
    rerender({ server_id: "srv_2", ip: "198.51.100.7" });
    fireEvent.click(screen.getByRole("button", { name: "销毁" }));
    fireEvent.click(screen.getByRole("button", { name: "确认销毁" }));
    const destroying = screen.getByRole("button", { name: "正在销毁…" });
    expect((destroying as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      finishRotate();
    });
    // 上一台的结果不落到 srv_2，也不把 srv_2 正在跑的销毁解锁。
    expect(document.body.textContent).not.toContain(
      "已更换。手机上的配置要重新导入一次。",
    );
    expect(document.body.textContent).not.toContain("没能更换。");
    expect(
      (screen.getByRole("button", { name: "正在销毁…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => {
      finishDestroy(server({ server_id: "srv_2", state: "destroyed" }));
    });
  });
});

describe("sing-box 升级", () => {
  function renderUpgrade(
    over: Partial<MyServer> = {},
    options: {
      upgrade?: (serverId: string) => Promise<{
        installed: string;
        target: string;
        upgraded: boolean;
      }>;
      onChanged?: () => void;
      onRenamed?: (server: MyServer) => void;
      fresh?: MyServer;
      readOnly?: boolean;
      bridged?: boolean;
    } = {},
  ) {
    const upgrade = vi.fn(
      options.upgrade ??
        (async () => ({
          installed: "1.14.4",
          target: "1.15.0",
          upgraded: true,
        })),
    );
    const onChanged = options.onChanged ?? vi.fn();
    const bridge = {
      myServerDestroy: vi.fn(async () => server()),
      myServerGet: vi.fn(
        async (serverId: string) => options.fresh ?? server({ server_id: serverId }),
      ),
      ...(options.bridged === false ? {} : { nodeUpgradeSingbox: upgrade }),
    } as unknown as AgentBridge;
    const element = (next: Partial<MyServer>) => (
      <MyServerDetail
        bridge={bridge}
        server={server(next)}
        regionLabel="新加坡 1"
        readOnly={options.readOnly}
        onCreateAnother={vi.fn()}
        onChanged={onChanged}
        onRebuilt={() => {}}
        onGone={vi.fn()}
        onForget={async () => {}}
        onRenamed={options.onRenamed}
      />
    );
    const view = render(element(over));
    return {
      upgrade,
      onChanged,
      rerender: (next: Partial<MyServer>) => view.rerender(element(next)),
    };
  }

  it("事实区显示 sing-box 版本与检查升级入口", () => {
    renderUpgrade({ singbox_version: "1.14.4" });

    const facts = document.querySelector(".myservers__facts")?.textContent ?? "";
    expect(facts).toContain("sing-box");
    expect(facts).toContain("1.14.4");
    const entry = screen.getByRole("button", { name: "检查升级" });
    // 事实区里的小按钮，不是主按钮。
    expect(entry.classList.contains("copy-btn")).toBe(true);
    expect(entry.classList.contains("btn--primary")).toBe(false);
  });

  it("没有版本时显示「未知」，按钮仍可点", () => {
    renderUpgrade({ singbox_version: null });

    const facts = document.querySelector(".myservers__facts")?.textContent ?? "";
    expect(facts).toContain("未知");
    const entry = screen.getByRole("button", { name: "检查升级" });
    expect((entry as HTMLButtonElement).disabled).toBe(false);
  });

  it("只在 healthy / active 且有节点 id、Host 接了命令时出现", () => {
    for (const state of [
      "creating",
      "booting",
      "installing",
      "verifying",
      "error",
      "destroying",
      "destroyed",
      "gone",
    ] as MyServerState[]) {
      renderUpgrade({ state });
      expect(screen.queryByRole("button", { name: "检查升级" })).toBeNull();
      cleanup();
    }

    renderUpgrade({ node_id: null });
    expect(screen.queryByRole("button", { name: "检查升级" })).toBeNull();
    cleanup();

    renderUpgrade({}, { bridged: false });
    expect(screen.queryByRole("button", { name: "检查升级" })).toBeNull();
    cleanup();

    renderUpgrade({}, { readOnly: true });
    expect(screen.queryByRole("button", { name: "检查升级" })).toBeNull();
  });

  it("点一次用一次，显示升级结果并刷新详情", async () => {
    const { upgrade, onChanged } = renderUpgrade({ singbox_version: "1.14.4" });

    fireEvent.click(screen.getByRole("button", { name: "检查升级" }));
    await act(async () => {});

    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(upgrade).toHaveBeenCalledWith("srv_1");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("已升级到 1.15.0");
    // 控制面还没刷新：这一行先用返回的 target 就地更新。
    expect(document.querySelector(".myservers__facts")?.textContent).toContain(
      "1.15.0",
    );
    // 焦点回到入口。
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "检查升级" }),
    );
  });

  it("成功后回源一次，用 Host 返回的完整对象更新详情", async () => {
    const fresh = server({ singbox_version: "1.15.0" });
    const onRenamed = vi.fn();
    const onChanged = vi.fn();
    const { upgrade } = renderUpgrade(
      { singbox_version: "1.14.4" },
      { fresh, onRenamed, onChanged },
    );

    fireEvent.click(screen.getByRole("button", { name: "检查升级" }));
    await act(async () => {});

    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(onRenamed).toHaveBeenCalledTimes(1);
    expect(onRenamed).toHaveBeenCalledWith(fresh);
    // 已经有完整对象，不再整表重拉。
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("已是最新时说已是最新，带上当前版本", async () => {
    renderUpgrade(
      { singbox_version: "1.14.4" },
      {
        upgrade: async () => ({
          installed: "1.14.4",
          target: "1.14.4",
          upgraded: false,
        }),
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "检查升级" }));
    await act(async () => {});

    expect(document.body.textContent).toContain("已是最新（1.14.4）");
    expect(document.body.textContent).not.toContain("已升级到");
  });

  it("已安装版本读不到时用 unknown 占位，不当成版本显示", async () => {
    renderUpgrade(
      {},
      {
        upgrade: async () => ({
          installed: "unknown",
          target: "",
          upgraded: false,
        }),
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "检查升级" }));
    await act(async () => {});

    expect(document.body.textContent).toContain("已是最新（未知）");
    expect(document.querySelector(".myservers__facts")?.textContent).not.toContain(
      "unknown",
    );
  });

  it("失败按 reason 给文案，事实区不变", async () => {
    renderUpgrade(
      { singbox_version: "1.14.4" },
      {
        upgrade: async () => {
          throw {
            code: "TIMEOUT",
            message: "",
            retryable: true,
            details: { reason: "agent_timeout" },
          };
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "检查升级" }));
    await act(async () => {});

    expect(document.body.textContent).toContain(
      "节点 180 秒内没完成升级，稍后再检查一次。",
    );
    const facts = document.querySelector(".myservers__facts")?.textContent ?? "";
    expect(facts).toContain("1.14.4");
  });

  it("控制面拿不到门票时单独提示，不把用户引去查节点", async () => {
    renderUpgrade(
      {},
      {
        upgrade: async () => {
          throw {
            code: "UPSTREAM_ERROR",
            message: "",
            retryable: true,
            details: { reason: "agent_token_unavailable" },
          };
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "检查升级" }));
    await act(async () => {});

    expect(document.body.textContent).toContain(
      "暂时连不上控制面，没能开始升级。稍后再试。",
    );
    expect(document.body.textContent).not.toContain("节点还没准备好");
  });

  it("认不出的失败码走兜底文案，不把后端原文抛给用户", async () => {
    renderUpgrade(
      {},
      {
        upgrade: async () => {
          throw { code: "INTERNAL", message: "boom", retryable: false };
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "检查升级" }));
    await act(async () => {});

    expect(document.body.textContent).toContain(
      "没能升级。节点可能暂时连不上，稍后再试。",
    );
    expect(document.body.textContent).not.toContain("boom");
  });

  it("节点忙时给「正在执行其他操作」，不说成一般失败", async () => {
    renderUpgrade(
      {},
      {
        upgrade: async () => {
          throw {
            code: "INTERNAL",
            message: "",
            retryable: true,
            details: { reason: "agent_busy" },
          };
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "检查升级" }));
    await act(async () => {});

    expect(document.body.textContent).toContain(
      "节点正在执行其他操作，稍后再试。",
    );
    expect(document.body.textContent).not.toContain("没能升级");
  });

  it("进行中按钮禁用并显示进行中文案", async () => {
    let finish: () => void = () => {};
    const pending = new Promise<{
      installed: string;
      target: string;
      upgraded: boolean;
    }>((resolve) => {
      finish = () =>
        resolve({ installed: "1.14.4", target: "1.15.0", upgraded: true });
    });
    renderUpgrade({ singbox_version: "1.14.4" }, { upgrade: () => pending });

    fireEvent.click(screen.getByRole("button", { name: "检查升级" }));

    const busy = screen.getByRole("button", { name: "正在升级…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    // 升级会重启节点：进行中必须说清楚当前连接会中断。
    expect(document.body.textContent).toContain(
      "升级会重启节点，当前连接会短暂中断。",
    );
    // 升级在途时不能顺手销毁这台机器。
    expect(
      (screen.getByRole("button", { name: "销毁" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      finish();
    });
    expect(document.body.textContent).toContain("已升级到 1.15.0");
    expect(
      (screen.getByRole("button", { name: "销毁" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("在途时切服务器：结果不落到新面板", async () => {
    let finish: () => void = () => {};
    const pending = new Promise<{
      installed: string;
      target: string;
      upgraded: boolean;
    }>((resolve) => {
      finish = () =>
        resolve({ installed: "1.14.4", target: "1.15.0", upgraded: true });
    });
    const { rerender } = renderUpgrade(
      { singbox_version: "1.14.4" },
      { upgrade: () => pending },
    );

    fireEvent.click(screen.getByRole("button", { name: "检查升级" }));
    rerender({ server_id: "srv_2", singbox_version: "1.12.0" });

    await act(async () => {
      finish();
    });
    expect(document.body.textContent).not.toContain("已升级到");
    expect(document.body.textContent).not.toContain("没能升级");
    expect(
      (screen.getByRole("button", { name: "检查升级" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("流量行（2.78.0）", () => {
  const traffic = (over: Partial<MyServer> = {}) =>
    renderDetail({
      traffic_used_bytes: 6 * GIB,
      traffic_limit_bytes: 20 * GIB,
      traffic_state: "ok",
      ...over,
    });

  it("只写这台已用多少；有清零点时按本地日写在行尾", () => {
    traffic({
      traffic_reset_at: new Date(2026, 11, 1, 0, 0, 0).toISOString(),
    });

    const dd = screen.getByText(/^已用 6 GiB/).closest("dd");
    expect(screen.getByText("12月1日重置")).toBeTruthy();
    expect(dd?.textContent).not.toMatch(/已释放|可用|剩余|%|快用完|已超出/);
  });
  it("额度未知：不写已释放，也不写可用", () => {
    traffic({
      traffic_used_bytes: 512 * 1024 ** 2,
      traffic_limit_bytes: 0,
    });

    const dd = screen.getByText(/已用 0\.5 GiB/).closest("dd");
    expect(dd?.textContent).toContain("额度未知");
    expect(dd?.textContent).not.toMatch(/已释放|可用|剩余/);
  });

  it("unpaid：墓碑说流量停机，状态点琥珀，不渲染流量行", () => {
    renderDetail({
      state: "destroyed",
      traffic_state: "unpaid",
      traffic_used_bytes: 42 * GIB,
      traffic_limit_bytes: 20 * GIB,
      failure: {
        stage: "active",
        code: "traffic_overage",
        message: "流量超支，余额不足已停机",
        retryable: false,
      },
    });

    expect(screen.getByText("流量超支，余额不足已停机")).toBeTruthy();
    expect(
      document.querySelector(".myservers__state")?.className,
    ).toContain("is-warn");
    expect(screen.queryByText("流量")).toBeNull();
    expect(screen.queryByText(/已用/)).toBeNull();
  });

  it("英文只说 Used；两个 span 之间有空格", () => {
    setLanguage("en");
    try {
      renderDetail({
        traffic_used_bytes: 37 * GIB,
        traffic_limit_bytes: 35 * GIB,
        traffic_state: "ok",
        traffic_reset_at: new Date(2026, 11, 1, 0, 0, 0).toISOString(),
      });

      const dd = screen.getByText(/Used 37 GiB/).closest("dd");
      expect(dd?.textContent).toContain("GiB Resets Dec 1");
      expect(dd?.textContent).not.toMatch(/released|over|limit by/i);
    } finally {
      setLanguage("zh");
    }
  });

  it("error / destroying / gone 都不渲染流量行", () => {
    for (const state of ["error", "destroying", "gone"] as const) {
      const view = renderDetail({
        state,
        traffic_used_bytes: 6 * GIB,
        traffic_limit_bytes: 20 * GIB,
        traffic_state: "ok",
      });
      expect(screen.queryByText("流量"), state).toBeNull();
      expect(screen.queryByText(/已用/), state).toBeNull();
      view.unmount();
    }
  });

  it("destroyed：也不渲染流量行", () => {
    renderDetail({
      state: "destroyed",
      traffic_state: "ok",
      traffic_used_bytes: 42 * GIB,
      traffic_limit_bytes: 20 * GIB,
    });

    expect(screen.queryByText("流量")).toBeNull();
    expect(screen.queryByText(/已用/)).toBeNull();
    // 通用墓碑文案仍在。
    expect(screen.getByText(/因余额不足已停机销毁/)).toBeTruthy();
  });

  it("销毁确认说明额度后果，数字是这台自己的日额度", () => {
    renderDetail({ transfer_gib: 1000, traffic_limit_bytes: 0 });

    fireEvent.click(screen.getByRole("button", { name: "销毁" }));
    const note = screen.getByText(/每天加 35\.7 GiB/);
    expect(note.textContent).toContain("删掉后本月额度不再增长");
    expect(note.textContent).toContain("已用的流量仍然算在账号里");
  });

  it("封顶机器或额度为 0：销毁确认里没有「每天加」那句", () => {
    renderDetail({
      transfer_gib: 1000,
      traffic_limit_bytes: 1000 * GIB,
    });
    fireEvent.click(screen.getByRole("button", { name: "销毁" }));
    expect(screen.queryByText(/每天加/)).toBeNull();
    // 其它确认文案保留。
    expect(screen.getByText(/销毁后不再产生新费用/)).toBeTruthy();
    cleanup();

    renderDetail({ transfer_gib: 0, traffic_limit_bytes: 0 });
    fireEvent.click(screen.getByRole("button", { name: "销毁" }));
    expect(screen.queryByText(/每天加/)).toBeNull();
  });
});
