/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServerAccount, SyncIntervalMinutes } from "../agent/bridge";
import { emptyRuntimeView } from "../agent/bridge";
import { setLanguage } from "../i18n";
import { Settings } from "./Settings";

afterEach(cleanup);

const signedInAccount: MyServerAccount = {
  logged_in: true,
  email: "me@example.com",
  account_id: "acc_1",
  device_id: "dev_1",
  account_kind: "email",
  session_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
};

const deviceAccount: MyServerAccount = {
  logged_in: false,
  email: null,
  account_id: null,
  device_id: "dev_1",
  account_kind: "device",
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
    llmProviderList: vi.fn(async () => ({
      providers: [],
      activeProviderId: null,
    })),
    getAppVersion: vi.fn(async () => "0.1.0"),
  } as unknown as AgentBridge;
}

interface SyncProps {
  syncInterval?: SyncIntervalMinutes;
  onSyncIntervalChange?: (minutes: SyncIntervalMinutes) => void;
  onSyncNow?: () => void;
  syncBusy?: boolean;
  syncResult?: "ok" | "error" | null;
  syncResultAt?: number | null;
  syncIntervalUnsaved?: boolean;
  lastSyncedAt?: number | null;
  account?: MyServerAccount | null;
}

function settingsElement({
  syncInterval = 240 as SyncIntervalMinutes,
  onSyncIntervalChange,
  onSyncNow,
  syncBusy = false,
  syncResult = null,
  syncResultAt = null,
  syncIntervalUnsaved = false,
  lastSyncedAt = null,
  account = signedInAccount,
}: SyncProps = {}) {
  return (
    <Settings
      open
      bridge={makeBridge()}
      runtime={emptyRuntimeView()}
      defaultProfile={null}
      configId="cfg_1"
      onClose={() => {}}
      onRestartOnboarding={() => {}}
      onOpenLogs={() => {}}
      onRestoreNetwork={() => {}}
      onAskAi={() => {}}
      initialSection="network"
      account={account}
      syncInterval={syncInterval}
      onSyncIntervalChange={onSyncIntervalChange}
      onSyncNow={onSyncNow}
      syncBusy={syncBusy}
      syncResult={syncResult}
      syncResultAt={syncResultAt}
      syncIntervalUnsaved={syncIntervalUnsaved}
      lastSyncedAt={lastSyncedAt}
    />
  );
}

function renderSettings(props: SyncProps = {}) {
  return render(settingsElement(props));
}

/** 同步行的状态文字：与「未保存」等左栏说明区分，只取右侧那一格。 */
function syncStatus(): string {
  const row = screen.getByText("节点配置同步").closest(".settings-row");
  return row
    ? (row.querySelector(".settings-row__aside .settings-row__value")?.textContent ??
        "")
    : "";
}

describe("设置 › 节点配置同步", () => {
  it("渲染行、六个间隔档位与立即同步按钮", () => {
    renderSettings({ onSyncIntervalChange: () => {}, onSyncNow: () => {} });

    expect(screen.getByText("节点配置同步")).toBeTruthy();
    const select = screen.getByLabelText("同步间隔") as HTMLSelectElement;
    expect(select.value).toBe("240");
    expect(
      Array.from(select.options).map((option) => option.textContent),
    ).toEqual(["手动", "30 分钟", "1 小时", "4 小时", "8 小时", "24 小时"]);
    expect(screen.getByRole("button", { name: "立即同步" })).toBeTruthy();
  });

  it("切换间隔只回调新值", () => {
    const onSyncIntervalChange = vi.fn();
    renderSettings({ onSyncIntervalChange, onSyncNow: () => {} });

    fireEvent.change(screen.getByLabelText("同步间隔"), {
      target: { value: "60" },
    });

    expect(onSyncIntervalChange).toHaveBeenCalledTimes(1);
    expect(onSyncIntervalChange).toHaveBeenCalledWith(60);
  });

  it("同步中只按钮写「同步中…」，值槽保留上一次的时间", () => {
    renderSettings({
      onSyncIntervalChange: () => {},
      onSyncNow: () => {},
      syncBusy: true,
    });

    expect(syncStatus()).toBe("尚未同步");
    expect(
      (screen.getByRole("button", { name: "同步中…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("同步中不覆盖已有的成功时间", () => {
    renderSettings({
      onSyncIntervalChange: () => {},
      onSyncNow: () => {},
      syncBusy: true,
      lastSyncedAt: Date.now(),
    });

    expect(syncStatus()).toBe("刚刚同步");
    expect(
      (screen.getByRole("button", { name: "同步中…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("点「立即同步」触发 onSyncNow", () => {
    const onSyncNow = vi.fn();
    renderSettings({ onSyncIntervalChange: () => {}, onSyncNow });

    fireEvent.click(screen.getByRole("button", { name: "立即同步" }));

    expect(onSyncNow).toHaveBeenCalledTimes(1);
  });

  it("账户还没读回来：按钮禁用，值槽保持「尚未同步」", () => {
    const onSyncNow = vi.fn();
    renderSettings({
      account: null,
      onSyncIntervalChange: () => {},
      onSyncNow,
    });

    expect(syncStatus()).toBe("尚未同步");
    const button = screen.getByRole("button", {
      name: "立即同步",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSyncNow).not.toHaveBeenCalled();
  });

  it("未登录：行内说明登录后才会同步，点按钮不发请求", () => {
    const onSyncNow = vi.fn();
    renderSettings({
      account: deviceAccount,
      onSyncIntervalChange: () => {},
      onSyncNow,
    });

    expect(syncStatus()).toBe("登录后才会同步");
    const button = screen.getByRole("button", {
      name: "立即同步",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSyncNow).not.toHaveBeenCalled();
  });

  it("同步成功：结果 ok 且时间推进后显示「刚刚同步」", () => {
    const onSyncNow = vi.fn();
    const { rerender } = renderSettings({
      onSyncIntervalChange: () => {},
      onSyncNow,
    });

    fireEvent.click(screen.getByRole("button", { name: "立即同步" }));
    rerender(
      settingsElement({ onSyncIntervalChange: () => {}, onSyncNow, syncBusy: true }),
    );
    expect(syncStatus()).toBe("尚未同步");

    rerender(
      settingsElement({
        onSyncIntervalChange: () => {},
        onSyncNow,
        lastSyncedAt: Date.now(),
        syncResult: "ok",
        syncResultAt: Date.now(),
      }),
    );
    expect(syncStatus()).toBe("刚刚同步");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("同步失败：结果 error 时给一行可读错误，成功后清掉", () => {
    const onSyncNow = vi.fn();
    const { rerender } = renderSettings({
      onSyncIntervalChange: () => {},
      onSyncNow,
    });

    fireEvent.click(screen.getByRole("button", { name: "立即同步" }));
    rerender(
      settingsElement({ onSyncIntervalChange: () => {}, onSyncNow, syncBusy: true }),
    );
    rerender(
      settingsElement({
        onSyncIntervalChange: () => {},
        onSyncNow,
        syncResult: "error",
        syncResultAt: Date.now(),
      }),
    );

    expect(screen.getByRole("alert").textContent).toBe("同步失败，稍后再试");
    expect(syncStatus()).toBe("尚未同步");

    rerender(
      settingsElement({
        onSyncIntervalChange: () => {},
        onSyncNow,
        lastSyncedAt: Date.now(),
        syncResult: "ok",
        syncResultAt: Date.now(),
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("间隔写库失败时行内标「未保存」", () => {
    renderSettings({
      onSyncIntervalChange: () => {},
      onSyncNow: () => {},
      syncIntervalUnsaved: true,
    });

    expect(screen.getByText("未保存")).toBeTruthy();
  });

  it("没有失败标记时不显示「未保存」", () => {
    renderSettings({ onSyncIntervalChange: () => {}, onSyncNow: () => {} });

    expect(screen.queryByText("未保存")).toBeNull();
  });

  it("从未同步时显示「尚未同步」", () => {
    renderSettings({
      onSyncIntervalChange: () => {},
      onSyncNow: () => {},
      lastSyncedAt: null,
    });

    expect(screen.getByText("尚未同步")).toBeTruthy();
  });

  it("有过成功同步时显示两位时分（跟随应用语言）", () => {
    setLanguage("zh");
    const at = new Date(2026, 10, 22, 9, 5).getTime();
    renderSettings({
      onSyncIntervalChange: () => {},
      onSyncNow: () => {},
      lastSyncedAt: at,
    });

    const expected = new Date(at).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(screen.getByText(`最近同步 ${expected}`)).toBeTruthy();
  });
});
