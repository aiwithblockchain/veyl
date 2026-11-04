import { describe, expect, it, vi } from "vitest";
import { deleteConfigWithDisconnect, withoutConfig } from "./deleteConfig";

const deleted = (over: Partial<{
  deleted: boolean;
  already_absent: boolean;
  active_config_id: string | null;
}> = {}) => ({
  config_id: "c1",
  deleted: true,
  already_absent: false,
  active_config_id: null as string | null,
  ...over,
});

describe("deleteConfigWithDisconnect", () => {
  it("删未连接的 active 配置后回到空态", async () => {
    const disconnect = vi.fn();
    const remove = vi.fn().mockResolvedValue(deleted());

    const outcome = await deleteConfigWithDisconnect({
      configId: "c1",
      connectedConfigId: null,
      disconnect,
      remove,
    });

    expect(outcome.ok).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);

    const next = withoutConfig([{ config_id: "c1" }], "c1", "c1");
    expect(next.configs).toEqual([]);
    expect(next.activeId).toBeNull();
  });

  it("连接中的配置先断开再删", async () => {
    const order: string[] = [];
    const disconnect = vi.fn(async () => {
      order.push("disconnect");
      return { ok: true };
    });
    const remove = vi.fn(async () => {
      order.push("remove");
      return deleted();
    });

    const outcome = await deleteConfigWithDisconnect({
      configId: "c1",
      connectedConfigId: "c1",
      disconnect,
      remove,
    });

    expect(outcome.ok).toBe(true);
    expect(order).toEqual(["disconnect", "remove"]);
  });

  it("断开失败就中止，不硬删", async () => {
    const disconnect = vi.fn().mockResolvedValue({ ok: false, message: "断开失败" });
    const remove = vi.fn();

    const outcome = await deleteConfigWithDisconnect({
      configId: "c1",
      connectedConfigId: "c1",
      disconnect,
      remove,
    });

    expect(outcome).toEqual({ ok: false, message: "断开失败" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("already_absent 当成功处理", async () => {
    const remove = vi.fn().mockResolvedValue(
      deleted({ deleted: false, already_absent: true }),
    );

    const outcome = await deleteConfigWithDisconnect({
      configId: "c1",
      connectedConfigId: null,
      disconnect: vi.fn(),
      remove,
    });

    expect(outcome).toEqual({ ok: true });
  });
});
