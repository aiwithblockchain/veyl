/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockAgentBridge } from "./mockAgent";

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

async function refresh() {
  const bridge = new MockAgentBridge();
  const pending = bridge.defaultProfileRefresh();
  await vi.advanceTimersByTimeAsync(1000);
  return pending;
}

describe("mock 种子刷新状态", () => {
  it("正常刷新：来自网络、内容有变化、记录检查时间", async () => {
    vi.useFakeTimers();
    const result = await refresh();
    expect(result).toMatchObject({
      source: "network",
      changed: true,
      reason: null,
      added: 1,
      removed: 0,
    });
    expect(result.checkedAt).toBeTruthy();
    expect(result.version).toBe("2026.11.2");
  });

  it("离线：保留旧节点并标记 offline", async () => {
    vi.useFakeTimers();
    localStorage.setItem("veyl.mock.seed.offline", "1");
    const result = await refresh();
    expect(result).toMatchObject({
      source: "cache",
      changed: false,
      reason: "offline",
      added: 0,
      removed: 0,
      version: "2026.11.1",
    });
    expect(result.checkedAt).toBeTruthy();
  });

  it("内容异常：保留旧节点并标记 invalid_content", async () => {
    vi.useFakeTimers();
    localStorage.setItem("veyl.mock.seed.invalid", "1");
    const result = await refresh();
    expect(result).toMatchObject({
      source: "cache",
      changed: false,
      reason: "invalid_content",
    });
  });

  it("本机写入失败：内容没问题，单独标记 local_write", async () => {
    vi.useFakeTimers();
    localStorage.setItem("veyl.mock.seed.localwrite", "1");
    const result = await refresh();
    expect(result).toMatchObject({
      source: "network",
      changed: false,
      reason: "local_write",
      added: 0,
      removed: 0,
    });
    expect(result.checkedAt).toBeTruthy();
  });

  it("status 只读：报告缓存口径，不声称有变化", async () => {
    vi.useFakeTimers();
    const bridge = new MockAgentBridge();
    const status = await bridge.defaultProfileStatus();
    expect(status).toMatchObject({
      source: "cache",
      changed: false,
      reason: null,
      added: 0,
      removed: 0,
      checkedAt: null,
    });
  });
});
