/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServerTopup, MyServerWallet } from "../agent/bridge";
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
  onRetry: () => void = () => {},
  onClose: () => void = () => {},
) {
  const { container } = render(
    <MyServerTopUp
      wallet={WALLET}
      loading={false}
      error={null}
      onRetry={onRetry}
      onTopUp={onTopUp}
      onClose={onClose}
    />,
  );
  return container;
}

describe("充值弹层", () => {
  it("成功打开收银台后直接关闭弹窗，不显示「已打开支付页面」", async () => {
    const onClose = vi.fn();
    renderTopUp(async () => TOPUP, () => {}, onClose);

    fireEvent.click(await screen.findByRole("button", { name: "$10.00" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/已打开支付页面/)).toBeNull();
    expect(screen.queryByRole("button", { name: "刷新余额" })).toBeNull();
  });

  it("checkout_url 为空：保留直接到账提示，不关闭弹窗", async () => {
    const onClose = vi.fn();
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => ({
      topup_id: "top_1",
      checkout_url: null,
      denomination_cents: 1000,
    }));
    renderTopUp(onTopUp, () => {}, onClose);

    fireEvent.click(await screen.findByRole("button", { name: "$10.00" }));

    expect(await screen.findByText("已充值 $10.00。")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

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
});
