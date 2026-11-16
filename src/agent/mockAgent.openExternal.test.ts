/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockAgentBridge } from "./mockAgent";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mock openExternal", () => {
  it("用新窗口打开外链", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const bridge = new MockAgentBridge();

    await bridge.openExternal("https://platform.deepseek.com/");

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      "https://platform.deepseek.com/",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("窗口被拦截时抛错，让调用方走手动兜底", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const bridge = new MockAgentBridge();

    await expect(
      bridge.openExternal("https://platform.deepseek.com/"),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
