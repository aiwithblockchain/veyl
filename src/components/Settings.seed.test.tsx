/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, DefaultProfileStatus } from "../agent/bridge";
import { emptyRuntimeView } from "../agent/bridge";
import { Settings, seedAgeLabel, seedSummary } from "./Settings";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = Date.now();

function profile(overrides: Record<string, unknown> = {}): DefaultProfileStatus {
  return {
    packageId: "veyl_seed",
    version: "3",
    appliedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
    newVersionAvailable: false,
    nodeCount: 12,
    checkedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
    source: "cache" as const,
    changed: false,
    reason: null,
    added: 0,
    removed: 0,
    ...overrides,
  } as unknown as DefaultProfileStatus;
}

function makeBridge(
  refresh: () => Promise<unknown>,
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
      expectedBuild: "2026.11.1",
      stale: false,
      state: "not_running" as const,
      needsAdminRestart: false,
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
    defaultProfileRefresh: vi.fn(refresh),
    ...overrides,
  } as unknown as AgentBridge;
}

function renderSettings(
  bridge: AgentBridge,
  options: {
    profile?: DefaultProfileStatus | null;
    connected?: boolean;
  } = {},
) {
  const runtime = options.connected
    ? { ...emptyRuntimeView(), state: "running" as const }
    : emptyRuntimeView();
  return render(
    <Settings
      open
      bridge={bridge}
      runtime={runtime}
      defaultProfile={options.profile ?? profile()}
      onClose={() => {}}
      onNotice={() => {}}
      importing={false}
      dragging={false}
      importResult={null}
      importError={null}
      onImportPath={() => {}}
      onRestartOnboarding={() => {}}
      onOpenLogs={() => {}}
      onRestoreNetwork={() => {}}
      onAskAi={() => {}}
      initialSection="advanced"
    />,
  );
}

function seedRow(): HTMLElement {
  return screen.getByText("测试节点").closest(".settings-row") as HTMLElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("测试节点纯函数", () => {
  it("相对时间按分钟、小时、天分档", () => {
    const now = 10 * 86_400_000;
    expect(seedAgeLabel(now - 30_000, now)).toBe("刚刚");
    expect(seedAgeLabel(now - 12 * 60_000, now)).toBe("12 分钟前");
    expect(seedAgeLabel(now - 3 * 3_600_000, now)).toBe("3 小时前");
    expect(seedAgeLabel(now - 2 * 86_400_000, now)).toBe("2 天前");
    expect(seedAgeLabel(null, now)).toBe("从未");
  });

  it("摘要省略空版本，节点为 0 时显示还没有节点", () => {
    expect(
      seedSummary({
        packageId: "veyl_seed",
        version: null,
        appliedAt: null,
        newVersionAvailable: false,
        nodeCount: 0,
        checkedAt: null,
      } as unknown as DefaultProfileStatus),
    ).toBe("还没有节点 · 从未检查");
  });
});

describe("设置页测试节点行", () => {
  it("高级页展示测试节点与检查更新，网络页不再保留默认配置源", async () => {
    renderSettings(makeBridge(async () => profile()));

    expect(await screen.findByText("测试节点")).toBeTruthy();
    expect(within(seedRow()).getByRole("button", { name: "检查更新" })).toBeTruthy();
    expect(screen.queryByText("测试节点地址")).toBeNull();
    expect(screen.getByText(/v3 · 12 个节点 · 3 小时前检查/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "网络" }));
    expect(screen.queryByText("默认配置源")).toBeNull();
    expect(screen.queryByText("测试节点")).toBeNull();
  });

  it("检查中禁用按钮，完成后回到可用", async () => {
    const gate = deferred<unknown>();
    const bridge = makeBridge(() => gate.promise);
    renderSettings(bridge);

    const button = await screen.findByRole("button", { name: "检查更新" });
    fireEvent.click(button);

    expect(await screen.findByText("正在检查测试节点…")).toBeTruthy();
    expect((within(seedRow()).getByRole("button", { name: "检查中…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(bridge.defaultProfileRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve(
        profile({ version: "3", nodeCount: 12, source: "network", changed: false }),
      );
      await Promise.resolve();
    });

    expect(await screen.findByText("已经是最新（刚刚检查）")).toBeTruthy();
    expect((within(seedRow()).getByRole("button", { name: "检查更新" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("连点只发一次请求", async () => {
    const gate = deferred<unknown>();
    const bridge = makeBridge(() => gate.promise);
    renderSettings(bridge);

    const button = await screen.findByRole("button", { name: "检查更新" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(bridge.defaultProfileRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve(profile({ source: "network", changed: false }));
      await Promise.resolve();
    });
  });

  it("已更新时显示数量与总数，连接中追加下次连接生效", async () => {
    const bridge = makeBridge(async () =>
      profile({ version: "4", nodeCount: 12, source: "network", changed: true, added: 3 }),
    );
    renderSettings(bridge, { connected: true });

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));

    expect(
      await screen.findByText("已更新 3 个节点（共 12 个），下次连接生效"),
    ).toBeTruthy();
    expect(screen.getByText(/v4 · 12 个节点/)).toBeTruthy();
  });

  it("没有 added 时退回「已更新（共 M 个节点）」", async () => {
    const bridge = makeBridge(async () =>
      profile({ nodeCount: 12, source: "network", changed: true, added: null }),
    );
    renderSettings(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("已更新（共 12 个节点）")).toBeTruthy();
  });

  it("离线保留缓存时用 warn 文案，按钮不被锁死", async () => {
    const bridge = makeBridge(async () =>
      profile({
        source: "cache",
        changed: false,
        checkedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      }),
    );
    renderSettings(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(
      await screen.findByText("现在连不上，继续用上次的节点（2 小时前）"),
    ).toBeTruthy();
    expect((within(seedRow()).getByRole("button", { name: "检查更新" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("内容异常时保留旧节点，并提供复制诊断信息", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const bridge = makeBridge(async () =>
      profile({ source: "cache", changed: false, reason: "invalid_content" }),
    );
    renderSettings(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("新内容有问题，已保留原来的节点")).toBeTruthy();
    const copy = within(seedRow()).getByRole("button", { name: "复制诊断信息" });
    fireEvent.click(copy);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain("invalid_content");
    expect(await within(seedRow()).findByRole("button", { name: "已复制" })).toBeTruthy();
  });

  it("无缓存且拉取失败时提示检查网络，不显示已是最新", async () => {
    const bridge = makeBridge(async () => {
      throw { code: "UPSTREAM_ERROR", message: "现在拿不到测试节点：offline" };
    });
    renderSettings(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("拿不到测试节点，请检查网络")).toBeTruthy();
    expect(screen.queryByText(/已经是最新/)).toBeNull();
    expect((within(seedRow()).getByRole("button", { name: "检查更新" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("刷新后切到网络再回高级，版本与节点数保持", async () => {
    const bridge = makeBridge(async () =>
      profile({ version: "4", nodeCount: 18, source: "network", changed: true, added: 6 }),
    );
    renderSettings(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("已更新 6 个节点（共 18 个）")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "网络" }));
    fireEvent.click(screen.getByRole("button", { name: "高级" }));

    expect(await screen.findByText(/v4 · 18 个节点/)).toBeTruthy();
  });

  it("本机写入失败时提示没能保存到本机，旧缓存保留且按钮可用", async () => {
    // 真实形态是 source = network、changed = false：内容没问题，只是没写进本机。
    const bridge = makeBridge(async () =>
      profile({ source: "network", changed: false, reason: "local_write" }),
    );
    renderSettings(bridge);

    fireEvent.click(within(seedRow()).getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("没能保存到本机")).toBeTruthy();
    expect(
      screen.getByText("检查磁盘空间后重试，已经拉到的内容不会丢。"),
    ).toBeTruthy();
    expect(screen.getByText(/v3 · 12 个节点/)).toBeTruthy();
    expect(
      (within(seedRow()).getByRole("button", { name: "检查更新" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByText("新内容有问题，已保留原来的节点")).toBeNull();
    expect(screen.queryByText(/现在连不上/)).toBeNull();
  });

  it("当前节点被新版本删除时提示替代节点，连接中追加生效时机", async () => {
    const bridge = makeBridge(async () =>
      profile({
        source: "network",
        changed: true,
        added: 2,
        removed: 1,
        removedNodeName: "香港 01",
        replacementNodeName: "东京 02",
      }),
    );
    renderSettings(bridge, { connected: true });

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(
      await screen.findByText(
        "原来的「香港 01」已下架，已切换到「东京 02」，下次连接生效",
      ),
    ).toBeTruthy();
  });

  it("当前节点被删且没有替代节点时说明这套配置没有节点", async () => {
    const bridge = makeBridge(async () =>
      profile({
        source: "network",
        changed: true,
        removedNodeName: "香港 01",
        replacementNodeName: null,
      }),
    );
    renderSettings(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(
      await screen.findByText("原来的「香港 01」已下架，这套配置现在没有节点"),
    ).toBeTruthy();
  });
});
