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

/** 中间区那「一件事」：一句话、代理卡或失败/降级卡。块顺序由 middleBlocks 决定。 */
export function MiddleArea({ blocks }: { blocks: MiddleBlock[] }) {
  if (blocks.length === 0) return null;
  return (
    <div className="one-thing">
      {blocks.map((block, index) => {
        if (block.kind === "empty_hint") {
          return (
            <p key="empty_hint" className={`note note--${block.tone}`}>
              {block.text}
            </p>
          );
        }
        if (block.kind === "proxy_card") {
          return <ProxyCard key="proxy_card" block={block} />;
        }
        return <IssueCard key={`issue_${index}`} block={block} />;
      })}
    </div>
  );
}
