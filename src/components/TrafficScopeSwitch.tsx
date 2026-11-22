import { useState } from "react";
import type { ConfigRouteMode } from "../agent/protocol";
import { t as translate, useT } from "../i18n";

interface Props {
  /** 当前配置的流量范围；旧数据的 proxy_selected 不显示开关。 */
  mode: ConfigRouteMode | null;
  /** 生效地区；null = 未知。 */
  region: string | null;
  /** 已连接时 AI 改了地区：说明行追加「地区已改，下次连接生效」。 */
  regionChanged?: boolean;
  connected: boolean;
  /** 连接中 / 断开中禁用，避免和建连抢状态。 */
  disabled?: boolean;
  onChange: (mode: "direct" | "proxy_all") => Promise<{ ok: boolean; message?: string }>;
}

function scopeNote(
  mode: "direct" | "proxy_all",
  region: string | null,
  connected: boolean,
): string {
  if (mode === "proxy_all") return translate("scope.note.global");
  if (!region) {
    return connected
      ? translate("scope.note.unknownConnected")
      : translate("scope.note.unknownDisconnected");
  }
  if (region === "cn") return translate("scope.note.cn");
  return translate("scope.note.other");
}

export function TrafficScopeSwitch({
  mode,
  region,
  regionChanged = false,
  connected,
  disabled = false,
  onChange,
}: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (mode !== "direct" && mode !== "proxy_all") return null;

  const switchTo = async (next: "direct" | "proxy_all") => {
    if (busy || disabled || next === mode) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onChange(next);
      if (!result.ok) {
        setError(result.message ?? t("stage.scopeFail"));
      }
    } finally {
      setBusy(false);
    }
  };

  const note = scopeNote(mode, region, connected);
  const suffix =
    !connected && !(mode === "direct" && !region)
      ? t("scope.suffix.afterConnect")
      : connected && regionChanged
        ? t("scope.suffix.regionChanged")
        : "";

  return (
    <div className="scope">
      <span className="scope__label">{t("stage.scopeAria")}</span>
      <div className="scope__switch" role="group" aria-label={t("stage.scopeAria")}>
        <button
          type="button"
          className={`scope__option ${mode === "direct" ? "is-selected" : ""}`}
          aria-pressed={mode === "direct"}
          aria-disabled={busy || disabled || undefined}
          disabled={busy || disabled}
          onClick={() => void switchTo("direct")}
        >
          {t("scope.smart")}
        </button>
        <button
          type="button"
          className={`scope__option ${mode === "proxy_all" ? "is-selected" : ""}`}
          aria-pressed={mode === "proxy_all"}
          aria-disabled={busy || disabled || undefined}
          disabled={busy || disabled}
          onClick={() => void switchTo("proxy_all")}
        >
          {t("scope.global")}
        </button>
      </div>
      <p
        className={`scope__note ${
          error ? "scope__note--error" : mode === "direct" && !region ? "scope__note--explain" : ""
        }`}
        role="status"
      >
        {error ?? `${note}${suffix}`}
      </p>
    </div>
  );
}
