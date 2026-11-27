import { describe, expect, it } from "vitest";
import toolsDoc from "../../docs/contracts/tools.md?raw";
import envelopeSource from "../../src-tauri/src/tools/envelope.rs?raw";
import { setLanguage } from "../i18n";
import { en } from "../i18n/en";
import { zh } from "../i18n/zh";
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

function contractHeader(): { version: string | null; proposal: boolean } {
  const head = toolsDoc.split(/^## 0\. /m)[0] ?? "";
  return {
    version: head.match(/契约版本：`([^`]+)`/)?.[1] ?? null,
    proposal: /^>\s*状态：提案/m.test(head),
  };
}

/** 实现侧权威版本：Host 信封的 CONTRACT_VERSION（TS 侧同名常量是事件契约，不能比）。 */
function implContractVersion(): string | null {
  return (
    envelopeSource.match(/CONTRACT_VERSION:\s*&str\s*=\s*"([^"]+)"/)?.[1] ?? null
  );
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

describe("工具名映射集合", () => {
  it("提案期只校验版本与非空，定稿后完全相等", () => {
    const { version: docVersion, proposal } = contractHeader();
    const implVersion = implContractVersion();
    expect(
      docVersion,
      "未识别到契约头/版本（期望 `> 契约版本：`x.y.z``），请按模板写",
    ).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      implVersion,
      "envelope.rs 里未识别到 CONTRACT_VERSION，请按模板写",
    ).toMatch(/^\d+\.\d+\.\d+$/);
    if (!docVersion || !implVersion) return;

    if (docVersion === implVersion) {
      // 文档与实现同版本：不再看状态字样，严格比对。
      expect(new Set(contractToolNames())).toEqual(new Set(TOOL_NAMES));
    } else if (compareVersions(docVersion, implVersion) > 0) {
      // 文档超前实现：必须是声明过的提案，且只做格式 / 非空断言。
      expect(proposal, "文档版本高于实现时必须声明「状态：提案」").toBe(true);
      expect(contractToolNames().length).toBeGreaterThan(0);
      expect(TOOL_NAMES.length).toBeGreaterThan(0);
    } else {
      expect.fail(
        `契约文档 ${docVersion} 落后于实现 ${implVersion}：两边已脱节，请对齐版本`,
      );
    }
    // 新工具必须有文案，避免整表对上了却漏掉刚加的两条。
    expect(TOOL_NAMES).toEqual(
      expect.arrayContaining(["OpenSettings", "MyServerFailure", "NodeRotateCredentials"]),
    );
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
  it("按 key + params 组装事实行", () => {
    expect(
      readToolDisplay({
        facts: [
          { key: "runtime.exit_ip", params: { ip: "203.0.113.7" } },
          { key: "probe.latency_ms", params: { ms: 42 } },
        ],
        changed: "none",
      }),
    ).toEqual({
      facts: [
        { label: "", value: "出口：203.0.113.7" },
        { label: "", value: "延迟：42 ms", mono: true },
      ],
      changed: "none",
      actions: [],
    });
  });

  it("未知 key、未知枚举值、缺参数都丢行，不露占位符", () => {
    const display = readToolDisplay({
      facts: [
        { key: "unknown.fact" },
        { key: "job.state", params: { state: "bogus" } },
        { key: "probe.latency_ms" },
        { key: "server.stage", params: { stage: "installing" } },
      ],
      changed: "none",
    });

    expect(display?.facts).toEqual([{ label: "", value: "阶段：装环境" }]);
    expect(JSON.stringify(display)).not.toMatch(/\{\w+\}/);
  });

  it("server.row 拼 state / ip / destroyed", () => {
    const display = readToolDisplay({
      facts: [
        {
          key: "server.row",
          params: {
            name: "新加坡 1",
            region: "新加坡",
            state: "destroyed",
            destroyed: "billing_unpaid",
            ip: "1.2.3.4",
          },
        },
      ],
    });

    expect(display?.facts).toEqual([
      {
        label: "",
        value: "新加坡 1 · 新加坡 · 已停机删除 · 1.2.3.4 · 因余额不足停机删除",
      },
    ]);
  });

  it("server.row 的 gone 写「云服务商已删除」，不是「已开通」", () => {
    const display = readToolDisplay({
      facts: [
        {
          key: "server.row",
          params: { name: "悉尼", region: "澳大利亚", state: "gone" },
        },
      ],
    });

    expect(display?.facts).toEqual([
      { label: "", value: "悉尼 · 澳大利亚 · 云服务商已删除" },
    ]);
  });

  it("server.row 未知状态仍渲染，真正非法枚举才丢行", () => {
    const unknown = readToolDisplay({
      facts: [
        {
          key: "server.row",
          params: { name: "东京 1", region: "日本", state: "unknown", ip: "1.2.3.4" },
        },
      ],
    });
    expect(unknown?.facts[0].value).toBe("东京 1 · 日本 · 状态未知 · 1.2.3.4");

    const illegal = readToolDisplay({
      facts: [{ key: "server.row", params: { name: "东京 1", region: "日本", state: "weird" } }],
    });
    expect(illegal).toBeNull();
  });

  it("server.failure_code 已知码给原因，未知码给通用句", () => {
    const known = readToolDisplay({
      facts: [{ key: "server.failure_code", params: { code: "billing_unpaid" } }],
    });
    expect(known?.facts[0].value).toBe("原因：余额不足，服务器已停机删除。");

    const unknown = readToolDisplay({
      facts: [{ key: "server.failure_code", params: { code: "whatever" } }],
    });
    expect(unknown?.facts[0].value).toBe("这次建机没有完成");
  });

  it("mode.current 先翻枚举再套模板", () => {
    const display = readToolDisplay({
      facts: [{ key: "mode.current", params: { mode: "tun" } }],
    });
    expect(display?.facts[0].value).toBe("方式：Tun 模式");
  });

  it("diag.result 按 failed/skipped 选四句", () => {
    const value = (failed: number, skipped: number) =>
      readToolDisplay({ facts: [{ key: "diag.result", params: { failed, skipped } }] })
        ?.facts[0].value;

    expect(value(0, 0)).toBe("结果：全部检查正常");
    expect(value(2, 0)).toBe("结果：2 项异常");
    expect(value(0, 1)).toBe("结果：1 项这次没检查");
    expect(value(2, 1)).toBe("结果：2 项异常，1 项没检查");
  });

  it("deepseek.verify 未知值丢行", () => {
    expect(
      readToolDisplay({ facts: [{ key: "deepseek.verify", params: { result: "weird" } }] }),
    ).toBeNull();
    expect(
      readToolDisplay({ facts: [{ key: "deepseek.verify", params: { result: "invalid" } }] })
        ?.facts[0].value,
    ).toBe("验证：失败");
  });

  it("region.code 优先查地区表，查不到用 label", () => {
    expect(
      readToolDisplay({ facts: [{ key: "region.code", params: { code: "jp", label: "日本" } }] })
        ?.facts[0].value,
    ).toBe("地区 日本");
    expect(
      readToolDisplay({ facts: [{ key: "region.code", params: { code: "zz", label: "火星" } }] })
        ?.facts[0].value,
    ).toBe("地区 火星");
    expect(
      readToolDisplay({ facts: [{ key: "region.code", params: {} }] }),
    ).toBeNull();
  });

  it("region.code 与 region.name 并存时不串", () => {
    const display = readToolDisplay({
      facts: [
        { key: "region.code", params: { code: "jp" } },
        { key: "region.name", params: { name: "新加坡" } },
      ],
    });
    expect(display?.facts.map((fact) => fact.value)).toEqual(["地区 日本", "地区 新加坡"]);
  });

  it("routing.mode 三值映射，未知值丢行", () => {
    const value = (mode: string) =>
      readToolDisplay({ facts: [{ key: "routing.mode", params: { mode } }] })?.facts[0]
        .value;

    expect(value("direct")).toBe("当前：直连");
    expect(value("proxy_all")).toBe("当前：全部走 VPN");
    expect(value("proxy_selected")).toBe("当前：指定服务走 VPN");
    expect(value("weird")).toBeUndefined();
  });

  it("rules.status 三值映射，未知值丢行", () => {
    // 线上载荷的键是 state（后端 routing.rs 与 events.md 都这么发），不是 status。
    const value = (state: string) =>
      readToolDisplay({ facts: [{ key: "rules.status", params: { state } }] })?.facts[0]
        .value;

    expect(value("stale")).toBe("状态：可能已过期");
    expect(value("current")).toBe("状态：已是最新");
    expect(value("empty")).toBe("状态：还没有数据");
    expect(value("weird")).toBeUndefined();
  });

  it("rules.status 喂 status 键不渲染，钉死线上载荷格式", () => {
    expect(
      readToolDisplay({ facts: [{ key: "rules.status", params: { status: "stale" } }] }),
    ).toBeNull();
  });

  it("数字类事实标 mono，文本不标", () => {
    const display = readToolDisplay({
      facts: [
        { key: "catalog.node_count", params: { count: 3 } },
        { key: "catalog.region_count", params: { count: 2 } },
        { key: "http.status_code", params: { code: 200 } },
        { key: "config.name", params: { name: "公司" } },
      ],
    });
    expect(display?.facts.map((fact) => fact.mono ?? false)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(display?.facts[0].value).toBe("节点数：3");
    expect(display?.facts[1].value).toBe("地区 2 个");
  });

  it("英文界面事实行不含中文与占位符", () => {
    setLanguage("en");
    try {
      const display = readToolDisplay({
        facts: [
          { key: "config.name", params: { name: "Office" } },
          { key: "job.state", params: { state: "running" } },
          { key: "server.failure_code", params: { code: "install_failed" } },
          { key: "server.row", params: { name: "Tokyo", region: "JP", state: "active" } },
        ],
      });
      const text = JSON.stringify(display);
      expect(text).not.toMatch(/[一-龥]/);
      expect(text).not.toMatch(/\{\w+\}/);
    } finally {
      setLanguage("zh");
    }
  });

  it("只认两个报告动作，未知 kind 与空 id 丢弃，最多两个", () => {
    const display = readToolDisplay({
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
    expect(readToolDisplay({ facts: [], changed: "???" })).toBeNull();
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
      facts: Array.from({ length: 5 }, () => ({ key: "runtime.connected" })),
    });
    expect(display?.facts).toHaveLength(4);
  });
});

describe("tool.fact 字典", () => {
  it("每个 tool.fact.* key 在 zh 与 en 都存在", () => {
    const isFact = (key: string) => key.startsWith("tool.fact.");
    const zhKeys = Object.keys(zh).filter(isFact);
    const enKeys = Object.keys(en).filter(isFact);
    expect(zhKeys.length).toBeGreaterThan(0);
    expect(new Set(enKeys)).toEqual(new Set(zhKeys));
    for (const key of zhKeys) {
      expect(typeof (zh as Record<string, string>)[key], key).toBe("string");
      expect(typeof (en as Record<string, string>)[key], key).toBe("string");
    }
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
