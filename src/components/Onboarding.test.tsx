/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge } from "../agent/bridge";
import { Onboarding } from "./Onboarding";

afterEach(cleanup);

function makeBridge(): AgentBridge {
  return { mode: "mock", subscribe: vi.fn(() => () => {}) } as unknown as AgentBridge;
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
});
