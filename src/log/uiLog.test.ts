/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { uiLog } from "./uiLog";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("uiLog", () => {
  it("按 ui_log 的签名调用，target 默认 wallet", () => {
    uiLog("debug", "refresh seq=7 trigger=focus");
    expect(invoke).toHaveBeenCalledWith("ui_log", {
      level: "debug",
      target: "wallet",
      message: "refresh seq=7 trigger=focus",
    });
  });

  it("命令失败只吞掉，不抛给调用方", async () => {
    invoke.mockRejectedValueOnce(new Error("unknown command"));
    expect(() => uiLog("warn", "refresh done outcome=failed")).not.toThrow();
    await Promise.resolve();
  });

  it("非 Tauri 环境里 invoke 同步抛也不影响调用方", () => {
    invoke.mockImplementationOnce(() => {
      throw new Error("__TAURI_INTERNALS__ is undefined");
    });
    expect(() => uiLog("debug", "refresh done outcome=ok")).not.toThrow();
  });
});
