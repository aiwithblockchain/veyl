import { Fragment, type ReactNode } from "react";

/**
 * 极简 Markdown：代码块、行内代码、加粗、无序列表、段落。
 * P1 不引入 markdown 依赖；需要表格/链接时再换 react-markdown（已列入依赖申请）。
 */
export function Markdown({ text }: { text: string }) {
  const blocks = splitFences(text);
  return (
    <>
      {blocks.map((block, index) =>
        block.type === "code" ? (
          <pre key={index} className="md-code">
            {block.lang ? <span className="md-code-lang">{block.lang}</span> : null}
            <code>{block.content}</code>
          </pre>
        ) : (
          <Fragment key={index}>{renderText(block.content)}</Fragment>
        ),
      )}
    </>
  );
}

type Block = { type: "text"; content: string } | { type: "code"; lang: string; content: string };

function splitFences(text: string): Block[] {
  const blocks: Block[] = [];
  const pattern = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      blocks.push({ type: "text", content: text.slice(cursor, match.index) });
    }
    blocks.push({ type: "code", lang: match[1], content: match[2].replace(/\n$/, "") });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    blocks.push({ type: "text", content: text.slice(cursor) });
  }
  return blocks;
}

function renderText(content: string): ReactNode {
  const paragraphs = content.split(/\n{2,}/).filter((p) => p.trim().length > 0);

  return paragraphs.map((paragraph, pIndex) => {
    const lines = paragraph.split("\n");

    if (lines.every((line) => line.trim().startsWith("- ") || line.trim() === "")) {
      return (
        <ul key={pIndex} className="md-list">
          {lines
            .filter((line) => line.trim().startsWith("- "))
            .map((line, lIndex) => (
              <li key={lIndex}>{renderInline(line.trim().slice(2))}</li>
            ))}
        </ul>
      );
    }

    return (
      <p key={pIndex}>
        {lines.map((line, lIndex) => (
          <Fragment key={lIndex}>
            {lIndex > 0 ? <br /> : null}
            {renderInline(line)}
          </Fragment>
        ))}
      </p>
    );
  });
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(
        <code key={nodes.length} className="md-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<strong key={nodes.length}>{token.slice(2, -2)}</strong>);
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
