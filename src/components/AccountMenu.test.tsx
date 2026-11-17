/** @vitest-environment jsdom */
// @ts-expect-error 测试跑在 Node 里；项目 tsconfig 只带浏览器类型（vite/client），没有 @types/node。
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
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
  return render(
    <AccountMenu
      email="buyer@example.com"
      wallet={WALLET}
      walletError={null}
      onTopUp={() => {}}
      onRefreshWallet={() => {}}
      onLogout={async () => ({ ok: true })}
      onClose={() => {}}
      {...over}
    />,
  );
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

  it("余额读取中与失败各自给一句话，失败可重试", () => {
    const retry = vi.fn();
    const { rerender } = renderMenu({ wallet: null, onRefreshWallet: retry });
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
    screen.getByRole("button", { name: "重试" }).click();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
