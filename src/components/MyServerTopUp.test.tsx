/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  open = true,
) {
  return render(
    <MyServerTopUp
      wallet={wallet}
      open={open}
      onTopUp={onTopUp}
      onCheckoutOpened={onCheckoutOpened}
    />,
  );
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

  it("打开收银台：面板不关，档位整块换成等待块", async () => {
    const onCheckoutOpened = vi.fn();
    renderPanel(async () => TOPUP, onCheckoutOpened);

    fireEvent.click(screen.getByRole("button", { name: "$10" }));

    await waitFor(() => expect(onCheckoutOpened).toHaveBeenCalledTimes(1));
    const wait = screen.getByRole("status");
    expect(wait.textContent).toContain("已在浏览器打开收付款页");
    expect(wait.textContent).toContain("$10");
    expect(wait.textContent).toContain("付款完成后余额会自动更新；没更新就点上面的「刷新」。");
    expect(screen.getByRole("button", { name: "重新打开收付款页" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "改金额" })).toBeTruthy();
    // 不留置灰的档位，焦点落在等待块上。
    expect(screen.queryByRole("button", { name: "$10" })).toBeNull();
    expect(document.activeElement).toBe(wait);
  });

  it("等待中余额没变不跳到账；变大立刻改成已到账", async () => {
    const props = {
      onTopUp: async () => TOPUP,
      onCheckoutOpened: () => {},
    };
    const view = renderPanel(props.onTopUp, props.onCheckoutOpened);
    fireEvent.click(screen.getByRole("button", { name: "$10" }));
    await screen.findByText("已在浏览器打开收付款页");

    view.rerender(
      <MyServerTopUp
        wallet={{ ...WALLET, balance_cents: 100 }}
        onTopUp={props.onTopUp}
        onCheckoutOpened={props.onCheckoutOpened}
      />,
    );
    expect(screen.getByText("已在浏览器打开收付款页")).toBeTruthy();
    expect(screen.queryByText(/已到账/)).toBeNull();

    // 余额变小更不能算到账（钉住 >，不是 !==）。
    view.rerender(
      <MyServerTopUp
        wallet={{ ...WALLET, balance_cents: 50 }}
        onTopUp={props.onTopUp}
        onCheckoutOpened={props.onCheckoutOpened}
      />,
    );
    expect(screen.getByText("已在浏览器打开收付款页")).toBeTruthy();
    expect(screen.queryByText(/已到账/)).toBeNull();

    view.rerender(
      <MyServerTopUp
        wallet={{ ...WALLET, balance_cents: 3420 }}
        onTopUp={props.onTopUp}
        onCheckoutOpened={props.onCheckoutOpened}
      />,
    );
    const paid = screen.getByText("已到账 $10 · 余额 $34.20");
    expect(paid.className).toContain("myservers-topup__paid");
    expect(paid.querySelector(".myservers-topup__dot")).toBeTruthy();
    // 已到账不自动收起：等待块与档位都不回来。
    expect(screen.queryByText("已在浏览器打开收付款页")).toBeNull();
    expect(screen.queryByRole("button", { name: "$10" })).toBeNull();
    expect(document.activeElement).toBe(paid);
  });

  it("等待中「改金额」回到选择态，焦点落回档位格", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "$10" }));
    await screen.findByText("已在浏览器打开收付款页");

    fireEvent.click(screen.getByRole("button", { name: "改金额" }));
    expect(screen.getByRole("button", { name: "$10" })).toBeTruthy();
    expect(screen.queryByText("已在浏览器打开收付款页")).toBeNull();
    expect((document.activeElement as HTMLElement).className).toContain(
      "myservers-topup__grid",
    );
  });

  it("等待中「重新打开收付款页」再发一单，等待块全程不消失", async () => {
    const deferred: { resolve?: (value: MyServerTopup) => void } = {};
    let calls = 0;
    const onTopUp = vi.fn((): Promise<MyServerTopup> => {
      calls += 1;
      if (calls === 1) return Promise.resolve(TOPUP);
      return new Promise((resolve) => {
        deferred.resolve = resolve;
      });
    });
    renderPanel(onTopUp);
    fireEvent.click(screen.getByRole("button", { name: "$10" }));
    await screen.findByText("已在浏览器打开收付款页");

    const reopen = screen.getByRole("button", {
      name: "重新打开收付款页",
    }) as HTMLButtonElement;
    fireEvent.click(reopen);
    await waitFor(() => expect(onTopUp).toHaveBeenCalledTimes(2));
    // 在途：等待块留着，不闪回置灰的档位网格。
    expect(screen.getByText("已在浏览器打开收付款页")).toBeTruthy();
    expect(document.querySelector(".myservers-topup__grid")).toBeNull();
    expect(screen.queryByRole("button", { name: "$10" })).toBeNull();
    expect(reopen.getAttribute("aria-disabled")).toBe("true");
    // 不用原生 disabled：焦点留在按钮上。
    expect(reopen.disabled).toBe(false);

    deferred.resolve?.(TOPUP);
    await waitFor(() => expect(screen.getByText("已在浏览器打开收付款页")).toBeTruthy());
    expect(reopen.getAttribute("aria-disabled")).toBeNull();
  });

  it("请求在途时收起：响应被丢弃，再展开是选择态", async () => {
    const deferred: { resolve?: (value: MyServerTopup) => void } = {};
    const onTopUp = vi.fn(
      (): Promise<MyServerTopup> =>
        new Promise((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const onCheckoutOpened = vi.fn();
    const view = renderPanel(onTopUp, onCheckoutOpened);
    fireEvent.click(screen.getByRole("button", { name: "$10" }));
    await waitFor(() => expect(onTopUp).toHaveBeenCalledTimes(1));

    view.rerender(
      <MyServerTopUp
        wallet={WALLET}
        open={false}
        onTopUp={onTopUp}
        onCheckoutOpened={onCheckoutOpened}
      />,
    );
    await act(async () => {
      deferred.resolve?.(TOPUP);
    });

    view.rerender(
      <MyServerTopUp
        wallet={WALLET}
        open
        onTopUp={onTopUp}
        onCheckoutOpened={onCheckoutOpened}
      />,
    );
    expect(screen.getByRole("button", { name: "$10" })).toBeTruthy();
    expect(screen.queryByText("已在浏览器打开收付款页")).toBeNull();
    expect(onCheckoutOpened).not.toHaveBeenCalled();
  });

  it("收起再展开：回到选择态，不保留已到账", async () => {
    const view = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "$10" }));
    await screen.findByText("已在浏览器打开收付款页");

    view.rerender(
      <MyServerTopUp
        wallet={{ ...WALLET, balance_cents: 3420 }}
        open={false}
        onTopUp={async () => TOPUP}
        onCheckoutOpened={() => {}}
      />,
    );
    view.rerender(
      <MyServerTopUp
        wallet={WALLET}
        open
        onTopUp={async () => TOPUP}
        onCheckoutOpened={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "$10" })).toBeTruthy();
    expect(screen.queryByText(/已到账/)).toBeNull();
    expect(screen.queryByText("已在浏览器打开收付款页")).toBeNull();
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
    expect(screen.getByRole("button", { name: "重新打开收付款页" })).toBeTruthy();
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
    expect(screen.queryByRole("button", { name: "重新打开收付款页" })).toBeNull();

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

  it("提示与错误文案跟着 wallet 的 min/max 走", () => {
    renderPanel(undefined, () => {}, {
      ...WALLET,
      min_topup_cents: 1000,
      max_topup_cents: 50000,
    });

    openCustom();
    expect(screen.getByText(/^\$10–\$500，整美元/)).toBeTruthy();

    const input = screen.getByLabelText("自定义金额");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);
    expect(screen.getByText("请输入 $10–$500 的整美元金额")).toBeTruthy();
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
    expect(screen.getByText("请输入 $10–$20 的整美元金额")).toBeTruthy();

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

  it("没有钱包：档位与「其他」都不可用，开不了自定义", () => {
    renderPanel(async () => TOPUP, () => {}, null);
    expect(screen.queryByRole("button", { name: "$10" })).toBeNull();
    const other = screen.getByRole("button", { name: "其他" }) as HTMLButtonElement;
    expect(other.disabled).toBe(true);
    fireEvent.click(other);
    expect(screen.queryByLabelText("自定义金额")).toBeNull();
  });
});
