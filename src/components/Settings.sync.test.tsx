/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, SyncIntervalMinutes } from "../agent/bridge";
import { emptyRuntimeView } from "../agent/bridge";
import { setLanguage } from "../i18n";
import { Settings } from "./Settings";

afterEach(cleanup);

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

function renderSettings({
  syncInterval = 240 as SyncIntervalMinutes,
  onSyncIntervalChange,
  onSyncNow,
  syncBusy = false,
  syncIntervalUnsaved = false,
  lastSyncedAt = null,
}: {
  syncInterval?: SyncIntervalMinutes;
  onSyncIntervalChange?: (minutes: SyncIntervalMinutes) => void;
  onSyncNow?: () => void;
  syncBusy?: boolean;
  syncIntervalUnsaved?: boolean;
  lastSyncedAt?: number | null;
} = {}) {
  return render(
    <Settings
      open
      bridge={makeBridge()}
      runtime={emptyRuntimeView()}
      defaultProfile={null}
      configId="cfg_1"
      onClose={() => {}}
      onNotice={() => {}}
      onRestartOnboarding={() => {}}
      onOpenLogs={() => {}}
      onRestoreNetwork={() => {}}
      onAskAi={() => {}}
      initialSection="network"
      syncInterval={syncInterval}
      onSyncIntervalChange={onSyncIntervalChange}
      onSyncNow={onSyncNow}
      syncBusy={syncBusy}
      syncIntervalUnsaved={syncIntervalUnsaved}
      lastSyncedAt={lastSyncedAt}
    />,
  );
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

  it("同步中禁用「立即同步」", () => {
    renderSettings({
      onSyncIntervalChange: () => {},
      onSyncNow: () => {},
      syncBusy: true,
    });

    expect(
      (screen.getByRole("button", { name: "立即同步" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("点「立即同步」触发 onSyncNow", () => {
    const onSyncNow = vi.fn();
    renderSettings({ onSyncIntervalChange: () => {}, onSyncNow });

    fireEvent.click(screen.getByRole("button", { name: "立即同步" }));

    expect(onSyncNow).toHaveBeenCalledTimes(1);
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
