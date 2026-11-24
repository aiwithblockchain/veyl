/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServerTopup, MyServerWallet } from "../agent/bridge";
import type { WalletRefreshResult } from "../myservers/useMyServers";
import { MyServerTopUp } from "./MyServerTopUp";

const WALLET: MyServerWallet = {
  balance_cents: 100,
  currency: "USD",
  denominations_cents: [1000, 2000],
  updated_at: new Date(0).toISOString(),
};

const TOPUP: MyServerTopup = {
  topup_id: "top_1",
  checkout_url: "https://pay.example.com/session/abc",
  denomination_cents: 1000,
};

afterEach(cleanup);

function renderTopUp(
  onTopUp: (cents: number) => Promise<MyServerTopup> = async () => TOPUP,
  onRetry: () => Promise<WalletRefreshResult> = async () => ({ ok: true, wallet: WALLET }),
  refreshing = false,
) {
  const { container } = render(
    <MyServerTopUp
      wallet={WALLET}
      loading={false}
      refreshing={refreshing}
      error={null}
      onRetry={onRetry}
      onTopUp={onTopUp}
      onClose={() => {}}
    />,
  );
  return container;
}

describe("充值弹层", () => {
  it("收银台打不开：不说已打开，给重新打开与可复制链接", async () => {
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => {
      throw {
        code: "INTERNAL",
        message: "收银台打不开。",
        details: {
          reason: "checkout_unavailable",
          checkout_url: "https://pay.example.com/session/abc",
        },
        retryable: true,
      };
    });
    renderTopUp(onTopUp);

    fireEvent.click(await screen.findByRole("button", { name: "$10.00" }));
    expect(await screen.findByText(/收银台暂时打不开/)).toBeTruthy();
    expect(screen.queryByText(/已打开支付页面/)).toBeNull();
    expect(screen.getByRole("button", { name: "重新打开支付页面" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制链接" })).toBeTruthy();
    expect(
      screen.getByText("https://pay.example.com/session/abc"),
    ).toBeTruthy();
  });

  it("没有链接时只给重试", async () => {
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => {
      throw {
        code: "INTERNAL",
        message: "收银台打不开。",
        details: { reason: "checkout_unavailable" },
        retryable: true,
      };
    });
    renderTopUp(onTopUp);

    fireEvent.click(await screen.findByRole("button", { name: "$10.00" }));
    expect(await screen.findByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新打开支付页面" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onTopUp).toHaveBeenCalledTimes(2));
  });

  it("焦点陷阱：Tab 在弹层内循环", async () => {
    const container = renderTopUp();
    const dialog = container.querySelector(".myservers-topup") as HTMLElement;
    const buttons = Array.from(dialog.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(1);

    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("刷新余额：进行中禁用，成功后提示并恢复", async () => {
    let resolveRefresh: (result: WalletRefreshResult) => void = () => {};
    const onRetry = vi.fn(
      () =>
        new Promise<WalletRefreshResult>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    renderTopUp(undefined, onRetry);

    fireEvent.click(await screen.findByRole("button", { name: "$10.00" }));
    fireEvent.click(await screen.findByRole("button", { name: "刷新余额" }));

    const busy = await screen.findByRole("button", { name: /正在刷新余额/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(onRetry).toHaveBeenCalledTimes(1);

    resolveRefresh({ ok: true, wallet: { ...WALLET, balance_cents: 200 } });

    expect(await screen.findByText("余额已更新 · $2.00")).toBeTruthy();
    const idle = screen.getByRole("button", { name: "刷新余额" });
    expect((idle as HTMLButtonElement).disabled).toBe(false);
  });

  it("刷新余额失败：给出提示并恢复", async () => {
    const onRetry = vi.fn(async (): Promise<WalletRefreshResult> => ({
      ok: false,
      reason: "failed",
    }));
    renderTopUp(undefined, onRetry);

    fireEvent.click(await screen.findByRole("button", { name: "$10.00" }));
    fireEvent.click(await screen.findByRole("button", { name: "刷新余额" }));

    expect(await screen.findByText("余额没更新，稍后再试。")).toBeTruthy();
    const idle = screen.getByRole("button", { name: "刷新余额" });
    expect((idle as HTMLButtonElement).disabled).toBe(false);
  });

  it("刷新余额被跳过时不报失败", async () => {
    const onRetry = vi.fn(async (): Promise<WalletRefreshResult> => ({
      ok: false,
      reason: "skipped",
    }));
    renderTopUp(undefined, onRetry);

    fireEvent.click(await screen.findByRole("button", { name: "$10.00" }));
    fireEvent.click(await screen.findByRole("button", { name: "刷新余额" }));

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "刷新余额" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.queryByText("余额没更新，稍后再试。")).toBeNull();
  });

  it("后台刷新在途时按钮禁用", async () => {
    const onRetry = vi.fn(async (): Promise<WalletRefreshResult> => ({
      ok: true,
      wallet: WALLET,
    }));
    renderTopUp(undefined, onRetry, true);

    fireEvent.click(await screen.findByRole("button", { name: "$10.00" }));
    const busy = await screen.findByRole("button", { name: /正在刷新余额/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(busy);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("成功提示 2.5 秒后自动消失", async () => {
    let resolveRefresh: (result: WalletRefreshResult) => void = () => {};
    const onRetry = vi.fn(
      () =>
        new Promise<WalletRefreshResult>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    renderTopUp(undefined, onRetry);

    fireEvent.click(await screen.findByRole("button", { name: "$10.00" }));
    fireEvent.click(await screen.findByRole("button", { name: "刷新余额" }));

    vi.useFakeTimers();
    try {
      await act(async () => {
        resolveRefresh({ ok: true, wallet: { ...WALLET, balance_cents: 200 } });
        await Promise.resolve();
      });
      expect(screen.getByText("余额已更新 · $2.00")).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(2500);
      });
      expect(screen.queryByText("余额已更新 · $2.00")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("刷新余额：连点只发一次", async () => {
    let resolveRefresh: (result: WalletRefreshResult) => void = () => {};
    const onRetry = vi.fn(
      () =>
        new Promise<WalletRefreshResult>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    renderTopUp(undefined, onRetry);

    fireEvent.click(await screen.findByRole("button", { name: "$10.00" }));
    const button = await screen.findByRole("button", { name: "刷新余额" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onRetry).toHaveBeenCalledTimes(1);
    resolveRefresh({ ok: true, wallet: WALLET });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "刷新余额" })).toBeTruthy(),
    );
  });
});
