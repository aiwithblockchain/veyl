/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentBridge,
  BillingLedger,
  MyServerAccount,
  MyServerTopup,
  MyServerWallet,
} from "../agent/bridge";
import { AccountSurface } from "./AccountSurface";

afterEach(cleanup);

const WALLET: MyServerWallet = {
  balance_cents: 920,
  currency: "USD",
  denominations_cents: [600, 1000, 2500, 5000, 10000],
  updated_at: new Date(0).toISOString(),
};

const ACCOUNT: MyServerAccount = {
  logged_in: true,
  email: "buyer@example.com",
  account_id: "acct_1",
  device_id: "dev_1",
  account_kind: "email",
  session_expires_at: null,
};

const TOPUP: MyServerTopup = {
  topup_id: "top_1",
  checkout_url: "https://pay.example.com/session/abc",
  denomination_cents: 1000,
};

const LEDGER: BillingLedger = {
  balance_cents: 11806,
  currency: "USD",
  window_days: 30,
  truncated: false,
  totals: { topup_cents: 12000, charge_cents: 294 },
  entries: [
    {
      id: "e1",
      kind: "topup",
      amount_cents: 12000,
      at: Date.UTC(2026, 10, 5, 12),
      server: null,
      note: null,
    },
    {
      id: "e2",
      kind: "machine_day",
      amount_cents: -20,
      at: Date.UTC(2026, 10, 4, 12),
      server: { id: "srv_1", name: "新加坡 1", plan: "s-1vcpu-1gb", region: "sgp1" },
      note: null,
    },
  ],
};

function makeBridge(
  overrides: Partial<Record<keyof AgentBridge, unknown>> = {},
): AgentBridge {
  return {
    myServerBillingLedger: vi.fn(async () => LEDGER),
    ...overrides,
  } as unknown as AgentBridge;
}

function renderSurface(
  over: Partial<ComponentProps<typeof AccountSurface>> = {},
) {
  const props: ComponentProps<typeof AccountSurface> = {
    open: true,
    bridge: makeBridge(),
    account: ACCOUNT,
    wallet: WALLET,
    onTopUp: async () => TOPUP,
    onClose: () => {},
    ...over,
  };
  return render(<AccountSurface {...props} />);
}

describe("账户弹层", () => {
  it("邮箱、余额、充值块与账单都在同一层", async () => {
    const force = vi.fn();
    renderSurface({ onForceRefresh: force });

    expect(screen.getByRole("dialog", { name: "账户" })).toBeTruthy();
    const email = screen.getByText("buyer@example.com");
    expect(email.getAttribute("title")).toBe("buyer@example.com");

    const amount = screen.getByText("$9.20");
    expect(amount.className).toContain("account-surface__amount");
    expect(amount.className).toContain("num");

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(force).toHaveBeenCalledTimes(1);

    // 充值就地：5 档直接摊在余额下面。
    for (const name of ["$6", "$10", "$25", "$50", "$100"]) {
      expect(screen.getByRole("button", { name }), name).toBeTruthy();
    }
    expect(await screen.findByRole("button", { name: /明细/ })).toBeTruthy();
  });

  it("打开就刷新一次余额（走门禁），未登录不发", () => {
    const refresh = vi.fn();
    const first = renderSurface({ onRefreshWallet: refresh });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("open_settings");
    first.unmount();

    const gated = vi.fn();
    renderSurface({
      account: { ...ACCOUNT, logged_in: false, email: null },
      onRefreshWallet: gated,
    });
    expect(gated).not.toHaveBeenCalled();
  });

  it("复制邮箱：写剪贴板并短暂显示「已复制」", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderSurface();

    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("buyer@example.com"),
    );
    expect(await screen.findByRole("button", { name: "已复制" })).toBeTruthy();
  });

  it("余额读取中显示「读取中」，失败显示同一句话与重试", () => {
    const first = renderSurface({ wallet: null, walletLoading: true });
    expect(screen.getByText("读取中")).toBeTruthy();
    first.unmount();

    const retry = vi.fn();
    renderSurface({ wallet: null, walletError: "down", onRefreshWallet: retry });
    expect(screen.getByText(/余额暂时读不到。/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenLastCalledWith("retry");
  });

  it("已有旧值、刷新失败：金额保留并写「没刷新成功」", () => {
    renderSurface({ walletStale: true });
    expect(screen.getByText("$9.20")).toBeTruthy();
    expect(screen.getByText("没刷新成功，显示的是上次的余额。")).toBeTruthy();
  });

  it("刷新中：「刷新中」并禁用刷新按钮", () => {
    renderSurface({ walletRefreshing: true });
    const busy = screen.getByRole("button", { name: "刷新中" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
  });

  it("没有接线时余额退化为 —，不崩", () => {
    renderSurface({ wallet: null, walletLoading: false });
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("充值成功打开收银台：交给 App 关面板，不就地置灰", async () => {
    const onCheckoutOpened = vi.fn();
    const onTopUp = vi.fn(async () => TOPUP);
    renderSurface({ onCheckoutOpened, onTopUp });

    fireEvent.click(await screen.findByRole("button", { name: "$10" }));
    await waitFor(() => expect(onTopUp).toHaveBeenCalledWith(1000));
    expect(onCheckoutOpened).toHaveBeenCalledTimes(1);
    // 面板不自己关，也不进入等待态。
    expect(screen.getByRole("dialog", { name: "账户" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "$10" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("余额已经到账（没有 checkout_url）：原地提示已充值", async () => {
    const onCheckoutOpened = vi.fn();
    renderSurface({
      onCheckoutOpened,
      onTopUp: async () => ({ ...TOPUP, checkout_url: null }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "$10" }));
    expect(await screen.findByText("已充值 $10.00。")).toBeTruthy();
    expect(onCheckoutOpened).not.toHaveBeenCalled();
  });

  it("账单默认折叠；展开后就地显示合计与行，不再弹第二层", async () => {
    renderSurface();

    const toggle = await screen.findByRole("button", { name: /明细/ });
    expect(toggle.textContent).toContain("近 30 天：充值 $120.00");
    expect(toggle.textContent).not.toContain("余额");
    expect(screen.queryByRole("table")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByText("+$120.00")).toBeTruthy();
    // 金额固定两位小数、负号用 −：列宽再紧也不能只剩一位。
    expect(screen.getByText("−$0.20")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "近 30 天账单" })).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("账单空时摘要与空态都在，且不可展开", async () => {
    renderSurface({
      bridge: makeBridge({
        myServerBillingLedger: vi.fn(async () => ({ ...LEDGER, entries: [] })),
      }),
    });
    expect(await screen.findByText("最近 30 天没有消费")).toBeTruthy();
    expect(screen.getByText(/近 30 天：充值 \$120\.00/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /明细/ })).toBeNull();
  });

  it("账单失败就在块内给原因与重试", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce({ code: "TIMEOUT", message: "" })
      .mockResolvedValueOnce(LEDGER);
    renderSurface({ bridge: makeBridge({ myServerBillingLedger: load }) });

    expect(await screen.findByText("账单服务没有按时返回。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: /明细/ })).toBeTruthy();
  });

  it("退出登录固定在 footer，正文是唯一滚动容器", async () => {
    const { container } = renderSurface();

    const body = container.querySelector(".account-surface__body") as HTMLElement;
    const footer = container.querySelector(".account-surface__footer") as HTMLElement;
    expect(body).toBeTruthy();
    expect(footer).toBeTruthy();
    const logout = screen.getByRole("button", { name: "退出登录" });
    expect(body.contains(logout)).toBe(false);
    expect(footer.contains(logout)).toBe(true);

    fireEvent.click(await screen.findByRole("button", { name: /明细/ }));
    expect(container.querySelector(".billing-details table")).toBeTruthy();
    // 表体没有自己的滚动容器：只有账户 body 在滚。
    expect(container.querySelector(".billing-body")).toBeNull();
  });

  it("退出登录：成功后关闭账户层；失败原位给错误与重试", async () => {
    const onClose = vi.fn();
    const first = renderSurface({
      onLogout: async () => ({ ok: true }),
      onClose,
    });
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    first.unmount();

    const onLogout = vi.fn(async () => ({ ok: false as const, message: "没网。" }));
    renderSurface({ onLogout });
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(await screen.findByText("没网。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(2));
  });

  it("设备身份丢了：给说明与重新注册", async () => {
    const onReRegister = vi.fn(async () => true);
    renderSurface({ identityProblem: "lost", onReRegister });

    expect(screen.getByText(/这台设备的身份丢了/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新注册设备" }));
    await waitFor(() => expect(onReRegister).toHaveBeenCalledTimes(1));
  });

  it("设备停用：退出失败的错误出现在恢复块里", async () => {
    const onLogout = vi.fn(async () => ({ ok: false as const, message: "没网。" }));
    renderSurface({ identityProblem: "device_revoked", onLogout });

    fireEvent.click(screen.getByRole("button", { name: "退出这台设备" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("没网。");
    expect(alert.textContent).toContain("重试");
  });

  it("账户停用：隐藏余额、充值、账单与退出，只留换账户与退出设备", async () => {
    const onSwitchAccount = vi.fn(async () => true);
    const onLogout = vi.fn(async () => ({ ok: true as const }));
    renderSurface({
      identityProblem: "account_blocked",
      onSwitchAccount,
      onLogout,
    });

    expect(screen.queryByText("余额")).toBeNull();
    expect(screen.queryByText("充值")).toBeNull();
    expect(screen.queryByText("近 30 天账单")).toBeNull();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    expect(screen.getByText(/这个账户已停用/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "换一个账户" }));
    await waitFor(() => expect(onSwitchAccount).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "退出这台设备" }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
  });

  it("未登录：只给登录入口，不出现余额与充值", () => {
    const onLogin = vi.fn();
    renderSurface({
      account: { ...ACCOUNT, logged_in: false, email: null },
      onLogin,
    });

    expect(screen.queryByText("余额")).toBeNull();
    expect(screen.queryByText("充值")).toBeNull();
    const login = screen.getByRole("button", { name: "登录" });
    fireEvent.click(login);
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it("trapPaused（AI 告警在上层）：Esc 不关账户层", () => {
    const onClose = vi.fn();
    renderSurface({ onClose, trapPaused: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Esc 与点遮罩都关闭；AI 指路滚到充值块并高亮", () => {
    const onClose = vi.fn();
    const first = renderSurface({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    first.unmount();

    const backdropClose = vi.fn();
    const second = renderSurface({ onClose: backdropClose });
    fireEvent.mouseDown(second.container.querySelector(".modal-backdrop")!);
    expect(backdropClose).toHaveBeenCalledTimes(1);
    second.unmount();

    const scrollSpy = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollSpy;
    const third = renderSurface({
      point: { row: "account.topup", nonce: 1 },
    });
    const row = third.container.querySelector(
      '[data-point="account.topup"]',
    ) as HTMLElement;
    expect(row).toBeTruthy();
    expect(scrollSpy).toHaveBeenCalled();
    expect(row.getAttribute("data-pointed")).toBe("true");
  });
});
