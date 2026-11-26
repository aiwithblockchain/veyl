import { describe, expect, it } from "vitest";
import {
  buildContext,
  emptyCollected,
  type DiagnosisFacts,
} from "./useNodeDiagnosis";

const facts: DiagnosisFacts = {
  serverId: "srv_1",
  region: "us",
  createdAt: "2026-11-01T00:00:00Z",
  state: "active",
  localNodeId: "nd_local_1",
  port: 8443,
  nodeInUse: true,
  appVersion: "1.1.0",
  platform: "macos",
  uiLogPath: "/tmp/veyl-ui.log",
};

describe("交给 AI 的节点诊断清单", () => {
  it("不带内部 id、端口和本地日志路径，即使这些值在 facts 与收集中都有", () => {
    const context = buildContext(facts, {
      ...emptyCollected(),
      rotatePort: 9443,
      syncPortAfter: 9443,
    });

    expect(context.node).not.toHaveProperty("local_id");
    expect(context.node).not.toHaveProperty("port");
    expect(context.client).not.toHaveProperty("ui_log_path");

    // 整段序列化也不许漏：防止以后换个嵌套位置又带回去。
    const payload = JSON.stringify(context);
    expect(payload).not.toContain("nd_local_1");
    expect(payload).not.toContain("8443");
    expect(payload).not.toContain("veyl-ui.log");
  });

  it("保留 node.in_use，且 port_changed 仍按 facts.port 计算", () => {
    expect(buildContext(facts, emptyCollected()).node.in_use).toBe(true);
    expect(buildContext(facts, emptyCollected()).config_update.port_changed).toBe(
      null,
    );

    const changed = buildContext(facts, {
      ...emptyCollected(),
      syncPortAfter: 9443,
    });
    expect(changed.config_update.port_changed).toBe(true);
    expect(changed.node.in_use).toBe(true);

    const same = buildContext(facts, {
      ...emptyCollected(),
      syncPortAfter: 8443,
    });
    expect(same.config_update.port_changed).toBe(false);
  });
});
