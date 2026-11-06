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

describe("默认种子状态字段", () => {
  it("透传检查时间、来源、变更与增删数量", async () => {
    invoke.mockResolvedValueOnce({
      package_id: "veyl_seed",
      version: "2026.11.2",
      applied_at: 1700000000000,
      new_version_available: true,
      node_count: 23,
      checked_at: 1700000100000,
      source: "network",
      changed: true,
      reason: null,
      added: 2,
      removed: 1,
    });
    const bridge = new TauriAgentBridge();
    const result = await bridge.defaultProfileRefresh();
    expect(result).toEqual({
      packageId: "veyl_seed",
      version: "2026.11.2",
      appliedAt: new Date(1700000000000).toISOString(),
      newVersionAvailable: true,
      nodeCount: 23,
      checkedAt: new Date(1700000100000).toISOString(),
      source: "network",
      changed: true,
      reason: null,
      added: 2,
      removed: 1,
    });
  });

  it("离线 / 内容异常原样透传，旧后端缺字段时给安全默认值", async () => {
    invoke.mockResolvedValueOnce({
      source: "cache",
      changed: false,
      reason: "offline",
      added: null,
      removed: null,
    });
    const bridge = new TauriAgentBridge();
    await expect(bridge.defaultProfileStatus()).resolves.toEqual({
      packageId: null,
      version: null,
      appliedAt: null,
      newVersionAvailable: false,
      nodeCount: 0,
      checkedAt: null,
      source: "cache",
      changed: false,
      reason: "offline",
      added: 0,
      removed: 0,
    });
  });

  it("本机写入失败按 local_write 透传，不归到内容异常", async () => {
    invoke.mockResolvedValueOnce({
      source: "network",
      changed: false,
      reason: "local_write",
    });
    const bridge = new TauriAgentBridge();
    await expect(bridge.defaultProfileRefresh()).resolves.toMatchObject({
      source: "network",
      changed: false,
      reason: "local_write",
    });
  });

  it("未知来源与原因不穿透到界面", async () => {
    invoke.mockResolvedValueOnce({ source: "weird", reason: "boom", added: -3 });
    const bridge = new TauriAgentBridge();
    await expect(bridge.defaultProfileStatus()).resolves.toMatchObject({
      source: null,
      reason: null,
      added: 0,
    });
  });

  it("ISO 字符串时间原样保留", async () => {
    invoke.mockResolvedValueOnce({
      applied_at: "2026-11-01T00:00:00.000Z",
      checked_at: "2026-11-02T00:00:00.000Z",
    });
    const bridge = new TauriAgentBridge();
    await expect(bridge.defaultProfileStatus()).resolves.toMatchObject({
      appliedAt: "2026-11-01T00:00:00.000Z",
      checkedAt: "2026-11-02T00:00:00.000Z",
    });
  });
});
