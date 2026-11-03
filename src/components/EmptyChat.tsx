import type { RuntimeProfile, RuntimeAction } from "../agent/bridge";
import type { RuntimeView } from "../agent/protocol";
import { primaryAction } from "../ui/status";
import { Composer } from "./Composer";

interface Props {
  runtime: RuntimeView;
  profiles: RuntimeProfile[];
  hasKey: boolean;
  pending: RuntimeAction | null;
  hasEverConnected: boolean;
  defaultBusy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onUseDefault: () => void;
  onConfigureKey: () => void;
  onSend: (text: string) => void;
}

const SUGGESTIONS = ["为什么我打不开某个网站？", "检查我的网络配置"];

const CONNECTING_STATES = new Set<RuntimeView["state"]>(["starting", "restarting", "stopping"]);

/** 对话的空态：不是页面，只是还没有消息时的对话区。 */
export function EmptyChat({
  runtime,
  profiles,
  hasKey,
  pending,
  hasEverConnected,
  defaultBusy,
  onConnect,
  onDisconnect,
  onUseDefault,
  onConfigureKey,
  onSend,
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

  const stopping = runtime.state === "stopping";

  let headline: string;
  if (stopping) headline = "正在断开…";
  else if (runtime.state === "starting" || runtime.state === "restarting") {
    headline = "正在连接…";
  } else if (connected) headline = "已就绪，聊点什么";
  else if (failed) headline = "这次没连上";
  else headline = "先连上，再聊。";

  let detail: string;
  if (stopping) {
    detail = "正在恢复系统代理，稍等片刻。";
  } else if (runtime.state === "starting" || runtime.state === "restarting") {
    detail = "正在建立安全通道，不会改动系统代理。";
  } else if (connected) {
    detail = "需要换节点时，打开右上角的状态面板。";
  } else if (failed) {
    detail = "可以重试，或打开状态面板查看原因。";
  } else {
    detail = "用官方提供的节点，点一下就能用。";
  }

  const showSuggestions = !hasEverConnected && !stopping && !connecting;

  return (
    <div className="chat empty-chat">
      <div className="empty-chat__scroll">
        <div className="empty-chat__body">
          {hasEverConnected && !connected && !failed && !connecting ? (
            <p className="empty-chat__plain">问点什么，或者让我诊断网络</p>
          ) : (
            <>
              <h1 className="empty-chat__headline">{headline}</h1>
              <p className="empty-chat__detail">{detail}</p>

              {action.kind === "start" || action.kind === "default" ? (
                <button
                  type="button"
                  className="btn btn--primary empty-chat__primary"
                  onClick={runPrimary}
                  disabled={action.disabled}
                >
                  {noProfiles ? "连接到测试节点" : action.label}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--ghost empty-chat__primary"
                  onClick={runPrimary}
                  disabled={action.disabled}
                >
                  {action.label}
                </button>
              )}

              {showSuggestions ? (
                <div className="empty-chat__suggest">
                  <p className="empty-chat__suggest-label">或者问我：</p>
                  <ul>
                    {SUGGESTIONS.map((suggestion) => (
                      <li key={suggestion}>
                        <button type="button" onClick={() => onSend(suggestion)}>
                          · {suggestion}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      <Composer
        streaming={false}
        statusText={null}
        onSend={onSend}
        onStop={() => undefined}
        placeholder="告诉我要去哪儿，或者让我诊断网络问题"
        disabled={!hasKey}
        onConfigure={onConfigureKey}
      />
    </div>
  );
}
