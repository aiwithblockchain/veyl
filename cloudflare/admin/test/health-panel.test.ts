import { describe, expect, it } from "vitest";

import type { ClientDocument, FetchLike } from "../src/client";
import { renderPage } from "../src/render";

// 一个够用的假 DOM：客户端只用 createElement / appendChild / after / remove /
// getAttribute / textContent / addEventListener，所以这里只实现这些。
class FakeEl {
  tagName: string;
  attributes: Record<string, string> = {};
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  className = "";
  disabled = false;
  type = "";
  colSpan = 1;
  title = "";
  private text = "";
  private listeners: Array<(event: { target: FakeEl }) => void> = [];

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get textContent(): string {
    if (this.children.length) return this.children.map((child) => child.textContent).join("");
    return this.text;
  }

  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  appendChild(child: FakeEl): FakeEl {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }

  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null;
  }

  addEventListener(_type: string, listener: (event: { target: FakeEl }) => void): void {
    this.listeners.push(listener);
  }

  remove(): void {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  after(node: FakeEl): void {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    parent.children.splice(index + 1, 0, node);
    node.parentNode = parent;
  }

  click(): void {
    for (const listener of this.listeners) listener({ target: this });
  }

  /** 事件委托挂在 table 上：在它这里派发，target 是被点的那颗按钮。 */
  clickOn(target: FakeEl): void {
    for (const listener of this.listeners) listener({ target });
  }
}

function page() {
  const table = new FakeEl("table");
  table.setAttribute("id", "servers");
  const tbody = new FakeEl("tbody");
  table.appendChild(tbody);
  const row = new FakeEl("tr");
  tbody.appendChild(row);
  const cell = new FakeEl("td");
  row.appendChild(cell);
  const button = new FakeEl("button");
  button.setAttribute("data-health", "");
  button.setAttribute("data-env", "prod");
  button.setAttribute("data-server", "srv_alpha");
  button.setAttribute("data-url", "https://203.0.113.7:32100/mcp");
  cell.appendChild(button);

  const doc = {
    getElementById: (id: string) => (id === "servers" ? table : null),
    createElement: (tag: string) => new FakeEl(tag),
  } as unknown as ClientDocument;

  return { doc, table, button };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const TICKET = { jwt: "tkt_value" };

function installer(status: unknown) {
  const nodeBody = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(status) }] },
  };
  const fakeFetch: FetchLike = async (url) => {
    if (url === "/ticket") return response(TICKET);
    return response(nodeBody);
  };
  return fakeFetch;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

/**
 * 页面里的脚本是 `${consoleClient.toString()}` 嵌进去的：它必须是自包含的，
 * 引用到模块里的任何标识符到了浏览器就是 undefined。所以测试直接从真正生成的
 * HTML 里把那段脚本抠出来跑，而不是直接调函数。
 */
function clientScript(): string {
  const html = renderPage({
    email: "ops@veyl.example",
    servers: [
      {
        id: "srv_alpha",
        name: "alpha",
        state: "active",
        agent_version: "0.1.7",
        ip: "203.0.113.7",
        control_port: 32100,
        cert_not_after: null,
        last_seen_at: null,
        provider_gone_at: null,
        failure_code: null,
        failure_stage: null,
        env: "prod",
      },
    ],
    now: Date.now(),
    nonce: "test-nonce",
    notes: [],
  });
  const open = html.indexOf("<script nonce=");
  return html.slice(html.indexOf(">", open) + 1, html.indexOf("</script>", open));
}

async function run(fakeFetch: FetchLike): Promise<{ text: string }> {
  const { doc, table, button } = page();
  const install = new Function("document", "fetch", clientScript()) as (
    doc: ClientDocument,
    fetchImpl: FetchLike,
  ) => void;
  install(doc, fakeFetch);
  table.clickOn(button);
  await flush();
  return { text: table.textContent };
}

const STATUS = {
  version: "0.1.9",
  uptime_secs: 90_000,
  now: 1_795_000_000,
  metering_attached: true,
  metering: {
    last_read_at: 1_794_999_880,
    observed: true,
    consecutive_read_failures: 0,
    pending_bytes: 4096,
  },
  cert_state: "current",
  cert: { not_after: 1_795_000_000 + 3 * 86_400 },
  health: {
    nft_read: { count: 2, last_error: "nft 读计数失败：permission denied", last_ok_at: 1_794_999_880 },
    report: { count: 0, last_ok_at: 1_794_999_982 },
  },
};

describe("查看健康面板", () => {
  it("成功：版本、uptime、证书、计量与健康行全部说人话", async () => {
    const { text } = await run(installer(STATUS));

    expect(text).toContain("节点健康");
    expect(text).toContain("0.1.9");
    expect(text).toContain("1 天 1 小时"); // 90000 秒
    expect(text).toContain("正常（统一根签发）");
    expect(text).toContain("剩余 3 天");

    // 计量区：不出现 observed / pending_bytes 之类的字段名。
    expect(text).toContain("最近读网卡");
    expect(text).toContain("2 分钟前"); // last_read_at = now - 120
    expect(text).toContain("本次进程已读到");
    expect(text).toContain("待上报");
    expect(text).toContain("4.0 KB（4,096 字节）");

    // 健康行是句子：失败带原文，正常带相对时间。
    expect(text).toContain("读网卡");
    expect(text).toContain("连续失败 2 次 · 最近错误：nft 读计数失败：permission denied");
    expect(text).toContain("上报控制面");
    expect(text).toContain("正常 · 18 秒前");

    // 面板里不再有任何手动执行的命令或复制入口。
    expect(text).not.toContain("复制");
    // 票不进页面文本。
    expect(text).not.toContain("tkt_value");

    // 原始字段名一个都不许当标签出现。
    for (const raw of [
      "nft_read",
      "report",
      "observed",
      "pending_bytes",
      "consecutive_read_failures",
      "count ",
    ]) {
      expect(text).not.toContain(raw);
    }
  });

  it("健康行：没有成功记录时不假装正常，空错误不写「最近错误」", async () => {
    const { text } = await run(
      installer({
        ...STATUS,
        health: {
          nft_read: { count: 3, last_error: "", last_ok_at: 0 },
          report: { count: 0, last_ok_at: 0 },
        },
      }),
    );

    expect(text).toContain("连续失败 3 次");
    expect(text).not.toContain("最近错误");
    expect(text).toContain("尚无成功记录");
    expect(text).not.toContain("正常 ·");
  });

  it("证书状态按人话显示，不再露出 current/legacy/stale/broken", async () => {
    const cases: Array<[string, string]> = [
      ["current", "正常（统一根签发）"],
      ["legacy", "旧的自签证书"],
      ["stale", "不是当前根签发（需要重签）"],
      ["broken", "证书或私钥损坏"],
    ];
    for (const [state, expected] of cases) {
      const { text } = await run(installer({ ...STATUS, cert_state: state }));
      expect(text).toContain(expected);
      expect(text).not.toContain(state);
    }
  });

  it("401：提示票被拒绝，而不是笼统的失败", async () => {
    const fakeFetch: FetchLike = async (url) =>
      url === "/ticket" ? response(TICKET) : response({ error: "unauthorized" }, 401);

    const { text } = await run(fakeFetch);

    expect(text).toContain("票被拒绝");
    expect(text).not.toContain("连不上节点");
  });

  it("网络错误：说明浏览器这一侧的常见原因，并提示可以重试", async () => {
    const fakeFetch: FetchLike = async (url) => {
      if (url === "/ticket") return response(TICKET);
      throw new Error("net down");
    };

    const { text } = await run(fakeFetch);

    expect(text).toContain("连不上节点");
    expect(text).toContain("根证书");
    // 命令行能通但页面失败时，根证书与「旧节点没有跨域」在 fetch 里是同一个 TypeError，文案不能二选一。
    expect(text).toContain("0.1.9");
    expect(text).toContain("跨域");
    expect(text).toContain("稍后重试");
    // 不给绕开浏览器的手动路径。
    expect(text).not.toContain("复制");
    expect(text).not.toContain("终端");
  });

  it("返回体异常：200 但不是 get_status 结构", async () => {
    const { text } = await run(async (url) =>
      url === "/ticket" ? response(TICKET) : response({ junk: true }),
    );

    expect(text).toContain("返回格式异常");
    expect(text).not.toContain("节点健康");
  });

  it("签不到票时报「无法签票」，不显示 CORS 那些猜测", async () => {
    const { text } = await run(async () =>
      response({ error: "未配置", code: "signing_key_missing" }, 503),
    );

    expect(text).toContain("无法签票");
    expect(text).toContain("signing_key_missing");
    expect(text).not.toContain("根证书");
  });
});
