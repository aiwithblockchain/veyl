/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyServerAccount, MyServerWallet } from "../agent/bridge";
import { MyServersAccount } from "./MyServersAccount";

afterEach(cleanup);

const LOGGED_IN: MyServerAccount = {
  logged_in: true,
  email: "buyer@example.com",
  account_id: "acct_1",
  device_id: "dev_1",
  account_kind: "email",
};

const LOGGED_OUT: MyServerAccount = {
  logged_in: false,
  email: null,
  account_id: null,
  device_id: "dev_1",
  account_kind: "device",
};

const WALLET: MyServerWallet = {
  balance_cents: 1230,
  currency: "USD",
  denominations_cents: [1000],
  updated_at: new Date(0).toISOString(),
};

function renderAccount(over: Partial<Parameters<typeof MyServersAccount>[0]> = {}) {
  const onLogout = vi.fn(async () => ({ ok: true }));
  const props = {
    account: LOGGED_IN,
    loaded: true,
    accountError: false,
    wallet: WALLET,
    walletError: null,
    open: false,
    onToggle: vi.fn(),
    onLogin: vi.fn(),
    onLogout,
    onTopUp: vi.fn(),
    onRefreshWallet: vi.fn(),
    onRefreshAccount: vi.fn(),
    ...over,
  };
  render(<MyServersAccount {...props} />);
  return props;
}

function avatarOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".account-avatar");
}

describe("账户行三态", () => {
  it("读取中：骨架头像 + 正在读取账户，不显示登录", () => {
    const props = renderAccount({ loaded: false, account: null, wallet: null });
    expect(screen.getByText("正在读取账户…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "登录" })).toBeNull();
    expect(document.querySelector(".account-avatar")?.classList.contains("is-loading")).toBe(
      true,
    );
    expect(props.onLogin).not.toHaveBeenCalled();
  });

  it("未登录：人形 + 未登录 + 登录", () => {
    const props = renderAccount({ account: LOGGED_OUT, wallet: null });
    expect(screen.getByText("未登录")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(props.onLogin).toHaveBeenCalledTimes(1);
    expect(avatarOf(document.body)?.classList.contains("has-initial")).toBe(false);
  });

  it("账户读取失败：账户暂时读不到 + 重试，不冒充未登录", () => {
    const props = renderAccount({ account: null, accountError: true, wallet: null });
    expect(screen.getByText("账户暂时读不到")).toBeTruthy();
    expect(screen.queryByText("未登录")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(props.onRefreshAccount).toHaveBeenCalledTimes(1);
  });

  it("已登录：首字母头像、邮箱与余额摘要", () => {
    renderAccount();
    const avatar = avatarOf(document.body);
    expect(avatar?.textContent).toBe("B");
    expect(avatar?.classList.contains("has-initial")).toBe(true);
    const email = document.querySelector(".rail-account__email");
    expect(email?.textContent).toBe("buyer@example.com");
    // 视觉截断靠 CSS，jsdom 量不到宽度：这里锁完整地址在 title 上。
    expect(email?.getAttribute("title")).toBe("buyer@example.com");
    expect(screen.getByText("$12.30")).toBeTruthy();
  });

  it("首字母：中文原样、取不到退回人形", () => {
    renderAccount({
      account: { ...LOGGED_IN, email: "张三@example.com" },
    });
    expect(avatarOf(document.body)?.textContent).toBe("张");
    cleanup();

    renderAccount({ account: { ...LOGGED_IN, email: null } });
    expect(avatarOf(document.body)?.classList.contains("has-initial")).toBe(false);
  });
});

describe("账户菜单", () => {
  it("展开后只有余额 / 充值 / 退出登录，没有设置与二次确认", async () => {
    const props = renderAccount({ open: true });
    expect(await screen.findByRole("dialog", { name: "账户菜单" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "充值" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "设置" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(props.onLogout).toHaveBeenCalledTimes(1);
  });

  it("退出失败：菜单内报错并给重试，保持登录", async () => {
    const onLogout = vi
      .fn()
      .mockResolvedValue({ ok: false, message: "没能退出登录，稍后再试。" });
    renderAccount({ open: true, onLogout });
    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("没能退出登录，稍后再试。");
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /buyer@example.com/ })).toBeTruthy();
  });
});
