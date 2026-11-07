/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgentBridge } from "./mockAgent";

let bridge: MockAgentBridge | null = null;

beforeEach(() => {
  bridge = new MockAgentBridge();
});

afterEach(() => {
  bridge?.dispose();
  bridge = null;
  localStorage.clear();
});

describe("浏览器演示用的节点命令", () => {
  it("粘贴文本逐行解析：好的进 nodes，坏的行进 skipped", async () => {
    const result = await bridge!.nodeImportText("ss://abc#东京\n不是链接\nss://def#大阪");
    expect(result.imported).toBe(2);
    expect(result.nodes.map((node) => node.name)).toEqual(["东京", "大阪"]);
    expect(result.skipped).toEqual([{ name: null, reason: "unsupported_scheme" }]);
  });

  it("一条都解析不出来时按 not_node_text 拒绝", async () => {
    await expect(bridge!.nodeImportText("hello")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "not_node_text" },
    });
  });

  it("订阅地址只接受 https，拉取失败走 fetch_failed", async () => {
    await expect(bridge!.nodeImportUrl("http://example.com/sub")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "insecure_url" },
    });
    await expect(bridge!.nodeImportUrl("https://example.com/fail")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      details: { reason: "fetch_failed" },
    });
    await expect(bridge!.nodeImportUrl("https://example.com/sub")).resolves.toMatchObject({
      imported: 2,
    });
  });

  it("手动节点返回五个字段的摘要", async () => {
    const node = await bridge!.nodeCreate({
      name: "东京",
      server: "203.0.113.9",
      port: 8388,
      method: "aes-256-gcm",
      password: "secret",
    });
    expect(node).toMatchObject({
      name: "东京",
      server: "203.0.113.9",
      port: 8388,
      method: "aes-256-gcm",
      protocol: "shadowsocks",
      source: "manual",
    });
  });

  it("服务目录可搜索", async () => {
    const all = await bridge!.categoryList();
    expect(all.categories.length).toBeGreaterThan(3);
    const filtered = await bridge!.categoryList("chat");
    expect(filtered.categories.map((category) => category.id)).toEqual(["chatgpt"]);
  });

  it("地区默认中国大陆，可用 localStorage 演示未知", async () => {
    await expect(bridge!.systemRegion()).resolves.toBe("cn");
    localStorage.setItem("veyl.mock.region", "unknown");
    await expect(bridge!.systemRegion()).resolves.toBeNull();
    localStorage.setItem("veyl.mock.region", "JP");
    await expect(bridge!.systemRegion()).resolves.toBe("jp");
  });
});
