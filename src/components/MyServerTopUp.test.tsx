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
  it("成功打开收银台：弹层保留、只留关闭，档位与提交都禁用", async () => {
    const onClose = vi.fn();
    renderTopUp(async () => TOPUP, () => {}, onClose);
    fireEvent.change(screen.getByLabelText("自定义金额"), {
      target: { value: "36" },
    });

    fireEvent.click(await screen.findByRole("button", { name: "$10" }));

    expect(
      await screen.findByText(
        "已在浏览器打开收款页。付完款后点「刷新」查看余额。",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    for (const name of ["$10", "$20"]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
        name,
      ).toBe(true);
    }
    expect(
      (screen.getByLabelText("自定义金额") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "充值 $36" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // 底部「关闭」仍可关。
    const closes = screen.getAllByRole("button", { name: "关闭" });
    fireEvent.click(closes[closes.length - 1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("等待态给「刷新」按钮，点击强制刷新余额", async () => {
    const onRefreshBalance = vi.fn();
    render(
      <MyServerTopUp
        wallet={WALLET}
        loading={false}
        error={null}
        onRetry={() => {}}
        onTopUp={async () => TOPUP}
        onClose={() => {}}
        onRefreshBalance={onRefreshBalance}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "$10" }));
    expect(
      await screen.findByText("已在浏览器打开收款页。付完款后点「刷新」查看余额。"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefreshBalance).toHaveBeenCalledTimes(1);
  });

  it("checkout_url 为空：保留直接到账提示，不关闭弹窗", async () => {
    const onClose = vi.fn();
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => ({
      topup_id: "top_1",
      checkout_url: null,
      denomination_cents: 1000,
    }));
    renderTopUp(onTopUp, () => {}, onClose);

    fireEvent.click(await screen.findByRole("button", { name: "$10" }));

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

    fireEvent.click(await screen.findByRole("button", { name: "$10" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "$10" }));
    expect(await screen.findByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新打开支付页面" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onTopUp).toHaveBeenCalledTimes(2));
  });

  it("自定义金额：合法时按整美元发起充值并保留等待态", async () => {
    const onClose = vi.fn();
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => TOPUP);
    renderTopUp(onTopUp, () => {}, onClose);

    fireEvent.change(screen.getByLabelText("自定义金额"), {
      target: { value: "36" },
    });
    const submit = screen.getByRole("button", {
      name: "充值 $36",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(onTopUp).toHaveBeenCalledWith(3600));
    expect(
      await screen.findByText(
        "已在浏览器打开收款页。付完款后点「刷新」查看余额。",
      ),
    ).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("空输入：按钮写「充值」且禁用", () => {
    renderTopUp();

    const submit = screen.getByRole("button", { name: "充值" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText("$6–$300，整美元")).toBeTruthy();
  });

  it("非法输入：输入时不报错，失焦后才提示并置 aria-invalid", () => {
    renderTopUp();
    const input = screen.getByLabelText("自定义金额");

    fireEvent.change(input, { target: { value: "3" } });
    expect(screen.queryByText("请输入 $6–$300 的整美元金额")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();

    fireEvent.blur(input);
    expect(screen.getByText("请输入 $6–$300 的整美元金额")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");

    // 清空后回到中性提示。
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("$6–$300，整美元")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBeNull();
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
    const invalid = screen.getByRole("button", { name: "充值" }) as HTMLButtonElement;
    expect(invalid.disabled).toBe(false);
    fireEvent.click(invalid);
    expect(onTopUp).not.toHaveBeenCalled();
    expect(screen.getByText("请输入 $6–$300 的整美元金额")).toBeTruthy();

    fireEvent.change(input, { target: { value: "10" } });
    const submit = screen.getByRole("button", {
      name: "充值 $10",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onTopUp).toHaveBeenCalledWith(1000));
  });

  it("自定义金额：默认范围下 6/300 可提交，300.01/5 被拦", async () => {
    // 不走收银台（checkout_url=null），否则第一次成功就会锁住等待态。
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => ({
      ...TOPUP,
      checkout_url: null,
    }));
    renderTopUp(onTopUp);
    const input = screen.getByLabelText("自定义金额");
    const submit = () => screen.getByRole("button", { name: /^充值/ }) as HTMLButtonElement;

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
      const button = submit();
      expect(button.disabled, value).toBe(false);
      fireEvent.click(button);
      expect(screen.getByText("请输入 $6–$300 的整美元金额")).toBeTruthy();
    }
    expect(onTopUp).toHaveBeenCalledTimes(2);
  });

  it("自定义金额：前导零 06 视为 6", async () => {
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => TOPUP);
    renderTopUp(onTopUp);

    fireEvent.change(screen.getByLabelText("自定义金额"), {
      target: { value: "06" },
    });
    const submit = screen.getByRole("button", {
      name: "充值 $6",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onTopUp).toHaveBeenCalledWith(600));
  });

  it("自定义金额：超长数字提交被拦", () => {
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => TOPUP);
    renderTopUp(onTopUp);
    fireEvent.change(screen.getByLabelText("自定义金额"), {
      target: { value: "999999999999999999999" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /^充值/ }) as HTMLButtonElement,
    );
    expect(onTopUp).not.toHaveBeenCalled();
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

    fireEvent.click(await screen.findByRole("button", { name: "$10" }));
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
