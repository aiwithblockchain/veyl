import type { ConfigSummary } from "../agent/protocol";

/** 左栏里的级别提示词：不出现「一级 / 二级」这类标签。 */
export function levelLabel(
  config: Pick<ConfigSummary, "connect_mode" | "routing_mode">,
): string {
  if (config.connect_mode === "tun") return "全部软件";
  if (config.routing_mode === "proxy_selected") return "本机代理";
  return "浏览器";
}

/** 未连接时读数行的「方式」。 */
export function modeSummary(
  config: Pick<ConfigSummary, "connect_mode" | "routing_mode">,
): { value: string; sub: string } {
  if (config.connect_mode === "tun") {
    return { value: "接管全部软件", sub: "所有软件都走节点" };
  }
  if (config.routing_mode === "proxy_selected") {
    return { value: "本机代理", sub: "需要手动填地址" };
  }
  return { value: "浏览器代理", sub: "只影响浏览器" };
}

/** 未连接时读数行的「范围」。 */
export function scopeSummary(
  config: Pick<ConfigSummary, "connect_mode" | "routing_mode">,
): { value: string; sub: string } {
  switch (config.routing_mode) {
    case "proxy_all":
      return { value: "全部走节点", sub: "没有直连" };
    case "proxy_selected":
      return { value: "指定服务走节点", sub: "其余直连" };
    default:
      return { value: "本地网站直连", sub: "其它走节点" };
  }
}
