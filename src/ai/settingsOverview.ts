import type { ConfigConnectMode, ConfigRouteMode, RuntimeState } from "../agent/protocol";
import type { TunHelperState } from "../agent/bridge";

/** 设置页「咨询 AI」用的快照：只收设置页拿得到的事实。 */
export interface SettingsOverviewSnapshot {
  connection: {
    connectMode: ConfigConnectMode | null;
    /** null = 还没读到配置，按智能处理。 */
    routingMode: ConfigRouteMode | null;
    /** Proxy 模式才有端口行；没有就整行不写。 */
    proxyPort?: number | null;
    /** 本次连接端口被占用而顺延；只有 Proxy 且真降级时非空。 */
    portFallback?: {
      requested: number;
      actual: number;
      reason: "occupied" | "unavailable";
    } | null;
    runtimeState: RuntimeState;
    /** 断开且系统里可能有残留代理：「清除残留代理」才写。 */
    cleanupProxyAvailable?: boolean;
    /** 有配置才写免费节点与节点导入。 */
    hasConfig?: boolean;
    seed?: {
      nodeCount: number;
      version: string | null;
      newVersionAvailable: boolean;
    } | null;
  };
  ai: {
    providers: Array<{
      name: string;
      model: string;
      baseUrl: string;
      hasKey: boolean;
      isActive: boolean;
    }>;
  };
  account: {
    loggedIn: boolean;
    email: string | null;
    balanceCents: number | null;
  };
  advanced: {
    includeDomains: boolean;
    appVersion: string | null;
    helper: { state: TunHelperState; version: string | null } | null;
  };
}

const RUNTIME_LABEL: Record<RuntimeState, string> = {
  idle: "未连接",
  starting: "正在连接",
  running: "已连接",
  degraded: "已连接（有异常）",
  restarting: "正在重启运行时",
  stopping: "正在断开",
  failed: "连接失败",
};

const HELPER_LABEL: Record<TunHelperState, string> = {
  running: "已是最新",
  not_running: "现在没在运行，连接时会自动启动",
  stale: "有更新，下次连接时自动完成",
  start_failed: "没有启动成功，连接「全部流量」时会再试一次",
  file_invalid: "文件校验失败，重新安装 Veyl 可以修复",
  unknown: "状态未知",
};

function connectionLines(snapshot: SettingsOverviewSnapshot["connection"]): string[] {
  const lines: string[] = [];
  if (snapshot.connectMode === "system_proxy") {
    lines.push("- 接管方式：Proxy 模式（默认）");
  } else if (snapshot.connectMode === "tun") {
    lines.push("- 接管方式：Tun 模式");
  }
  if (snapshot.connectMode !== null) {
    lines.push(
      snapshot.routingMode === "proxy_all"
        ? "- 流量范围：全局"
        : "- 流量范围：智能（默认）",
    );
  }
  if (snapshot.connectMode === "system_proxy" && snapshot.proxyPort != null) {
    const fallback = snapshot.portFallback;
    const reason =
      fallback?.reason === "unavailable" ? "这台机器绑不了这个端口" : "端口被占用";
    lines.push(
      fallback
        ? `- 本地代理端口：127.0.0.1:${snapshot.proxyPort}；这次连接顺延到 ${fallback.actual}（${reason}）`
        : `- 本地代理端口：127.0.0.1:${snapshot.proxyPort}`,
    );
  }
  lines.push(`- 当前连接：${RUNTIME_LABEL[snapshot.runtimeState]}`);
  if (snapshot.hasConfig && snapshot.seed) {
    const { nodeCount, version, newVersionAvailable } = snapshot.seed;
    const versionText = version ? `，包版本 ${version}` : "";
    lines.push(
      `- 免费节点：${nodeCount} 个${versionText}${newVersionAvailable ? "，有新版本可以更新" : ""}`,
    );
    lines.push("- 节点导入：可以添加自己的节点");
  }
  if (snapshot.cleanupProxyAvailable) {
    lines.push("- 清除残留代理：可用，断开后仍上不了网时用");
  }
  return lines;
}

function aiLines(snapshot: SettingsOverviewSnapshot["ai"]): string[] {
  if (snapshot.providers.length === 0) return [];
  const active =
    snapshot.providers.find((provider) => provider.isActive) ?? null;
  const lines: string[] = [];
  if (active) {
    const address = active.baseUrl || "官方地址";
    const key = active.hasKey ? "已保存 Key" : "没有 Key";
    lines.push(
      `- 当前服务：${active.name}（模型 ${active.model || "未填"}，${address}，${key}）`,
    );
  }
  lines.push(`- 服务总数：${snapshot.providers.length} 个`);
  return lines;
}

function accountLines(snapshot: SettingsOverviewSnapshot["account"]): string[] {
  if (!snapshot.loggedIn) return ["- 未登录"];
  const lines: string[] = [`- 已登录：${snapshot.email ?? "账号已登录"}`];
  if (snapshot.balanceCents != null) {
    lines.push(`- 余额：$${(snapshot.balanceCents / 100).toFixed(2)}`);
  }
  return lines;
}

function advancedLines(snapshot: SettingsOverviewSnapshot["advanced"]): string[] {
  const lines: string[] = [
    snapshot.includeDomains
      ? "- 域名写入报告：开"
      : "- 域名写入报告：关（默认）",
  ];
  if (snapshot.appVersion) lines.push(`- 版本：v${snapshot.appVersion}`);
  if (snapshot.helper) {
    const version =
      snapshot.helper.state === "running" && snapshot.helper.version
        ? `（${snapshot.helper.version}）`
        : "";
    lines.push(`- 后台组件：${HELPER_LABEL[snapshot.helper.state]}${version}`);
  }
  return lines;
}

/**
 * 设置页「咨询 AI」的开场提示词：先把当前设置原样列给 AI，再给解释要求。
 * 只写快照里真实存在的项；不存在的不写「无」。
 */
export function settingsOverviewPrompt(snapshot: SettingsOverviewSnapshot): string {
  const sections: string[] = [];
  const add = (title: string, lines: string[]) => {
    if (lines.length > 0) sections.push(`## ${title}\n${lines.join("\n")}`);
  };
  add("连接", connectionLines(snapshot.connection));
  add("AI", aiLines(snapshot.ai));
  add("账户", accountLines(snapshot.account));
  add("高级", advancedLines(snapshot.advanced));

  return `我在 Veyl 的设置页，想请你把这套配置跟我过一遍。下面是现在的设置：

${sections.join("\n\n")}

请这样帮我：
1. 先用一句话说清现在这套配置在做什么。
2. 再按上面的分区逐项解释：标了（默认）的一句带过，其余的说清楚它改变了什么、什么时候该改、改错会怎样。
3. 只讲上面真实存在的项，不要补充没写出来的设置，也不要给通用教程。`;
}
