import { useEffect, useRef, useState } from "react";
import { copyText } from "../ui/clipboard";
import type { MiddleBlock } from "../ui/middleArea";

type ProxyBlock = Extract<MiddleBlock, { kind: "proxy_card" }>;
type IssueBlock = Extract<MiddleBlock, { kind: "issue_card" }>;
type CopyState = "idle" | "copied" | "failed";

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <rect
        x="5.5"
        y="5.5"
        width="7.5"
        height="7.5"
        rx="1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M10.2 5.5V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v4.9a1.4 1.4 0 0 0 1.4 1.4h1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function ProxyCard({ block }: { block: ProxyBlock }) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setCopy("idle");
  }, [block.address]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const runCopy = async () => {
    if (!block.address) return;
    const ok = await copyText(block.address);
    setCopy(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopy("idle"), 2000);
  };

  let addressText: string;
  if (block.address) addressText = block.address;
  else if (block.connected) addressText = "正在确认代理地址…";
  else addressText = "连上后显示";

  return (
    <div className="card card--proxy">
      <p className="card__title">
        {block.connected ? "代理已经开好" : "连上后，这里会给你一个代理地址"}
      </p>
      {block.systemProxyEnabled ? (
        <p className="card__action">浏览器已经设好了，其它软件按上面的地址填。</p>
      ) : null}
      <div className="proxy__row">
        <span className={`proxy__addr num ${block.address ? "" : "is-pending"}`}>
          {addressText}
        </span>
        {block.connected && block.address ? (
          <button type="button" className="copy-btn" onClick={() => void runCopy()}>
            <CopyIcon />
            <span aria-live="polite">
              {copy === "copied" ? "已复制" : copy === "failed" ? "复制失败" : "复制"}
            </span>
          </button>
        ) : null}
      </div>
      {block.fallback ? (
        <p className="card__action card__action--warn">
          {block.fallback.reason === "unavailable"
            ? `你设置的 ${block.fallback.requested} 用不了（需要管理员权限），这次用的是 ${block.fallback.actual}。`
            : `你设置的 ${block.fallback.requested} 被别的软件占用了，这次用的是 ${block.fallback.actual}。`}
        </p>
      ) : null}
      <p className="card__action">
        {block.connected
          ? "HTTP 和 SOCKS5 都支持，填同一个地址。只在本机可用，别的设备连不上。"
          : "HTTP 和 SOCKS5 都支持，同一个地址。实际端口连上后确认；被占用会自动换。"}
      </p>
    </div>
  );
}

function IssueCard({ block }: { block: IssueBlock }) {
  return (
    <div className={`card card--${block.tone === "failed" ? "err" : "warn"}`}>
      <p className="card__lead">{block.reason}</p>
      {block.steps.length > 0 ? (
        <div className="recovery">
          {block.steps.map((step, index) => (
            <div className="recovery__row" key={step.label}>
              <span className="recovery__num">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {block.next ? <p className="card__action">{block.next}</p> : null}
    </div>
  );
}

function SourceChoice({
  onUseSeedNodes,
  onUseOwnNodes,
}: {
  onUseSeedNodes?: () => void;
  onUseOwnNodes?: () => void;
}) {
  return (
    <div className="card card--choice">
      <p className="card__title">这套配置还没有节点，先选一种</p>
      <div className="choice">
        <button
          type="button"
          className="choice__option"
          onClick={onUseSeedNodes}
          disabled={!onUseSeedNodes}
        >
          <strong>用 Veyl 提供的测试节点（仅供试用）</strong>
          <small>从默认节点包里挑一台，先试试。</small>
        </button>
        <button
          type="button"
          className="choice__option"
          onClick={onUseOwnNodes}
          disabled={!onUseOwnNodes}
        >
          <strong>用我自己的节点</strong>
          <small>导入配置文件，或者自己填。</small>
        </button>
      </div>
    </div>
  );
}

function Reachability({
  targets,
  connected,
}: {
  targets: string[];
  connected: boolean;
}) {
  return (
    <div className="card card--reach">
      <p className="card__title">
        {connected ? "这些服务还没确认" : "连上后会确认这些能不能打开"}
      </p>
      <ul className="reach">
        {targets.map((target) => (
          <li key={target} className="reach__row">
            <span>{target}</span>
            <span className="reach__status">待确认</span>
          </li>
        ))}
      </ul>
      <p className="card__action">
        {connected
          ? "现在还没有检查结果。"
          : "连上之后逐个确认。"}
      </p>
    </div>
  );
}

function UpdateHint() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="card card--hint">
      <p className="card__title">默认节点包有新版本。</p>
      <p className="card__action">不影响当前连接，下次连接时生效。</p>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => setDismissed(true)}
      >
        稍后提醒
      </button>
    </div>
  );
}

/** 中间区那「一件事」：本地兜底块与 AI 布局块共用同一套渲染。 */
export function MiddleArea({
  blocks,
  onUseSeedNodes,
  onUseOwnNodes,
}: {
  blocks: MiddleBlock[];
  onUseSeedNodes?: () => void;
  onUseOwnNodes?: () => void;
}) {
  if (blocks.length === 0) return null;
  return (
    <div className="one-thing">
      {blocks.map((block, index) => {
        if (block.kind === "empty_hint") {
          return (
            <p key={`empty_hint_${index}`} className={`note note--${block.tone}`}>
              {block.text}
            </p>
          );
        }
        if (block.kind === "proxy_card") {
          return <ProxyCard key={`proxy_card_${index}`} block={block} />;
        }
        if (block.kind === "source_choice") {
          return (
            <SourceChoice
              key={`source_choice_${index}`}
              onUseSeedNodes={onUseSeedNodes}
              onUseOwnNodes={onUseOwnNodes}
            />
          );
        }
        if (block.kind === "reachability") {
          return (
            <Reachability
              key={`reachability_${index}`}
              targets={block.targets}
              connected={block.connected}
            />
          );
        }
        if (block.kind === "update_hint") {
          return <UpdateHint key={`update_hint_${index}`} />;
        }
        return <IssueCard key={`issue_${index}`} block={block} />;
      })}
    </div>
  );
}
