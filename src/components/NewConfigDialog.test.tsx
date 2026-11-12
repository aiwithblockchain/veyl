/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, ConfigCreateInput } from "../agent/bridge";
import type { ConfigSummary } from "../agent/protocol";
import { NewConfigDialog } from "./NewConfigDialog";

afterEach(cleanup);

function status(nodeCount: number) {
  return {
    packageId: null,
    version: null,
    appliedAt: null,
    newVersionAvailable: false,
    nodeCount,
    checkedAt: null,
    source: "cache" as const,
    changed: false,
    reason: null,
    added: 0,
    removed: 0,
  };
}

function makeBridge(overrides: Partial<AgentBridge> = {}): AgentBridge {
  return {
    mode: "mock",
    defaultProfileStatus: vi.fn(async () => status(3)),
    defaultProfileRefresh: vi.fn(async () => status(3)),
    ...overrides,
  } as unknown as AgentBridge;
}

interface RenderOptions {
  region?: string | null;
  configs?: Partial<ConfigSummary>[];
  bridge?: AgentBridge;
  defaultNodeCount?: number | null;
  connected?: boolean;
  onCreate?: (input: ConfigCreateInput) => Promise<{ ok: boolean; message?: string; reason?: string }>;
  onCreated?: (connect: boolean) => void;
  onClose?: () => void;
}

function renderDialog(options: RenderOptions = {}) {
  const props = {
    bridge: options.bridge ?? makeBridge(),
    configs: (options.configs ?? []) as ConfigSummary[],
    region: options.region === undefined ? "cn" : options.region,
    defaultNodeCount: options.defaultNodeCount === undefined ? 3 : options.defaultNodeCount,
    connected: options.connected ?? false,
    onClose: options.onClose ?? vi.fn(),
    onCreate: options.onCreate ?? vi.fn(async () => ({ ok: true })),
    onCreated: options.onCreated ?? vi.fn(),
  };
  render(<NewConfigDialog {...props} />);
  return props;
}

describe("新建配置两问页", () => {
  it("只有两问，没有 AI 协助卡；默认 TUN + 免费节点，焦点在第一组", () => {
    renderDialog();
    expect(screen.getByText("怎么接管")).toBeTruthy();
    expect(screen.getByText("节点从哪来")).toBeTruthy();
    expect(screen.queryByText("AI 协助")).toBeNull();
    expect(
      (screen.getByRole("radio", { name: /TUN 模式/ }) as HTMLElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(
      (screen.getByRole("radio", { name: /Veyl 免费节点/ }) as HTMLElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /TUN 模式/ }));
    expect(screen.getByLabelText("第 1 步，共 2 步")).toBeTruthy();
  });

  it("↑↓ 在组内移动焦点并即时选中", () => {
    renderDialog();
    const tun = screen.getByRole("radio", { name: /TUN 模式/ });
    const proxy = screen.getByRole("radio", { name: /Proxy 模式/ });
    fireEvent.keyDown(tun, { key: "ArrowDown" });
    expect(document.activeElement).toBe(proxy);
    expect(proxy.getAttribute("aria-checked")).toBe("true");
    expect(tun.getAttribute("aria-checked")).toBe("false");
    fireEvent.keyDown(proxy, { key: "ArrowUp" });
    expect(document.activeElement).toBe(tun);
    expect(tun.getAttribute("aria-checked")).toBe("true");
  });

  it("Esc 关闭弹窗", () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("审视页与保存", () => {
  it("默认值直接下一步：审视页只读，保存为 direct + seed", async () => {
    const onCreate = vi.fn(async () => ({ ok: true }));
    const onCreated = vi.fn();
    renderDialog({ onCreate, onCreated });

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(await screen.findByText("看一眼，没问题就创建。")).toBeTruthy();
    expect(screen.getByLabelText("第 2 步，共 2 步")).toBeTruthy();
    expect(screen.getByText("配置 1")).toBeTruthy();
    expect(screen.getByText("智能模式")).toBeTruthy();
    expect(screen.getByText("中国大陆")).toBeTruthy();
    // 审视页是只读事实列表：没有输入框、没有单选控件。
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "创建并连接" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith({
      name: "配置 1",
      connectMode: "tun",
      routingMode: "direct",
      source: "seed",
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(true));
  });

  it("默认名取最小可用整数", () => {
    renderDialog({ configs: [{ name: "配置 1" }, { name: "配置 3" }] });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("配置 2")).toBeTruthy();
  });

  it("已连接时主按钮是「创建配置」，创建后不自动连接", async () => {
    const onCreate = vi.fn(async () => ({ ok: true }));
    const onCreated = vi.fn();
    renderDialog({ onCreate, onCreated, connected: true });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建配置" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(false));
  });

  it("Proxy 模式：审视页不出现本机代理地址，保存 system_proxy", async () => {
    const onCreate = vi.fn(async () => ({ ok: true }));
    renderDialog({ onCreate });
    fireEvent.click(screen.getByRole("radio", { name: /Proxy 模式/ }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    expect(await screen.findByText("Proxy 模式（只给代理地址）")).toBeTruthy();
    expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
    expect(screen.queryByText("本机代理地址在设置里改")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "创建并连接" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ connectMode: "system_proxy", routingMode: "direct" }),
      ),
    );
  });

  it("地区未知：按全局模式保存并解释", async () => {
    const onCreate = vi.fn(async () => ({ ok: true }));
    renderDialog({ region: null, onCreate });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    expect(await screen.findByText("全局模式")).toBeTruthy();
    expect(
      screen.getByText(/没识别出你在哪个地区，所以按全局模式创建/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "创建并连接" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ routingMode: "proxy_all" }),
      ),
    );
  });

  it("保存中 Esc、遮罩、✕、返回都不能关窗", async () => {
    let resolveCreate: (value: { ok: boolean }) => void = () => {};
    const onCreate = vi.fn(
      () => new Promise<{ ok: boolean }>((resolve) => (resolveCreate = resolve)),
    );
    const onClose = vi.fn();
    renderDialog({ onCreate, onClose });

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建并连接" }));
    expect(await screen.findByRole("button", { name: "正在创建…" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".modal-backdrop") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: /返回/ }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("看一眼，没问题就创建。")).toBeTruthy();

    resolveCreate({ ok: true });
    await waitFor(() => expect(onClose).not.toHaveBeenCalled());
  });

  it("后端 duplicate_name 显示在页内错误条，不关闭审视页", async () => {
    const onCreate = vi.fn(async () => ({
      ok: false,
      reason: "duplicate_name",
      message: "已经有一套叫这个名字的配置了。",
    }));
    renderDialog({ configs: [{ name: "配置 1" }], onCreate });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "创建并连接" }));

    expect(
      await screen.findByText("已经有一套叫这个名字的配置了。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "创建并连接" })).toBeTruthy();
  });
});

describe("免费节点失败", () => {
  it("池为空：下一步才拉取；失败显示三段式，不自动跳转", async () => {
    const bridge = makeBridge({
      defaultProfileRefresh: vi.fn(async () => status(0)),
    });
    const onCreate = vi.fn(async () => ({ ok: true }));
    renderDialog({ bridge, defaultNodeCount: 0, onCreate });

    expect(screen.getByText("还没有免费节点，下一步时会去获取。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    expect(await screen.findByText("没能取到免费节点。")).toBeTruthy();
    expect(screen.getByText("可能没联网，或免费节点服务暂时不可用。")).toBeTruthy();
    expect(
      screen.getByText("点「重试」；还是不行，就改选「其它节点」。"),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "下一步" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(bridge.defaultProfileRefresh).toHaveBeenCalledTimes(2));
  });

  it("池为空但拉取成功：进入审视页", async () => {
    const bridge = makeBridge({
      defaultProfileRefresh: vi.fn(async () => status(2)),
    });
    renderDialog({ bridge, defaultNodeCount: 0 });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(await screen.findByText("看一眼，没问题就创建。")).toBeTruthy();
  });

  it("保存时 seed_unavailable：弹窗只报错，重试再提交；刷新由 hook 负责", async () => {
    const bridge = makeBridge({
      defaultProfileRefresh: vi.fn(async () => status(0)),
    });
    const onCreate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "seed_unavailable" })
      .mockResolvedValueOnce({ ok: true });
    const onCreated = vi.fn();
    renderDialog({ bridge, onCreate, onCreated });

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建并连接" }));

    expect(await screen.findByText("没能取到免费节点。")).toBeTruthy();
    // 刷新 + 重试只在 useVpnSession.createConfig 一层，弹窗不再重复。
    expect(bridge.defaultProfileRefresh).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalledTimes(2);
  });
});

describe("供应商广场", () => {
  it("预览页三条示例、按钮 disabled、返回保留选择且不建配置", async () => {
    const onCreate = vi.fn(async () => ({ ok: true }));
    const { onClose } = renderDialog({ onCreate });

    fireEvent.click(screen.getByRole("radio", { name: /Proxy 模式/ }));
    fireEvent.click(screen.getByRole("radio", { name: /其它节点/ }));
    expect(screen.getByText("预览")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    expect(await screen.findByText("示例供应商 A")).toBeTruthy();
    expect(screen.getAllByText("供应商广场")).toHaveLength(1);
    expect(screen.getByText("示例供应商 B")).toBeTruthy();
    expect(screen.getByText("示例供应商 C")).toBeTruthy();
    const pending = screen.getAllByRole("button", { name: "即将支持" });
    expect(pending).toHaveLength(3);
    pending.forEach((button) => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(
      screen.getByText("本页只做展示：不能购买、不能跳转、不能加入配置。"),
    ).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /返回新建配置/ }));
    expect(
      (screen.getByRole("radio", { name: /Proxy 模式/ }) as HTMLElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(
      (screen.getByRole("radio", { name: /其它节点/ }) as HTMLElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  });

  it("Esc 先回两问页，再按才关弹窗", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByRole("radio", { name: /其它节点/ }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("示例供应商 A")).toBeTruthy();
    const back = screen.getByRole("button", { name: /返回新建配置/ });
    expect(document.activeElement).toBe(back);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("怎么接管")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: /其它节点/ }),
    );
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
