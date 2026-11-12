/**
 * 工具调用的用户语言映射。
 *
 * 默认视图只用这张表与后端 `display.text`；`call.tool` / `call.action`
 * 永远不出现在用户界面里，技术细节除外。
 * 工具名集合必须与 `docs/contracts/tools.md` §3 完全一致（测试有集合断言）。
 */

export type ChangedState = "none" | "restored" | "unknown";

export interface ToolFact {
  label: string;
  value: string;
}

/** events.md 2.11.0 的两个动作；未识别的 kind 直接丢弃。 */
export type DisplayActionKind = "reveal_report_dir" | "compose_report_mail";

export interface ToolDisplayAction {
  kind: DisplayActionKind;
  reportId: string;
}

export interface ToolDisplayInfo {
  text: string | null;
  facts: ToolFact[];
  changed: ChangedState | null;
  actions?: ToolDisplayAction[];
}

export interface ToolCopy {
  /** 进行中的一句话。 */
  running: string;
  /** 完成后的通用兜底；有 `display.text` 时以后端为准。 */
  done: string;
  /** 失败时的一行标题。 */
  failed: string;
  /** 没有 next_actions 时「现在能做什么」。 */
  advice: string;
  /** 只读工具失败时固定「没有改动」。 */
  readOnly: boolean;
}

export const FALLBACK_COPY: ToolCopy = {
  running: "正在处理…",
  done: "已完成",
  failed: "没成功",
  advice: "可以再试一次；还是不行就告诉我。",
  readOnly: false,
};

export const TOOL_COPY: Record<string, ToolCopy> = {
  RuntimeStatus: {
    running: "正在检查连接状态",
    done: "已查看连接状态",
    failed: "读不到连接状态",
    advice: "可以稍后再试一次。",
    readOnly: true,
  },
  RuntimeStart: {
    running: "正在启动后台运行库",
    done: "后台运行库已启动",
    failed: "没能启动后台运行库",
    advice: "可以再试一次。",
    readOnly: false,
  },
  RuntimeStop: {
    running: "正在停止后台运行库",
    done: "后台运行库已停止",
    failed: "没能停止后台运行库",
    advice: "可以再试一次。",
    readOnly: false,
  },
  RuntimeRestart: {
    running: "正在重启后台运行库",
    done: "后台运行库已重启",
    failed: "没能重启后台运行库",
    advice: "可以再试一次。",
    readOnly: false,
  },
  RuntimeLogs: {
    running: "正在取运行记录",
    done: "已取到运行记录",
    failed: "运行记录取不到",
    advice: "不影响正常使用，可以稍后再试。",
    readOnly: true,
  },
  CoreListVersions: {
    running: "正在查看运行库版本",
    done: "已查看运行库版本",
    failed: "读不到运行库版本",
    advice: "可以到设置里手动检查。",
    readOnly: true,
  },
  CoreUpgrade: {
    running: "正在检查运行库更新",
    done: "运行库已检查",
    failed: "没检查成运行库更新",
    advice: "可以到设置里手动检查更新。",
    readOnly: false,
  },
  CatalogSearch: {
    running: "正在找可用节点",
    done: "已查过可用节点",
    failed: "没能查到可用节点",
    advice: "可能是网络问题，可以再试一次。",
    readOnly: true,
  },
  ConfigList: {
    running: "正在看你的配置",
    done: "已查看你的配置",
    failed: "读不到你的配置",
    advice: "可以稍后再试一次。",
    readOnly: true,
  },
  ConfigDetail: {
    running: "正在看这套配置",
    done: "已查看这套配置",
    failed: "这套配置打不开",
    advice: "可以换一套配置再试。",
    readOnly: true,
  },
  ConfigCreate: {
    running: "正在新建配置",
    done: "已新建配置",
    failed: "没建成配置",
    advice: "可能是同名或信息不全，改一下再试。",
    readOnly: false,
  },
  ConfigUpdate: {
    running: "正在修改配置",
    done: "已更新配置",
    failed: "没改成配置",
    advice: "原设置不变，可以再试一次。",
    readOnly: false,
  },
  ConfigDelete: {
    running: "正在删除配置",
    done: "已删除配置",
    failed: "没删掉配置",
    advice: "这套配置可能正在使用，先换一套再删。",
    readOnly: false,
  },
  NodeImportUrl: {
    running: "正在从订阅导入节点",
    done: "已导入节点",
    failed: "没能导入节点",
    advice: "检查订阅地址是否可用后再试。",
    readOnly: false,
  },
  NodeImportText: {
    running: "正在导入节点",
    done: "已导入节点",
    failed: "没能导入节点",
    advice: "检查粘贴的内容是不是节点链接后再试。",
    readOnly: false,
  },
  NodeCreate: {
    running: "正在添加节点",
    done: "已添加节点",
    failed: "没添上节点",
    advice: "检查地址和端口后再试。",
    readOnly: false,
  },
  NodeSwitch: {
    running: "正在切换节点",
    done: "已切换节点",
    failed: "没切成功节点",
    advice: "还在原来节点，可以再试一次。",
    readOnly: false,
  },
  NodeProbe: {
    running: "正在测试这个节点",
    done: "已测试这个节点",
    failed: "这个节点连不上",
    advice: "超时或被拒绝，可以换一个节点。",
    readOnly: true,
  },
  VpnConnect: {
    running: "正在连接",
    done: "已连接",
    failed: "没能连上",
    advice: "可以换一个节点，或稍后再试。",
    readOnly: false,
  },
  VpnDisconnect: {
    running: "正在断开",
    done: "已断开，已恢复直连",
    failed: "没能断开",
    advice: "仍在连接，可以再试一次。",
    readOnly: false,
  },
  ProxyParams: {
    running: "正在读本机代理设置",
    done: "已读取本机代理设置",
    failed: "读不到本机代理设置",
    advice: "不影响连接，可以稍后再试。",
    readOnly: true,
  },
  ProbeRun: {
    running: "正在检查连接质量",
    done: "已检查连接质量",
    failed: "检查没跑完",
    advice: "已记录，可以稍后再试。",
    readOnly: false,
  },
  IssueList: {
    running: "正在看问题记录",
    done: "已查看问题记录",
    failed: "问题记录读不到",
    advice: "可以稍后再试一次。",
    readOnly: true,
  },
  IssueGet: {
    running: "正在看这条问题",
    done: "已拿到这条问题的信息",
    failed: "这条问题找不到",
    advice: "可能已被处理，刷新再看。",
    readOnly: true,
  },
  IssueHandoff: {
    running: "正在接手这个问题",
    done: "已接手这个问题",
    failed: "没能接手这个问题",
    advice: "可以再试一次。",
    readOnly: false,
  },
  IssueResolve: {
    running: "正在复查",
    done: "已复查",
    failed: "复查没通过",
    advice: "先不标记解决，可以再试一次。",
    readOnly: false,
  },
  IssueIgnore: {
    running: "正在忽略这条问题",
    done: "已忽略这条问题",
    failed: "没能忽略这条问题",
    advice: "可以再试一次。",
    readOnly: false,
  },
  DiagRun: {
    running: "正在做诊断",
    done: "诊断已完成",
    failed: "诊断没跑完",
    advice: "可以再试一次。",
    readOnly: true,
  },
  DeepseekSetupKey: {
    running: "正在准备开通步骤",
    done: "已给出开通步骤",
    failed: "没能给出开通步骤",
    advice: "可以再试一次。",
    readOnly: true,
  },
  DeepseekSaveKey: {
    running: "正在保存密钥",
    done: "密钥已保存",
    failed: "没能保存密钥",
    advice: "检查密钥是否有效后再试。",
    readOnly: false,
  },
  JobGet: {
    running: "正在查任务进度",
    done: "已查到任务进度",
    failed: "任务找不到",
    advice: "可能已经结束，刷新再看。",
    readOnly: true,
  },
  AskUserQuestion: {
    running: "正在等待回答",
    done: "已回答",
    failed: "没有回答",
    advice: "可以再问一次。",
    readOnly: true,
  },
  NetConfigGet: {
    running: "正在检查系统网络设置",
    done: "已检查系统网络设置",
    failed: "读不到系统网络设置",
    advice: "可以稍后再试一次。",
    readOnly: true,
  },
  NetRepair: {
    running: "正在恢复网络",
    done: "网络已恢复",
    failed: "没能恢复网络",
    advice: "可以再试一次。",
    readOnly: false,
  },
  CatalogRefresh: {
    running: "正在更新默认节点包",
    done: "已更新默认节点包",
    failed: "没能更新默认节点包",
    advice: "原来的还在，可以再试一次。",
    readOnly: false,
  },
  DefaultProfileStatus: {
    running: "正在看内置配置状态",
    done: "已查看内置配置状态",
    failed: "内置配置状态读不到",
    advice: "可以稍后再试一次。",
    readOnly: true,
  },
  RouteGet: {
    running: "正在看哪些软件走 VPN",
    done: "已查看哪些软件走 VPN",
    failed: "读不到直连范围",
    advice: "可以稍后再试一次。",
    readOnly: true,
  },
  RouteSetMode: {
    running: "正在切换走法",
    done: "已切换走法",
    failed: "没能切换走法",
    advice: "还是原来的走法，可以再试一次。",
    readOnly: false,
  },
  RouteTargetsSet: {
    running: "正在调整直连范围",
    done: "已调整直连范围",
    failed: "没能调整直连范围",
    advice: "可以再试一次。",
    readOnly: false,
  },
  RuleCustomList: {
    running: "正在看自定义直连",
    done: "已查看自定义直连",
    failed: "自定义直连读不到",
    advice: "可以稍后再试一次。",
    readOnly: true,
  },
  RuleCustomAdd: {
    running: "正在添加一条直连",
    done: "已添加一条直连",
    failed: "没能添加这条直连",
    advice: "可能已存在或格式不对，改一下再试。",
    readOnly: false,
  },
  RuleCustomDelete: {
    running: "正在删除一条直连",
    done: "已删除一条直连",
    failed: "没能删除这条直连",
    advice: "可能这条不存在，刷新再看。",
    readOnly: false,
  },
  CategoryList: {
    running: "正在看服务分类",
    done: "已查看服务分类",
    failed: "服务分类读不到",
    advice: "可以稍后再试一次。",
    readOnly: true,
  },
  RulesStatus: {
    running: "正在检查直连数据",
    done: "已检查直连数据",
    failed: "直连数据状态读不到",
    advice: "可以稍后再试一次。",
    readOnly: true,
  },
  RulesUpdate: {
    running: "正在更新直连数据",
    done: "已更新直连数据",
    failed: "没能更新直连数据",
    advice: "旧数据继续用，可以稍后再试。",
    readOnly: false,
  },
  IssueReport: {
    running: "正在整理问题报告",
    done: "问题报告已生成",
    failed: "问题报告没生成",
    advice: "可以再试一次；还是不行就先把日志留着。",
    readOnly: false,
  },
};

export const TOOL_NAMES = Object.keys(TOOL_COPY);

const warnedTools = new Set<string>();

export function toolCopy(tool: string): ToolCopy {
  const copy = TOOL_COPY[tool];
  if (copy) return copy;
  // 开发构建只提醒一次；原始工具名不是合法的兜底文案。
  if (import.meta.env.DEV && !warnedTools.has(tool)) {
    warnedTools.add(tool);
    console.warn(`[toolDisplay] 未映射的工具：${tool}`);
  }
  return FALLBACK_COPY;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function readChanged(value: unknown): ChangedState | null {
  if (value === true) return "unknown";
  if (value === false) return "none";
  if (typeof value !== "string") return null;
  switch (value.toLowerCase()) {
    case "none":
    case "no":
    case "unchanged":
    case "not_changed":
    case "false":
      return "none";
    case "restored":
    case "reverted":
    case "recovered":
    case "rolled_back":
      return "restored";
    case "unknown":
    case "maybe":
    case "unsure":
    case "true":
      return "unknown";
    default:
      return null;
  }
}

function readFact(raw: unknown): ToolFact | null {
  if (typeof raw === "string") {
    const value = raw.trim();
    return value ? { label: "", value } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const value =
    readText(record.value) ?? readText(record.text) ?? readText(record.body) ?? null;
  if (!value) return null;
  const label =
    readText(record.label) ?? readText(record.title) ?? readText(record.name) ?? "";
  return { label, value };
}

function readDisplayAction(raw: unknown): ToolDisplayAction | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  const reportId = readText(record.report_id);
  if (kind !== "reveal_report_dir" && kind !== "compose_report_mail") return null;
  if (!reportId) return null;
  return { kind, reportId };
}

/** 后端 `display` 缺失或字段不全时返回 null，界面静默回落到静态表。 */
export function readToolDisplay(raw: unknown): ToolDisplayInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const facts = Array.isArray(record.facts)
    ? record.facts
        .map(readFact)
        .filter((fact): fact is ToolFact => fact !== null)
        .slice(0, 4)
    : [];
  const actions = Array.isArray(record.actions)
    ? record.actions
        .map(readDisplayAction)
        .filter((action): action is ToolDisplayAction => action !== null)
        .slice(0, 2)
    : [];
  const text = readText(record.text);
  const changed = readChanged(record.changed);
  if (!text && facts.length === 0 && !changed && actions.length === 0) return null;
  return { text, facts, changed, actions };
}

const FACT_KEYS: Array<{
  pattern: RegExp;
  label: string;
  format?: (value: string) => string;
}> = [
  { pattern: /^(config|configuration)_name$/, label: "配置" },
  { pattern: /^node_name$/, label: "节点" },
  { pattern: /^(exit_ip|public_ip)$/, label: "出口" },
  {
    pattern: /^(latency_ms|delay_ms|node_latency_ms)$/,
    label: "延迟",
    format: (value) => `${value} 毫秒`,
  },
];

/** 只从参数里取名称与结果事实，绝不取 `config_id` / `node_id`。 */
export function factsFromArgs(
  args: Record<string, unknown> | undefined,
): ToolFact[] {
  if (!args) return [];
  const facts: ToolFact[] = [];
  for (const [key, raw] of Object.entries(args)) {
    const spec = FACT_KEYS.find((item) => item.pattern.test(key));
    if (!spec) continue;
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const text = String(raw).trim();
    if (!text) continue;
    facts.push({ label: spec.label, value: spec.format ? spec.format(text) : text });
    if (facts.length >= 4) break;
  }
  return facts;
}

export function changedLabel(changed: ChangedState | null, readOnly: boolean): string {
  if (changed === "none") return "没有改动任何设置";
  if (changed === "restored") return "已经恢复原样";
  if (changed === "unknown") return "不确定，诊断日志里有记录";
  return readOnly ? "没有改动任何设置" : "不确定，诊断日志里有记录";
}

/** 默认行只在 ≥3 秒时出现。 */
export function shortDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`;
}

/** 展开里始终显示精确值。 */
export function exactDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}

export const DURATION_THRESHOLD_MS = 3000;
