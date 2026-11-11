/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentBridge,
  NetworkForceResetResult,
  NetworkForceResetStep,
} from "../agent/bridge";
import { emptyRuntimeView } from "../agent/bridge";
import {
  Settings,
  resetOutcome,
  resetStepLabel,
  resetStepStatus,
  resetTimeLabel,
} from "./Settings";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeBridge(
  overrides: Partial<Record<keyof AgentBridge, unknown>> = {},
): AgentBridge {
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
    tunHelperRestart: vi.fn(async () => ({
      ok: true,
      restarted: true,
      needsAdminRestart: false,
    })),
    getDeepSeekKey: vi.fn(async () => ({
      masked: null,
      verified: false,
      validation: "unverified",
    })),
    llmProviderList: vi.fn(async () => ({ providers: [], activeProviderId: null })),
    networkForceReset: vi.fn(),
    ...overrides,
  } as unknown as AgentBridge;
}

function renderSettings(bridge: AgentBridge) {
  return render(
    <Settings
      open
      bridge={bridge}
      runtime={emptyRuntimeView()}
      defaultProfile={null}
      onClose={() => {}}
      onRestartOnboarding={() => {}}
      onOpenLogs={() => {}}
      onRestoreNetwork={() => {}}
      onAskAi={() => {}}
      initialSection="advanced"
    />,
  );
}

function step(
  id: string,
  status: "ok" | "failed" | "skipped" = "ok",
  detail = "",
): NetworkForceResetStep {
  return { id, ok: status === "ok", detail, status };
}

function successResult(): NetworkForceResetResult {
  return {
    ok: true,
    verified: true,
    exitIp: "198.51.100.9",
    steps: [
      step("stop_tun", "ok", "接管未在运行"),
      step("stop_runtime", "ok", "代理模式已停止"),
      step("restore_proxy", "ok", "系统代理未指向 Veyl"),
      step("sweep_processes", "ok", "没有 Veyl 的 sing-box 残留"),
      step("clear_routes", "ok", "没有分流路由残留"),
      step("flush_dns", "ok", "DNS 缓存已刷新"),
      step("clear_plaintext", "ok", "已清理 0 个明文配置"),
      step("verify", "ok", "各项检查都符合预期"),
    ],
  };
}

async function openConfirm() {
  const trigger = await screen.findByRole("button", { name: "重置网络" });
  // jsdom 的 click 不会移动焦点，显式模拟浏览器里点按钮后的焦点位置。
  trigger.focus();
  fireEvent.click(trigger);
  return {
    trigger,
    dialog: await screen.findByRole("dialog", { name: "重置网络？" }),
  };
}

describe("重置网络的纯函数", () => {
  it("后端 id 与设计文档 id 都映射到同一个中文名", () => {
    expect(resetStepLabel("sweep_processes")).toBe("清理残留组件");
    expect(resetStepLabel("clean_leftovers")).toBe("清理残留组件");
    expect(resetStepLabel("clear_routes")).toBe("恢复系统路由");
    expect(resetStepLabel("restore_routes")).toBe("恢复系统路由");
    expect(resetStepLabel("unknown_step")).toBe("其它检查");
  });

  it("ok 布尔与 status 冲突时以 status 为准", () => {
    expect(resetStepStatus({ id: "verify", ok: true, detail: "", status: "skipped" })).toBe(
      "skipped",
    );
    expect(resetStepStatus({ id: "verify", ok: false, detail: "" })).toBe("failed");
    expect(resetStepStatus({ id: "verify", ok: true, detail: "" })).toBe("ok");
  });

  it("只有 DNS / 临时配置 / 复查失败算部分完成，其余关键步骤失败算没有完成", () => {
    const result = successResult();
    result.ok = false;
    result.verified = false;
    result.steps[5] = step("flush_dns", "failed", "DNS 没有恢复");
    expect(resetOutcome(result)).toMatchObject({
      kind: "partial",
      title: "网络已重置，但有 1 项没完成",
    });

    result.steps[3] = step("sweep_processes", "failed", "还有残留组件");
    expect(resetOutcome(result).kind).toBe("failed");
  });

  it("没有逐项结果或复查未通过时用第三种说法，不虚构失败项", () => {
    expect(
      resetOutcome({ ok: false, verified: false, exitIp: null, steps: [] }),
    ).toMatchObject({ kind: "unverified", title: "没拿到逐项结果" });

    const greenButUnverified = successResult();
    greenButUnverified.ok = false;
    greenButUnverified.verified = false;
    expect(resetOutcome(greenButUnverified)).toMatchObject({
      kind: "unverified",
      title: "网络已重置，但复查没有通过",
    });
  });

  it("顶层 ok/verified 不可信时不会报成功", () => {
    const result = successResult();
    result.verified = false;
    expect(resetOutcome(result).kind).not.toBe("success");
    expect(resetOutcome({ ...result, steps: [] }).kind).toBe("unverified");
  });

  it("十分钟内显示「刚刚」，超过后显示今天的具体时间", () => {
    const now = new Date(2026, 10, 5, 14, 32, 0).getTime();
    expect(resetTimeLabel(now - 30_000, now)).toBe("刚刚");
    expect(resetTimeLabel(now - 10 * 60_000, now)).toBe("今天 14:22");
  });
});

describe("设置 → 遇到问题 → 修复网络", () => {
  it("重置网络独立成危险区域，入口在修复组里", async () => {
    const bridge = makeBridge();
    renderSettings(bridge);
    const trigger = await screen.findByRole("button", { name: "重置网络" });
    expect(trigger.className).toContain("btn--danger-ghost");
    expect(trigger.closest(".danger-zone")).not.toBeNull();
    expect(screen.getByText("修复网络")).toBeTruthy();
  });

  it("入口先弹二次确认，初始焦点在「取消」而不是危险按钮", async () => {
    const bridge = makeBridge();
    renderSettings(bridge);
    const { dialog } = await openConfirm();

    expect(
      within(dialog).getByText(
        "会立刻断开当前连接，并撤销 Veyl 对网络的改动。不会删除配置和节点。",
        { normalizer: (text) => text.replace(/\s+/g, " ").trim() },
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("正在开会或下载时，等结束再做。")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "重置网络" }).className).toContain(
      "btn--danger-ghost",
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: "取消" }),
      ),
    );
  });

  it("确认后显示等待态；运行中不能关、不能 Esc", async () => {
    let resolveReset!: (value: NetworkForceResetResult) => void;
    const pending = new Promise<NetworkForceResetResult>((resolve) => {
      resolveReset = resolve;
    });
    const networkForceReset = vi.fn(() => pending);
    renderSettings(makeBridge({ networkForceReset }));

    const { dialog } = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "重置网络" }));

    const running = await screen.findByRole("dialog", { name: "正在重置网络" });
    expect(networkForceReset).toHaveBeenCalledTimes(1);
    expect(within(running).getByText("不要关闭 Veyl。网络会短暂中断。")).toBeTruthy();
    expect(running.querySelector(".reset-progress")).not.toBeNull();
    expect(within(running).getByRole("button", { name: "正在重置…" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      within(running)
        .getAllByRole("button", { name: "关闭" })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "正在重置网络" })).toBeTruthy();

    await act(async () => {
      resolveReset(successResult());
      await pending;
    });

    const result = await screen.findByRole("dialog", { name: "重置网络" });
    expect(
      within(result).getByRole("heading", {
        name: "网络已恢复。可以重新连接了。",
      }),
    ).toBeTruthy();
  });

  it("成功只留一行结论，八步收进可展开的详情", async () => {
    const networkForceReset = vi.fn(async () => successResult());
    renderSettings(makeBridge({ networkForceReset }));
    const { trigger, dialog } = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "重置网络" }));

    const result = await screen.findByRole("dialog", { name: "重置网络" });
    expect(
      within(result).getByText("网络已恢复。可以重新连接了。"),
    ).toBeTruthy();
    const details = within(result).getByText("查看详情").closest("details");
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);

    expect(within(result).getAllByText("已完成")).toHaveLength(8);
    expect(within(result).getByText("停止连接程序")).toBeTruthy();
    expect(within(result).getByText("关闭接管")).toBeTruthy();
    expect(within(result).getByText("复查网络状态")).toBeTruthy();
    // 成功行用固定说明，不直接抛后端里带内部路径的 detail。
    expect(within(result).getByText("接管已关闭。")).toBeTruthy();
    expect(within(result).getByText("临时配置文件已删除。")).toBeTruthy();
    expect(within(result).queryByText(/sing-box|utun/)).toBeNull();
    expect(within(result).queryByText(/没有通过复查/)).toBeNull();

    fireEvent.click(within(result).getAllByRole("button", { name: "关闭" })[1]);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "网络已恢复。可以重新连接了。" }),
      ).toBeNull(),
    );
    expect(screen.getByText("上次重置：刚刚 · 8 项全部完成")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("关键步骤失败时给出下一步和手动清理路由，跳过的行显示未执行", async () => {
    const failure: NetworkForceResetResult = {
      ok: false,
      verified: false,
      exitIp: null,
      steps: [
        step("stop_tun"),
        step("stop_runtime"),
        step("restore_proxy"),
        step("sweep_processes"),
        step("clear_routes", "failed", "路由残留需要手工清理：sudo route -n delete -net 128.0.0.0/1"),
        step("flush_dns"),
        step("clear_plaintext"),
        step("verify", "skipped", ""),
      ],
    };
    const networkForceReset = vi.fn(async () => failure);
    renderSettings(makeBridge({ networkForceReset }));
    const { dialog } = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "重置网络" }));

    const result = await screen.findByRole("dialog", { name: "重置网络" });
    expect(
      within(result).getByRole("heading", { name: "重置没有完成" }),
    ).toBeTruthy();
    expect(within(result).getByText("未完成")).toBeTruthy();
    // 后端 detail 可能带命令和路径：界面用固定文案，原文只进诊断复制。
    expect(within(result).getByText("系统路由还有残留。")).toBeTruthy();
    expect(within(result).queryByText(/128\.0\.0\.0\/1/)).toBeNull();
    expect(within(result).getByText("重启电脑后再试一次；仍然不行，展开「手动清理路由」。")).toBeTruthy();
    expect(within(result).getByText("未执行")).toBeTruthy();
    expect(within(result).getByText("前面一步没有完成，已跳过。")).toBeTruthy();
    expect(within(result).getByText(/网络状态没有通过复查/)).toBeTruthy();
    expect(within(result).getByText("手动清理路由（高级）")).toBeTruthy();
    expect(within(result).getByRole("button", { name: "再试一次" })).toBeTruthy();
  });

  it("仅非关键步骤失败时标题是「网络已重置，但有 n 项没完成」", async () => {
    const partial = successResult();
    partial.ok = false;
    partial.verified = false;
    partial.steps[5] = step("flush_dns", "failed", "DNS 没有恢复");
    const networkForceReset = vi.fn(async () => partial);
    renderSettings(makeBridge({ networkForceReset }));
    const { dialog } = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "重置网络" }));

    const result = await screen.findByRole("dialog", { name: "重置网络" });
    expect(
      within(result).getByRole("heading", {
        name: "网络已重置，但有 1 项没完成",
      }),
    ).toBeTruthy();
  });

  it("命令没有开始时不假装成功，给出原因", async () => {
    const networkForceReset = vi.fn(async () => {
      throw new Error("unknown command: network_force_reset");
    });
    renderSettings(makeBridge({ networkForceReset }));
    const { dialog } = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "重置网络" }));

    const result = await screen.findByRole("dialog", { name: "重置网络" });
    expect(
      within(result).getByRole("heading", { name: "重置没有开始" }),
    ).toBeTruthy();
    expect(within(result).getByText("当前版本还没有接入重置网络，请更新应用后再试。")).toBeTruthy();
    expect(within(result).queryByText("已完成")).toBeNull();
  });

  it("确认前 Esc 只关重置弹层，不关设置", async () => {
    renderSettings(makeBridge());
    await openConfirm();
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "重置网络？" })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
  });

  it("点「取消」按钮也能关闭重置弹层，设置还在", async () => {
    renderSettings(makeBridge());
    const { dialog } = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "重置网络？" })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
  });

  it("连点两次「重置网络」只调用一次命令", async () => {
    let resolveReset!: (value: NetworkForceResetResult) => void;
    const pending = new Promise<NetworkForceResetResult>((resolve) => {
      resolveReset = resolve;
    });
    const networkForceReset = vi.fn(() => pending);
    renderSettings(makeBridge({ networkForceReset }));
    const { dialog } = await openConfirm();

    const confirm = within(dialog).getByRole("button", { name: "重置网络" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await screen.findByRole("dialog", { name: "正在重置网络" });
    expect(networkForceReset).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveReset(successResult());
      await pending;
    });
  });

  it("重置弹层打开时设置弹层的陷阱让位，Tab 不会把焦点拉回设置头部", async () => {
    renderSettings(makeBridge());
    const { dialog } = await openConfirm();

    // 设置弹层此时 inert + aria-hidden，不能再按 role 找。
    const settingsDialog = document.querySelector(".modal--settings");
    expect(settingsDialog).not.toBeNull();
    const focusInSettings = vi.fn();
    settingsDialog!.addEventListener("focusin", focusInSettings);

    const confirm = within(dialog).getByRole("button", { name: "重置网络" });
    confirm.focus();
    focusInSettings.mockClear();

    fireEvent.keyDown(document, { key: "Tab" });

    expect(focusInSettings).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      within(dialog).getAllByRole("button", { name: "关闭" })[0],
    );

    settingsDialog!.removeEventListener("focusin", focusInSettings);
  });
});
