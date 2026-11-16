import { describe, expect, it } from "vitest";
import { isAiReady, shouldShowOnboarding } from "./onboarding";

const key = { masked: "sk-****abcd" };
const noKey = { masked: null };

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

  it("本机端点没有 Key 也算就绪", () => {
    expect(
      isAiReady({
        key: noKey,
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
    expect(shouldShowOnboarding({ key, providers: null })).toBe(false);
  });

  it("无 Key 但有服务商 Key 不显示", () => {
    expect(
      shouldShowOnboarding({
        key: noKey,
        providers: providers("custom", [{ providerId: "custom", hasKey: true }]),
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
      }),
    ).toBe(true);
  });

  it("本机端点无 Key 时不显示", () => {
    expect(
      shouldShowOnboarding({
        key: noKey,
        providers: providers("local", [
          {
            providerId: "local",
            hasKey: false,
            baseUrl: "http://localhost:11434",
          },
        ]),
      }),
    ).toBe(false);
  });
});
