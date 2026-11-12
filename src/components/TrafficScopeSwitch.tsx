import { useState } from "react";
import type { ConfigRouteMode } from "../agent/protocol";

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
  if (mode === "proxy_all") return "所有流量走 VPN。";
  if (!region) {
    return connected
      ? "没识别出你在哪个地区，现在所有网站都会走 VPN。"
      : "没识别出你在哪个地区，连接后所有网站都会走 VPN。";
  }
  if (region === "cn") return "国内网站直连，其它走 VPN。";
  return "本国网站直连，其它走 VPN。";
}

export function TrafficScopeSwitch({
  mode,
  region,
  regionChanged = false,
  connected,
  disabled = false,
  onChange,
}: Props) {
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
        setError(result.message ?? "没切成功，还是原来的范围。");
      }
    } finally {
      setBusy(false);
    }
  };

  const note = scopeNote(mode, region, connected);
  const suffix =
    !connected && !(mode === "direct" && !region)
      ? "连接后生效。"
      : connected && regionChanged
        ? "地区已改，下次连接生效。"
        : "";

  return (
    <div className="scope">
      <span className="scope__label">流量范围</span>
      <div className="scope__switch" role="group" aria-label="流量范围">
        <button
          type="button"
          className={`scope__option ${mode === "direct" ? "is-selected" : ""}`}
          aria-pressed={mode === "direct"}
          aria-disabled={busy || disabled || undefined}
          disabled={busy || disabled}
          onClick={() => void switchTo("direct")}
        >
          智能模式
        </button>
        <button
          type="button"
          className={`scope__option ${mode === "proxy_all" ? "is-selected" : ""}`}
          aria-pressed={mode === "proxy_all"}
          aria-disabled={busy || disabled || undefined}
          disabled={busy || disabled}
          onClick={() => void switchTo("proxy_all")}
        >
          全局模式
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
