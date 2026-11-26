/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, BillingLedger } from "../agent/bridge";
import { BillingLedgerTable, formatBillingDay } from "./BillingLedgerTable";

afterEach(cleanup);

const DAY = 24 * 60 * 60 * 1000;
const AT = new Date(2026, 10, 5, 12, 0, 0).getTime();
const SERVER = {
  id: "srv_1",
  name: "新加坡 1",
  plan: "s-1vcpu-1gb",
  region: "sgp1",
};

function ledger(over: Partial<BillingLedger> = {}): BillingLedger {
  return {
    balance_cents: 11806,
    currency: "USD",
    window_days: 30,
    truncated: false,
    // 与 entries 故意对不上：界面必须只用 totals。
    totals: { topup_cents: 12000, charge_cents: 294 },
    entries: [
      {
        id: "e1",
        kind: "topup",
        amount_cents: 12000,
        at: AT,
        server: null,
        note: null,
      },
      {
        id: "e2",
        kind: "machine_day",
        amount_cents: -20,
        at: AT - DAY,
        server: SERVER,
        note: null,
      },
      {
        id: "e3",
        kind: "traffic",
        amount_cents: -45,
        at: AT - 2 * DAY,
        server: SERVER,
        note: null,
      },
      {
        id: "e4",
        kind: "refund",
        amount_cents: 200,
        at: AT - 3 * DAY,
        server: SERVER,
        note: null,
      },
      {
        id: "e5",
        kind: "other",
        amount_cents: -80,
        at: AT - 4 * DAY,
        server: null,
        note: null,
      },
    ],
    ...over,
  };
}

function makeBridge(load: () => Promise<BillingLedger>): AgentBridge {
  return {
    mode: "mock",
    subscribe: vi.fn(() => () => {}),
    myServerBillingLedger: vi.fn(load),
  } as unknown as AgentBridge;
}

function renderTable(bridge: AgentBridge, language: "zh" | "en" = "zh") {
  render(<BillingLedgerTable bridge={bridge} language={language} />);
}

describe("近 30 天账单表格", () => {
  it("顶部汇总只用 totals，不按 entries 求和", async () => {
    renderTable(makeBridge(async () => ledger()));

    const summary = await screen.findByText(/余额 \$118\.06/);
    expect(summary.textContent).toContain("充值 $120.00");
    expect(summary.textContent).toContain("扣费 $2.94");
    // entries 求和会得到 $122.00 / $1.45，界面不能显示这两个数。
    expect(summary.textContent).not.toContain("$122.00");
    expect(summary.textContent).not.toContain("$1.45");
  });

  it("五种类别都有中文标签；机器费 / 流量超支 / 退款补机器标识，充值与 other 不补", async () => {
    renderTable(makeBridge(async () => ledger()));

    await screen.findByText("机器费");
    expect(screen.getByText("充值")).toBeTruthy();
    expect(screen.getByText("流量超支")).toBeTruthy();
    expect(screen.getByText("退款")).toBeTruthy();
    expect(screen.getByText("其他")).toBeTruthy();
    expect(
      screen.getAllByText("新加坡 1 · s-1vcpu-1gb / sgp1"),
    ).toHaveLength(3);
  });

  it("四列表头；充值行机器格留空，机器行有机器名", async () => {
    renderTable(makeBridge(async () => ledger()));
    await screen.findByText("机器费");

    expect(
      screen.getAllByRole("columnheader").map((head) => head.textContent),
    ).toEqual(["类别", "机器", "日期", "金额"]);

    const rows = screen.getAllByRole("row").slice(1);
    const topup = rows.find((row) => row.textContent?.includes("充值"))!;
    expect(within(topup).getAllByRole("cell")[1].textContent).toBe("");
    const machine = rows.find((row) => row.textContent?.includes("机器费"))!;
    expect(within(machine).getAllByRole("cell")[1].textContent).toBe(
      "新加坡 1 · s-1vcpu-1gb / sgp1",
    );
  });

  it("金额带正负号、固定两位小数；零金额不带号", async () => {
    renderTable(makeBridge(async () => ledger()));
    await screen.findByText("+$120.00");

    expect(screen.getByText("−$0.20")).toBeTruthy();
    expect(screen.getByText("−$0.45")).toBeTruthy();
    expect(screen.getByText("+$2.00")).toBeTruthy();
    expect(screen.getByText("−$0.80")).toBeTruthy();
    cleanup();

    renderTable(
      makeBridge(async () =>
        ledger({
          entries: [
            {
              id: "z1",
              kind: "other",
              amount_cents: 0,
              at: AT,
              server: null,
              note: null,
            },
          ],
        }),
      ),
    );
    expect(await screen.findByText("$0.00")).toBeTruthy();
    expect(screen.queryByText("+$0.00")).toBeNull();
    expect(screen.queryByText("−$0.00")).toBeNull();
  });

  it("日期按本地日显示，毫秒当毫秒用", async () => {
    renderTable(makeBridge(async () => ledger()));
    await screen.findByText("11月5日");
    expect(screen.getByText("11月4日")).toBeTruthy();
    expect(formatBillingDay(AT, "en")).toMatch(/^Nov\s+5$/);
  });

  it("空账本显示空态，汇总照常显示", async () => {
    renderTable(makeBridge(async () => ledger({ entries: [] })));
    await screen.findByText("最近 30 天没有消费");
    expect(screen.getByText(/余额 \$118\.06/)).toBeTruthy();
  });

  it("被截断时列表底部有一行脚注", async () => {
    renderTable(makeBridge(async () => ledger({ truncated: true })));
    await screen.findByText("只显示最近 1000 笔");
  });

  it("失败态给三段式文案，点重试重新读取", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce({ code: "TIMEOUT", message: "" })
      .mockResolvedValueOnce(ledger());
    renderTable(makeBridge(load as unknown as () => Promise<BillingLedger>));

    await screen.findByText("账单没有加载出来");
    expect(screen.getByText("账单服务没有按时返回。")).toBeTruthy();
    expect(
      screen.getByText("点「重试」；还是不行就稍后再来看。"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/余额 \$118\.06/)).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("权限错误用全站同一句；业务错误不冒充「连不上」", async () => {
    renderTable(
      makeBridge(async () => {
        throw { code: "PERMISSION_DENIED", message: "" };
      }),
    );
    await screen.findByText("没有权限做这个操作。");
    cleanup();

    renderTable(
      makeBridge(async () => {
        throw {
          code: "PRECONDITION_FAILED",
          message: "",
          details: { reason: "conflict" },
        };
      }),
    );
    await screen.findByText("账单暂时打不开。");
    expect(screen.queryByText("账单服务暂时连不上。")).toBeNull();
  });

  it("未登录与数据不完整各有自己的原因句", async () => {
    renderTable(
      makeBridge(async () => {
        throw { code: "UNAUTHENTICATED", message: "" };
      }),
    );
    await screen.findByText("需要先登录才能看账单。");
    cleanup();

    renderTable(
      makeBridge(async () => {
        throw {
          code: "UPSTREAM_ERROR",
          message: "",
          details: { reason: "invalid_response" },
        };
      }),
    );
    await screen.findByText("账单数据不完整。");
  });

  it("读取中显示占位，不显示空态", () => {
    renderTable(makeBridge(() => new Promise<BillingLedger>(() => {})));
    expect(screen.getByText("正在读取账单…")).toBeTruthy();
    expect(screen.queryByText("最近 30 天没有消费")).toBeNull();
  });
});
