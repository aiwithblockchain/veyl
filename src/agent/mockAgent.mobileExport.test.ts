/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { MockAgentBridge } from "./mockAgent";

describe("mock 手机端导出", () => {
  it("返回三种格式：sing-box / Clash / ss 都带码", async () => {
    const bridge = new MockAgentBridge();

    const data = await bridge.mobileExportGet?.();
    expect(data?.state).toBe("ok");
    if (data?.state !== "ok") return;
    expect(data.formats.map((item) => item.format)).toEqual([
      "singbox",
      "clash",
      "ss",
    ]);
    const singbox = data.formats.find((item) => item.format === "singbox");
    const clash = data.formats.find((item) => item.format === "clash");
    const ss = data.formats.find((item) => item.format === "ss");
    expect(singbox?.qr_data_url?.startsWith("data:image/svg+xml;base64,")).toBe(
      true,
    );
    expect(clash?.url).toContain("/clash");
    expect(clash?.qr_data_url?.startsWith("data:image/svg+xml;base64,")).toBe(
      true,
    );
    expect(ss?.url).toContain("/ss");
    expect(ss?.qr_data_url?.startsWith("data:image/svg+xml;base64,")).toBe(
      true,
    );
    expect(singbox?.url).not.toContain("dessage.xyz");
  });

  it("重新生成同样返回三种格式", async () => {
    const bridge = new MockAgentBridge();
    const data = await bridge.mobileExportRotate?.();
    expect(data?.state).toBe("ok");
  });

  it("客户端下载码按枚举返回对应 URL", async () => {
    const bridge = new MockAgentBridge();

    await expect(bridge.mobileClientsQr?.("singbox")).resolves.toMatchObject({
      url: "https://sing-box.sagernet.org/clients/",
    });
    await expect(bridge.mobileClientsQr?.("hiddify")).resolves.toMatchObject({
      url: "https://github.com/hiddify/hiddify-app",
    });
    await expect(bridge.mobileClientsQr?.("cmfa")).resolves.toMatchObject({
      url: "https://github.com/MetaCubeX/ClashMetaForAndroid/releases",
    });
    await expect(
      bridge.mobileClientsQr?.("shadowrocket"),
    ).resolves.toMatchObject({
      url: "https://apps.apple.com/us/app/shadowrocket/id932747118",
    });
    const data = await bridge.mobileClientsQr?.("cmfa");
    expect(data?.qr_data_url.startsWith("data:image/svg+xml;base64,")).toBe(
      true,
    );
  });
});
