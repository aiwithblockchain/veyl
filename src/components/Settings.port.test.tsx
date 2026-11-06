/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge } from "../agent/bridge";
import { emptyRuntimeView } from "../agent/bridge";
import type { RuntimeView } from "../agent/protocol";
import { Settings } from "./Settings";

afterEach(cleanup);

function runtime(over: Partial<RuntimeView> = {}): RuntimeView {
  return { ...emptyRuntimeView(), ...over };
}

function makeBridge(
  setImpl: (
    port: number,
  ) => Promise<{ port: number; availability: "free" | "occupied" | "unavailable" }> =
    async (port) => ({ port, availability: "free" }),
) {
  const proxyPortSet = vi.fn(setImpl);
  const bridge = {
    mode: "mock",
    subscribe: vi.fn(() => () => {}),
    proxyPortGet: vi.fn(async () => ({ port: 7890, occupied: false })),
    proxyPortSet,
    llmProviderList: vi.fn(async () => ({ providers: [], activeProviderId: null })),
    defaultProfileRefresh: vi.fn(),
    defaultProfileStatus: vi.fn(),
  } as unknown as AgentBridge;
  return { bridge, proxyPortSet };
}

function renderSettings(
  bridge: AgentBridge,
  {
    proxyPort = 7890,
    runtimeView = runtime(),
    onProxyPortSaved,
  }: {
    proxyPort?: number;
    runtimeView?: RuntimeView;
    onProxyPortSaved?: (port: number) => void;
  } = {},
) {
  return render(
    <Settings
      open
      bridge={bridge}
      runtime={runtimeView}
      defaultProfile={null}
      proxyPort={proxyPort}
      onProxyPortSaved={onProxyPortSaved}
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
      initialSection="network"
    />,
  );
}

function portInput(): HTMLInputElement {
  return screen.getByLabelText("本地代理端口") as HTMLInputElement;
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: /保存/ }));
}

describe("本地代理端口", () => {
  it("显示 App 传下来的端口与说明", () => {
    renderSettings(makeBridge().bridge, { proxyPort: 8080 });
    expect(portInput().value).toBe("8080");
    expect(
      screen.getByText(
        "别的软件要填代理地址时，用的是这个端口。改一次，以后每次连接都用它。",
      ),
    ).toBeTruthy();
    expect(screen.getByText("127.0.0.1 :")).toBeTruthy();
  });

  it("非法值直接拒绝，不发命令", () => {
    const { bridge, proxyPortSet } = makeBridge();
    renderSettings(bridge);
    for (const bad of ["0", "70000", "abc", "12.5", ""]) {
      fireEvent.change(portInput(), { target: { value: bad } });
      save();
      expect(screen.getByText("请填一个 1–65535 之间的数字")).toBeTruthy();
    }
    expect(proxyPortSet).not.toHaveBeenCalled();
  });

  it("保存成功：回写 App 状态，未连接只说已保存", async () => {
    const { bridge, proxyPortSet } = makeBridge();
    const onSaved = vi.fn();
    renderSettings(bridge, { onProxyPortSaved: onSaved });

    fireEvent.change(portInput(), { target: { value: "8081" } });
    save();

    await waitFor(() => expect(proxyPortSet).toHaveBeenCalledWith(8081));
    expect(onSaved).toHaveBeenCalledWith(8081);
    expect(await screen.findByText("已保存")).toBeTruthy();
  });

  it("已连接时保存：提示下次连接生效", async () => {
    const { bridge } = makeBridge();
    renderSettings(bridge, { runtimeView: runtime({ state: "running" }) });

    fireEvent.change(portInput(), { target: { value: "8081" } });
    save();

    expect(await screen.findByText("已保存，下次连接生效")).toBeTruthy();
  });

  it("小于 1024 给提示但仍允许保存", async () => {
    const { bridge, proxyPortSet } = makeBridge();
    renderSettings(bridge);

    fireEvent.change(portInput(), { target: { value: "80" } });
    expect(
      screen.getByText("小于 1024 的端口在系统里通常需要管理员权限，不建议用。"),
    ).toBeTruthy();

    save();
    await waitFor(() => expect(proxyPortSet).toHaveBeenCalledWith(80));
  });

  it("失焦与点保存连着触发时只提交一次", async () => {
    const { bridge, proxyPortSet } = makeBridge();
    renderSettings(bridge);

    fireEvent.change(portInput(), { target: { value: "8081" } });
    fireEvent.blur(portInput());
    save();

    await waitFor(() => expect(proxyPortSet).toHaveBeenCalledTimes(1));
  });

  it("端口被占用仍保存成功，只给行内提示", async () => {
    const { bridge, proxyPortSet } = makeBridge(async (port) => ({
      port,
      availability: "occupied",
    }));
    renderSettings(bridge, { proxyPort: 7891 });

    fireEvent.change(portInput(), { target: { value: "7890" } });
    fireEvent.blur(portInput());

    await waitFor(() => expect(proxyPortSet).toHaveBeenCalledWith(7890));
    expect(await screen.findByText("现在被占用了，连接时会自动顺延")).toBeTruthy();
  });

  it("端口在这台机器上用不了：只显示结果提示，不叠静态低端口提示", async () => {
    const { bridge, proxyPortSet } = makeBridge(async (port) => ({
      port,
      availability: "unavailable",
    }));
    renderSettings(bridge, { proxyPort: 8080 });

    fireEvent.change(portInput(), { target: { value: "80" } });
    expect(
      screen.getByText("小于 1024 的端口在系统里通常需要管理员权限，不建议用。"),
    ).toBeTruthy();

    save();
    await waitFor(() => expect(proxyPortSet).toHaveBeenCalledWith(80));
    expect(
      await screen.findByText(
        "这个端口在这台机器上用不了（需要管理员权限），连接时会自动顺延",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("小于 1024 的端口在系统里通常需要管理员权限，不建议用。"),
    ).toBeNull();
  });

  it("端口可用时不显示任何占用或权限提示", async () => {
    const { bridge } = makeBridge();
    renderSettings(bridge, { proxyPort: 8080 });

    fireEvent.change(portInput(), { target: { value: "8081" } });
    save();

    await waitFor(() => expect(screen.getByText("已保存")).toBeTruthy());
    expect(screen.queryByText("现在被占用了，连接时会自动顺延")).toBeNull();
    expect(
      screen.queryByText(
        "这个端口在这台机器上用不了（需要管理员权限），连接时会自动顺延",
      ),
    ).toBeNull();
  });

  it("后端拒绝时显示错误，不改 App 状态", async () => {
    const { bridge } = makeBridge(async () => {
      throw { code: "INVALID_ARGUMENT", message: "请填一个 1–65535 之间的数字" };
    });
    const onSaved = vi.fn();
    renderSettings(bridge, { onProxyPortSaved: onSaved });

    fireEvent.change(portInput(), { target: { value: "8081" } });
    save();

    expect(
      await screen.findByText("请填一个 1–65535 之间的数字"),
    ).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
