import type { ConfigConnectMode, ConfigRouteMode } from "../agent/protocol";
import { t } from "../i18n";

/** 连接页两个 chip 的「问 AI」：把当前值和固定问题一起交给 AI。 */
export function modeScopePrompt(
  mode: ConfigConnectMode,
  scope: ConfigRouteMode | null,
): string {
  const modeLabel = t(mode === "tun" ? "stage.mode.tun" : "stage.mode.proxy");
  const scopeLabel = t(scope === "proxy_all" ? "stage.scope.global" : "stage.scope.smart");
  return t("advanced.modeScope", { mode: modeLabel, scope: scopeLabel });
}

/**
 * 「在其它设备上使用」弹层的「问 AI」：逐字固定（v4），只讲设备，不讲格式。
 * 改动等同于改产品文案，需走设计与 PM。
 */
export function mobileExportPrompt(): string {
  return t("advanced.mobileExport");
}
