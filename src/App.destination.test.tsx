/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import type { MyServer } from "./agent/bridge";
import type { ConfigSummary } from "./agent/protocol";
import { DESTINATION_KEY, DESTINATION_VERSION, DESTINATION_VERSION_KEY } from "./ui/destination";
import { saveAccount } from "./myservers/account";

const CONFIG_ID = "cfg_1";

const SUMMARY: ConfigSummary = {
  config_id: CONFIG_ID,
  name: "全部流量",
  connect_mode: "tun",
  routing_mode: "proxy_all",
  node_count: 1,
  listen_port: null,
  is_active: true,
  current_node_id: "node_1",
  created_at: 0,
  updated_at: 0,
  last_used_at: null,
};

const SERVER: MyServer = {
  server_id: "srv_1",
  name: "东京 · Vultr",
  region: "nrt",
  plan: "vc2-1c-1gb",
  state: "healthy",
  created_at: new Date(0).toISOString(),
  ip: "45.76.20.100",
  port: 8388,
  node_id: "node_srv_1",
  hourly_usd: 0.007,
  monthly_usd: 5,
  failure: null,
};

const bridge = getAgentBridge();
const modeDescriptor = Object.getOwnPropertyDescriptor(bridge, "mode");

function prepare(servers: MyServer[] = []) {
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  localStorage.setItem("veyl.onboarding.skipped", "1");
  saveAccount("me@example.com");
  vi.spyOn(bridge, "configList").mockResolvedValue({
    configs: [SUMMARY],
    active_config_id: CONFIG_ID,
  });
  vi.spyOn(bridge, "configDetail").mockResolvedValue({
    config_id: CONFIG_ID,
    name: SUMMARY.name,
    connect_mode: "tun",
    routing_mode: "proxy_all",
    node_count: 1,
    listen_port: null,
    is_active: true,
    current_node_id: "node_1",
    created_at: 0,
    updated_at: 0,
    last_used_at: null,
    nodes: [
      {
        node_id: "node_1",
        name: "东京 01",
        server: "203.0.113.1",
        port: 8388,
        method: "aes-128-gcm",
        protocol: "shadowsocks",
        source: "seed",
        created_at: 0,
      },
    ],
    dns: { mode: "auto", local: [], remote: [] },
    tun_excludes: [],
    layout: null,
    layout_revision: null,
  });
  vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
  vi.spyOn(bridge, "tunHelperInfo").mockResolvedValue({
    runningBuild: null,
    expectedBuild: "2026.11.1",
    stale: false,
    state: "not_running",
    needsAdminRestart: false,
  } as never);
  vi.spyOn(bridge, "myServerCatalog").mockResolvedValue({
    regions: [{ id: "nrt", name: "东京", continent: "asia" }],
    plans: [
      {
        id: "vc2-1c-1gb",
        label: "1 核 · 1 GB 内存 · 25 GB 硬盘",
        hourly_usd: 0.007,
        monthly_usd: 5,
      },
    ],
    currency: "USD",
    updated_at: new Date(0).toISOString(),
  });
  vi.spyOn(bridge, "myServerList").mockResolvedValue({ servers });
  const runtimeStart = vi.spyOn(bridge, "runtimeStart");
  return { runtimeStart };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  if (modeDescriptor) Object.defineProperty(bridge, "mode", modeDescriptor);
});

describe("destination 切换", () => {
  it("默认落在客户端；点服务器换成服务器列表 + 详情，不发运行时命令", async () => {
    const { runtimeStart } = prepare();
    const { container } = render(<App />);

    expect(await screen.findByRole("button", { name: "启动 VPN" })).toBeTruthy();
    expect(container.querySelector(".rail")).not.toBeNull();
    expect(screen.getByRole("button", { name: "客户端" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "服务器" }));

    expect(await screen.findByRole("complementary", { name: "服务器列表" })).toBeTruthy();
    expect(screen.getByText("我的服务器")).toBeTruthy();
    expect(container.querySelector(".console")).toBeNull();
    expect(runtimeStart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "客户端" }));
    expect(await screen.findByRole("button", { name: "启动 VPN" })).toBeTruthy();
  });

  it("记住上次停留的 destination；版本不符回客户端", async () => {
    prepare();
    localStorage.setItem(DESTINATION_KEY, "servers");
    localStorage.setItem(DESTINATION_VERSION_KEY, DESTINATION_VERSION);

    const first = render(<App />);
    expect(await screen.findByRole("complementary", { name: "服务器列表" })).toBeTruthy();
    first.unmount();

    localStorage.setItem(DESTINATION_KEY, "servers");
    localStorage.setItem(DESTINATION_VERSION_KEY, "old-version");
    render(<App />);
    expect(await screen.findByRole("button", { name: "启动 VPN" })).toBeTruthy();
  });

  it("新建流程选其它节点 → 服务器；点客户端图标恢复接管方式；用来建配置回审视页", async () => {
    prepare([SERVER]);
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "启动 VPN" });

    fireEvent.click(container.querySelector(".rail__add")!);
    expect(await screen.findByRole("dialog", { name: "新建配置" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Proxy 模式/ }));
    fireEvent.click(screen.getByRole("radio", { name: /其它节点/ }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    expect(await screen.findByRole("complementary", { name: "服务器列表" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "新建配置" })).toBeNull();
    expect(screen.queryByRole("button", { name: "← 返回" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "客户端" }));
    const dialog = await screen.findByRole("dialog", { name: "新建配置" });
    expect(dialog).toBeTruthy();
    expect(
      (screen.getByRole("radio", { name: /Proxy 模式/ }) as HTMLElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");

    // 再走一次，点「用来建配置」应带着节点回到审视页。
    fireEvent.click(screen.getByRole("radio", { name: /其它节点/ }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(await screen.findByRole("button", { name: "用来建配置" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "新建配置" })).toBeTruthy(),
    );
    expect(screen.getByText("东京 · Vultr")).toBeTruthy();

    await act(async () => {});
  });
});
