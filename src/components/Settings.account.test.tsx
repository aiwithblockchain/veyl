/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServerAccount, MyServerWallet } from "../agent/bridge";
import { emptyRuntimeView } from "../agent/bridge";
import { Settings } from "./Settings";

afterEach(cleanup);

const WALLET: MyServerWallet = {
  balance_cents: 920,
  currency: "USD",
  denominations_cents: [1000],
  updated_at: new Date(0).toISOString(),
};

const ACCOUNT: MyServerAccount = {
  logged_in: true,
  email: "buyer@example.com",
  account_id: "acct_1",
  device_id: "dev_1",
  account_kind: "email",
  session_expires_at: null,
};

function makeBridge(): AgentBridge {
  return {
    mode: "mock",
    subscribe: vi.fn(() => () => {}),
    coreInfo: vi.fn(async () => ({
      bundledVersion: "1.14.4",
      activeVersion: "1.14.4",
      activeSource: "bundled" as const,
      restartRequired: false,
    })),
    tunHelperInfo: vi.fn(async () => ({
      runningBuild: null,
      helperVersion: null,
      expectedBuild: "2026.11.1",
      stale: false,
      state: "not_running" as const,
      needsAdminRestart: false,
    })),
    coreCheckUpdates: vi.fn(async () => ({
      network: "ok" as const,
      candidates: [],
      cached: false,
    })),
    llmProviderList: vi.fn(async () => ({ providers: [], activeProviderId: null })),
    getAppVersion: vi.fn(async () => "0.1.0"),
    defaultProfileRefresh: vi.fn(),
    defaultProfileStatus: vi.fn(),
    issueReportPreference: vi.fn(async (includeDomains?: boolean) => ({
      includeDomains: includeDomains ?? false,
    })),
  } as unknown as AgentBridge;
}

function renderAccount(
  over: Partial<ComponentProps<typeof Settings>> = {},
) {
  return render(
    <Settings
      open
      bridge={makeBridge()}
      runtime={emptyRuntimeView()}
      defaultProfile={null}
      onClose={() => {}}
      onRestartOnboarding={() => {}}
      onOpenLogs={() => {}}
      onRestoreNetwork={() => {}}
      onAskAi={() => {}}
      initialSection="account"
      account={ACCOUNT}
      wallet={WALLET}
      onTopUp={() => {}}
      onLogout={async () => ({ ok: true })}
      {...over}
    />,
  );
}

describe("设置 › 账户", () => {
  it("邮箱整行显示并带 title，金额用与账户页一致的格式", () => {
    renderAccount();

    const email = screen.getByText("buyer@example.com");
    expect(email.className).toBe("settings-account__email");
    expect(email.getAttribute("title")).toBe("buyer@example.com");

    const amount = screen.getByText("$9.20");
    expect(amount.className).toContain("settings-account__amount");
    expect(amount.className).toContain("num");

    const topUp = screen.getByRole("button", { name: "充值" });
    expect(topUp.className).toContain("btn--primary");
    expect(screen.queryByText("在其它设备上使用")).toBeNull();
  });

  it("余额下有一句计费说明", () => {
    renderAccount();
    expect(screen.getByText("余额按天扣费，每台服务器单独计费。")).toBeTruthy();
  });

  it("余额读取中显示「读取中」，不显示 —", () => {
    renderAccount({ wallet: null, walletLoading: true });
    expect(screen.getByText("读取中")).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("余额失败显示同一句话与「重试」，点重试调用刷新", () => {
    const retry = vi.fn();
    renderAccount({ wallet: null, walletError: "down", onRefreshWallet: retry });

    expect(screen.getByText(/余额暂时读不到。/)).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
    const before = retry.mock.calls.length;
    screen.getByRole("button", { name: "重试" }).click();
    expect(retry.mock.calls.length).toBe(before + 1);
    expect(retry).toHaveBeenLastCalledWith("retry");
  });

  it("没有接线时退化为 —，不崩", () => {
    renderAccount({ wallet: undefined, onRefreshWallet: undefined });
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("未登录时不出现余额与邮箱行", () => {
    renderAccount({ account: { ...ACCOUNT, logged_in: false, email: null } });
    expect(screen.queryByText("buyer@example.com")).toBeNull();
    expect(screen.queryByText("$9.20")).toBeNull();
    expect(screen.getByRole("button", { name: "登录" })).toBeTruthy();
  });

  it("近 30 天账单是本批占位：点查看展开一句说明，再点收起", () => {
    renderAccount();
    const row = document.querySelector('[data-point="account.bills"]') as HTMLElement;
    const button = within(row).getByRole("button", { name: "查看账单" });

    expect(within(row).queryByText("账单还在接入，下一版开放。")).toBeNull();
    fireEvent.click(button);
    expect(within(row).getByText("账单还在接入，下一版开放。")).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(button);
    expect(within(row).queryByText("账单还在接入，下一版开放。")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("退出登录：成功后关闭设置", async () => {
    const onLogout = vi.fn(async () => ({ ok: true as const }));
    const onClose = vi.fn();
    renderAccount({ onLogout, onClose });

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("退出登录失败：原位显示错误并可重试", async () => {
    const onLogout = vi.fn(async () => ({ ok: false as const, message: "没网。" }));
    renderAccount({ onLogout });

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(await screen.findByText("没网。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(2));
  });

  it("设备身份丢了：顶部给说明与重新注册", async () => {
    const onReRegister = vi.fn(async () => true);
    renderAccount({ identityProblem: "lost", onReRegister });

    expect(screen.getByText(/这台设备的身份丢了/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新注册设备" }));
    await waitFor(() => expect(onReRegister).toHaveBeenCalledTimes(1));
  });

  it("设备停用：退出这台设备失败时，错误出现在恢复块里", async () => {
    const onLogout = vi.fn(async () => ({ ok: false as const, message: "没网。" }));
    renderAccount({ identityProblem: "device_revoked", onLogout });

    fireEvent.click(screen.getByRole("button", { name: "退出这台设备" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("没网。")).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("账户停用：隐藏余额与充值，给换账户与退出这台设备", async () => {
    const onSwitchAccount = vi.fn(async () => true);
    const onLogout = vi.fn(async () => ({ ok: true as const }));
    renderAccount({
      identityProblem: "account_blocked",
      onSwitchAccount,
      onLogout,
    });

    expect(screen.queryByText("余额")).toBeNull();
    expect(screen.queryByRole("button", { name: "充值" })).toBeNull();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    expect(screen.getByText(/这个账户已停用/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "换一个账户" }));
    await waitFor(() => expect(onSwitchAccount).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "退出这台设备" }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
  });
});

describe("余额刷新入口与陈旧提示", () => {
  it("余额右侧有「刷新」，点击走强制刷新；刷新中禁用并写「刷新中」", () => {
    const gated = vi.fn();
    const force = vi.fn();
    const first = renderAccount({
      onRefreshWallet: gated,
      onForceRefresh: force,
    });
    // 打开账户段走门禁版；「刷新」链接走强制版。
    expect(gated.mock.calls.length).toBe(1);
    expect(force).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "刷新" }).click();
    expect(force).toHaveBeenCalledTimes(1);
    expect(gated.mock.calls.length).toBe(1);
    first.unmount();

    renderAccount({ walletRefreshing: true, onForceRefresh: force });
    const busy = screen.getByRole("button", {
      name: "刷新中",
    }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
  });

  it("已有旧值、刷新失败：金额保留，同屏写「没刷新成功」并保留刷新入口", () => {
    const first = renderAccount({ walletStale: true });
    expect(screen.getByText("$9.20")).toBeTruthy();
    expect(
      screen.getByText("没刷新成功，显示的是上次的余额。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
    first.unmount();

    renderAccount();
    expect(screen.queryByText(/没刷新成功/)).toBeNull();
  });

  it("从未取到值就失败：只写「余额暂时读不到」+ 重试，不出现旧值提示", () => {
    renderAccount({
      wallet: null,
      walletError: "down",
      onRefreshWallet: vi.fn(),
    });
    expect(screen.getByText(/余额暂时读不到。/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByText(/没刷新成功/)).toBeNull();
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
  });

  it("打开设置›账户时触发一次刷新", () => {
    const refresh = vi.fn();
    renderAccount({ onRefreshWallet: refresh });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("open_settings");
  });

  it("未登录时停在账户段不发余额请求", () => {
    const refresh = vi.fn();
    renderAccount({
      account: { ...ACCOUNT, logged_in: false, email: null },
      onRefreshWallet: refresh,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("AI ↔ 账户来回切：每次都触发门禁版回调（去重由 App 的 hook 负责）", () => {
    const refresh = vi.fn();
    renderAccount({ onRefreshWallet: refresh });
    const base = refresh.mock.calls.length;
    fireEvent.click(screen.getByRole("tab", { name: "AI" }));
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));
    // 组件每次切回账户段都会问一次；30 秒门禁在同一份 refreshWallet 里。
    expect(refresh.mock.calls.length).toBe(base + 1);
  });
});
