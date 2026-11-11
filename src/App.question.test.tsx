/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";

const CONFIG = {
  config_id: "cfg-home",
  name: "家里",
  connect_mode: "system_proxy",
  routing_mode: "direct",
  node_count: 1,
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

const bridge = getAgentBridge();

beforeAll(async () => {
  await bridge.saveDeepSeekKey("sk-" + "abcdefghijklmnopqrstuvwxyz0123");
});

afterAll(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function textarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

function prepareApp() {
  localStorage.setItem(
    "veyl.configs.mock.v1",
    JSON.stringify({ configs: [CONFIG], activeId: "cfg-home" }),
  );
  localStorage.setItem("veyl.onboarding.skipped", "1");
  localStorage.setItem("veyl.ui.panelOpen", "1");
  localStorage.setItem("veyl.ui.panelVersion", "redesign-1");
}

async function openPendingQuestion(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(document.querySelector(".app")).not.toBeNull());
  await waitFor(() => expect(document.querySelector(".composer textarea")).not.toBeNull());
  await waitFor(() =>
    expect((document.querySelector(".composer textarea") as HTMLTextAreaElement).disabled).toBe(
      false,
    ),
  );

  fireEvent.change(textarea(), { target: { value: "第一次用" } });
  fireEvent.keyDown(textarea(), { key: "Enter" });
  await waitFor(() => expect(document.querySelector(".ask-card")).not.toBeNull(), {
    timeout: 5000,
  });
}

describe("提问的回答路径", () => {
  it("NOT_FOUND 时把文字放回输入框，不生成消息也不弹错误", async () => {
    prepareApp();

    vi.spyOn(bridge, "replyUserQuestion").mockImplementation(async () => {
      throw { code: "NOT_FOUND", message: "question_not_pending" };
    });

    await openPendingQuestion();

    fireEvent.change(textarea(), { target: { value: "我想给手机用" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(textarea().value).toBe("我想给手机用"));
    expect(bridge.replyUserQuestion).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "我想给手机用",
    );
    expect(screen.queryByText("我想给手机用", { selector: ".msg--user" })).toBeNull();
    expect(document.querySelector(".ask-card")).toBeNull();
    expect(document.querySelector(".app-toast")).toBeNull();
  }, 15_000);

  it("回答成功只追加一条 user 消息，卡片收起", async () => {
    prepareApp();
    await openPendingQuestion();

    fireEvent.change(textarea(), { target: { value: "我想给手机用" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(document.querySelector(".ask-card")).toBeNull());
    await waitFor(() => expect(textarea().value).toBe(""));
    await waitFor(() => {
      const matches = [...document.querySelectorAll(".msg--user .msg__text")].filter(
        (element) => element.textContent?.trim() === "我想给手机用",
      );
      expect(matches).toHaveLength(1);
    });
  }, 15_000);
});
