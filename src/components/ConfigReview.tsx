import type { ConfigConnectMode } from "../agent/protocol";
import { regionLabel } from "../ui/configLabels";

interface Props {
  connectMode: ConfigConnectMode;
  region: string | null;
  name: string;
  error: string | null;
  saving: boolean;
  /** 当前是否已经连着；决定主按钮是「创建配置」还是「创建并连接」。 */
  connected: boolean;
  /** config_create 仍报免费节点不可用：留在审视页，给重试与返回。 */
  seedProblem: boolean;
  onRetrySeed: () => void;
  onBack: () => void;
  onCancel: () => void;
  onSave: () => void;
}

const SEED_ERROR = [
  "没能取到免费节点。",
  "可能没联网，或免费节点服务暂时不可用。",
  "点「重试」；还是不行，就改选「其它节点」。",
];

function scopeCopy(region: string | null): { value: string; note: string } {
  if (!region) {
    return {
      value: "全局模式",
      note: "没识别出你在哪个地区，所以按全局模式创建；之后可以在控制台切换。",
    };
  }
  return {
    value: "智能模式",
    note:
      region === "cn"
        ? "国内网站直连，其它走 VPN。保存后可以在控制台随时切换。"
        : "本国网站直连，其它走 VPN。保存后可以在控制台随时切换。",
  };
}

export function ConfigReview({
  connectMode,
  region,
  name,
  error,
  saving,
  connected,
  seedProblem,
  onRetrySeed,
  onBack,
  onCancel,
  onSave,
}: Props) {
  const scope = scopeCopy(region);
  const saveLabel = saving
    ? "正在创建…"
    : connected
      ? "创建配置"
      : "创建并连接";

  return (
    <div className="new-config__review">
      <p className="new-config__intro">看一眼，没问题就创建。</p>

      <dl className="new-config__facts">
        <div className="new-config__fact">
          <dt>名称</dt>
          <dd>
            <span className="new-config__fact-value">{name}</span>
          </dd>
        </div>
        <div className="new-config__fact">
          <dt>接管方式</dt>
          <dd>
            <span className="new-config__fact-value">
              {connectMode === "tun"
                ? "TUN 模式（接管全部流量）"
                : "Proxy 模式（只给代理地址）"}
            </span>
            <span className="new-config__fact-note">
              {connectMode === "tun"
                ? "浏览器、聊天、游戏都走 VPN。"
                : "只让填了代理地址的软件走 VPN。"}
            </span>
          </dd>
        </div>
        <div className="new-config__fact">
          <dt>节点来源</dt>
          <dd>
            <span className="new-config__fact-value">Veyl 免费节点</span>
          </dd>
        </div>
        <div className="new-config__fact">
          <dt>流量范围</dt>
          <dd>
            <span className="new-config__fact-value">{scope.value}</span>
            <span className="new-config__fact-note">{scope.note}</span>
          </dd>
        </div>
        <div className="new-config__fact">
          <dt>地区</dt>
          <dd>
            <span className="new-config__fact-value">{regionLabel(region)}</span>
          </dd>
        </div>
      </dl>

      {seedProblem ? (
        <div className="new-config__seed-error" role="alert">
          {SEED_ERROR.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <div className="new-config__seed-actions">
            <button type="button" className="btn btn--ghost" disabled={saving} onClick={onRetrySeed}>
              重试
            </button>
            <button type="button" className="btn btn--ghost" disabled={saving} onClick={onBack}>
              返回上一步
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="new-config__error new-config__error--form" role="alert">
          {error}
        </p>
      ) : null}

      <div className="new-config__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={saving}>
          取消
        </button>
        <button type="button" className="btn btn--primary" onClick={onSave} disabled={saving}>
          {saveLabel}
        </button>
      </div>
    </div>
  );
}
