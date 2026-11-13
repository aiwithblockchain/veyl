import type { ConfigSummary } from "../agent/protocol";

/** 左栏里的接管方式标签：只看 `connect_mode`，与流量范围无关。 */
export function levelLabel(
  config: Pick<ConfigSummary, "connect_mode">,
): string {
  return config.connect_mode === "tun" ? "TUN 模式" : "Proxy 模式";
}

/** 未连接时读数行的「方式」；流量范围只住在 hero 的开关里。 */
export function modeSummary(
  config: Pick<ConfigSummary, "connect_mode">,
): { value: string; sub: string } {
  if (config.connect_mode === "tun") {
    return { value: "TUN 模式", sub: "所有软件都走节点" };
  }
  return { value: "Proxy 模式", sub: "需要手动填地址" };
}

const REGION_LABELS: Record<string, string> = {
  cn: "中国大陆",
  hk: "中国香港",
  tw: "中国台湾",
  mo: "中国澳门",
  jp: "日本",
  us: "美国",
  sg: "新加坡",
  gb: "英国",
  de: "德国",
  fr: "法国",
  ca: "加拿大",
  au: "澳大利亚",
  kr: "韩国",
};

export function regionLabel(region: string | null): string {
  if (!region) return "未知";
  return REGION_LABELS[region] ?? region.toUpperCase();
}
