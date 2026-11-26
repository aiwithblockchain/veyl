/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServerTopup, MyServerWallet } from "../agent/bridge";
import { BridgeError } from "../agent/errors";
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
  wallet: MyServerWallet = WALLET,
) {
  const { container } = render(
    <MyServerTopUp
      wallet={wallet}
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

  it("自定义金额：合法时按整美元发起充值并关闭", async () => {
    const onClose = vi.fn();
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => TOPUP);
    renderTopUp(onTopUp, () => {}, onClose);

    fireEvent.change(screen.getByLabelText("自定义金额"), {
      target: { value: "36" },
    });
    const submit = screen.getByRole("button", {
      name: "充值 $36.00",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(onTopUp).toHaveBeenCalledWith(3600));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("自定义金额：非整美元、越界或空值禁用并提示", () => {
    renderTopUp();
    const input = screen.getByLabelText("自定义金额");
    const submit = () => screen.getByRole("button", { name: /充值 / }) as HTMLButtonElement;

    for (const value of ["5", "301", "12.5", "abc", ""]) {
      fireEvent.change(input, { target: { value } });
      expect(submit().disabled, value || "empty").toBe(true);
      if (value) {
        expect(screen.getByText("请输入 $6–$300 的整美元金额")).toBeTruthy();
      }
    }
  });

  it("自定义金额：wallet 的 min/max 生效", async () => {
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => TOPUP);
    renderTopUp(onTopUp, () => {}, () => {}, {
      ...WALLET,
      min_topup_cents: 1000,
      max_topup_cents: 2000,
    });

    const input = screen.getByLabelText("自定义金额");
    fireEvent.change(input, { target: { value: "6" } });
    expect(
      (screen.getByRole("button", { name: "充值 $6.00" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.change(input, { target: { value: "10" } });
    const submit = screen.getByRole("button", {
      name: "充值 $10.00",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onTopUp).toHaveBeenCalledWith(1000));
  });

  it("自定义金额：默认范围下 6/300 可提交，300.01/5 禁用", async () => {
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => TOPUP);
    renderTopUp(onTopUp);
    const input = screen.getByLabelText("自定义金额");
    const submit = () => screen.getByRole("button", { name: /充值 / }) as HTMLButtonElement;

    for (const [value, cents] of [
      ["6", 600],
      ["300", 30000],
    ] as const) {
      fireEvent.change(input, { target: { value } });
      const button = submit();
      expect(button.disabled, value).toBe(false);
      fireEvent.click(button);
      await waitFor(() => expect(onTopUp).toHaveBeenLastCalledWith(cents));
    }

    for (const value of ["5", "300.01"]) {
      fireEvent.change(input, { target: { value } });
      expect(submit().disabled, value).toBe(true);
      expect(screen.getByText("请输入 $6–$300 的整美元金额")).toBeTruthy();
    }
  });

  it("自定义金额：前导零 06 视为 6", async () => {
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => TOPUP);
    renderTopUp(onTopUp);

    fireEvent.change(screen.getByLabelText("自定义金额"), {
      target: { value: "06" },
    });
    const submit = screen.getByRole("button", {
      name: "充值 $6.00",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onTopUp).toHaveBeenCalledWith(600));
  });

  it("自定义金额：超长数字禁用", () => {
    renderTopUp();
    fireEvent.change(screen.getByLabelText("自定义金额"), {
      target: { value: "999999999999999999999" },
    });
    expect(
      (screen.getByRole("button", { name: /充值 / }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("请输入 $6–$300 的整美元金额")).toBeTruthy();
  });

  it("速率限制显示专用文案", async () => {
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => {
      throw new BridgeError(
        "RATE_LIMITED",
        "",
        { reason: "topup_rate_limited" },
        true,
      );
    });
    renderTopUp(onTopUp);

    fireEvent.click(await screen.findByRole("button", { name: "$10.00" }));
    expect(await screen.findByText("充值太频繁，请一小时后再试。")).toBeTruthy();
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
