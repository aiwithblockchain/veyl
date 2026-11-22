import type { ConfigSummary } from "../agent/protocol";
import { t } from "../i18n";
import type { MessageKey } from "../i18n";

/** 左栏里的接管方式标签：只看 `connect_mode`，与流量范围无关。 */
export function levelLabel(
  config: Pick<ConfigSummary, "connect_mode">,
): string {
  return t(config.connect_mode === "tun" ? "stage.mode.tun" : "stage.mode.proxy");
}

/** 未连接时读数行的「方式」；流量范围只住在 hero 的开关里。 */
export function modeSummary(
  config: Pick<ConfigSummary, "connect_mode">,
): { value: string; sub: string } {
  if (config.connect_mode === "tun") {
    return { value: t("stage.mode.tun"), sub: t("labels.tun.sub") };
  }
  return { value: t("stage.mode.proxy"), sub: t("labels.proxy.sub") };
}

const REGION_KEYS: Record<string, MessageKey> = {
  cn: "labels.region.cn",
  hk: "labels.region.hk",
  tw: "labels.region.tw",
  mo: "labels.region.mo",
  jp: "labels.region.jp",
  us: "labels.region.us",
  sg: "labels.region.sg",
  gb: "labels.region.gb",
  de: "labels.region.de",
  fr: "labels.region.fr",
  ca: "labels.region.ca",
  au: "labels.region.au",
  kr: "labels.region.kr",
};

export function regionLabel(region: string | null): string {
  if (!region) return t("labels.region.unknown");
  const key = REGION_KEYS[region];
  return key ? t(key) : region.toUpperCase();
}
