// 第一屏的纯展示层：单位换算、待处理判定、排序、HTML。没有任何 I/O，
// 这样测试可以直接拿 now 固定时间断言排序与缺失值渲染。
//
// 视觉规范见 cloudflare/admin/ui-tokens.md，色值一律取自那里的 token，不新增颜色。

import { consoleClient } from "./client";

/** 控制面 servers 表的字段。单位以 cloudflare/control-plane/src/servers.ts 为准：
 *  cert_not_after 是 unix 秒（certs.ts:224），last_seen_at 是毫秒（servers.ts:1713 Date.now()）。 */
export interface ServerRow {
  id: string;
  name: string;
  state: string;
  agent_version: string | null;
  ip: string | null;
  control_port: number | null;
  cert_not_after: number | null;
  last_seen_at: number | null;
  /** 非空 = DigitalOcean 那边已经查无此机（billing 巡检 404 后写的标记），毫秒。 */
  provider_gone_at: number | null;
  failure_code: string | null;
  failure_stage: string | null;
}

export type EnvName = "prod" | "dev";

export interface LabelledServer extends ServerRow {
  env: EnvName;
}

/** 待处理的五类，按严重程度从高到低。 */
export type Issue = "gone" | "failed" | "cert" | "stale" | "no_version";

const RANK: Record<Issue, number> = { gone: 4, failed: 3, cert: 2, stale: 1, no_version: 0 };

export const CERT_WARN_MS = 7 * 86_400_000;
export const STALE_MS = 24 * 3_600_000;

/** servers.state 的「失败」是 `error`；`failed` 是 orders 的状态，这里一并认，避免以后改口径漏判。 */
export function isFailed(state: string): boolean {
  return state === "error" || state === "failed";
}

export function issuesOf(server: LabelledServer, now: number): Issue[] {
  // DO 后台已删除：这是最强的信号，一台机器只算这一条——否则它还会同时算失联，
  // 横幅就成了「一台机器两条」，看不出实际有几台要处理。
  if (server.provider_gone_at !== null) return ["gone"];

  const issues: Issue[] = [];
  if (isFailed(server.state)) issues.push("failed");
  if (server.cert_not_after !== null && server.cert_not_after * 1000 <= now + CERT_WARN_MS) {
    issues.push("cert");
  }
  // 建机中的节点本来就还没有版本、也还没上报过，把它们算进「待处理」只会淹没真问题。
  // 证书与失败态不看 state，照常判。
  if (server.state === "active") {
    if (server.last_seen_at !== null && now - server.last_seen_at > STALE_MS) {
      issues.push("stale");
    }
    if (!server.agent_version || server.agent_version.trim() === "") {
      issues.push("no_version");
    }
  }
  return issues;
}

function primaryIssue(issues: Issue[]): Issue | null {
  let best: Issue | null = null;
  for (const issue of issues) {
    if (best === null || RANK[issue] > RANK[best]) best = issue;
  }
  return best;
}

/**
 * 需要处理的排最上面；同组按「最严重的那个问题」降序，再 prod 先于 dev，
 * 最后按名称、再按 id，保证同一次查询的输出稳定（测试依赖这个顺序）。
 */
export function sortServers(rows: LabelledServer[], now: number): LabelledServer[] {
  const keyed = rows.map((row) => {
    const issues = issuesOf(row, now);
    return { row, issues, rank: primaryIssue(issues) === null ? -1 : RANK[primaryIssue(issues)!] };
  });
  keyed.sort((a, b) => {
    const aNeed = a.issues.length > 0 ? 1 : 0;
    const bNeed = b.issues.length > 0 ? 1 : 0;
    if (aNeed !== bNeed) return bNeed - aNeed;
    if (a.rank !== b.rank) return b.rank - a.rank;
    if (a.row.env !== b.row.env) return a.row.env === "prod" ? -1 : 1;
    if (a.row.name !== b.row.name) return a.row.name < b.row.name ? -1 : 1;
    if (a.row.id !== b.row.id) return a.row.id < b.row.id ? -1 : 1;
    return 0;
  });
  return keyed.map((entry) => entry.row);
}

export interface Counts {
  attention: number;
  gone: number;
  failed: number;
  cert: number;
  stale: number;
  noVersion: number;
}

export function countIssues(rows: LabelledServer[], now: number): Counts {
  const counts: Counts = {
    attention: 0,
    gone: 0,
    failed: 0,
    cert: 0,
    stale: 0,
    noVersion: 0,
  };
  for (const row of rows) {
    const issues = issuesOf(row, now);
    if (issues.length > 0) counts.attention += 1;
    if (issues.includes("gone")) counts.gone += 1;
    if (issues.includes("failed")) counts.failed += 1;
    if (issues.includes("cert")) counts.cert += 1;
    if (issues.includes("stale")) counts.stale += 1;
    if (issues.includes("no_version")) counts.noVersion += 1;
  }
  return counts;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

const DAY_MS = 86_400_000;

export interface CertExpiry {
  text: string;
  missing: boolean;
  /** 剩余整天数；未签发时为 null。 */
  days: number | null;
  /** 剩余不足一天（含已过期）——展示成「已到期」，颜色按 danger。 */
  expired: boolean;
}

/**
 * 证书到期只显示日期（UTC）+ 剩余整天数。整个页面不加时区后缀，列头写 UTC。
 * 剩余天数向下取整，所以「还剩 12 小时」是 0 天，按已到期处理。
 */
export function formatCertExpiry(seconds: number | null, now: number): CertExpiry {
  if (seconds === null) return { text: "未签发", missing: true, days: null, expired: false };
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return { text: "未签发", missing: true, days: null, expired: false };
  }
  const stamp = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  const days = Math.floor((seconds * 1000 - now) / DAY_MS);
  if (days <= 0) return { text: `${stamp} · 已到期`, missing: false, days, expired: true };
  return { text: `${stamp} · 剩余 ${days} 天`, missing: false, days, expired: false };
}

export function formatLastSeen(ms: number | null, now: number): { text: string; missing: boolean } {
  if (ms === null) return { text: "—", missing: true };
  const diff = now - ms;
  if (diff < 0) return { text: "刚刚", missing: false };
  if (diff < 60_000) return { text: "刚刚", missing: false };
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return { text: `${minutes} 分钟前`, missing: false };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { text: `${hours} 小时前`, missing: false };
  return { text: `${Math.floor(hours / 24)} 天前`, missing: false };
}

export type ChipKind = "ok" | "warn" | "danger" | "neutral";

/**
 * 状态 chip 按 ui-tokens §4，只有「正常」和「失败」两档上色。
 * 建机中的状态（creating/booting/…）是过程不是异常，给中性 chip——
 * 用 warn 会让每一台新机器都像告警，淹没真正要处理的行。
 */
export function stateChip(state: string): { label: string; kind: ChipKind } {
  if (state === "active") return { label: state, kind: "ok" };
  if (isFailed(state)) return { label: state, kind: "danger" };
  return { label: state, kind: "neutral" };
}

export function formatAddress(server: ServerRow): { text: string; missing: boolean } {
  if (!server.ip || server.control_port === null) return { text: "—", missing: true };
  return { text: `${server.ip}:${server.control_port}`, missing: false };
}

const CSS = `
:root{
  --bg:#FAFAF8; --surface:#FFFFFF; --surface-sunken:#F4F4F1; --surface-danger:#F4ECEA;
  --border:rgba(20,22,28,.10); --border-strong:rgba(20,22,28,.18);
  --text-1:#14161C; --text-2:#5B5850; --text-3:#6E6A62; --text-missing:#6E6A62;
  --action-bg:#14161C; --action-bg-hover:#2A2D36;
  --focus:#E03A66;
  --state-ok-bg:#E6EEE9; --state-ok-text:#14613D;
  --state-warn-bg:#F2EEE4; --state-warn-text:#7A5100;
  --state-danger-bg:#F4ECEA; --state-danger-text:#8F2F26;
  --font-sans:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --font-mono:"SF Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text-1);font:400 14px/22px var(--font-sans);-webkit-font-smoothing:antialiased}
main{padding:32px}
h1{margin:0;font-size:15px;line-height:22px;font-weight:600}
.topbar{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:20px}
.who{display:flex;align-items:center;gap:12px;margin:0;font-size:12px;line-height:16px;font-weight:500;color:var(--text-2)}
.who strong{color:var(--text-1);font-weight:500}
.who a{color:var(--text-2);text-decoration:none}
.who a:hover{text-decoration:underline}
.banner{height:40px;display:flex;align-items:center;flex-wrap:wrap;padding:0 2px;font-size:14px;line-height:22px;
  color:var(--text-2);background:transparent;border-bottom:1px solid var(--border)}
.banner.warn{background:var(--state-warn-bg);color:var(--state-warn-text);border-bottom-color:var(--border-strong)}
.banner.danger{background:var(--state-danger-bg);color:var(--state-danger-text);border-bottom-color:var(--border-strong)}
.banner .sep{margin:0 8px;opacity:.55}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px;line-height:20px}
thead th{height:36px;padding:0 14px;text-align:left;font-size:12px;line-height:16px;font-weight:500;
  color:var(--text-2);background:var(--surface-sunken);border-bottom:1px solid var(--border-strong);white-space:nowrap}
tbody td{height:44px;padding:12px 14px;border-bottom:1px solid var(--border);vertical-align:middle;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
tbody tr.is-failed td{background:var(--surface-danger)}
.name{color:var(--text-1);font-weight:500}
.mono{font-family:var(--font-mono);font-size:12px;line-height:18px}
.id{color:var(--text-3)}
.dim{color:var(--text-2)}
.text3{color:var(--text-3)}
.missing{color:var(--text-missing)}
.num{font-variant-numeric:tabular-nums}
.warntext{color:var(--state-warn-text)}
.dangertext{color:var(--state-danger-text)}
.failnote{font-family:var(--font-mono);font-size:12px;line-height:18px;color:var(--text-3);margin-top:2px}
.chip{display:inline-block;height:20px;line-height:18px;padding:0 6px;border-radius:4px;font-size:12px;font-weight:500;
  border:1px solid transparent}
.chip-ok{background:var(--state-ok-bg);color:var(--state-ok-text)}
.chip-warn{background:var(--state-warn-bg);color:var(--state-warn-text)}
.chip-danger{background:var(--state-danger-bg);color:var(--state-danger-text)}
.chip-neutral{background:transparent;color:var(--text-2);border-color:var(--border)}
.chip-prod{background:rgba(20,22,28,.10);color:var(--text-1)}
.chip-dev{background:transparent;color:var(--text-2);border-color:var(--border)}
.btn{height:30px;padding:0 12px;border-radius:6px;background:var(--surface);border:1px solid var(--border-strong);
  color:var(--text-1);font:500 13px/28px var(--font-sans);cursor:pointer;transition:background-color 120ms}
.btn:hover:not(:disabled){background:var(--surface-sunken)}
.btn:disabled{background:rgba(20,22,28,.06);color:var(--text-3);cursor:default}
.btn:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.btn-primary{background:var(--action-bg);border-color:var(--action-bg);color:#fff}
.btn-primary:hover:not(:disabled){background:var(--action-bg-hover);border-color:var(--action-bg-hover)}
.btn-primary:disabled{background:rgba(20,22,28,.06);border-color:rgba(20,22,28,.06);color:var(--text-3)}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;font-size:12px;line-height:20px}
.kv .k{color:var(--text-2)}
.kv .v{color:var(--text-1);font-family:var(--font-mono);word-break:break-all}
.kv .v.missing{color:var(--text-missing)}
.causes{margin:6px 0 0;padding-left:18px;color:var(--text-2);font-size:12px;line-height:20px}
.note{margin:0;color:var(--text-2);font-size:13px;line-height:20px}
.ticket{background:var(--surface);border:1px solid var(--border-strong);border-radius:6px;padding:12px 14px}
.ticket h2{margin:0;font-size:12px;line-height:16px;font-weight:500;color:var(--text-2)}
.ticket .label{margin:10px 0 6px;font-size:12px;line-height:16px;font-weight:500;color:var(--text-2)}
.ticket .row{display:flex;align-items:flex-start;gap:8px}
.ticket textarea{flex:1;display:block;font-family:var(--font-mono);font-size:12px;line-height:18px;word-break:break-all;
  resize:none;background:var(--surface-sunken);border:1px solid var(--border);padding:10px;min-height:76px;
  color:var(--text-1);user-select:text}
.ticket .err{color:var(--state-danger-text);background:var(--state-danger-bg);font-size:13px;line-height:20px;padding:6px 10px;border-radius:4px}
`;

function bannerHtml(counts: Counts): string {
  if (counts.attention === 0) {
    return `<div class="banner">待处理 0 台</div>`;
  }
  const parts = [`待处理 ${counts.attention} 台`];
  if (counts.gone > 0) parts.push(`云服务商已删除 ${counts.gone}`);
  if (counts.failed > 0) parts.push(`失败 ${counts.failed}`);
  if (counts.cert > 0) parts.push(`证书 ${counts.cert}`);
  if (counts.stale > 0) parts.push(`失联 ${counts.stale}`);
  if (counts.noVersion > 0) parts.push(`无版本 ${counts.noVersion}`);
  const kind = counts.gone > 0 || counts.failed > 0 ? "danger" : "warn";
  return `<div class="banner ${kind}">${parts
    .map((part, index) => (index === 0 ? part : `<span class="sep">·</span>${part}`))
    .join("")}</div>`;
}

function rowHtml(server: LabelledServer, now: number): string {
  const issues = issuesOf(server, now);
  const primary = primaryIssue(issues);
  const failed = issues.includes("failed");
  const cert = formatCertExpiry(server.cert_not_after, now);
  const seen = formatLastSeen(server.last_seen_at, now);
  const address = formatAddress(server);
  const chip =
    server.provider_gone_at !== null
      ? { label: "云服务商已删除", kind: "danger" as ChipKind }
      : stateChip(server.state);
  const version = server.agent_version?.trim() ? server.agent_version.trim() : null;

  // §7.5/§7.6：一行最多一个彩色元素；失败行整行变底，其余单元格一律中性。
  const certClass = !failed && primary === "cert" ? (cert.expired ? " dangertext" : " warntext") : "";
  const seenClass = !failed && primary === "stale" ? " warntext" : "";

  const envChip = server.env === "prod" ? "chip-prod" : "chip-dev";
  const failNote =
    failed && (server.failure_code || server.failure_stage)
      ? `<div class="failnote">${escapeHtml(server.failure_code ?? "")}${
          server.failure_stage ? ` · ${escapeHtml(server.failure_stage)}` : ""
        }</div>`
      : "";

  const canTicket = Boolean(server.ip) && server.control_port !== null;
  const target = canTicket ? `https://${server.ip}:${server.control_port}/mcp` : "";
  const buttonDisabled = canTicket ? "" : ' disabled title="没有 IP 或控制端口，连不上节点"';
  const certCellClass = cert.missing ? "missing" : `text3${certClass}`;
  const seenCellClass = seen.missing ? "missing" : `dim${seenClass}`;

  return `<tr${failed ? ' class="is-failed"' : ""}>
  <td class="name">${escapeHtml(server.name)}</td>
  <td class="mono id">${escapeHtml(server.id)}</td>
  <td><span class="chip ${envChip}">${server.env}</span></td>
  <td><span class="chip chip-${chip.kind}">${escapeHtml(chip.label)}</span>${failNote}</td>
  <td class="mono ${version ? "dim" : "missing"}">${version ? escapeHtml(version) : "—"}</td>
  <td class="mono ${address.missing ? "missing" : "dim"}">${escapeHtml(address.text)}</td>
  <td class="num ${certCellClass}">${escapeHtml(cert.text)}</td>
  <td class="num ${seenCellClass}">${escapeHtml(seen.text)}</td>
  <td><button type="button" class="btn btn-primary" data-health data-env="${server.env}" data-server="${escapeHtml(
    server.id,
  )}" data-url="${escapeHtml(target)}"${buttonDisabled}>查看健康</button></td>
</tr>`;
}

export interface PageOptions {
  email: string;
  servers: LabelledServer[];
  now: number;
  nonce: string;
  /** 读库失败或未绑定时的说明，按环境列一条。 */
  notes: string[];
}

export function renderPage(options: PageOptions): string {
  const counts = countIssues(options.servers, options.now);
  const rows = sortServers(options.servers, options.now);
  const body = rows.length
    ? rows.map((server) => rowHtml(server, options.now)).join("\n")
    : `<tr><td colspan="9" class="note">没有未销毁的节点。</td></tr>`;
  const notes = options.notes.length
    ? `<p class="note">${options.notes.map((note) => escapeHtml(note)).join(" ")}</p>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veyl 节点</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <div class="topbar">
    <h1>Veyl 节点</h1>
    <p class="who"><span>已登录 <strong>${escapeHtml(options.email)}</strong></span><a href="/cdn-cgi/access/logout">退出</a></p>
  </div>
  ${bannerHtml(counts)}
  <div class="scroll">
  <table id="servers">
    <thead><tr>
      <th>名称</th><th>节点 ID</th><th>环境</th><th>状态</th><th>agent 版本</th><th>地址</th>
      <th>证书到期 (UTC)</th><th>最后上报</th><th>操作</th>
    </tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
  </div>
  ${notes}
</main>
<script nonce="${options.nonce}">
(${consoleClient.toString()})(document, function (url, init) { return fetch(url, init); });
</script>
</body>
</html>`;
}
