/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { MockAgentBridge } from "./mockAgent";

let bridge: MockAgentBridge | null = null;

afterEach(() => {
  bridge?.dispose();
  bridge = null;
  localStorage.clear();
});

describe("同一会话单飞", () => {
  it("上一条没结束时，第二条被 BUSY 拒绝并带上进行中的 request id", async () => {
    bridge = new MockAgentBridge();
    const first = await bridge.sendMessage("session_a", "第一条");
    await expect(bridge.sendMessage("session_a", "第二条")).rejects.toMatchObject({
      code: "BUSY",
      details: {
        reason: "request_in_flight",
        active_request_id: first.requestId,
      },
    });
  });

  it("取消：进行中的请求返回 true，未知请求返回 false", async () => {
    bridge = new MockAgentBridge();
    const { requestId } = await bridge.sendMessage("session_a", "第一条");
    await expect(bridge.cancel(requestId)).resolves.toBe(true);
    await expect(bridge.cancel("req_unknown")).resolves.toBe(false);
  });

  it("不同会话互不影响", async () => {
    bridge = new MockAgentBridge();
    await bridge.sendMessage("session_a", "第一条");
    await expect(bridge.sendMessage("session_b", "另一条")).resolves.toHaveProperty(
      "requestId",
    );
  });
});
