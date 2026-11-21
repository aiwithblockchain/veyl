/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, AppLanguageState } from "../agent/bridge";
import { emptyRuntimeView } from "../agent/bridge";
import { Settings } from "./Settings";

afterEach(cleanup);

function makeBridge({
  get = vi.fn(async (): Promise<AppLanguageState> => ({
    selected: "system",
    resolved: "zh",
  })),
  set = vi.fn(async (lang: "system" | "zh" | "en"): Promise<AppLanguageState> => ({
    selected: lang,
    resolved: lang === "system" ? "zh" : lang,
  })),
} = {}) {
  const bridge = {
    mode: "mock",
    subscribe: vi.fn(() => () => {}),
    coreInfo: vi.fn(async () => ({
      bundledVersion: "1.14.4",
      activeVersion: "1.14.4",
      activeSource: "bundled" as const,
      restartRequired: false,
    })),
    coreCheckUpdates: vi.fn(async () => ({
      network: "ok" as const,
      candidates: [],
      cached: false,
    })),
    tunHelperInfo: vi.fn(async () => ({
      runningBuild: null,
      helperVersion: null,
      expectedBuild: "2026.11.1",
      stale: false,
      state: "not_running" as const,
      needsAdminRestart: false,
    })),
    llmProviderList: vi.fn(async () => ({ providers: [], activeProviderId: null })),
    getAppVersion: vi.fn(async () => "0.1.0"),
    appLanguageGet: get,
    appLanguageSet: set,
    defaultProfileRefresh: vi.fn(),
    defaultProfileStatus: vi.fn(),
  } as unknown as AgentBridge;
  return { bridge, get, set };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function settingsUi(
  bridge: AgentBridge,
  options: {
    open?: boolean;
    onNotice?: (notice: { level: "info" | "error"; text: string }) => void;
  } = {},
) {
  return (
    <Settings
      open={options.open ?? true}
      bridge={bridge}
      runtime={emptyRuntimeView()}
      defaultProfile={null}
      onClose={() => {}}
      onNotice={options.onNotice ?? (() => {})}
      onRestartOnboarding={() => {}}
      onOpenLogs={() => {}}
      onRestoreNetwork={() => {}}
      onAskAi={() => {}}
      initialSection="advanced"
    />
  );
}

function renderSettings(
  bridge: AgentBridge,
  options: Parameters<typeof settingsUi>[1] = {},
) {
  return render(settingsUi(bridge, options));
}

function segButton(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

describe("设置 › 高级 › 语言", () => {
  it("语言行是高级第一行，在「修复网络」之前，段首说明落在修复组下", async () => {
    const { bridge } = makeBridge();
    const { container } = renderSettings(bridge);
    await screen.findByText("已开始的对话保持原语言。");

    const rows = container.querySelectorAll(".settings-row");
    expect(rows[0].textContent).toContain("语言");
    const subhead = screen.getByText("修复网络");
    const note = screen.getByText("这里的东西平时不用改。连不上网、打不开网页时再看。");
    expect(
      rows[0].compareDocumentPosition(subhead) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      subhead.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("打开时读取当前值并选中对应档位", async () => {
    const { bridge, get } = makeBridge({
      get: vi.fn(async (): Promise<AppLanguageState> => ({
        selected: "en",
        resolved: "en",
      })),
    });
    renderSettings(bridge);

    await waitFor(() => expect(segButton("English").getAttribute("aria-pressed")).toBe("true"));
    expect(segButton("中文").getAttribute("aria-pressed")).toBe("false");
    expect(segButton("跟随系统").getAttribute("aria-pressed")).toBe("false");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("点选后写入：选中态跟着变，且不再回读", async () => {
    const { bridge, set, get } = makeBridge();
    renderSettings(bridge);
    await waitFor(() =>
      expect(segButton("跟随系统").getAttribute("aria-pressed")).toBe("true"),
    );

    fireEvent.click(segButton("中文"));

    await waitFor(() => expect(segButton("中文").getAttribute("aria-pressed")).toBe("true"));
    expect(set).toHaveBeenCalledWith("zh");
    expect(segButton("跟随系统").getAttribute("aria-pressed")).toBe("false");
    // 契约里 set 的 selected 就是写入值（先写库再返回），所以「用返回值重绘」
    // 与「本地乐观更新」在界面上不可区分；能验证的是写入后不再回读。
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("写入在途：三档都禁用，重复点击只发一次请求", async () => {
    const pending = deferred<AppLanguageState>();
    const { bridge, set } = makeBridge({ set: vi.fn(() => pending.promise) });
    renderSettings(bridge);
    await waitFor(() =>
      expect(segButton("跟随系统").getAttribute("aria-pressed")).toBe("true"),
    );

    fireEvent.click(segButton("中文"));
    expect(segButton("跟随系统").disabled).toBe(true);
    expect(segButton("中文").disabled).toBe(true);
    expect(segButton("English").disabled).toBe(true);

    fireEvent.click(segButton("English"));
    expect(set).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ selected: "zh", resolved: "zh" });
    });
    await waitFor(() => expect(segButton("中文").getAttribute("aria-pressed")).toBe("true"));
    expect(segButton("中文").disabled).toBe(false);
  });

  it("读取晚到：点选先成功，旧的读取结果不覆盖新选中态", async () => {
    const pending = deferred<AppLanguageState>();
    const { bridge } = makeBridge({
      get: vi.fn(() => pending.promise),
      set: vi.fn(async () => ({ selected: "zh", resolved: "zh" })),
    });
    renderSettings(bridge);

    // 读取还没回来，用户就已经点了中文并写成功。
    fireEvent.click(segButton("中文"));
    await waitFor(() => expect(segButton("中文").getAttribute("aria-pressed")).toBe("true"));

    await act(async () => {
      pending.resolve({ selected: "en", resolved: "en" });
    });
    expect(segButton("中文").getAttribute("aria-pressed")).toBe("true");
    expect(segButton("English").getAttribute("aria-pressed")).toBe("false");
  });

  it("再次打开时读失败：保留已选中的档位，不清空", async () => {
    const get = vi.fn(async (): Promise<AppLanguageState> => ({
      selected: "en",
      resolved: "en",
    }));
    const { bridge } = makeBridge({ get });
    const view = renderSettings(bridge);
    await waitFor(() => expect(segButton("English").getAttribute("aria-pressed")).toBe("true"));

    get.mockRejectedValueOnce({ code: "INTERNAL", message: "db is locked" });
    view.rerender(settingsUi(bridge, { open: false }));
    view.rerender(settingsUi(bridge, { open: true }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    expect(segButton("English").getAttribute("aria-pressed")).toBe("true");
    expect(segButton("中文").getAttribute("aria-pressed")).toBe("false");
  });

  it("写入失败时保持原选中，行下显示失败文案，且不弹 toast", async () => {
    const onNotice = vi.fn();
    const { bridge } = makeBridge({
      get: vi.fn(async (): Promise<AppLanguageState> => ({
        selected: "en",
        resolved: "en",
      })),
      set: vi.fn(async () => {
        throw { code: "INTERNAL", message: "db is locked" };
      }),
    });
    renderSettings(bridge, { onNotice });
    await waitFor(() => expect(segButton("English").getAttribute("aria-pressed")).toBe("true"));

    fireEvent.click(segButton("中文"));

    expect(
      await screen.findByText("语言没有切换。本地设置写入失败。再试一次。"),
    ).toBeTruthy();
    expect(segButton("English").getAttribute("aria-pressed")).toBe("true");
    expect(segButton("中文").getAttribute("aria-pressed")).toBe("false");
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("点当前档位不重复发命令", async () => {
    const { bridge, set } = makeBridge({
      get: vi.fn(async (): Promise<AppLanguageState> => ({
        selected: "zh",
        resolved: "zh",
      })),
    });
    renderSettings(bridge);
    await waitFor(() => expect(segButton("中文").getAttribute("aria-pressed")).toBe("true"));

    fireEvent.click(segButton("中文"));
    expect(set).not.toHaveBeenCalled();
  });

  it("读不到值时不猜档位：三档都不选中，也不挡写入", async () => {
    const { bridge, set } = makeBridge({
      get: vi.fn(async () => {
        throw { code: "NOT_FOUND", message: "unknown command" };
      }),
    });
    renderSettings(bridge);
    await screen.findByText("已开始的对话保持原语言。");

    expect(segButton("跟随系统").getAttribute("aria-pressed")).toBe("false");
    expect(segButton("中文").getAttribute("aria-pressed")).toBe("false");
    expect(segButton("English").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(segButton("English"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("en"));
  });
});
