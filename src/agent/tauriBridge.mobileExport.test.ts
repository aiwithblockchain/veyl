import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { TauriAgentBridge } from "./tauriBridge";

beforeEach(() => {
  invoke.mockReset();
});

const FORMATS = ["singbox", "clash", "ss", "shadowrocket"] as const;

describe("手机端导出的格式白名单", () => {
  it("四种格式全部透传：漏一种界面就会显示「暂时生成不了」", async () => {
    invoke.mockResolvedValueOnce({
      state: "ok",
      node_count: 1,
      created_at: 1,
      formats: FORMATS.map((format) => ({
        format,
        url: `https://veyl:t@veyl.example/v1/mobile/profile/${format}`,
        qr_data_url: "data:image/svg+xml;base64,AA==",
      })),
    });

    const bridge = new TauriAgentBridge();
    const data = await bridge.mobileExportGet();
    expect(data.state).toBe("ok");
    if (data.state !== "ok") return;
    expect(data.formats.map((item) => item.format)).toEqual([...FORMATS]);
  });

  it("未知格式丢弃，不让它变成没有 url 的半条数据", async () => {
    invoke.mockResolvedValueOnce({
      state: "ok",
      node_count: 1,
      created_at: 1,
      formats: [
        { format: "surge", url: "https://x/1", qr_data_url: "data:x" },
        { format: "ss", url: "https://x/2", qr_data_url: "data:y" },
        { format: "shadowrocket", url: "https://x/3" },
      ],
    });

    const bridge = new TauriAgentBridge();
    const data = await bridge.mobileExportGet();
    if (data.state !== "ok") throw new Error("应为 ok");
    expect(data.formats.map((item) => item.format)).toEqual(["ss"]);
  });
});
