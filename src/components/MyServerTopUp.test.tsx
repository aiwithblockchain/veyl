/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServerWallet } from "../agent/bridge";
import { MyServerTopUp } from "./MyServerTopUp";

const WALLET: MyServerWallet = {
  balance_cents: 100,
  currency: "USD",
  denominations_cents: [1000, 2000],
  updated_at: new Date(0).toISOString(),
};

afterEach(cleanup);

function renderTopUp(onTopUp: (cents: number) => Promise<never>) {
  const { container } = render(
    <MyServerTopUp
      wallet={WALLET}
      loading={false}
      error={null}
      onRetry={() => {}}
      onTopUp={onTopUp}
      onClose={() => {}}
    />,
  );
  return container;
}

describe("充值弹层", () => {
  it("收银台打不开：不说已打开，给重新打开与可复制链接", async () => {
    const onTopUp = vi.fn(async () => {
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
    renderTopUp(onTopUp as unknown as (cents: number) => Promise<never>);

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
    const onTopUp = vi.fn(async () => {
      throw {
        code: "INTERNAL",
        message: "收银台打不开。",
        details: { reason: "checkout_unavailable" },
        retryable: true,
      };
    });
    renderTopUp(onTopUp as unknown as (cents: number) => Promise<never>);

    fireEvent.click(await screen.findByRole("button", { name: "$10.00" }));
    expect(await screen.findByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新打开支付页面" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onTopUp).toHaveBeenCalledTimes(2));
  });

  it("焦点陷阱：Tab 在弹层内循环", async () => {
    const container = renderTopUp(vi.fn() as unknown as (cents: number) => Promise<never>);
    const dialog = container.querySelector(".myservers-topup") as HTMLElement;
    const buttons = Array.from(dialog.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(1);

    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
  });
});
