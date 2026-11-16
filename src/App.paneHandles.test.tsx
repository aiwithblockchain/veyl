/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

const CONFIG = {
  config_id: "cfg-home",
  name: "家里",
  connect_mode: "system_proxy",
  routing_mode: "direct",
  node_count: 2,
  listen_port: 7890,
  is_active: true,
  current_node_id: "cfg-home-n1",
  created_at: 0,
  updated_at: 0,
  last_used_at: null,
  nodes: [
    {
      node_id: "cfg-home-n1",
      name: "东京 01",
      server: "203.0.113.21",
      port: 20343,
      method: "aes-256-gcm",
      protocol: "shadowsocks",
      source: "seed",
      created_at: 0,
    },
  ],
  dns: { mode: "auto", local: [], remote: [] },
  tun_excludes: [],
  layout: null,
};

beforeAll(async () => {
  // AI 是必需路径：先备好 Key，测试才能停在主界面。
  await getAgentBridge().saveDeepSeekKey(
    "sk-" + "abcdefghijklmnopqrstuvwxyz0123",
  );
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    "veyl.configs.mock.v1",
    JSON.stringify({ configs: [CONFIG], activeId: "cfg-home" }),
  );
  localStorage.setItem("veyl.ui.panelOpen", "1");
  localStorage.setItem("veyl.ui.panelVersion", "redesign-1");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setWidth(1024);
});

describe("App 的栏宽手柄", () => {
  it("连接 destination 没有列表手柄；切到我的服务器后才出现", async () => {
    setWidth(1100);
    const { container } = render(<App />);

    await waitFor(() => expect(container.querySelector(".app")).not.toBeNull());
    await waitFor(() =>
      expect(container.querySelector(".assistant-overlay")).not.toBeNull(),
    );

    expect(container.querySelector(".pane-handle--assistant")).toBeNull();
    expect(container.querySelector(".pane-handle--rail")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "我的服务器" }));
    await waitFor(() =>
      expect(container.querySelector(".pane-handle--rail")).not.toBeNull(),
    );
  });

  it("宽屏助手停靠时才出现助手手柄", async () => {
    setWidth(1100);
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".app")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "我的服务器" }));
    setWidth(1568);
    window.dispatchEvent(new Event("resize"));

    await waitFor(() =>
      expect(container.querySelector(".assistant-slot")).not.toBeNull(),
    );
    expect(container.querySelector(".pane-handle--assistant")).not.toBeNull();
    expect(container.querySelector(".pane-handle--rail")).not.toBeNull();
  });
});
