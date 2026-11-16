/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import type { MockAgentBridge } from "./agent/mockAgent";

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

function prepareApp() {
  localStorage.setItem(
    "veyl.configs.mock.v1",
    JSON.stringify({ configs: [], activeId: null }),
  );
  localStorage.setItem("veyl.ui.panelOpen", "1");
  localStorage.setItem("veyl.ui.panelVersion", "redesign-1");
}

async function renderApp() {
  prepareApp();
  render(<App />);
  await waitFor(() => expect(document.querySelector(".app")).not.toBeNull());
  await waitFor(() => expect(document.querySelector(".composer textarea")).not.toBeNull());
  await waitFor(() =>
    expect((document.querySelector(".composer textarea") as HTMLTextAreaElement).disabled).toBe(
      false,
    ),
  );
}

async function requestQuit() {
  act(() => {
    (bridge as MockAgentBridge).requestQuitDemo();
  });
  await waitFor(() => expect(document.querySelector(".quit-dialog")).not.toBeNull());
}

function dialog(): HTMLElement {
  return document.querySelector(".quit-dialog") as HTMLElement;
}

describe("退出确认", () => {
  it("只在收到 quit-requested 后出现；后台运行回传 background", async () => {
    const decide = vi.spyOn(bridge, "quitDecision").mockResolvedValue(undefined);
    await renderApp();
    expect(document.querySelector(".quit-dialog")).toBeNull();

    await requestQuit();
    expect(within(dialog()).getByText("退出 Veyl？")).toBeTruthy();

    fireEvent.click(within(dialog()).getByRole("button", { name: "后台运行" }));
    await waitFor(() => expect(document.querySelector(".quit-dialog")).toBeNull());
    expect(decide).toHaveBeenCalledWith("background");
  });

  it("Esc、×、点遮罩都按取消退出处理", async () => {
    const decide = vi.spyOn(bridge, "quitDecision").mockResolvedValue(undefined);
    await renderApp();

    await requestQuit();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".quit-dialog")).toBeNull());

    await requestQuit();
    fireEvent.click(within(dialog()).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(document.querySelector(".quit-dialog")).toBeNull());

    await requestQuit();
    fireEvent.mouseDown(document.querySelector(".quit-backdrop") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".quit-dialog")).toBeNull());

    expect(decide.mock.calls.map((call) => call[0])).toEqual([
      "background",
      "background",
      "background",
    ]);
  });

  it("退出回传 quit", async () => {
    const decide = vi.spyOn(bridge, "quitDecision").mockResolvedValue(undefined);
    await renderApp();

    await requestQuit();
    fireEvent.click(within(dialog()).getByRole("button", { name: "退出" }));
    await waitFor(() => expect(document.querySelector(".quit-dialog")).toBeNull());
    expect(decide).toHaveBeenCalledWith("quit");
  });

  it("命令失败时弹窗不关，就地报错并可重试", async () => {
    const decide = vi
      .spyOn(bridge, "quitDecision")
      .mockRejectedValueOnce({ code: "INTERNAL", message: "后台没有响应" })
      .mockResolvedValueOnce(undefined);
    await renderApp();

    await requestQuit();
    fireEvent.click(within(dialog()).getByRole("button", { name: "退出" }));

    await waitFor(() => expect(within(dialog()).getByRole("alert")).toBeTruthy());
    expect(document.querySelector(".quit-dialog")).not.toBeNull();
    expect(within(dialog()).getByRole("alert").textContent).toContain("后台没有响应");
    expect(document.querySelector(".app-toast")).toBeNull();

    fireEvent.click(within(dialog()).getByRole("button", { name: "后台运行" }));
    await waitFor(() => expect(document.querySelector(".quit-dialog")).toBeNull());
    expect(decide.mock.calls.map((call) => call[0])).toEqual(["quit", "background"]);
  });

  it("收到 quit-dismissed 后收起弹窗", async () => {
    await renderApp();
    await requestQuit();

    act(() => {
      (bridge as MockAgentBridge).dismissQuitDemo();
    });
    await waitFor(() => expect(document.querySelector(".quit-dialog")).toBeNull());
  });

  it("浏览器 demo 的 window 事件也能触发弹窗", async () => {
    await renderApp();
    act(() => {
      window.dispatchEvent(new Event("veyl:quit-requested"));
    });
    await waitFor(() => expect(document.querySelector(".quit-dialog")).not.toBeNull());
  });
});
