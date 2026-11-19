/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
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
      onNotice={() => {}}
      onRestartOnboarding={() => {}}
      onOpenLogs={() => {}}
      onRestoreNetwork={() => {}}
      onAskAi={() => {}}
      initialSection="account"
      account={ACCOUNT}
      wallet={WALLET}
      onTopUp={() => {}}
      onViewBills={() => {}}
      {...over}
    />,
  );
}

describe("设置 › 账户", () => {
  it("邮箱整行显示并带 title，金额与账号菜单同一格式，且没有「查看账单」", () => {
    renderAccount();

    const email = screen.getByText("buyer@example.com");
    expect(email.className).toBe("settings-account__email");
    expect(email.getAttribute("title")).toBe("buyer@example.com");

    const amount = screen.getByText("$9.20");
    expect(amount.className).toContain("settings-account__amount");
    expect(amount.className).toContain("num");

    expect(screen.getByRole("button", { name: "充值" })).toBeTruthy();
    expect(screen.queryByText("查看账单")).toBeNull();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
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
    screen.getByRole("button", { name: "重试" }).click();
    expect(retry).toHaveBeenCalledTimes(1);
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

  it("在手机上使用：行常驻，点查看把触发行交给 App", () => {
    const open = vi.fn();
    renderAccount({ onOpenMobileExport: open });

    const button = screen.getByRole("button", { name: "查看" });
    expect(button.closest('[data-point="account.mobile"]')).toBeTruthy();
    button.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe(button);
  });

  it("未登录也有在手机上使用：下载入口对所有用户开放", () => {
    renderAccount({
      account: { ...ACCOUNT, logged_in: false, email: null },
      onOpenMobileExport: () => {},
    });
    expect(screen.getByText("在手机上使用")).toBeTruthy();
    expect(
      screen.getByText("下载 sing-box 官方客户端，扫码导入你的节点。"),
    ).toBeTruthy();
  });
});
