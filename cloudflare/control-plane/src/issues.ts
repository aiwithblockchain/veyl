// 问题墙（issue-report-api.md §3–§4）：用户主动上报 + 公开读取。
// 不做审核：提交即公开。答复与删除只由运营在 Cloudflare 侧直接改 D1，应用侧没有入口。

import { authenticate, bumpRateLimit, isResponse } from "./auth";
import { randomId, sha256B64u } from "./lib/crypto";
import { apiError, json, methodNotAllowed } from "./lib/http";
import { idempotencyKey } from "./lib/idempotency";

export interface IssueEnv {
  DB?: D1Database;
  TOKEN_SIGNING_JWK?: string;
  /** normal | closed；closed 只影响提交，公开读取不受影响。 */
  ISSUE_SUBMIT_MODE?: string;
  /** 官网站点地址（取其 origin），用于帖子链接与 CORS，不拿支付回跳地址推。 */
  PUBLIC_SITE_URL?: string;
}

const MAX_BODY_BYTES = 16 * 1024;
const SUBMIT_WINDOW_MS = 24 * 3600_000;
const ACCOUNT_SUBMIT_LIMIT = 10;
const DEVICE_SUBMIT_LIMIT = 5;
const IP_SUBMIT_LIMIT = 30;
const READ_WINDOW_MS = 60_000;
const READ_LIMIT = 60;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;
const DEFAULT_SITE_BASE = "https://veyl.dessage.xyz";

const PLATFORMS = ["macos", "windows", "linux"] as const;
const ARCHES = ["arm64", "x64"] as const;
const STAGES = ["connectivity", "config_update", "rotate", "ai"] as const;
const STEP_NAMES = ["connectivity", "config_update", "rotate"] as const;

interface Step {
  step: string;
  ok: boolean;
  duration_ms?: number;
  reason?: string;
}

interface Prepared {
  title: string;
  summary: string;
  expected: string;
  actual: string;
  repro: string;
  platform: string;
  appVersion: string;
  build: string;
  osVersion: string;
  arch: string;
  locale: string | null;
  stage: string;
  errorCode: string | null;
  steps: Step[];
  /** 只落进 body 供运营排查，不公开。 */
  server: Record<string, unknown> | null;
  serverId: string | null;
}

interface IssueRow {
  id: string;
  account_id: string;
  account_email_masked: string;
  device_id: string;
  server_id: string | null;
  idempotency_key: string;
  title: string;
  summary: string;
  body: string;
  platform: string;
  app_version: string;
  os_version: string | null;
  arch: string | null;
  stage: string;
  error_code: string | null;
  reply_count: number;
  last_activity_at: number;
  hidden_at: number | null;
  created_at: number;
  ip_prefix: string | null;
}

interface ReplyRow {
  author: string;
  body: string;
  created_at: number;
}

class Invalid extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function changesOf(result: unknown): number {
  return Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0);
}

function iso(at: number): string {
  return new Date(Number(at)).toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Invalid("INVALID_ARGUMENT", "invalid_field", `${field} 必须是对象`);
  }
  return value;
}

function rejectUnknown(
  object: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new Invalid("INVALID_ARGUMENT", "unknown_field", `${field} 不允许字段 ${key}`);
    }
  }
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") {
    throw new Invalid("INVALID_ARGUMENT", "invalid_field", `${field} 必须是字符串`);
  }
  const length = Array.from(value).length;
  if (length < min) {
    throw new Invalid("INVALID_ARGUMENT", "too_short", `${field} 太短`);
  }
  if (length > max) {
    throw new Invalid("INVALID_ARGUMENT", "too_long", `${field} 太长`);
  }
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined) return null;
  return text(value, field, 0, max);
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as never)) {
    throw new Invalid("INVALID_ARGUMENT", "invalid_field", `${field} 不合法`);
  }
  return value as T[number];
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Invalid("INVALID_ARGUMENT", "invalid_field", `${field} 不合法`);
  }
  return value;
}

function booleanAt(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Invalid("INVALID_ARGUMENT", "invalid_field", `${field} 必须是布尔值`);
  }
  return value;
}

function parseSteps(value: unknown): Step[] {
  if (!Array.isArray(value)) {
    throw new Invalid("INVALID_ARGUMENT", "invalid_field", "diagnosis.steps 必须是数组");
  }
  if (value.length > 3) {
    throw new Invalid("INVALID_ARGUMENT", "invalid_field", "diagnosis.steps 最多 3 条");
  }
  return value.map((raw, index) => {
    const field = `diagnosis.steps[${index}]`;
    const item = objectAt(raw, field);
    rejectUnknown(item, ["step", "ok", "duration_ms", "reason"], field);
    const step: Step = {
      step: oneOf(item.step, STEP_NAMES, `${field}.step`),
      ok: booleanAt(item.ok, `${field}.ok`),
    };
    if (item.duration_ms !== undefined) {
      step.duration_ms = integer(item.duration_ms, `${field}.duration_ms`, 0, 3600_000);
    }
    if (item.reason !== undefined) {
      step.reason = text(item.reason, `${field}.reason`, 1, 64);
    }
    return step;
  });
}

function parsePayload(raw: unknown): Prepared {
  const root = objectAt(raw, "请求体");
  rejectUnknown(root, ["report_version", "client", "diagnosis", "server", "server_id", "issue"], "请求体");

  if (root.report_version !== 1) {
    throw new Invalid("INVALID_ARGUMENT", "unsupported_version", "只支持 report_version = 1");
  }

  const client = objectAt(root.client, "client");
  rejectUnknown(
    client,
    ["app_version", "build", "platform", "os_version", "arch", "locale"],
    "client",
  );

  const diagnosis = objectAt(root.diagnosis, "diagnosis");
  rejectUnknown(diagnosis, ["session_id", "stage", "error_code", "steps"], "diagnosis");

  const issue = objectAt(root.issue, "issue");
  rejectUnknown(issue, ["title", "summary", "expected", "actual", "repro"], "issue");

  let server: Record<string, unknown> | null = null;
  if (root.server !== undefined) {
    const candidate = objectAt(root.server, "server");
    rejectUnknown(
      candidate,
      ["region", "created_at", "state", "node_port_in_band"],
      "server",
    );
    server = {
      region: text(candidate.region, "server.region", 1, 32),
      created_at: integer(candidate.created_at, "server.created_at", 0, 9_999_999_999_999),
      state: text(candidate.state, "server.state", 1, 32),
      node_port_in_band: booleanAt(candidate.node_port_in_band, "server.node_port_in_band"),
    };
  }

  const prepared: Prepared = {
    title: text(issue.title, "issue.title", 8, 120),
    summary: text(issue.summary, "issue.summary", 30, 2000),
    expected: text(issue.expected, "issue.expected", 1, 500),
    actual: text(issue.actual, "issue.actual", 1, 500),
    repro: text(issue.repro, "issue.repro", 1, 500),
    platform: oneOf(client.platform, PLATFORMS, "client.platform"),
    appVersion: text(client.app_version, "client.app_version", 1, 32),
    build: text(client.build, "client.build", 1, 32),
    osVersion: text(client.os_version, "client.os_version", 1, 32),
    arch: oneOf(client.arch, ARCHES, "client.arch"),
    locale: optionalText(client.locale, "client.locale", 16),
    stage: oneOf(diagnosis.stage, STAGES, "diagnosis.stage"),
    errorCode: optionalText(diagnosis.error_code, "diagnosis.error_code", 64),
    steps: parseSteps(diagnosis.steps),
    server,
    serverId: null,
  };

  text(diagnosis.session_id, "diagnosis.session_id", 1, 64);
  if (root.server_id !== undefined) {
    prepared.serverId = text(root.server_id, "server_id", 1, 64);
  }

  assertNoForbidden(prepared);
  return prepared;
}

const FORBIDDEN_RULES: Array<{ name: string; re: RegExp }> = [
  { name: "token", re: /\b(?:agt_|enr_)[A-Za-z0-9_-]{6,}\b/ },
  { name: "bearer", re: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/ },
  { name: "node_link", re: /\b(?:ss|vmess|vless|trojan):\/\//i },
  { name: "url_credentials", re: /\bhttps?:\/\/[^\s/@]+:[^\s/@]+@/i },
  { name: "password", re: /(?:password|passwd|密码)\s*[:=：]\s*\S+/i },
  { name: "hex32", re: /\b[0-9a-fA-F]{32}\b/ },
  { name: "ipv4", re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/ },
  { name: "ipv6_full", re: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/ },
  { name: "ipv6_compressed", re: /\b(?:[0-9a-fA-F]{1,4}:){1,7}:(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}\b/ },
  { name: "ipv6_leading", re: /\b::(?:[0-9a-fA-F]{1,4}:){0,7}[0-9a-fA-F]{1,4}\b/ },
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "phone", re: /\b(?:86[-\s]?)?1[3-9]\d{9}\b/ },
  { name: "path", re: /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/i },
  { name: "host", re: /\b(?:localhost|[A-Za-z0-9-]+\.(?:local|internal|lan|home|corp))\b/i },
  { name: "private_key", re: /BEGIN (?:[A-Z]+ )?PRIVATE KEY/i },
  { name: "certificate", re: /BEGIN CERTIFICATE/i },
];

function assertNoForbidden(prepared: Prepared): void {
  const haystack = [
    prepared.title,
    prepared.summary,
    prepared.expected,
    prepared.actual,
    prepared.repro,
    prepared.errorCode ?? "",
    prepared.locale ?? "",
    prepared.osVersion,
  ];
  for (const step of prepared.steps) {
    if (step.reason) haystack.push(step.reason);
  }

  for (const value of haystack) {
    for (const rule of FORBIDDEN_RULES) {
      if (rule.re.test(value)) {
        console.warn("issue.submit forbidden_content", { rule: rule.name });
        throw new Invalid(
          "INVALID_ARGUMENT",
          "forbidden_content",
          "内容里包含不能公开的信息，请删掉后重试",
        );
      }
    }
  }
}

/** 公开身份：本地部分首字符 + *** + 完整域名。 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}

function parseHextets(address: string): string[] | null {
  const separator = address.indexOf("::");
  const compressed = separator >= 0;
  const headRaw = compressed ? address.slice(0, separator) : address;
  const tailRaw = compressed ? address.slice(separator + 2) : "";
  const head = headRaw === "" ? [] : headRaw.split(":");
  const tail = tailRaw === "" ? [] : tailRaw.split(":");
  if (!compressed) {
    return head.length === 8 ? head : null;
  }
  // 只允许一个 `::`；第二个说明地址本身不合法。
  if (address.indexOf("::", separator + 1) >= 0) return null;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return null;
  return [...head, ...Array.from({ length: zeros }, () => "0"), ...tail];
}

function normaliseHextet(value: string): string | null {
  return /^[0-9a-fA-F]{1,4}$/.test(value) ? parseInt(value, 16).toString(16) : null;
}

/** 只保留网段前缀，不存完整 IP。IPv6 压缩写法必须先展开再取前三段。 */
export function ipPrefix(ip: string | null): string | null {
  if (!ip) return null;
  const address = ip.trim();
  if (address === "") return null;

  if (address.includes(":")) {
    const groups = parseHextets(address);
    if (!groups) return null;
    const first: string[] = [];
    for (const group of groups.slice(0, 3)) {
      const normalised = normaliseHextet(group);
      if (normalised === null) return null;
      first.push(normalised);
    }
    return `${first.join(":")}::/48`;
  }

  const parts = address.split(".");
  if (parts.length !== 4) return null;
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  return `${parts.slice(0, 3).join(".")}.0/24`;
}

export function siteBase(env: IssueEnv): string {
  const raw = env.PUBLIC_SITE_URL;
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      // 配置写坏时退回生产站点，不让链接变成空串。
    }
  }
  return DEFAULT_SITE_BASE;
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function rateLimited(retryAfterSeconds: number): Response {
  const response = apiError("RATE_LIMITED", "今天上报得有点多，明天再试；本地报告仍然可用", {
    status: 429,
    retryable: true,
    reason: "rate_limited",
  });
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return noStore(response);
}

/** 读取按分钟限流：不能沿用上报那句「明天再试」，Retry-After 也只该是 60 秒。 */
function readRateLimited(): Response {
  const response = apiError("RATE_LIMITED", "读取太频繁，请稍后再试", {
    status: 429,
    retryable: true,
    reason: "rate_limited",
  });
  response.headers.set("Retry-After", String(READ_WINDOW_MS / 1000));
  return noStore(response);
}

function serviceUnavailable(): Response {
  return noStore(
    apiError("INTERNAL", "服务还没准备好", { status: 503, retryable: true, reason: "db_missing" }),
  );
}

function submitResponse(env: IssueEnv, row: IssueRow, duplicate: boolean): Response {
  return noStore(
    json(
      {
        ok: true,
        issue_id: row.id,
        url: `${siteBase(env)}/issues.html?id=${row.id}`,
        app_version: row.app_version,
        created_at: iso(row.created_at),
        duplicate,
      },
      duplicate ? 200 : 201,
    ),
  );
}

async function submit(request: Request, env: IssueEnv): Promise<Response> {
  const db = env.DB;
  if (!db) return serviceUnavailable();

  const auth = await authenticate(request, {
    DB: env.DB,
    TOKEN_SIGNING_JWK: env.TOKEN_SIGNING_JWK,
  });
  if (isResponse(auth)) return auth;

  const emailRow = await db
    .prepare("SELECT email FROM accounts WHERE id = ?")
    .bind(auth.accountId)
    .first<{ email: string | null }>();
  const email = emailRow?.email;
  if (!email) {
    return noStore(
      apiError("FORBIDDEN", "请先登录邮箱账户再上报", {
        status: 403,
        reason: "not_logged_in",
      }),
    );
  }

  const key = idempotencyKey(request);
  if (!key) {
    throw new Invalid(
      "INVALID_ARGUMENT",
      "missing_idempotency_key",
      "缺少 Idempotency-Key 请求头",
    );
  }

  const existing = await db
    .prepare("SELECT * FROM issues WHERE account_id = ? AND idempotency_key = ?")
    .bind(auth.accountId, key)
    .first<IssueRow>();
  if (existing) {
    // 已被运营删除：软删除的行仍在，键仍被占用。既不能回一个指向 404 的「成功」链接，
    // 也不能借同键重试把删掉的内容复活。键由客户端按 (会话, 诊断) 派生、不含内容，
    // 所以只有重新发起一次诊断（换 diagnosis.session_id）才能拿到新键再提交。
    if (existing.hidden_at !== null) {
      console.warn("issue.submit.duplicate_removed", { issue_id: existing.id });
      return noStore(
        apiError("PRECONDITION_FAILED", "这条反馈已被删除，不能原样重复提交；如需再次反馈，请重新发起一次诊断后再提交", {
          status: 409,
          reason: "issue_removed",
        }),
      );
    }
    console.log("issue.submit.duplicate", { issue_id: existing.id });
    return submitResponse(env, existing, true);
  }

  if ((env.ISSUE_SUBMIT_MODE ?? "normal") === "closed") {
    console.log("issue.submit.closed");
    return noStore(json({ ok: false, reason: "issues_closed", retryable: true }, 503));
  }

  if (!(await bumpRateLimit(db, `issue:acct:${auth.accountId}`, ACCOUNT_SUBMIT_LIMIT, SUBMIT_WINDOW_MS))) {
    console.warn("issue.submit.rate_limited", { bucket: "account" });
    return rateLimited(3600);
  }
  if (!(await bumpRateLimit(db, `issue:device:${auth.deviceId}`, DEVICE_SUBMIT_LIMIT, SUBMIT_WINDOW_MS))) {
    console.warn("issue.submit.rate_limited", { bucket: "device" });
    return rateLimited(3600);
  }
  const prefix = ipPrefix(request.headers.get("cf-connecting-ip"));
  if (prefix && !(await bumpRateLimit(db, `issue:ip:${prefix}`, IP_SUBMIT_LIMIT, SUBMIT_WINDOW_MS))) {
    console.warn("issue.submit.rate_limited", { bucket: "ip" });
    return rateLimited(3600);
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    throw new Invalid("INVALID_ARGUMENT", "body_too_large", "请求体不能超过 16 KiB");
  }

  const rawText = await request.text();
  if (new TextEncoder().encode(rawText).length > MAX_BODY_BYTES) {
    throw new Invalid("INVALID_ARGUMENT", "body_too_large", "请求体不能超过 16 KiB");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new Invalid("INVALID_ARGUMENT", "invalid_json", "请求体不是合法 JSON");
  }

  const prepared = parsePayload(payload);

  if (prepared.serverId) {
    const owned = await db
      .prepare("SELECT id FROM servers WHERE id = ? AND account_id = ?")
      .bind(prepared.serverId, auth.accountId)
      .first<{ id: string }>();
    if (!owned) {
      throw new Invalid("INVALID_ARGUMENT", "invalid_server_id", "server_id 不属于当前账户");
    }
  }

  const now = Date.now();
  // randomId 的第二个参数是字节数：9 字节 → 12 个 base64url 字符（无填充），即 iss_<12>。
  const id = randomId("iss_", 9);
  const body = JSON.stringify({
    expected: prepared.expected,
    actual: prepared.actual,
    repro: prepared.repro,
    steps: prepared.steps,
    ...(prepared.server ? { server: prepared.server } : {}),
  });

  const inserted = await db
    .prepare(
      "INSERT OR IGNORE INTO issues (" +
        "id, account_id, account_email_masked, device_id, server_id, idempotency_key, " +
        "title, summary, body, platform, app_version, os_version, arch, stage, error_code, " +
        "reply_count, last_activity_at, created_at, ip_prefix" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
    )
    .bind(
      id,
      auth.accountId,
      maskEmail(email),
      auth.deviceId,
      prepared.serverId,
      key,
      prepared.title,
      prepared.summary,
      body,
      prepared.platform,
      prepared.appVersion,
      prepared.osVersion,
      prepared.arch,
      prepared.stage,
      prepared.errorCode,
      now,
      now,
      prefix,
    )
    .run();

  if (changesOf(inserted) !== 1) {
    const raced = await db
      .prepare("SELECT * FROM issues WHERE account_id = ? AND idempotency_key = ?")
      .bind(auth.accountId, key)
      .first<IssueRow>();
    if (raced) {
      if (raced.hidden_at !== null) {
        console.warn("issue.submit.duplicate_removed", { issue_id: raced.id });
        return noStore(
          apiError("PRECONDITION_FAILED", "这条反馈已被删除，不能原样重复提交；如需再次反馈，请重新发起一次诊断后再提交", {
            status: 409,
            reason: "issue_removed",
          }),
        );
      }
      console.log("issue.submit.duplicate", { issue_id: raced.id });
      return submitResponse(env, raced, true);
    }
    console.warn("issue.submit.insert_failed");
    return noStore(
      apiError("INTERNAL", "保存失败，请稍后重试", { retryable: true, reason: "insert_failed" }),
    );
  }

  console.log("issue.submit.ok", {
    issue_id: id,
    platform: prepared.platform,
    stage: prepared.stage,
    app_version: prepared.appVersion,
  });
  return submitResponse(
    env,
    {
      id,
      account_id: auth.accountId,
      account_email_masked: maskEmail(email),
      device_id: auth.deviceId,
      server_id: prepared.serverId,
      idempotency_key: key,
      title: prepared.title,
      summary: prepared.summary,
      body,
      platform: prepared.platform,
      app_version: prepared.appVersion,
      os_version: prepared.osVersion,
      arch: prepared.arch,
      stage: prepared.stage,
      error_code: prepared.errorCode,
      reply_count: 0,
      last_activity_at: now,
      hidden_at: null,
      created_at: now,
      ip_prefix: prefix,
    },
    false,
  );
}

interface Cursor {
  at: number;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return btoa(`${cursor.at}:${cursor.id}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeCursor(value: string): Cursor | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const separator = raw.indexOf(":");
    if (separator <= 0) return null;
    const at = Number(raw.slice(0, separator));
    const id = raw.slice(separator + 1);
    if (!Number.isFinite(at) || id === "") return null;
    return { at, id };
  } catch {
    return null;
  }
}

async function readAllowed(request: Request, db: D1Database): Promise<boolean> {
  // 读接口没有账户/设备身份可按。缺 CF-Connecting-IP 时落一个共享桶，而不是直接放行——
  // 否则不带这个头就能绕过读取限流。真实请求由 Cloudflare 保证这个头存在。
  const prefix = ipPrefix(request.headers.get("cf-connecting-ip")) ?? "unknown";
  return bumpRateLimit(db, `issue:read:${prefix}`, READ_LIMIT, READ_WINDOW_MS);
}

async function cachedJson(request: Request, payload: unknown): Promise<Response> {
  const text = JSON.stringify(payload, null, 2);
  const etag = `"${await sha256B64u(text)}"`;
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=60",
    etag,
    "x-content-type-options": "nosniff",
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(text, { status: 200, headers });
}

function publicIssue(row: IssueRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    platform: row.platform,
    app_version: row.app_version,
    os_version: row.os_version ?? null,
    email_masked: row.account_email_masked,
    reply_count: Number(row.reply_count ?? 0),
    created_at: iso(row.created_at),
    last_activity_at: iso(row.last_activity_at),
  };
}

function storedBody(row: IssueRow): { expected: string; actual: string; repro: string } {
  try {
    const parsed = JSON.parse(row.body) as Record<string, unknown>;
    return {
      expected: typeof parsed.expected === "string" ? parsed.expected : "",
      actual: typeof parsed.actual === "string" ? parsed.actual : "",
      repro: typeof parsed.repro === "string" ? parsed.repro : "",
    };
  } catch {
    return { expected: "", actual: "", repro: "" };
  }
}

async function list(request: Request, env: IssueEnv): Promise<Response> {
  const db = env.DB;
  if (!db) return serviceUnavailable();
  if (!(await readAllowed(request, db))) return readRateLimited();

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_PAGE;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE) {
      throw new Invalid("INVALID_ARGUMENT", "invalid_limit", "limit 必须是 1–50 的整数");
    }
    limit = parsed;
  }

  const platform = url.searchParams.get("platform");
  if (platform !== null && !PLATFORMS.includes(platform as never)) {
    throw new Invalid("INVALID_ARGUMENT", "invalid_platform", "platform 不合法");
  }
  const stage = url.searchParams.get("stage");
  if (stage !== null && !STAGES.includes(stage as never)) {
    throw new Invalid("INVALID_ARGUMENT", "invalid_stage", "stage 不合法");
  }
  const query = (url.searchParams.get("q") ?? "").trim();
  if (Array.from(query).length > 100) {
    throw new Invalid("INVALID_ARGUMENT", "invalid_query", "q 不能超过 100 字");
  }

  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
  if (rawCursor !== null && !cursor) {
    throw new Invalid("INVALID_ARGUMENT", "invalid_cursor", "cursor 不合法");
  }

  const rows = await db
    .prepare(
      "SELECT id, title, summary, platform, app_version, os_version, account_email_masked, " +
        "reply_count, created_at, last_activity_at FROM issues " +
        "WHERE hidden_at IS NULL " +
        "AND (? IS NULL OR platform = ?) " +
        "AND (? IS NULL OR stage = ?) " +
        "AND (? IS NULL OR title LIKE ? OR summary LIKE ?) " +
        "AND (? IS NULL OR last_activity_at < ? OR (last_activity_at = ? AND id < ?)) " +
        "ORDER BY last_activity_at DESC, id DESC LIMIT ?",
    )
    .bind(
      platform,
      platform,
      stage,
      stage,
      query === "" ? null : query,
      `%${query}%`,
      `%${query}%`,
      cursor ? cursor.at : null,
      cursor ? cursor.at : null,
      cursor ? cursor.at : null,
      cursor ? cursor.id : null,
      limit,
    )
    .all<IssueRow>();

  const issues = rows.results.map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    platform: row.platform,
    app_version: row.app_version,
    os_version: row.os_version ?? null,
    email_masked: row.account_email_masked,
    reply_count: Number(row.reply_count ?? 0),
    created_at: iso(row.created_at),
    last_activity_at: iso(row.last_activity_at),
  }));

  const last = rows.results.at(-1);
  const nextCursor =
    rows.results.length === limit && last
      ? encodeCursor({ at: Number(last.last_activity_at), id: last.id })
      : null;

  console.log("issue.list", { count: issues.length, limit, has_query: query !== "" });
  return cachedJson(request, { ok: true, issues, next_cursor: nextCursor });
}

async function detail(request: Request, env: IssueEnv, id: string): Promise<Response> {
  const db = env.DB;
  if (!db) return serviceUnavailable();
  if (!(await readAllowed(request, db))) return readRateLimited();

  const row = await db
    .prepare("SELECT * FROM issues WHERE id = ? AND hidden_at IS NULL")
    .bind(id)
    .first<IssueRow>();
  if (!row) {
    console.log("issue.detail.not_found", { issue_id: id });
    return noStore(apiError("NOT_FOUND", "这个问题不存在或已被删除"));
  }

  const replies = await db
    .prepare(
      "SELECT author, body, created_at FROM issue_replies " +
        "WHERE issue_id = ? AND hidden_at IS NULL ORDER BY created_at ASC",
    )
    .bind(id)
    .all<ReplyRow>();

  console.log("issue.detail", { issue_id: id, replies: replies.results.length });
  return cachedJson(request, {
    ok: true,
    issue: { ...publicIssue(row), ...storedBody(row) },
    replies: replies.results.map((reply) => ({
      author: reply.author,
      body: reply.body,
      created_at: iso(reply.created_at),
    })),
  });
}

export async function handleIssues(
  request: Request,
  env: IssueEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/issues" && !url.pathname.startsWith("/v1/issues/")) {
    return null;
  }

  // 公开 JSON 只允许官网站点跨域读取；同源页面不受影响。
  const finish = (response: Response): Response => {
    response.headers.set("access-control-allow-origin", siteBase(env));
    return response;
  };

  try {
    if (url.pathname === "/v1/issues") {
      if (request.method === "POST") return finish(await submit(request, env));
      if (request.method === "GET") return finish(await list(request, env));
      return finish(methodNotAllowed());
    }

    const id = url.pathname.slice("/v1/issues/".length);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      return finish(apiError("NOT_FOUND", "这个问题不存在或已被删除"));
    }
    if (request.method !== "GET") return finish(methodNotAllowed());
    return finish(await detail(request, env, id));
  } catch (error) {
    if (error instanceof Invalid) {
      return finish(
        noStore(
          apiError(error.code, error.message, { status: error.status, reason: error.reason }),
        ),
      );
    }
    throw error;
  }
}
