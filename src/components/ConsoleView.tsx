import type {
  DefaultProfileStatus,
  RuntimeProfile,
  RuntimeAction,
} from "../agent/bridge";
import type { RuntimeView } from "../agent/protocol";
import { formatDate } from "../format";
import { primaryAction } from "../ui/status";
import { Composer } from "./Composer";

interface Props {
  runtime: RuntimeView;
  profiles: RuntimeProfile[];
  hasKey: boolean;
  pending: RuntimeAction | null;
  streaming: boolean;
  statusText: string | null;
  hasEverConnected: boolean;
  sessionCount: number;
  defaultProfile: DefaultProfileStatus | null;
  defaultBusy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onUseDefault: () => void;
  onRefreshDefault: () => void;
  onImport: () => void;
  onConfigureKey: () => void;
  onOpenDiagnosis: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
}

const SUGGESTIONS = [
  "连接到最快节点",
  "为什么我打不开某个网站？",
  "检查我的网络配置",
];

const CONNECTING_STATES = new Set<RuntimeView["state"]>(["starting", "restarting", "stopping"]);

export function ConsoleView({
  runtime,
  profiles,
  hasKey,
  pending,
  streaming,
  statusText,
  hasEverConnected,
  sessionCount,
  defaultProfile,
  defaultBusy,
  onConnect,
  onDisconnect,
  onUseDefault,
  onRefreshDefault,
  onImport,
  onConfigureKey,
  onOpenDiagnosis,
  onSend,
  onStop,
}: Props) {
  const noProfiles = profiles.length === 0;
  const connected = runtime.state === "running" || runtime.state === "degraded";
  const connecting = CONNECTING_STATES.has(runtime.state);
  const failed = runtime.state === "failed";

  const action = primaryAction({
    state: runtime.state,
    hasProfiles: !noProfiles,
    pending,
    defaultBusy,
  });

  const runPrimary = () => {
    if (action.kind === "default") onUseDefault();
    else if (action.kind === "stop") onDisconnect();
    else onConnect();
  };

  // 默认配置包连接时 profile 列表本来就是空的：不能因为「没有本地配置」
  // 就把已连接/连接中/失败的中性说明覆盖成「还没有可用的配置」。
  let headline: string;
  let detail: string;
  if (noProfiles) {
    if (runtime.state === "stopping") {
      headline = "正在断开";
      detail = "正在撤下系统代理。";
    } else if (connected) {
      headline = "Veyl 已就绪";
      detail = "正在使用官方测试节点；需要换节点时用右侧面板。";
    } else if (connecting) {
      headline = "正在准备测试节点";
      detail = "连接建立后就可以直接上网。";
    } else if (failed) {
      headline = "测试节点没有连上";
      detail = "可以重试，或导入自己的配置文件。";
    } else {
      headline = "还没有可用的配置";
      detail = "导入一份配置文件，或使用官方提供的测试节点。";
    }
  } else if (failed) {
    headline = "Veyl 已就绪";
    detail = "这次连接没有成功。可以重新连接，或用诊断查看原因。";
  } else if (runtime.state === "stopping") {
    headline = "Veyl 已就绪";
    detail = "正在断开连接。";
  } else if (connected) {
    headline = "Veyl 已就绪";
    detail = "需要换节点时用右侧面板。";
  } else if (connecting) {
    headline = "Veyl 已就绪";
    detail = "正在建立安全通道，不会改动系统代理。";
  } else if (hasEverConnected) {
    headline = "Veyl 已就绪";
    detail = "准备就绪，点一下连接。";
  } else {
    headline = "Veyl 已就绪";
    detail = "点一下连接到测试节点。";
  }

  const showSuggestions = !hasEverConnected && sessionCount === 0;

  return (
    <div className="console">
      <div className="console__scroll">
        <div className="console__card">
          <h1 className="console__headline">{headline}</h1>
          <p className="console__detail">{detail}</p>

          <div className="console__actions">
            <button
              type="button"
              className="btn btn--primary console__primary"
              onClick={runPrimary}
              disabled={action.disabled}
            >
              {action.label}
            </button>
            {noProfiles && !connecting && !connected ? (
              <button type="button" className="btn btn--ghost" onClick={onImport}>
                导入配置文件
              </button>
            ) : null}
            {failed ? (
              <button type="button" className="btn btn--ghost" onClick={onOpenDiagnosis}>
                诊断网络
              </button>
            ) : null}
          </div>

          {showSuggestions ? (
            <ul className="console__suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <li key={suggestion}>
                  <button type="button" onClick={() => onSend(suggestion)}>
                    · {suggestion}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <div className="console__default">
        <span className="console__default-label">默认配置</span>
        {defaultProfile?.version ? (
          <>
            <span className="num">v{defaultProfile.version}</span>
            <span className="console__default-meta">
              {defaultProfile.nodeCount} 个节点 · 更新于 {formatDate(defaultProfile.appliedAt)}
            </span>
          </>
        ) : (
          <span className="console__default-meta">未启用</span>
        )}
        {defaultProfile?.newVersionAvailable ? (
          <span className="console__badge">有新版本</span>
        ) : null}
        <button
          type="button"
          className="console__default-refresh"
          onClick={onRefreshDefault}
          disabled={defaultBusy}
        >
          {defaultBusy ? "检查中…" : "检查更新"}
        </button>
      </div>

      <Composer
        streaming={streaming}
        statusText={statusText}
        onSend={onSend}
        onStop={onStop}
        placeholder="告诉我要去哪儿，或者让我诊断网络问题"
        disabled={!hasKey}
        onConfigure={onConfigureKey}
      />
    </div>
  );
}
