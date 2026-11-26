/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServerTopup, MyServerWallet } from "../agent/bridge";
import { BridgeError } from "../agent/errors";
import { MyServerTopUp } from "./MyServerTopUp";

const WALLET: MyServerWallet = {
  balance_cents: 100,
  currency: "USD",
  denominations_cents: [600, 1000, 2500, 5000, 10000],
  updated_at: new Date(0).toISOString(),
};

const TOPUP: MyServerTopup = {
  topup_id: "top_1",
  checkout_url: "https://pay.example.com/session/abc",
  denomination_cents: 1000,
};

afterEach(cleanup);

function openCustom() {
  fireEvent.click(screen.getByRole("button", { name: "其他" }));
}

function renderPanel(
  onTopUp: (cents: number) => Promise<MyServerTopup> = async () => TOPUP,
  onCheckoutOpened: () => void = () => {},
  wallet: MyServerWallet | null = WALLET,
) {
  const { container } = render(
    <MyServerTopUp
      wallet={wallet}
      onTopUp={onTopUp}
      onCheckoutOpened={onCheckoutOpened}
    />,
  );
  return container;
}

describe("充值面板（账户弹层内嵌）", () => {
  it("5 个价格档位都在，另有「其他」入口，档位是整美元", () => {
    renderPanel();
    for (const name of ["$6", "$10", "$25", "$50", "$100", "其他"]) {
      expect(screen.getByRole("button", { name }), name).toBeTruthy();
    }
    expect(screen.queryByLabelText("自定义金额")).toBeNull();

    // 收纳时指向的目标还不存在：不挂悬空的 aria-controls。
    const other = screen.getByRole("button", { name: "其他" });
    expect(other.getAttribute("aria-controls")).toBeNull();
    fireEvent.click(other);
    expect(other.getAttribute("aria-controls")).toBe("myservers-topup-custom");
    expect(document.getElementById("myservers-topup-custom")).toBeTruthy();
  });

  it("打开收银台：交给外层关面板，不进入等待态", async () => {
    const onCheckoutOpened = vi.fn();
    renderPanel(async () => TOPUP, onCheckoutOpened);

    fireEvent.click(screen.getByRole("button", { name: "$10" }));

    await waitFor(() => expect(onCheckoutOpened).toHaveBeenCalledTimes(1));
    expect(
      (screen.getByRole("button", { name: "$10" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText(/已在浏览器打开收款页/)).toBeNull();
  });

  it("checkout_url 为空：保留直接到账提示", async () => {
    const onCheckoutOpened = vi.fn();
    renderPanel(
      async () => ({ ...TOPUP, checkout_url: null }),
      onCheckoutOpened,
    );

    fireEvent.click(screen.getByRole("button", { name: "$10" }));
    expect(await screen.findByText("已充值 $10.00。")).toBeTruthy();
    expect(onCheckoutOpened).not.toHaveBeenCalled();
  });

  it("收银台打不开：不说已打开，给重新打开与可复制链接", async () => {
    const onCheckoutOpened = vi.fn();
    renderPanel(async () => {
      throw {
        code: "INTERNAL",
        message: "收银台打不开。",
        details: {
          reason: "checkout_unavailable",
          checkout_url: "https://pay.example.com/session/abc",
        },
        retryable: true,
      };
    }, onCheckoutOpened);

    fireEvent.click(screen.getByRole("button", { name: "$10" }));
    expect(await screen.findByText(/收银台暂时打不开/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新打开支付页面" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制链接" })).toBeTruthy();
    expect(screen.getByText("https://pay.example.com/session/abc")).toBeTruthy();
    expect(onCheckoutOpened).not.toHaveBeenCalled();
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
    renderPanel(onTopUp);

    fireEvent.click(screen.getByRole("button", { name: "$10" }));
    expect(await screen.findByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新打开支付页面" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onTopUp).toHaveBeenCalledTimes(2));
  });

  it("自定义金额：合法时按整美元发起充值", async () => {
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => TOPUP);
    const onCheckoutOpened = vi.fn();
    renderPanel(onTopUp, onCheckoutOpened);

    openCustom();
    fireEvent.change(screen.getByLabelText("自定义金额"), {
      target: { value: "36" },
    });
    const submit = screen.getByRole("button", {
      name: "充值 $36",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(onTopUp).toHaveBeenCalledWith(3600));
    expect(onCheckoutOpened).toHaveBeenCalledTimes(1);
  });

  it("空输入：按钮写「充值」且禁用", () => {
    renderPanel();
    openCustom();

    const submit = screen.getByRole("button", { name: "充值" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/付款在浏览器里完成/)).toBeTruthy();
  });

  it("非法输入：输入时不报错，失焦后才提示并置 aria-invalid", () => {
    renderPanel();
    openCustom();
    const input = screen.getByLabelText("自定义金额");

    fireEvent.change(input, { target: { value: "3" } });
    expect(screen.queryByText("请输入 $6–$300 的整美元金额")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();

    fireEvent.blur(input);
    expect(screen.getByText("请输入 $6–$300 的整美元金额")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");

    // 清空后回到中性提示。
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText(/付款在浏览器里完成/)).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("自定义金额：wallet 的 min/max 生效", async () => {
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => TOPUP);
    renderPanel(onTopUp, () => {}, {
      ...WALLET,
      min_topup_cents: 1000,
      max_topup_cents: 2000,
    });

    openCustom();
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
    // 不走收银台（checkout_url=null），成功也不会关面板。
    const onTopUp = vi.fn(async (): Promise<MyServerTopup> => ({
      ...TOPUP,
      checkout_url: null,
    }));
    renderPanel(onTopUp);
    openCustom();
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
    renderPanel(onTopUp);

    openCustom();
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
    renderPanel(onTopUp);
    openCustom();
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
    renderPanel(onTopUp);

    fireEvent.click(screen.getByRole("button", { name: "$10" }));
    expect(await screen.findByText("充值太频繁，请一小时后再试。")).toBeTruthy();
  });

  it("没有钱包时不渲染档位，只看自定义输入", () => {
    renderPanel(async () => TOPUP, () => {}, null);
    expect(screen.queryByRole("button", { name: "$10" })).toBeNull();
    expect(screen.getByRole("button", { name: "其他" })).toBeTruthy();
    openCustom();
    expect(screen.getByLabelText("自定义金额")).toBeTruthy();
  });
});
