/** @vitest-environment jsdom */
// @ts-expect-error 测试跑在 Node 里；项目 tsconfig 只带浏览器类型（vite/client），没有 @types/node。
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServerWallet } from "../agent/bridge";
import { AccountMenu } from "./AccountMenu";

afterEach(cleanup);

const css = readFileSync("src/styles/app.css", "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `缺少规则 ${selector}`).not.toBeNull();
  return match![1];
}

const WALLET: MyServerWallet = {
  balance_cents: 920,
  currency: "USD",
  denominations_cents: [1000],
  updated_at: new Date(0).toISOString(),
};

function renderMenu(over: Partial<Parameters<typeof AccountMenu>[0]> = {}) {
  const props = {
    email: "buyer@example.com",
    wallet: WALLET,
    walletError: null,
    onTopUp: () => {},
    onRefreshWallet: () => {},
    onLogout: async () => ({ ok: true }),
    onClose: () => {},
    ...over,
  };
  const view = render(<AccountMenu {...props} />);
  return {
    ...view,
    rerenderMenu: (next: Partial<Parameters<typeof AccountMenu>[0]>) =>
      view.rerender(<AccountMenu {...props} {...next} />),
  };
}

describe("账号菜单", () => {
  it("头部只有邮箱一行，带全量 title，不再出现头像与已登录副行", () => {
    renderMenu({ email: "a-very-long-buyer-address@example.com" });

    const email = screen.getByText("a-very-long-buyer-address@example.com");
    expect(email.className).toBe("account-menu__email");
    expect(email.getAttribute("title")).toBe(
      "a-very-long-buyer-address@example.com",
    );
    expect(screen.queryByText(/已登录/)).toBeNull();
    expect(screen.queryByText("这台设备")).toBeNull();
    // 头像由导航承担，菜单里不再有一份。
    expect(document.querySelector(".account-menu img, .account-menu svg")).toBeNull();
  });

  it("邮箱单行省略由样式保证", () => {
    const body = rule(".account-menu__email");
    expect(body).toContain("text-overflow: ellipsis");
    expect(body).toContain("white-space: nowrap");
    expect(body).toContain("height: 36px");
  });

  it("只剩一种布局：没有 rail / nav 变体类，也没有对应 CSS", () => {
    const { container } = renderMenu();
    const panel = container.querySelector(".account-menu");
    expect(panel).not.toBeNull();
    expect(panel?.className).toBe("account-menu");
    expect(css).not.toContain(".account-menu--rail");
    expect(css).not.toContain(".account-menu--nav");
  });

  it("金额是 20 mono；充值 28 ghost；退出登录 13/500 红字、高 36", () => {
    renderMenu();
    const amount = screen.getByText("$9.20");
    expect(amount.className).toContain("account-menu__amount");
    expect(amount.className).toContain("num");
    expect(rule(".account-menu__amount")).toContain("font-size: 20px");
    expect(rule(".account-menu__amount")).toContain("letter-spacing: 0");

    const topup = screen.getByRole("button", { name: "充值" });
    expect(topup.className).toContain("account-menu__topup");
    expect(rule(".account-menu__topup")).toContain("min-height: 28px");

    const logout = screen.getByRole("button", { name: "退出登录" });
    expect(logout.className).toContain("account-menu__logout");
    const logoutRule = rule(".account-menu__logout");
    expect(logoutRule).toContain("height: 36px");
    expect(logoutRule).toContain("font-weight: 500");
    expect(logoutRule).toContain("color: var(--red)");
  });

  it("菜单里不出现「查看账单」", () => {
    renderMenu();
    expect(screen.queryByText("查看账单")).toBeNull();
  });

  it("没有值也不在途：显示「—」，不冒充「读取中」", () => {
    renderMenu({ wallet: null });
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("读取中")).toBeNull();
  });

  it("余额读取中与失败各自给一句话，失败可重试", () => {
    const retry = vi.fn();
    const { rerender } = renderMenu({
      wallet: null,
      walletLoading: true,
      onRefreshWallet: retry,
    });
    expect(screen.getByText("读取中")).toBeTruthy();

    rerender(
      <AccountMenu
        email="buyer@example.com"
        wallet={null}
        walletError="down"
        onTopUp={() => {}}
        onRefreshWallet={retry}
        onLogout={async () => ({ ok: true })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/余额暂时读不到。/)).toBeTruthy();
    const before = retry.mock.calls.length;
    screen.getByRole("button", { name: "重试" }).click();
    expect(retry.mock.calls.length).toBe(before + 1);
    expect(retry).toHaveBeenLastCalledWith("retry");
  });
});

describe("设备身份丢了", () => {
  it("说明是身份丢失而非网络问题，并提供「重新注册设备」入口", () => {
    renderMenu({ identityProblem: "lost", onReRegister: async () => true });

    expect(
      screen.getByText("这台设备的身份丢了，需要重新注册设备；账户和服务器都在。"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "重新注册设备" }),
    ).toBeTruthy();
    expect(screen.queryByText(/稍后再试/)).toBeNull();
  });

  it("点击调用恢复动作；恢复后入口消失", async () => {
    const onReRegister = vi.fn(async () => true);
    const menu = renderMenu({ identityProblem: "lost", onReRegister });

    fireEvent.click(screen.getByRole("button", { name: "重新注册设备" }));
    await waitFor(() => expect(onReRegister).toHaveBeenCalledTimes(1));

    menu.rerenderMenu({ identityProblem: null });
    expect(screen.queryByRole("button", { name: "重新注册设备" })).toBeNull();
    expect(screen.queryByText(/这台设备的身份丢了/)).toBeNull();
  });

  it("恢复失败时给出诚实结果，入口保留可再试", async () => {
    const onReRegister = vi.fn(async () => false);
    renderMenu({ identityProblem: "lost", onReRegister });

    fireEvent.click(screen.getByRole("button", { name: "重新注册设备" }));

    expect(
      await screen.findByText("这一步没完成。检查网络后再试一次；账户和服务器都还在。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新注册设备" })).toBeTruthy();
  });

  it("没有身份问题时不出现在菜单里", () => {
    renderMenu();
    expect(screen.queryByRole("button", { name: "重新注册设备" })).toBeNull();
  });
});

describe("设备 / 账户被停用", () => {
  it("设备停用：诚实说明 + 「退出这台设备」，不再给普通退出按钮", () => {
    renderMenu({
      identityProblem: "device_revoked",
      onLogout: async () => ({ ok: true }),
    });

    expect(
      screen.getByText("这台设备已被停用。退出这台设备后可以重新登录。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "退出这台设备" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    expect(screen.queryByText("余额")).toBeNull();
    expect(screen.queryByText("充值")).toBeNull();
    expect(screen.queryByText(/稍后再试/)).toBeNull();
  });

  it("设备停用：点「退出这台设备」调用登出并收起菜单", async () => {
    const onLogout = vi.fn(async () => ({ ok: true as const }));
    const onClose = vi.fn();
    renderMenu({ identityProblem: "device_revoked", onLogout, onClose });

    fireEvent.click(screen.getByRole("button", { name: "退出这台设备" }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("切换进行中，次按钮不可点（两个动作互斥）", async () => {
    let finish: (value: boolean) => void = () => {};
    const onSwitchAccount = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const onLogout = vi.fn(async () => ({ ok: true as const }));
    renderMenu({ identityProblem: "account_blocked", onSwitchAccount, onLogout });

    const secondary = screen.getByRole("button", {
      name: "退出这台设备",
    }) as HTMLButtonElement;
    expect(secondary.disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "换一个账户" }));
    await waitFor(() => expect(secondary.disabled).toBe(true));

    const primary = screen.getByRole("button", {
      name: "正在切换…",
    }) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);

    finish(true);
    await waitFor(() => expect(secondary.disabled).toBe(false));
  });

  it("账户停用：主行动「换一个账户」，次行动「退出这台设备」", async () => {
    const onSwitchAccount = vi.fn(async () => true);
    const onLogout = vi.fn(async () => ({ ok: true as const }));
    const onClose = vi.fn();
    const menu = renderMenu({
      identityProblem: "account_blocked",
      onSwitchAccount,
      onLogout,
      onClose,
    });

    expect(
      screen.getByText(
        "这个账户已停用。换一个账户需要重新注册这台设备；这台设备上的旧账户仍会保留。",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    expect(screen.queryByText("余额")).toBeNull();
    expect(screen.queryByText("充值")).toBeNull();
    expect(screen.queryByText(/稍后再试/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "换一个账户" }));
    await waitFor(() => expect(onSwitchAccount).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "退出这台设备" }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    menu.rerenderMenu({ identityProblem: null });
    expect(screen.queryByRole("button", { name: "换一个账户" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "退出这台设备" }),
    ).toBeNull();
  });
});

describe("账号菜单的余额陈旧提示", () => {
  it("已有旧值、刷新失败：金额保留，写「没刷新成功」并给重试", () => {
    const retry = vi.fn();
    const first = renderMenu({ walletStale: true, onRefreshWallet: retry });
    expect(screen.getByText("$9.20")).toBeTruthy();
    expect(
      screen.getByText(/没刷新成功，显示的是上次的余额。/),
    ).toBeTruthy();
    // 浮层克制：没有「刷新」按钮，失败时只给「重试」。
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
    const before = retry.mock.calls.length;
    screen.getByRole("button", { name: "重试" }).click();
    expect(retry.mock.calls.length).toBe(before + 1);
    first.unmount();

    renderMenu();
    expect(screen.queryByText(/没刷新成功/)).toBeNull();
  });

  it("挂载即打开：触发一次刷新", () => {
    const refresh = vi.fn();
    renderMenu({ onRefreshWallet: refresh });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("open_menu");
  });
});
