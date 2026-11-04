import { describe, expect, it } from "vitest";
import { isAiReady, shouldKickOffFirstRun, shouldShowOnboarding } from "./onboarding";

const key = { masked: "sk-****abcd" };
const noKey = { masked: null };

function providers(
  activeProviderId: string | null,
  list: Array<{ providerId: string; hasKey: boolean }>,
) {
  return { providers: list, activeProviderId };
}

describe("isAiReady", () => {
  it("有 DeepSeek Key 就绪", () => {
    expect(isAiReady({ key, providers: null })).toBe(true);
  });

  it("没有 Key，但当前服务商有 Key", () => {
    expect(
      isAiReady({
        key: noKey,
        providers: providers("custom", [{ providerId: "custom", hasKey: true }]),
      }),
    ).toBe(true);
  });

  it("内置服务商是 active 但没有 Key，不算就绪", () => {
    expect(
      isAiReady({
        key: noKey,
        providers: providers("deepseek", [{ providerId: "deepseek", hasKey: false }]),
      }),
    ).toBe(false);
  });

  it("有 Key 的服务商不是当前项，不算就绪", () => {
    expect(
      isAiReady({
        key: noKey,
        providers: providers("deepseek", [
          { providerId: "deepseek", hasKey: false },
          { providerId: "other", hasKey: true },
        ]),
      }),
    ).toBe(false);
  });

  it("没有服务商目录时只看 Key", () => {
    expect(isAiReady({ key: noKey, providers: null })).toBe(false);
  });
});

describe("shouldShowOnboarding", () => {
  it("有 Key 不显示", () => {
    expect(
      shouldShowOnboarding({ key, providers: null, skipped: false }),
    ).toBe(false);
  });

  it("无 Key 但有服务商 Key 不显示", () => {
    expect(
      shouldShowOnboarding({
        key: noKey,
        providers: providers("custom", [{ providerId: "custom", hasKey: true }]),
        skipped: false,
      }),
    ).toBe(false);
  });

  it("完全没有 AI 时显示", () => {
    expect(
      shouldShowOnboarding({
        key: noKey,
        providers: providers("deepseek", [
          { providerId: "deepseek", hasKey: false },
        ]),
        skipped: false,
      }),
    ).toBe(true);
  });

  it("用户明确选择过不用 AI 就不显示", () => {
    expect(
      shouldShowOnboarding({
        key: noKey,
        providers: providers("deepseek", [
          { providerId: "deepseek", hasKey: false },
        ]),
        skipped: true,
      }),
    ).toBe(false);
  });

  it("跳过过但后来配好了 AI，也不显示", () => {
    expect(
      shouldShowOnboarding({ key, providers: null, skipped: true }),
    ).toBe(false);
  });
});

describe("shouldKickOffFirstRun", () => {
  const base = {
    aiReady: true,
    configCount: 0,
    messageCount: 0,
  };

  it("三个条件都满足时触发", () => {
    expect(shouldKickOffFirstRun(base)).toBe(true);
  });

  it("连接过但配置删光、会话为空，仍然触发", () => {
    // hasEverConnected 不参与判断：老用户删光配置后同样需要 AI 帮他重建。
    const returningUser = {
      aiReady: true,
      hasEverConnected: true,
      configCount: 0,
      messageCount: 0,
    };
    expect(shouldKickOffFirstRun(returningUser)).toBe(true);
  });

  it("没有可用 AI 不触发", () => {
    expect(shouldKickOffFirstRun({ ...base, aiReady: false })).toBe(false);
  });

  it("已有配置不触发", () => {
    expect(shouldKickOffFirstRun({ ...base, configCount: 1 })).toBe(false);
  });

  it("当前会话已有消息不触发", () => {
    expect(shouldKickOffFirstRun({ ...base, messageCount: 1 })).toBe(false);
  });
});
