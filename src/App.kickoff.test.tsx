/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";

const KICKOFF =
  "用户刚进入 Veyl，还没有可用的节点。请先打个招呼，然后问他想自建服务器还是先用免费节点。";

const bridge = getAgentBridge();
const modeDescriptor = Object.getOwnPropertyDescriptor(bridge, "mode");
const widthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");

let keyConfigured = false;

function keyState() {
  return keyConfigured
    ? { masked: "sk-****abcd", verified: true, validation: "ok" as const }
    : { masked: null, verified: false, validation: "unverified" as const };
}

beforeEach(() => {
  keyConfigured = false;
  localStorage.clear();
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  // 窄屏默认收起右栏：只有真的「打开右栏」才看得到浮层。
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  vi.spyOn(bridge, "getDeepSeekKey").mockImplementation(async () => keyState());
  vi.spyOn(bridge, "saveDeepSeekKey").mockImplementation(async () => {
    keyConfigured = true;
    return keyState();
  });
  vi.spyOn(bridge, "llmProviderList").mockResolvedValue({
    providers: [],
    activeProviderId: null,
  });
  vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
  vi.spyOn(bridge, "configList").mockResolvedValue({
    configs: [],
    active_config_id: null,
  });
  vi.spyOn(bridge, "sendMessage").mockResolvedValue({ requestId: "req_1" });
  vi.spyOn(bridge, "aiSessionKickoff").mockResolvedValue({ text: KICKOFF });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  if (modeDescriptor) Object.defineProperty(bridge, "mode", modeDescriptor);
  if (widthDescriptor) {
    Object.defineProperty(window, "innerWidth", widthDescriptor);
  } else {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  }
});

async function openOnboarding() {
  const view = render(<App />);
  await screen.findByLabelText("DeepSeek API Key");
  return view;
}

function keyForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector<HTMLFormElement>("form.first-run__form");
  if (!form) throw new Error("没有首启表单");
  return form;
}

async function finishOnboarding(container: HTMLElement) {
  fireEvent.change(screen.getByLabelText("DeepSeek API Key"), {
    target: { value: "sk-test-1234" },
  });
  await act(async () => {
    fireEvent.submit(keyForm(container));
  });
}

/** 会话列表为空 = 没有新建会话。 */
async function expectNoSession() {
  fireEvent.click(await screen.findByRole("button", { name: "历史会话" }));
  expect(
    await screen.findByText("还没有对话。新建一个，或者直接问我。"),
  ).toBeTruthy();
}

describe("首启开场", () => {
  it("完成后新建一个会话，发一条 hidden 开场，文本来自 kickoff", async () => {
    const { container } = await openOnboarding();
    await finishOnboarding(container);

    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledTimes(1));
    const [sessionId, text, options] = (
      bridge.sendMessage as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(String(sessionId)).toMatch(/^session_/);
    expect(text).toBe(KICKOFF);
    expect(options).toMatchObject({ hidden: true });
    expect(bridge.aiSessionKickoff).toHaveBeenCalledTimes(1);
    // 会话里挂上了助手占位：这是 start_hidden_request 的结果，不只是调了一次命令。
    await waitFor(() =>
      expect(document.querySelector(".msg--assistant")).toBeTruthy(),
    );
    // 右栏打开：窄屏是浮层。
    expect(document.querySelector(".assistant-overlay")).toBeTruthy();
  });

  it("重复完成只发一次", async () => {
    const { container } = await openOnboarding();
    fireEvent.change(screen.getByLabelText("DeepSeek API Key"), {
      target: { value: "sk-test-1234" },
    });
    // 同一批里提交两次：第二次仍看得到 saving=null，会再走一遍 onDone。
    await act(async () => {
      fireEvent.submit(keyForm(container));
      fireEvent.submit(keyForm(container));
    });

    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledTimes(1));
    expect(bridge.aiSessionKickoff).toHaveBeenCalledTimes(1);
  });

  it("bridge 没有这个方法：只开右栏，不发消息也不抛错", async () => {
    Object.defineProperty(bridge, "aiSessionKickoff", {
      value: undefined,
      configurable: true,
    });
    const { container } = await openOnboarding();
    await finishOnboarding(container);

    await waitFor(() =>
      expect(document.querySelector(".assistant-overlay")).toBeTruthy(),
    );
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    await expectNoSession();
  });

  it("返回空文本：只开右栏，不发消息、不建会话", async () => {
    vi.mocked(bridge.aiSessionKickoff).mockResolvedValue({ text: "  " });
    const { container } = await openOnboarding();
    await finishOnboarding(container);

    await waitFor(() =>
      expect(document.querySelector(".assistant-overlay")).toBeTruthy(),
    );
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    await expectNoSession();
  });

  it("命令失败（Host 还没接）：只开右栏，不发消息、不报错、不建会话", async () => {
    vi.mocked(bridge.aiSessionKickoff).mockRejectedValue({
      code: "UNSUPPORTED",
      message: "unknown command",
    });
    const { container } = await openOnboarding();
    await finishOnboarding(container);

    await waitFor(() =>
      expect(document.querySelector(".assistant-overlay")).toBeTruthy(),
    );
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(document.querySelector(".app-toast--error")).toBeNull();
    await expectNoSession();
  });

  it("已经有配置：完成首启不发开场、不建会话（只开右栏）", async () => {
    vi.mocked(bridge.configList).mockResolvedValue({
      configs: [
        {
          config_id: "cfg_1",
          name: "浏览器",
          connect_mode: "system_proxy",
          routing_mode: "proxy_selected",
          node_count: 0,
          listen_port: null,
          is_active: true,
          current_node_id: null,
          created_at: 0,
          updated_at: 0,
          last_used_at: null,
        },
      ],
      active_config_id: "cfg_1",
    });
    const { container } = await openOnboarding();
    await finishOnboarding(container);

    await waitFor(() =>
      expect(document.querySelector(".assistant-overlay")).toBeTruthy(),
    );
    // startKickoff 里取文本是异步的：先让出一个宏任务再断言，别跑在调用之前。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bridge.aiSessionKickoff).not.toHaveBeenCalled();
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    await expectNoSession();
  });
});
