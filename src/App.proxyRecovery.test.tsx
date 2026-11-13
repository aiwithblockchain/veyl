/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import type { ProxyRecovery } from "./agent/bridge";

const bridge = getAgentBridge();
const modeDescriptor = Object.getOwnPropertyDescriptor(bridge, "mode");

function recovery(over: Partial<ProxyRecovery> = {}): ProxyRecovery {
  return {
    status: "restored",
    endpoint: "127.0.0.1:7890",
    current: null,
    error: null,
    at: Date.now(),
    source: "watchdog",
    ...over,
  };
}

function prepare(report: { recovery: ProxyRecovery | null } | null) {
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  localStorage.setItem("veyl.onboarding.skipped", "1");
  vi.spyOn(bridge, "configList").mockResolvedValue({
    configs: [],
    active_config_id: null,
  });
  vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
  vi.spyOn(bridge, "tunHelperInfo").mockResolvedValue({
    runningBuild: null,
    expectedBuild: "2026.11.1",
    stale: false,
    state: "not_running",
    needsAdminRestart: false,
  } as never);
  return vi.spyOn(bridge, "proxyRecoveryReport").mockResolvedValue(report as never);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  vi.restoreAllMocks();
  if (modeDescriptor) Object.defineProperty(bridge, "mode", modeDescriptor);
});

describe("异常退出后的网络设置恢复提示", () => {
  it("restored：普通提示，4 秒后自动消失", async () => {
    vi.useFakeTimers();
    prepare({ recovery: recovery({ status: "restored" }) });
    const { container } = render(<App />);
    await act(async () => {});

    const toast = container.querySelector(".app-toast");
    expect(toast?.className).toContain("app-toast--info");
    expect(toast?.textContent).toContain("上次没退出干净，网络设置已恢复。");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(container.querySelector(".app-toast")).toBeNull();
  });

  it("failed：错误色提示，不自动消失", async () => {
    vi.useFakeTimers();
    prepare({ recovery: recovery({ status: "failed", error: "改不回去" }) });
    const { container } = render(<App />);
    await act(async () => {});

    const toast = container.querySelector(".app-toast");
    expect(toast?.className).toContain("app-toast--error");
    expect(toast?.textContent).toContain(
      "网络设置没能自动恢复。打开「设置 → 遇到问题 → 强制重置网络」。",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(container.querySelector(".app-toast")).not.toBeNull();
  });

  it.each(["already_restored", "left_alone"] as const)(
    "%s：静默，不提示",
    async (status) => {
      prepare({ recovery: recovery({ status }) });
      const { container } = render(<App />);
      await act(async () => {});
      expect(container.querySelector(".app-toast")).toBeNull();
    },
  );

  it("没有恢复动作（null）：不提示", async () => {
    prepare(null);
    const { container } = render(<App />);
    await act(async () => {});
    expect(container.querySelector(".app-toast")).toBeNull();
  });

  it("每次启动只读一次", async () => {
    const report = prepare({ recovery: recovery({ status: "restored" }) });
    const { rerender } = render(<App />);
    await act(async () => {});
    rerender(<App />);
    await act(async () => {});
    expect(report).toHaveBeenCalledTimes(1);
  });
});
