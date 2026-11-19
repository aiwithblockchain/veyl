/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { MockAgentBridge } from "./mockAgent";

describe("mock 手机端导出", () => {
  it("浏览器预览直接给成功态：静态二维码、示例串不含真令牌", async () => {
    const bridge = new MockAgentBridge();

    const data = await bridge.mobileExportGet?.();
    expect(data?.state).toBe("ok");
    if (data?.state !== "ok") return;
    expect(data.qr_data_url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(data.url).toContain("demo-token");
    expect(data.url).not.toContain("dessage.xyz");
    expect(data.node_count).toBeGreaterThanOrEqual(0);
  });

  it("重新生成同样返回成功态", async () => {
    const bridge = new MockAgentBridge();
    const data = await bridge.mobileExportRotate?.();
    expect(data?.state).toBe("ok");
  });

  it("下载码返回静态 SVG 占位图", async () => {
    const bridge = new MockAgentBridge();
    const data = await bridge.mobileClientsQr?.();
    expect(data?.qr_data_url.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });
});
