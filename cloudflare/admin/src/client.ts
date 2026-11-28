// 第一屏的浏览器端逻辑：点「查看健康」→ 签一张只读票 → 浏览器直连节点调 get_status。
// 这段函数会被 toString() 原样嵌进页面（没有构建步骤），所以它必须是自包含的：
// 不引用模块里的任何其它标识符，只用形参与浏览器全局。
//
// 票只在内存里流转：签 → 放进这一条请求的 Authorization 头 → 丢弃。不写 localStorage、不进 URL。

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

// 这段代码只在浏览器里跑，Worker 侧只负责把它的源码嵌进页面。
// tsconfig 没有加载 DOM lib，所以这里声明它真正用到的那几个成员。
export interface ClientElement {
  tagName: string;
  className: string;
  textContent: string;
  parentNode: ClientElement | null;
  disabled: boolean;
  type: string;
  colSpan: number;
  title: string;
  appendChild(node: ClientElement): unknown;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: (event: ClientEvent) => void): void;
  after(node: ClientElement): void;
  remove(): void;
}

export interface ClientEvent {
  target: ClientElement | null;
}

export interface ClientDocument {
  getElementById(id: string): ClientElement | null;
  createElement(tag: string): ClientElement;
}

export function consoleClient(doc: ClientDocument, fetchImpl: FetchLike): void {
  const table = doc.getElementById("servers");
  if (!table) return;

  const TIMEOUT_MS = 7000;
  const BODY =
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_status","arguments":{}}}';

  type El = ClientElement & {
    _veylPanel?: El;
    _veylCurl?: string;
  };

  function make(tag: string, cls?: string): El {
    const node = doc.createElement(tag) as El;
    if (cls) node.className = cls;
    return node;
  }

  function pad(value: number): string {
    return value < 10 ? `0${value}` : String(value);
  }

  /** 从 target 往上找第一个满足条件的祖先（含自身），到 table 为止。 */
  function walk(node: ClientEvent["target"], hit: (el: El) => boolean): El | null {
    let current = (node as El | null) ?? null;
    while (current && current !== (table as El)) {
      if (typeof current.getAttribute === "function" && hit(current)) return current;
      current = (current.parentNode as El | null) ?? null;
    }
    return null;
  }

  function rel(unixNow: number, seconds: number | null): { text: string; missing: boolean } {
    if (!seconds) return { text: "—", missing: true };
    const diff = unixNow - seconds;
    if (diff < 0) return { text: "刚刚", missing: false };
    if (diff < 60) return { text: `${diff} 秒前`, missing: false };
    if (diff < 3600) return { text: `${Math.floor(diff / 60)} 分钟前`, missing: false };
    if (diff < 86400) return { text: `${Math.floor(diff / 3600)} 小时前`, missing: false };
    return { text: `${Math.floor(diff / 86400)} 天前`, missing: false };
  }

  /** 与表格里的证书列同一套规则：日期 + 剩余整天数，不足一天算已到期。 */
  function certLine(unixNow: number, seconds: number | null): { text: string; missing: boolean } {
    if (!seconds) return { text: "未签发", missing: true };
    const date = new Date(seconds * 1000);
    const stamp = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    const days = Math.floor((seconds * 1000 - unixNow * 1000) / 86_400_000);
    if (days <= 0) return { text: `${stamp} · 已到期`, missing: false };
    return { text: `${stamp} · 剩余 ${days} 天`, missing: false };
  }

  function uptime(seconds: number): string {
    if (seconds < 60) return `${seconds} 秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
    if (seconds < 86400) {
      return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
    }
    return `${Math.floor(seconds / 86400)} 天 ${Math.floor((seconds % 86400) / 3600)} 小时`;
  }

  function kv(parent: El, label: string, value: { text: string; missing: boolean }): void {
    const k = make("div", "k");
    k.textContent = label;
    const v = make("div", value.missing ? "v missing" : "v");
    v.textContent = value.text;
    parent.appendChild(k);
    parent.appendChild(v);
  }

  function copyButton(curl: string, primary?: boolean): El {
    const button = make("button", primary ? "btn btn-primary" : "btn");
    button.setAttribute("data-copy", "");
    button.type = "button";
    button.textContent = "复制 curl";
    button._veylCurl = curl;
    if (!curl) {
      button.disabled = true;
      button.title = "这台节点没有 IP 或控制端口";
    }
    return button;
  }

  /** 出错时也保留「复制 curl」：浏览器连不上不代表命令行连不上（通常是根证书没被信任）。 */
  function fail(box: El, title: string, detail: string, curl: string): void {
    box.textContent = "";
    const head = make("div", "panel-head");
    const heading = make("h2");
    heading.textContent = title;
    head.appendChild(heading);
    if (curl) head.appendChild(copyButton(curl));
    box.appendChild(head);
    const line = make("p", "err");
    line.textContent = detail;
    box.appendChild(line);
  }

  /**
   * 连不上时不要并列三种猜测：先让人用 curl 分清卡在哪一层，再按结果对号入座。
   * 浏览器连不上不代表命令行连不上，所以 curl 在这个状态下就是下一步——做成主按钮。
   */
  function failCauses(box: El, status: string, curl: string): void {
    box.textContent = "";
    const head = make("div", "panel-head");
    const heading = make("h2");
    heading.textContent = "连不上节点";
    head.appendChild(heading);
    if (curl) head.appendChild(copyButton(curl, true));
    box.appendChild(head);

    const line = make("p", "err");
    line.textContent = status;
    box.appendChild(line);

    const lead = make("p", "note");
    lead.textContent = "把这条 curl 复制到终端里跑一次，按结果判断卡在哪一层：";
    box.appendChild(lead);

    const outcomes: Array<[string, string]> = [
      [
        "拿到 JSON",
        "节点和票都没问题，问题在浏览器这一侧：可能是根证书未信任，也可能是节点版本低于 0.1.9（没有跨域）；仍失败就看控制台的具体报错",
      ],
      ["报证书错误", "根证书没装好，或装了但没设为信任"],
      ["连不上 / 超时", "节点不可达：端口、IP、机器状态都要看"],
    ];
    const list = make("ol", "causes");
    for (const [when, then] of outcomes) {
      const item = make("li");
      item.textContent = `${when} → ${then}`;
      list.appendChild(item);
    }
    box.appendChild(list);
  }

  interface StatusPayload {
    version?: unknown;
    uptime_secs?: unknown;
    now?: unknown;
    metering_attached?: unknown;
    metering?: unknown;
    cert_state?: unknown;
    cert?: unknown;
    health?: unknown;
  }

  function renderStatus(box: El, payload: StatusPayload, curl: string): void {
    box.textContent = "";
    const head = make("div", "panel-head");
    const heading = make("h2");
    heading.textContent = "节点健康";
    head.appendChild(heading);
    head.appendChild(copyButton(curl));
    box.appendChild(head);

    const unixNow = typeof payload.now === "number" ? payload.now : Math.floor(Date.now() / 1000);
    const grid = make("div", "kv");

    const version = typeof payload.version === "string" ? payload.version : "";
    kv(grid, "agent 版本", version ? { text: version, missing: false } : { text: "—", missing: true });

    const up = typeof payload.uptime_secs === "number" ? payload.uptime_secs : null;
    kv(grid, "uptime", up === null ? { text: "—", missing: true } : { text: uptime(up), missing: false });

    const certState = typeof payload.cert_state === "string" ? payload.cert_state : "";
    kv(grid, "证书状态", certState ? { text: certState, missing: false } : { text: "—", missing: true });

    const cert = (payload.cert ?? null) as { not_after?: unknown } | null;
    const notAfter = cert && typeof cert.not_after === "number" ? cert.not_after : null;
    kv(grid, "证书到期", certLine(unixNow, notAfter));

    if (!payload.metering_attached) {
      kv(grid, "计量", { text: "未接入", missing: true });
    } else if (!payload.metering || typeof payload.metering !== "object") {
      kv(grid, "计量", { text: "已接入，尚未读取", missing: true });
    } else {
      const m = payload.metering as {
        last_read_at?: unknown;
        observed?: unknown;
        consecutive_read_failures?: unknown;
        pending_bytes?: unknown;
      };
      kv(grid, "计量", { text: "已接入", missing: false });
      kv(
        grid,
        "最近读取",
        rel(unixNow, typeof m.last_read_at === "number" ? m.last_read_at : 0),
      );
      kv(grid, "observed", {
        text: typeof m.observed === "boolean" ? String(m.observed) : "—",
        missing: typeof m.observed !== "boolean",
      });
      kv(grid, "连续读取失败", {
        text: typeof m.consecutive_read_failures === "number" ? String(m.consecutive_read_failures) : "—",
        missing: typeof m.consecutive_read_failures !== "number",
      });
      kv(grid, "pending_bytes", {
        text: typeof m.pending_bytes === "number" ? String(m.pending_bytes) : "—",
        missing: typeof m.pending_bytes !== "number",
      });
    }

    const health = payload.health;
    if (health && typeof health === "object") {
      const entries = health as Record<string, { count?: unknown; last_ok_at?: unknown }>;
      for (const key of Object.keys(entries)) {
        const entry = entries[key] ?? {};
        const count = typeof entry.count === "number" ? entry.count : null;
        const seen = rel(unixNow, typeof entry.last_ok_at === "number" ? entry.last_ok_at : 0);
        const parts = [`count ${count === null ? "—" : count}`, `最近成功 ${seen.text}`];
        kv(grid, key, { text: parts.join(" · "), missing: count === null });
      }
    }

    box.appendChild(grid);
  }

  /** 从 MCP 的 tools/call 响应里取出 get_status 的那段 JSON 字符串。 */
  function parseStatus(text: string): StatusPayload {
    const outer = JSON.parse(text) as { result?: { content?: Array<{ text?: unknown }> } };
    const content = outer && outer.result && outer.result.content;
    const first = content && content[0];
    const inner = first && first.text;
    if (typeof inner !== "string") throw new Error("no text content");
    const payload = JSON.parse(inner) as StatusPayload;
    if (!payload || typeof payload !== "object") throw new Error("status is not an object");
    return payload;
  }

  function post(url: string, init: RequestInit): Promise<Response> {
    return fetchImpl(url, init);
  }

  function load(owner: El, button: El, env: string, id: string, target: string): void {
    if (owner._veylPanel) {
      owner._veylPanel.remove();
      owner._veylPanel = undefined;
    }
    const row = make("tr");
    const cell = make("td");
    cell.colSpan = 9;
    row.appendChild(cell);
    owner.after(row);
    owner._veylPanel = row;

    const box = make("div", "ticket");
    cell.appendChild(box);
    box.textContent = "连接中…";
    button.disabled = true;

    const ticket = post("/ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env, server_id: id }),
    })
      .then((response) =>
        response
          .json()
          .then(
            (body: unknown) => ({ status: response.status, ok: response.ok, body }),
            () => ({ status: response.status, ok: response.ok, body: null }),
          ),
      )
      .catch(() => null);

    ticket
      .then((issued) => {
        if (!issued) {
          fail(box, "无法签票", "签票请求没有完成，稍后重试。", "");
          return;
        }
        if (!issued.ok) {
          const code =
            issued.body && typeof (issued.body as { code?: unknown }).code === "string"
              ? (issued.body as { code: string }).code
              : `HTTP ${issued.status}`;
          fail(box, "无法签票", `签票接口返回 ${code}。`, "");
          return;
        }
        const jwt = (issued.body as { jwt?: unknown } | null)?.jwt;
        const curl = (issued.body as { curl?: unknown } | null)?.curl;
        const curlText = typeof curl === "string" ? curl : "";
        if (typeof jwt !== "string" || !jwt) {
          fail(box, "无法签票", "签票接口没有返回票。", curlText);
          return;
        }

        const controller = typeof AbortController === "function" ? new AbortController() : null;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (controller) controller.abort();
        }, TIMEOUT_MS);

        const init: RequestInit = {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${jwt}`,
          },
          body: BODY,
        };
        if (controller) init.signal = controller.signal;

        return post(target, init)
          .then(
            (response) => {
              clearTimeout(timer);
              return response.text().then((body) => ({ status: response.status, body }));
            },
            () => {
              clearTimeout(timer);
              return null;
            },
          )
          .then((reply) => {
            if (!reply) {
              failCauses(
                box,
                timedOut
                  ? `请求在 ${TIMEOUT_MS / 1000} 秒内没有完成。`
                  : "浏览器没有拿到响应（连接被拒绝或证书不被信任）。",
                curlText,
              );
              return;
            }
            if (reply.status === 401) {
              fail(box, "票被拒绝", "节点不认这张票：多半是它还没有拿到运维公钥，或票已过期。", curlText);
              return;
            }
            if (reply.status !== 200) {
              failCauses(box, `节点返回 HTTP ${reply.status}。`, curlText);
              return;
            }
            let payload: StatusPayload;
            try {
              payload = parseStatus(reply.body);
            } catch {
              fail(box, "返回格式异常", "节点回了 200，但内容不是 get_status 的结构。", curlText);
              return;
            }
            renderStatus(box, payload, curlText);
          });
      })
      .then(
        () => {
          button.disabled = false;
        },
        () => {
          button.disabled = false;
        },
      );
  }

  function copy(text: string, button: El): void {
    const done = (): void => {
      button.textContent = "已复制";
      setTimeout(() => {
        button.textContent = "复制 curl";
      }, 1500);
    };
    const nav = (typeof navigator !== "undefined" ? navigator : undefined) as
      | { clipboard?: { writeText(text: string): Promise<void> } }
      | undefined;
    const clipboard = nav ? nav.clipboard : undefined;
    if (clipboard && typeof clipboard.writeText === "function") {
      clipboard.writeText(text).then(done, () => {
        button.textContent = "复制失败";
        setTimeout(() => {
          button.textContent = "复制 curl";
        }, 1500);
      });
      return;
    }
    button.textContent = "复制失败";
    setTimeout(() => {
      button.textContent = "复制 curl";
    }, 1500);
  }

  table.addEventListener("click", (event) => {
    const copyTarget = walk(event.target, (el) => el.getAttribute("data-copy") !== null);
    if (copyTarget) {
      const curl = copyTarget._veylCurl ?? "";
      if (curl) copy(curl, copyTarget);
      return;
    }

    const button = walk(event.target, (el) => el.getAttribute("data-health") !== null);
    if (!button || button.disabled) return;
    const owner = walk(button, (el) => el.tagName === "TR");
    if (!owner) return;

    const env = button.getAttribute("data-env") ?? "";
    const id = button.getAttribute("data-server") ?? "";
    const target = button.getAttribute("data-url") ?? "";
    if (!env || !id || !target) return;
    load(owner, button, env, id, target);
  });
}
