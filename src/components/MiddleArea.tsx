import { useEffect, useRef, useState } from "react";
import { copyText } from "../ui/clipboard";
import type { MiddleBlock } from "../ui/middleArea";

type ProxyBlock = Extract<MiddleBlock, { kind: "proxy_card" }>;
type CopyState = "idle" | "copied" | "failed";

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
    <section
      className="console-card console-card--proxy"
      aria-label={block.connected ? "本机代理地址" : "预计地址"}
    >
      <h2 className="console-card__title">
        {block.connected ? "代理已经开好" : "连上后，这里会给你一个代理地址"}
      </h2>
      {block.systemProxyEnabled ? (
        <p className="console-card__note">浏览器已经设好了，其它软件按上面的地址填。</p>
      ) : null}
      <div className="console-card__field">
        <span className="console-card__label">
          {block.connected ? "本机代理地址" : "预计地址"}
        </span>
        <span className="console-card__address">
          <span className="num">{addressText}</span>
          {block.connected && block.address ? (
            <button type="button" className="console-card__copy" onClick={() => void runCopy()}>
              <span aria-live="polite">
                {copy === "copied" ? "已复制" : copy === "failed" ? "复制失败" : "复制"}
              </span>
            </button>
          ) : null}
        </span>
      </div>
      <p className="console-card__text">
        {block.connected
          ? "HTTP 和 SOCKS5 都支持，填同一个地址。"
          : "HTTP 和 SOCKS5 都支持，同一个地址。"}
      </p>
      <p className="console-card__foot">
        {block.connected ? "只在本机可用，别的设备连不上。" : "实际端口连上后确认；被占用会自动换。"}
      </p>
    </section>
  );
}

function IssueCard({ block }: { block: Extract<MiddleBlock, { kind: "issue_card" }> }) {
  return (
    <section className={`console-card console-card--issue is-${block.tone}`}>
      <h2 className="console-card__title">{block.title}</h2>
      <p className="console-card__text">{block.reason}</p>
      <p className="console-card__foot">{block.next}</p>
    </section>
  );
}

/** 中间区的块：一句话居中；有卡片时靠上排。块顺序由 middleBlocks 决定。 */
export function MiddleArea({ blocks }: { blocks: MiddleBlock[] }) {
  if (blocks.length === 0) return null;
  const stacked = blocks.some((block) => block.kind !== "empty_hint");
  return (
    <div className={stacked ? "console-mid__stack" : "console-mid__hint"}>
      {blocks.map((block, index) => {
        if (block.kind === "empty_hint") {
          return (
            <p key="empty_hint" className="console-hint">
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
