import { describe, expect, it } from "vitest";
import { failureHeadline, isDisconnectFailure } from "./middleArea";

describe("isDisconnectFailure", () => {
  it("只有 running / degraded 掉到 failed 算连接断了", () => {
    expect(isDisconnectFailure("running", "failed")).toBe(true);
    expect(isDisconnectFailure("degraded", "failed")).toBe(true);
    expect(isDisconnectFailure("starting", "failed")).toBe(false);
    expect(isDisconnectFailure("idle", "failed")).toBe(false);
  });

  it("不是失败的迁移一律复位", () => {
    expect(isDisconnectFailure("running", "idle")).toBe(false);
    expect(isDisconnectFailure("failed", "idle")).toBe(false);
    expect(isDisconnectFailure("running", "stopping")).toBe(false);
  });
});

describe("failureHeadline", () => {
  it("连接断了 vs 从来没有连上", () => {
    expect(failureHeadline(true)).toBe("连接断了。");
    expect(failureHeadline(false)).toBe("没有连上节点。");
  });
});
