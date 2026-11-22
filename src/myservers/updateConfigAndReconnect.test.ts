import { describe, expect, it, vi } from "vitest";
import { updateConfigAndReconnect } from "./updateConfigAndReconnect";

function options(over: Partial<Parameters<typeof updateConfigAndReconnect>[0]> = {}) {
  return {
    fetchPort: vi.fn(async () => 9000),
    tunnelRunning: true,
    runningNodeId: "nd_a",
    nodeId: "nd_a",
    reconnect: vi.fn(async () => true),
    ...over,
  };
}

describe("先更新配置的共用流程", () => {
  it("隧道在跑且跑的就是这台：取凭据后 stop → start", async () => {
    const opts = options();
    const outcome = await updateConfigAndReconnect(opts);
    expect(opts.fetchPort).toHaveBeenCalledTimes(1);
    expect(opts.reconnect).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ port: 9000, reconnected: true, reconnectOk: true });
  });

  it("运行的是别的节点：只取凭据，不重启", async () => {
    const opts = options({ runningNodeId: "nd_other" });
    const outcome = await updateConfigAndReconnect(opts);
    expect(opts.reconnect).not.toHaveBeenCalled();
    expect(outcome.reconnected).toBe(false);
    expect(outcome.port).toBe(9000);
  });

  it("隧道没在跑：只取凭据，不重启", async () => {
    const opts = options({ tunnelRunning: false });
    await updateConfigAndReconnect(opts);
    expect(opts.reconnect).not.toHaveBeenCalled();
  });

  it("不知道这台节点的本地 id：只取凭据，不重启", async () => {
    const opts = options({ nodeId: null });
    await updateConfigAndReconnect(opts);
    expect(opts.reconnect).not.toHaveBeenCalled();
  });

  it("重连失败：reconnectOk 为 false，端口仍然返回", async () => {
    const opts = options({ reconnect: vi.fn(async () => false) });
    const outcome = await updateConfigAndReconnect(opts);
    expect(outcome).toEqual({ port: 9000, reconnected: true, reconnectOk: false });
  });

  it("取凭据失败原样抛出，不尝试重连", async () => {
    const opts = options({
      fetchPort: vi.fn(async () => {
        throw { code: "NETWORK", message: "连不上" };
      }),
    });
    await expect(updateConfigAndReconnect(opts)).rejects.toMatchObject({
      code: "NETWORK",
    });
    expect(opts.reconnect).not.toHaveBeenCalled();
  });
});
