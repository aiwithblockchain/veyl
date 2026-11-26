/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentBridge,
  BillingLedger,
  MyServerAccount,
  MyServerWallet,
} from "../agent/bridge";
import { AccountSurface } from "./AccountSurface";

afterEach(cleanup);

const WALLET: MyServerWallet = {
  balance_cents: 920,
  currency: "USD",
  denominations_cents: [1000],
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
    onClose: () => {},
    ...over,
  };
  return render(<AccountSurface {...props} />);
}

describe("账户弹层", () => {
  it("邮箱、余额、刷新与充值都在同一层", () => {
    const force = vi.fn();
    const topUp = vi.fn();
    renderSurface({ onForceRefresh: force, onTopUp: topUp });

    expect(screen.getByRole("dialog", { name: "账户" })).toBeTruthy();
    const email = screen.getByText("buyer@example.com");
    expect(email.getAttribute("title")).toBe("buyer@example.com");

    const amount = screen.getByText("$9.20");
    expect(amount.className).toContain("account-surface__amount");
    expect(amount.className).toContain("num");

    const topUpButton = screen.getByRole("button", { name: "充值" });
    expect(topUpButton.className).toContain("btn--primary");
    fireEvent.click(topUpButton);
    expect(topUp).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(force).toHaveBeenCalledTimes(1);
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

  it("账单：打开后 Esc 只关账单，焦点回到「查看账单」", async () => {
    const load = vi.fn(async () => LEDGER);
    renderSurface({ bridge: makeBridge({ myServerBillingLedger: load }) });

    const trigger = screen.getByRole("button", { name: "查看账单" });
    trigger.focus();
    fireEvent.click(trigger);

    await screen.findByRole("dialog", { name: "近 30 天账单" });
    expect(load).toHaveBeenCalledWith(30);
    expect(await screen.findByText(/余额 \$118\.06/)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "近 30 天账单" })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "账户" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
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
    expect(screen.queryByRole("button", { name: "充值" })).toBeNull();
    expect(screen.queryByRole("button", { name: "查看账单" })).toBeNull();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    expect(screen.getByText(/这个账户已停用/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "换一个账户" }));
    await waitFor(() => expect(onSwitchAccount).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "退出这台设备" }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
  });

  it("未登录：只给登录入口，不出现余额", () => {
    const onLogin = vi.fn();
    renderSurface({
      account: { ...ACCOUNT, logged_in: false, email: null },
      onLogin,
    });

    expect(screen.queryByText("余额")).toBeNull();
    expect(screen.queryByRole("button", { name: "充值" })).toBeNull();
    const login = screen.getByRole("button", { name: "登录" });
    fireEvent.click(login);
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it("Esc 与点遮罩都关闭；AI 指路滚到余额行并高亮", () => {
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
      point: { row: "account.balance", nonce: 1 },
    });
    const row = third.container.querySelector(
      '[data-point="account.balance"]',
    ) as HTMLElement;
    expect(row).toBeTruthy();
    expect(scrollSpy).toHaveBeenCalled();
    expect(row.getAttribute("data-pointed")).toBe("true");
  });
});
