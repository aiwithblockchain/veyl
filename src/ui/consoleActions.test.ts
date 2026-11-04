import { describe, expect, it, vi } from "vitest";
import {
  runZeroConfigPrimaryAction,
  zeroConfigActions,
  zeroConfigContent,
  zeroConfigMode,
} from "./consoleActions";

describe("零配置入口", () => {
  it("A：刚配好 AI 时只有「我自己配置」", () => {
    expect(zeroConfigMode(true, true)).toBe("just-onboarded");
    expect(zeroConfigActions("just-onboarded")).toEqual(["new-config"]);
  });

  it("B：已配 AI、非刚引导时有「让 AI 帮我配」和「我自己配置」", () => {
    expect(zeroConfigMode(true, false)).toBe("ai-ready");
    expect(zeroConfigActions("ai-ready")).toEqual(["ask-ai", "new-config"]);
  });

  it("C：未配 AI 时只有「我自己配置」，文案不提 AI", () => {
    expect(zeroConfigMode(false, false)).toBe("manual");
    expect(zeroConfigMode(false, true)).toBe("manual");
    expect(zeroConfigActions("manual")).toEqual(["new-config"]);

    const content = zeroConfigContent("manual");
    const text = [
      content.title,
      content.body ?? "",
      ...(content.steps ?? []),
    ].join(" ");
    expect(text).not.toMatch(/AI/i);
  });

  it("A 没有主按钮动作，B 走让 AI 帮我配，C 走我自己配置", () => {
    const onAskAi = vi.fn();
    const onNewConfig = vi.fn();
    const handlers = { onAskAi, onNewConfig };

    runZeroConfigPrimaryAction("just-onboarded", handlers);
    expect(onAskAi).not.toHaveBeenCalled();
    expect(onNewConfig).not.toHaveBeenCalled();

    runZeroConfigPrimaryAction("ai-ready", handlers);
    expect(onAskAi).toHaveBeenCalledTimes(1);
    expect(onNewConfig).not.toHaveBeenCalled();

    runZeroConfigPrimaryAction("manual", handlers);
    expect(onNewConfig).toHaveBeenCalledTimes(1);
    expect(onAskAi).toHaveBeenCalledTimes(1);
  });

  it("主按钮不会发出消息", () => {
    const onAskAi = vi.fn();
    const onNewConfig = vi.fn();
    const onSend = vi.fn();
    const handlers = { onAskAi, onNewConfig, onSend };

    runZeroConfigPrimaryAction("ai-ready", handlers);
    runZeroConfigPrimaryAction("manual", handlers);

    expect(onSend).not.toHaveBeenCalled();
  });
});
