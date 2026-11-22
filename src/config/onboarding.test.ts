import { describe, expect, it } from "vitest";
import {
  isAiReady,
  ONBOARDING_SKIPPED_KEY,
  shouldShowOnboarding,
} from "./onboarding";

function providers(
  activeProviderId: string | null,
  list: Array<{ providerId: string; hasKey: boolean; baseUrl?: string }>,
) {
  return {
    providers: list.map((provider) => ({
      baseUrl: "https://api.example.com",
      ...provider,
    })),
    activeProviderId,
  };
}

describe("isAiReady", () => {
  it("没有服务商目录就不就绪", () => {
    expect(isAiReady({ providers: null })).toBe(false);
  });

  it("有服务商目录但没有 active，不就绪", () => {
    expect(
      isAiReady({
        providers: providers(null, [{ providerId: "deepseek", hasKey: true }]),
      }),
    ).toBe(false);
  });

  it("当前服务商有 Key 就绪", () => {
    expect(
      isAiReady({
        providers: providers("custom", [{ providerId: "custom", hasKey: true }]),
      }),
    ).toBe(true);
  });

  it("内置服务商是 active 但没有 Key，不算就绪", () => {
    expect(
      isAiReady({
        providers: providers("deepseek", [{ providerId: "deepseek", hasKey: false }]),
      }),
    ).toBe(false);
  });

  it("本机端点没有 Key 也算就绪", () => {
    expect(
      isAiReady({
        providers: providers("local", [
          {
            providerId: "local",
            hasKey: false,
            baseUrl: "http://127.0.0.1:11434",
          },
        ]),
      }),
    ).toBe(true);
  });

  it("有 Key 的服务商不是当前项，不算就绪", () => {
    expect(
      isAiReady({
        providers: providers("deepseek", [
          { providerId: "deepseek", hasKey: false },
          { providerId: "other", hasKey: true },
        ]),
      }),
    ).toBe(false);
  });
});

describe("shouldShowOnboarding", () => {
  it("跳过标记键名固定", () => {
    expect(ONBOARDING_SKIPPED_KEY).toBe("veyl.onboarding.skipped");
  });

  it("没有服务商目录时显示", () => {
    expect(shouldShowOnboarding({ providers: null }, false)).toBe(true);
  });

  it("当前服务商有 Key 不显示", () => {
    expect(
      shouldShowOnboarding(
        {
          providers: providers("custom", [
            { providerId: "custom", hasKey: true },
          ]),
        },
        false,
      ),
    ).toBe(false);
  });

  it("完全没有 AI 时显示", () => {
    expect(
      shouldShowOnboarding(
        {
          providers: providers("deepseek", [
            { providerId: "deepseek", hasKey: false },
          ]),
        },
        false,
      ),
    ).toBe(true);
  });

  it("本机端点无 Key 时不显示", () => {
    expect(
      shouldShowOnboarding(
        {
          providers: providers("local", [
            {
              providerId: "local",
              hasKey: false,
              baseUrl: "http://localhost:11434",
            },
          ]),
        },
        false,
      ),
    ).toBe(false);
  });

  it("已跳过：没有 AI 也不显示", () => {
    expect(
      shouldShowOnboarding(
        {
          providers: providers("deepseek", [
            { providerId: "deepseek", hasKey: false },
          ]),
        },
        true,
      ),
    ).toBe(false);
  });

  it("已跳过：有 AI 同样不显示", () => {
    expect(
      shouldShowOnboarding(
        { providers: providers("custom", [{ providerId: "custom", hasKey: true }]) },
        true,
      ),
    ).toBe(false);
  });
});
