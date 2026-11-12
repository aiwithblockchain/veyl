import { describe, expect, it } from "vitest";
import toolsDoc from "../../docs/contracts/tools.md?raw";
import {
  FALLBACK_COPY,
  TOOL_COPY,
  TOOL_NAMES,
  changedLabel,
  exactDuration,
  factsFromArgs,
  readToolDisplay,
  shortDuration,
  toolCopy,
} from "./toolDisplay";

function contractToolNames(): string[] {
  const section = toolsDoc.split(/^## 3\. /m)[1]?.split(/^## 4\. /m)[0] ?? "";
  return Array.from(section.matchAll(/^\|\s*\d+\s*\|\s*`([^`]+)`\s*\|/gm)).map(
    (match: RegExpExecArray) => match[1],
  );
}

describe("工具名映射集合", () => {
  it("与 tools.md §3 的 47 个工具名完全相等", () => {
    const names = contractToolNames();
    expect(names).toHaveLength(47);
    expect(new Set(names)).toEqual(new Set(TOOL_NAMES));
    expect(TOOL_NAMES).toHaveLength(47);
  });

  it("每个工具都有进行中、完成、失败与建议文案", () => {
    for (const name of TOOL_NAMES) {
      const copy = TOOL_COPY[name];
      expect(copy.running.length, name).toBeGreaterThan(0);
      expect(copy.done.length, name).toBeGreaterThan(0);
      expect(copy.failed.length, name).toBeGreaterThan(0);
      expect(copy.advice.length, name).toBeGreaterThan(0);
    }
  });

  it("未映射工具走通用兜底，不暴露原始工具名", () => {
    expect(toolCopy("FooBar")).toBe(FALLBACK_COPY);
    expect(FALLBACK_COPY.running).toBe("正在处理…");
    expect(FALLBACK_COPY.done).toBe("已完成");
    expect(FALLBACK_COPY.failed).toBe("没成功");
  });

  it("未映射工具的四个文案字段都不含原始工具名", () => {
    const copy = toolCopy("NotARealTool");
    expect(copy.running).toBe("正在处理…");
    for (const value of [copy.running, copy.done, copy.failed, copy.advice]) {
      expect(value).not.toContain("NotARealTool");
    }
  });
});

describe("readToolDisplay", () => {
  it("读取后端扁平字段", () => {
    expect(
      readToolDisplay({
        text: "已连接",
        facts: ["出口 203.0.113.7", { label: "延迟", value: "42 毫秒" }],
        changed: "none",
      }),
    ).toEqual({
      text: "已连接",
      facts: [
        { label: "", value: "出口 203.0.113.7" },
        { label: "延迟", value: "42 毫秒" },
      ],
      changed: "none",
      actions: [],
    });  });

  it("只认两个报告动作，未知 kind 与空 id 丢弃，最多两个", () => {
    const display = readToolDisplay({
      text: "报告已生成",
      changed: "none",
      actions: [
        { kind: "reveal_report_dir", report_id: "rpt-1" },
        { kind: "compose_report_mail", report_id: "rpt-1" },
        { kind: "open_path", report_id: "rpt-1" },
        { kind: "reveal_report_dir", report_id: "" },
        { kind: "compose_report_mail", report_id: "rpt-2" },
      ],
    });
    expect(display?.actions).toEqual([
      { kind: "reveal_report_dir", reportId: "rpt-1" },
      { kind: "compose_report_mail", reportId: "rpt-1" },
    ]);
  });

  it("只有 actions 也算有效 display", () => {
    expect(
      readToolDisplay({
        actions: [{ kind: "reveal_report_dir", report_id: "rpt-1" }],
      }),
    ).not.toBeNull();
  });

  it("字段缺失或类型不对时返回 null", () => {
    expect(readToolDisplay(null)).toBeNull();
    expect(readToolDisplay("已连接")).toBeNull();
    expect(readToolDisplay({})).toBeNull();
    expect(readToolDisplay({ text: "  ", facts: [], changed: "???" })).toBeNull();
  });

  it("changed 兼容布尔值与后端枚举", () => {
    expect(readToolDisplay({ changed: false })?.changed).toBe("none");
    expect(readToolDisplay({ changed: true })?.changed).toBe("unknown");
    expect(readToolDisplay({ changed: "restored" })?.changed).toBe("restored");
    expect(readToolDisplay({ changed: "reverted" })?.changed).toBe("restored");
    expect(readToolDisplay({ changed: "rolled_back" })?.changed).toBe("restored");
  });

  it("facts 最多保留四行", () => {
    const display = readToolDisplay({
      facts: ["一", "二", "三", "四", "五"],
    });
    expect(display?.facts).toHaveLength(4);
  });
});

describe("参数事实兜底", () => {
  it("只取名称与结果事实，不显示 id", () => {
    expect(
      factsFromArgs({
        config_id: "cfg_1",
        node_id: "seed-jp-01",
        config_name: "公司",
        node_name: "东京 01",
        exit_ip: "203.0.113.7",
        latency_ms: 42,
      }),
    ).toEqual([
      { label: "配置", value: "公司" },
      { label: "节点", value: "东京 01" },
      { label: "出口", value: "203.0.113.7" },
      { label: "延迟", value: "42 毫秒" },
    ]);
  });

  it("没有可展示字段时为空数组", () => {
    expect(factsFromArgs({ config_id: "cfg_1", node_id: "n_1" })).toEqual([]);
    expect(factsFromArgs(undefined)).toEqual([]);
  });
});

describe("文案辅助", () => {
  it("三句 changed 文案固定，且不写死成「网络设置」", () => {
    const lines = [
      changedLabel("none", false),
      changedLabel("restored", false),
      changedLabel("unknown", false),
      changedLabel(null, true),
      changedLabel(null, false),
    ];
    expect(lines).toEqual([
      "没有改动任何设置",
      "已经恢复原样",
      "不确定，诊断日志里有记录",
      "没有改动任何设置",
      "不确定，诊断日志里有记录",
    ]);
    for (const line of lines) {
      expect(line).not.toContain("网络");
    }
  });

  it("只读工具缺失 changed 时按没有改动处理", () => {
    expect(changedLabel(null, true)).toBe("没有改动任何设置");
    expect(changedLabel(null, false)).toBe("不确定，诊断日志里有记录");
  });

  it("默认用时一位小数，展开里保留精确值", () => {
    expect(shortDuration(3200)).toBe("3.2 秒");
    expect(exactDuration(3200)).toBe("3.2 秒");
    expect(exactDuration(380)).toBe("380 毫秒");
  });
});
