/** @vitest-environment jsdom */
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServer, MyServerState } from "../agent/bridge";
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

describe("服务器详情", () => {
  it("健康检查失败但 node_id 还在：节点写「未就绪」", () => {
    renderDetail({ state: "error", node_id: "nd_control_1" });

    const term = screen.getByText("节点");
    const value = term.parentElement?.querySelector("dd");
    expect(value?.textContent).toBe("未就绪");
  });

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

  it("待开通（billing_state=pending）：费用行写开通后开始计费，流量照常", () => {
    renderDetail({
      state: "verifying",
      billing_state: "pending",
      paid_until: null,
      transfer_gib: 1000,
    });

    const facts = document.querySelector(".myservers__facts");
    expect(facts?.textContent).toContain("创建中，开通后开始计费");
    expect(facts?.textContent).not.toContain("本期有效至");
    expect(screen.getByText("流量")).toBeTruthy();
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
    expect(screen.getByText("装环境失败。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "去充值" })).toBeNull();
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

    // 就绪后进度块原地换成完成态：不再计时，四个步骤全打勾。
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
    expect(screen.getByRole("group", { name: "建机进度" })).toBeTruthy();
    const doneSteps = [...document.querySelectorAll(".myservers__steps li")];
    expect(doneSteps).toHaveLength(4);
    expect(
      doneSteps.every((step) => step.classList.contains("is-done")),
    ).toBe(true);
    expect(screen.getByText("用时未记录")).toBeTruthy();
  });

  it("重进详情不从零算：以阶段进入时间为基准", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 10, 0, 0) });
    renderDetail({
      state: "installing",
      created_at: new Date(2026, 10, 18, 9, 55, 0).toISOString(),
      installing_at: new Date(2026, 10, 18, 9, 58, 0).toISOString(),
    });

    // 安装阶段已过去 2 分钟，不因为刚打开详情而从 0 开始。
    expect(screen.getByText("已等待 2 分 0 秒")).toBeTruthy();
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

  it("就绪的机器显示创建用时；旧机器没有 ready_at 时写未知", () => {
    const created = "2026-11-18T10:00:00.000Z";
    const view = renderDetail({
      state: "healthy",
      created_at: created,
      ready_at: "2026-11-18T10:02:55.000Z",
    });
    const createdLine = document.querySelector(".myservers__created-in");
    expect(createdLine?.textContent).toContain("创建用时 2 分 55 秒");
    expect(createdLine?.querySelector(".num")?.textContent).toBe("2 分 55 秒");
    view.unmount();

    renderDetail({
      state: "healthy",
      created_at: created,
      ready_at: null,
    });
    expect(screen.getByText("用时未记录")).toBeTruthy();
  });

  it("没建成的机器不显示创建用时", () => {
    renderDetail({
      state: "error",
      created_at: "2026-11-18T10:00:00.000Z",
      ready_at: "2026-11-18T10:02:55.000Z",
    });
    expect(screen.queryByText(/创建用时/)).toBeNull();
  });

  it("建机进度不显示百分比，秒数每秒更新，当前阶段用 aria-current", () => {
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
    const steps = [...document.querySelectorAll(".myservers__steps li")];
    expect(steps[0].getAttribute("aria-current")).toBe("step");
    expect(steps[1].getAttribute("aria-current")).toBeNull();

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
    expect(screen.getByText("通常 2–4 分钟。")).toBeTruthy();
    expect(screen.queryByText(/还在继续/)).toBeNull();
    booting.unmount();

    // installing 但 Host 还没给 installing_at：同样不显示阶段耗时、不编数。
    renderDetail({
      state: "installing",
      created_at: new Date(2026, 10, 18, 9, 0, 0).toISOString(),
      installing_at: null,
    });
    expect(screen.getByText("通常 2–4 分钟。")).toBeTruthy();
    expect(screen.queryByText(/还在继续/)).toBeNull();
    expect(screen.queryByText(/这一步已经/)).toBeNull();
  });

  it("安装中拿到 sing-box 版本就显示出来", () => {
    renderDetail({
      state: "installing",
      installing_at: new Date(Date.now() - 10_000).toISOString(),
      singbox_version: "1.14.4",
    });
    expect(screen.getByText("正在安装 sing-box 1.14.4")).toBeTruthy();
  });

  it("流量行只留额度一个事实，不带括号补充", () => {
    renderDetail({ transfer_gib: 1000 });

    expect(screen.getByText("每月 1000 GB 出站")).toBeTruthy();
    expect(screen.queryByText(/共用额度|同账户/)).toBeNull();
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
    expect(screen.getByRole("alert").textContent).toContain("连不上");
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

    const alert = await screen.findByText(/连不上/);
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
