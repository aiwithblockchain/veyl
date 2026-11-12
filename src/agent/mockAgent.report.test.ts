/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { ISSUE_REPORT_OPENING } from "../ui/issueReport";
import { MockAgentBridge } from "./mockAgent";
import { AGENT_EVENTS, CONTRACT_VERSION } from "./protocol";

const DISCLOSURE =
  "报告只保存在你的电脑上；生成时，脱敏后的日志会发给你配置的 AI 服务。要不要把它发出去，由你决定。";

describe("问题报告开场", () => {
  it("开场指令要求第一句逐字说出披露句", () => {
    expect(ISSUE_REPORT_OPENING).toContain(DISCLOSURE);
    expect(ISSUE_REPORT_OPENING).toContain("第一句原样说出");
  });

  it("mock 的第一条回复以披露句开头", async () => {
    const bridge = new MockAgentBridge();
    let text = "";
    bridge.subscribe((event) => {
      if (
        event.name === AGENT_EVENTS.messageChunk &&
        event.payload.contract_version === CONTRACT_VERSION &&
        "chunk" in event.payload
      ) {
        text += event.payload.chunk;
      }
    });

    await bridge.sendMessage("session_report", ISSUE_REPORT_OPENING, { hidden: true });
    await vi.waitFor(() => expect(text).toContain("你遇到了什么问题"), {
      timeout: 3000,
    });

    expect(text.startsWith(DISCLOSURE)).toBe(true);
  });
});
