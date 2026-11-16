/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, DeepSeekKeyState } from "../agent/bridge";
import { Onboarding } from "./Onboarding";

afterEach(cleanup);

function makeBridge(): AgentBridge {
  return {
    mode: "mock",
    subscribe: vi.fn(() => () => {}),
    getDeepSeekKey: vi.fn(async () => ({
      masked: null,
      verified: false,
      validation: "unverified" as const,
    })),
    saveDeepSeekKey: vi.fn(
      async (): Promise<DeepSeekKeyState> => ({
        masked: "sk-****abcd",
        verified: true,
        validation: "ok" as const,
      }),
    ),
  } as unknown as AgentBridge;
}

describe("Onboarding 原生表单与输入法", () => {
  it("Key 表单：组合态回车被拦，普通回车不拦", () => {
    render(<Onboarding bridge={makeBridge()} onDone={() => {}} />);
    const input = screen.getByLabelText("DeepSeek API Key");

    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(false);
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
  });

  it("自定义服务商表单：同样", () => {
    render(<Onboarding bridge={makeBridge()} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /使用其他 AI 服务/ }));
    const input = screen.getByLabelText("Base URL");

    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(false);
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
  });

  it("展开其他 AI 服务：Key 输入框收起，只留一个连接按钮", () => {
    render(<Onboarding bridge={makeBridge()} onDone={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /使用其他 AI 服务/ }));

    expect(screen.queryByLabelText("DeepSeek API Key")).toBeNull();
    expect(screen.queryByRole("button", { name: /获取 Key/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: "连接" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /使用 DeepSeek Key/ }));

    const input = screen.getByLabelText("DeepSeek API Key");
    expect(input).toBeTruthy();
    expect(screen.getByRole("button", { name: "连接" })).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it("连接中显示三点，成功后交回 App", async () => {
    let release: (value: DeepSeekKeyState) => void = () => {};
    const bridge = makeBridge();
    bridge.saveDeepSeekKey = vi.fn(
      () =>
        new Promise<DeepSeekKeyState>((resolve) => {
          release = resolve;
        }),
    );
    const onDone = vi.fn();
    render(<Onboarding bridge={bridge} onDone={onDone} />);

    fireEvent.change(screen.getByLabelText("DeepSeek API Key"), {
      target: { value: "sk-test-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    expect(screen.getByRole("button", { name: "校验中" })).toBeTruthy();
    expect(document.querySelectorAll(".first-run__dots span")).toHaveLength(3);

    release({ masked: "sk-****abcd", verified: true, validation: "ok" });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("Key 格式不对：就地报错且不清空输入", () => {
    render(<Onboarding bridge={makeBridge()} onDone={() => {}} />);
    const input = screen.getByLabelText("DeepSeek API Key");

    fireEvent.change(input, { target: { value: "not-a-key" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    expect(screen.getByRole("alert").textContent).toContain("sk- 开头");
    expect((input as HTMLInputElement).value).toBe("not-a-key");
  });

  it("服务商保存了但没成为当前 AI：停在首屏并保留表单", async () => {
    const bridge = makeBridge();
    const provider = {
      providerId: "prv_1",
      name: "my-model",
      protocol: "openai" as const,
      baseUrl: "https://api.example.com",
      model: "my-model",
      hasKey: true,
      isActive: false,
      isBuiltin: false,
    };
    bridge.llmProviderTest = vi.fn(async () => ({ ok: true, latencyMs: 120 }));
    bridge.llmProviderSave = vi.fn(async () => ({ ...provider }));
    bridge.llmProviderActivate = vi.fn(async () => {
      throw { code: "INTERNAL", message: "activate 没成功" };
    });
    bridge.llmProviderList = vi.fn(async () => ({
      providers: [{ ...provider }],
      activeProviderId: null,
    }));

    const onDone = vi.fn();
    render(<Onboarding bridge={bridge} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: /使用其他 AI 服务/ }));
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://api.example.com" },
    });
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "my-model" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-1234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "已保存，但没能设为当前 AI。请重试。",
    );
    expect(onDone).not.toHaveBeenCalled();
    expect((screen.getByLabelText("模型") as HTMLInputElement).value).toBe(
      "my-model",
    );
    expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(
      "sk-1234567890",
    );
  });

  it("本机端点无 Key：保存后复核通过并交回 App", async () => {
    const bridge = makeBridge();
    const provider = {
      providerId: "prv_local",
      name: "llama",
      protocol: "openai" as const,
      baseUrl: "http://127.0.0.1:11434",
      model: "llama",
      hasKey: false,
      isActive: true,
      isBuiltin: false,
    };
    bridge.llmProviderTest = vi.fn(async () => ({ ok: true, latencyMs: 80 }));
    bridge.llmProviderSave = vi.fn(async () => ({ ...provider }));
    bridge.llmProviderActivate = vi.fn(async () => {});
    bridge.llmProviderList = vi.fn(async () => ({
      providers: [{ ...provider }],
      activeProviderId: "prv_local",
    }));

    const onDone = vi.fn();
    render(<Onboarding bridge={bridge} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: /使用其他 AI 服务/ }));
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "http://127.0.0.1:11434" },
    });
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "llama" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
