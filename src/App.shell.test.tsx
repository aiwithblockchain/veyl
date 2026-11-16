/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";

const bridge = getAgentBridge();

beforeAll(async () => {
  await bridge.saveDeepSeekKey("sk-" + "abcdefghijklmnopqrstuvwxyz0123");
});

afterAll(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  cleanup();
  // mock 运行时是单例：每个用例都从断开状态开始，免得上一条连接影响下一条。
  await bridge.runtimeStop().catch(() => undefined);
  localStorage.clear();
  vi.restoreAllMocks();
});

async function renderApp(): Promise<HTMLElement> {
  const { container } = render(<App />);
  await waitFor(() => expect(container.querySelector(".app")).not.toBeNull());
  await waitFor(() => expect(screen.queryByText("从哪里开始？")).toBeTruthy());
  return container;
}

describe("三区外壳与连接舞台", () => {
  it("没有节点时停在两选一：没有列表列，也没有节点组入口", async () => {
    const container = await renderApp();

    expect(screen.getByRole("button", { name: /新建节点/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /先试用免费节点/ })).toBeTruthy();
    expect(container.querySelector(".rail")).toBeNull();

    expect(screen.getByRole("button", { name: "连接" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "我的服务器" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "节点组" })).toBeNull();
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "账户" })).toBeTruthy();
  });

  it("先试用免费节点：建唯一配置、自动连接，收敛成节点卡", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: /先试用免费节点/ }));

    await waitFor(() => expect(screen.getByText("东京 01")).toBeTruthy(), {
      timeout: 5000,
    });
    await waitFor(
      () => expect(screen.getAllByText(/已连接/).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );

    const stored = JSON.parse(
      localStorage.getItem("veyl.configs.mock.v1") ?? "{}",
    ) as {
      configs: Array<{
        connect_mode: string;
        routing_mode: string;
        nodes: Array<{ name: string }>;
      }>;
    };
    expect(stored.configs).toHaveLength(1);
    expect(stored.configs[0].connect_mode).toBe("tun");
    expect(stored.configs[0].routing_mode).toBe("direct");
    expect(stored.configs[0].nodes.map((node) => node.name)).toEqual([
      "东京 01",
      "新加坡 01",
    ]);
  }, 15_000);

  it("试用到期只留「新建节点」，不再出现免费节点入口", async () => {
    localStorage.setItem("veyl.mock.trial", "expired");
    render(<App />);

    await waitFor(() => expect(screen.getByText("试用已到期")).toBeTruthy());
    expect(screen.getByText("免费节点已从节点池移除。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建节点" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /先试用免费节点/ })).toBeNull();
  });

  it("收到 trial-expired 后切到到期屏", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("从哪里开始？")).toBeTruthy());

    act(() => {
      (bridge as unknown as { expireTrialDemo: () => void }).expireTrialDemo();
    });

    await waitFor(() => expect(screen.getByText("试用已到期")).toBeTruthy());
  });

  it("重复点试用不会多建配置", async () => {
    await renderApp();

    const button = screen.getByRole("button", { name: /先试用免费节点/ });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(
      () => expect(screen.getAllByText(/已连接/).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
    const stored = JSON.parse(
      localStorage.getItem("veyl.configs.mock.v1") ?? "{}",
    ) as { configs: unknown[] };
    expect(stored.configs).toHaveLength(1);
  }, 15_000);

  it("新建节点打开右栏助手", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: /新建节点/ }));

    await waitFor(() =>
      expect(
        document.querySelector(".assistant-slot, .assistant-overlay"),
      ).toBeTruthy(),
    );
  });

  it("切换 destination 不重置连接", async () => {
    const container = await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /先试用免费节点/ }));
    await waitFor(
      () => expect(screen.getAllByText(/已连接/).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "我的服务器" }));
    await waitFor(() => expect(container.querySelector(".app")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    await waitFor(
      () => expect(screen.getAllByText(/已连接/).length).toBeGreaterThan(0),
    );
    expect(container.querySelector(".app--solo")).not.toBeNull();
  }, 15_000);
});
