import { describe, expect, it } from "vitest";

import { route, type Env } from "../src/index";
import { ipPrefix } from "../src/issues";
import { signAccessToken } from "../src/lib/crypto";
import { assertSqlMatchesSchema } from "./helpers/schemaGuard";

const ACCOUNT = "acct_issue0000000000000000";
const DEVICE = "dev_issue00000000000000000";
const EMAIL = "wesley@gmail.com";

type Row = Record<string, unknown>;

function normalise(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 只覆盖 issues.ts 会发出的语句。与 mobile.test.ts 的 MobileD1 同口径：
 * 不复用 fakeD1.ts，避免为一个端点改到其它测试依赖的替身。
 */
class IssueD1 {
  accounts: Row[] = [];
  devices: Row[] = [];
  servers: Row[] = [];
  issues: Row[] = [];
  replies: Row[] = [];
  rateLimits = new Map<string, { window_start: number; count: number }>();

  prepare(sql: string): IssueStatement {
    return new IssueStatement(this, sql, []);
  }

  read(sqlRaw: string, a: unknown[]): Row | null {
    const sql = normalise(sqlRaw);
    if (sql.startsWith("select * from devices where id")) {
      return this.devices.find((device) => device.id === a[0]) ?? null;
    }
    if (sql.startsWith("select status, kind, merged_into from accounts")) {
      const account = this.accounts.find((row) => row.id === a[0]);
      return account
        ? { status: account.status, kind: account.kind, merged_into: account.merged_into ?? null }
        : null;
    }
    if (sql.startsWith("select email from accounts")) {
      const account = this.accounts.find((row) => row.id === a[0]);
      return account ? { email: account.email ?? null } : null;
    }
    if (sql.startsWith("select * from issues where account_id = ? and idempotency_key")) {
      return (
        this.issues.find(
          (issue) => issue.account_id === a[0] && issue.idempotency_key === a[1],
        ) ?? null
      );
    }
    if (sql.startsWith("select id from servers where id = ? and account_id")) {
      const server = this.servers.find((row) => row.id === a[0] && row.account_id === a[1]);
      return server ? { id: server.id } : null;
    }
    if (sql.startsWith("select * from issues where id = ? and hidden_at is null")) {
      return this.issues.find((issue) => issue.id === a[0] && issue.hidden_at == null) ?? null;
    }
    throw new Error(`IssueD1 未覆盖的读语句：${sqlRaw}`);
  }

  readAll(sqlRaw: string, a: unknown[]): Row[] {
    const sql = normalise(sqlRaw);
    if (sql.startsWith("select author, body, created_at from issue_replies")) {
      return this.replies
        .filter((reply) => reply.issue_id === a[0] && reply.hidden_at == null)
        .sort((left, right) => Number(left.created_at) - Number(right.created_at));
    }
    if (sql.startsWith("select id, title, summary, platform, app_version")) {
      const platform = a[0] == null ? null : String(a[0]);
      const stage = a[2] == null ? null : String(a[2]);
      const query = a[4] == null ? null : String(a[4]).toLowerCase();
      const cursorAt = a[7] == null ? null : Number(a[7]);
      const cursorId = a[10] == null ? null : String(a[10]);
      const limit = Number(a[11]);
      return this.issues
        .filter((issue) => issue.hidden_at == null)
        .filter((issue) => platform == null || issue.platform === platform)
        .filter((issue) => stage == null || issue.stage === stage)
        .filter(
          (issue) =>
            query == null ||
            String(issue.title).toLowerCase().includes(query) ||
            String(issue.summary).toLowerCase().includes(query),
        )
        .filter(
          (issue) =>
            cursorAt == null ||
            Number(issue.last_activity_at) < cursorAt ||
            (Number(issue.last_activity_at) === cursorAt && String(issue.id) < String(cursorId)),
        )
        .sort(
          (left, right) =>
            Number(right.last_activity_at) - Number(left.last_activity_at) ||
            String(right.id).localeCompare(String(left.id)),
        )
        .slice(0, limit);
    }
    throw new Error(`IssueD1 未覆盖的多行读语句：${sqlRaw}`);
  }

  write(sqlRaw: string, a: unknown[]): number {
    const sql = normalise(sqlRaw);
    assertSqlMatchesSchema(sql, a);

    if (sql.startsWith("update rate_limits set count = count + 1")) {
      const row = this.rateLimits.get(String(a[0]));
      if (row && row.window_start > Number(a[1]) && row.count < Number(a[2])) {
        row.count += 1;
        return 1;
      }
      return 0;
    }
    if (sql.startsWith("update rate_limits set window_start")) {
      const row = this.rateLimits.get(String(a[1]));
      if (row && row.window_start <= Number(a[2])) {
        row.window_start = Number(a[0]);
        row.count = 1;
        return 1;
      }
      return 0;
    }
    if (sql.startsWith("insert or ignore into rate_limits")) {
      if (this.rateLimits.has(String(a[0]))) return 0;
      this.rateLimits.set(String(a[0]), { window_start: Number(a[1]), count: 1 });
      return 1;
    }
    if (sql.startsWith("insert or ignore into issues")) {
      const exists = this.issues.some(
        (issue) => issue.account_id === a[1] && issue.idempotency_key === a[5],
      );
      if (exists) return 0;
      this.issues.push({
        id: a[0],
        account_id: a[1],
        account_email_masked: a[2],
        device_id: a[3],
        server_id: a[4] ?? null,
        idempotency_key: a[5],
        title: a[6],
        summary: a[7],
        body: a[8],
        platform: a[9],
        app_version: a[10],
        os_version: a[11] ?? null,
        arch: a[12] ?? null,
        stage: a[13],
        error_code: a[14] ?? null,
        reply_count: 0,
        last_activity_at: Number(a[15]),
        hidden_at: null,
        created_at: Number(a[16]),
        ip_prefix: a[17] ?? null,
      });
      return 1;
    }
    throw new Error(`IssueD1 未覆盖的写语句：${sqlRaw}`);
  }
}

class IssueStatement {
  constructor(
    private db: IssueD1,
    private sql: string,
    private args: unknown[],
  ) {}

  bind(...args: unknown[]): IssueStatement {
    return new IssueStatement(this.db, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    await Promise.resolve();
    return this.db.read(this.sql, this.args) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    await Promise.resolve();
    return { results: this.db.readAll(this.sql, this.args) as T[] };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    await Promise.resolve();
    return { success: true, meta: { changes: this.db.write(this.sql, this.args) } };
  }
}

async function signingJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

async function setup(
  account: { email?: string | null } = {},
): Promise<{ db: IssueD1; env: Env; token: string }> {
  const db = new IssueD1();
  const jwk = await signingJwk();
  db.accounts.push({
    id: ACCOUNT,
    kind: account.email === null ? "device" : "email",
    email: account.email === undefined ? EMAIL : account.email,
    status: "active",
    merged_into: null,
  });
  db.devices.push({
    id: DEVICE,
    account_id: ACCOUNT,
    secret_hash: "x",
    platform: "macos",
    app_version: "1.0.0",
    refresh_family: "rf_test",
    created_at: 0,
    last_seen_at: 0,
    revoked_at: null,
  });
  const now = Math.floor(Date.now() / 1000);
  const token = await signAccessToken(jwk, {
    sub: ACCOUNT,
    did: DEVICE,
    iat: now,
    exp: now + 600,
    jti: "jti_issue_test",
    kind: "email",
    amr: "email",
  });
  return {
    db,
    env: {
      ENVIRONMENT: "test",
      DB: db as unknown as D1Database,
      TOKEN_SIGNING_JWK: jwk,
      PUBLIC_SITE_URL: "https://veyl.dessage.xyz",
    },
    token,
  };
}

function validPayload(overrides: { issue?: Row; diagnosis?: Row; client?: Row; server?: Row | null } = {}) {
  return {
    report_version: 1,
    client: {
      app_version: "1.0.0",
      build: "2026.11.22",
      platform: "macos",
      os_version: "14.5",
      arch: "arm64",
      locale: "zh-CN",
      ...(overrides.client ?? {}),
    },
    diagnosis: {
      session_id: "diag_01J",
      stage: "rotate",
      error_code: "agent_timeout",
      steps: [
        { step: "connectivity", ok: true, duration_ms: 32 },
        { step: "config_update", ok: true },
        { step: "rotate", ok: false, reason: "agent_timeout" },
      ],
      ...(overrides.diagnosis ?? {}),
    },
    server:
      overrides.server === null
        ? undefined
        : {
            region: "sgp1",
            created_at: 1763800000000,
            state: "active",
            node_port_in_band: true,
            ...(overrides.server ?? {}),
          },
    issue: {
      title: "智能分析在重置端口这一步超时",
      summary: "节点连通正常，更新配置无变化；重置端口时 agent 在 90 秒内没有返回。",
      expected: "重置后自动重连并恢复",
      actual: "面板停在「正在重置」，90 秒后提示失败",
      repro: "连续两次触发智能分析",
      ...(overrides.issue ?? {}),
    },
  };
}

function submitRequest(
  token: string | null,
  body: unknown,
  options: { key?: string; ip?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": options.key ?? crypto.randomUUID(),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.ip) headers["cf-connecting-ip"] = options.ip;
  return new Request("https://cp.test/v1/issues", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("问题墙提交", () => {
  it("未登录时拒绝上报", async () => {
    const { env } = await setup();
    const response = await route(submitRequest(null, validPayload()), env);
    expect(response.status).toBe(401);
    expect((await bodyOf(response)).code).toBe("UNAUTHENTICATED");
  });

  it("邮箱为空的设备账户不能上报", async () => {
    const { env, token } = await setup({ email: null });
    const response = await route(submitRequest(token, validPayload()), env);
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).details).toMatchObject({ reason: "not_logged_in" });
  });

  it("上报成功后公开列表与详情可见，且只暴露脱敏邮箱与版本号", async () => {
    const { env, token } = await setup();
    const created = await route(submitRequest(token, validPayload()), env);
    expect(created.status).toBe(201);
    const createdBody = await bodyOf(created);
    expect(createdBody.ok).toBe(true);
    expect(String(createdBody.issue_id)).toMatch(/^iss_[A-Za-z0-9_-]{12}$/);
    expect(String(createdBody.url)).toContain("/issues.html?id=iss_");
    expect(createdBody.app_version).toBe("1.0.0");

    const listResponse = await route(new Request("https://cp.test/v1/issues"), env);
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get("cache-control")).toContain("max-age=60");
    expect(listResponse.headers.get("access-control-allow-origin")).toBe(
      "https://veyl.dessage.xyz",
    );
    const listBody = await bodyOf(listResponse);
    const issues = listBody.issues as Row[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      title: "智能分析在重置端口这一步超时",
      platform: "macos",
      app_version: "1.0.0",
      os_version: "14.5",
      email_masked: "w***@gmail.com",
      reply_count: 0,
    });
    expect(issues[0]).not.toHaveProperty("account_id");
    expect(issues[0]).not.toHaveProperty("device_id");
    expect(issues[0]).not.toHaveProperty("server_id");
    expect(issues[0]).not.toHaveProperty("ip_prefix");

    const detailResponse = await route(
      new Request(`https://cp.test/v1/issues/${String(createdBody.issue_id)}`),
      env,
    );
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.headers.get("access-control-allow-origin")).toBe(
      "https://veyl.dessage.xyz",
    );
    const detailBody = await bodyOf(detailResponse);
    expect(detailBody.issue).toMatchObject({
      id: createdBody.issue_id,
      app_version: "1.0.0",
      os_version: "14.5",
      email_masked: "w***@gmail.com",
      expected: "重置后自动重连并恢复",
      actual: "面板停在「正在重置」，90 秒后提示失败",
      repro: "连续两次触发智能分析",
    });
    expect(detailBody.issue).not.toHaveProperty("body");
    expect(detailBody.issue).not.toHaveProperty("steps");
  });

  it("同一 Idempotency-Key 重复提交只产生一条记录", async () => {
    const { env, token } = await setup();
    const key = "8f1f6f4e-6a5f-4f0d-9a6e-2b7a3c5d1e2f";
    const first = await route(submitRequest(token, validPayload(), { key }), env);
    expect(first.status).toBe(201);
    const second = await route(submitRequest(token, validPayload(), { key }), env);
    expect(second.status).toBe(200);
    const secondBody = await bodyOf(second);
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.issue_id).toBe((await bodyOf(first)).issue_id);

    const list = await bodyOf(await route(new Request("https://cp.test/v1/issues"), env));
    expect((list.issues as Row[]).length).toBe(1);
  });

  it("已被删除的帖子同键重试返回 409，不复活也不给死链", async () => {
    const { db, env, token } = await setup();
    const key = "6d0c2b1a-3f4e-4a5b-8c9d-0e1f2a3b4c5d";
    const created = await bodyOf(
      await route(submitRequest(token, validPayload(), { key }), env),
    );
    const row = db.issues.find((issue) => issue.id === created.issue_id);
    if (!row) throw new Error("测试数据缺失");
    row.hidden_at = Date.now();

    const retry = await route(submitRequest(token, validPayload(), { key }), env);
    expect(retry.status).toBe(409);
    const retryBody = await bodyOf(retry);
    expect(retryBody.code).toBe("PRECONDITION_FAILED");
    expect(retryBody.retryable).toBe(false);
    expect(retryBody.details).toMatchObject({ reason: "issue_removed" });
    expect(retryBody).not.toHaveProperty("issue_id");
    expect(retryBody).not.toHaveProperty("url");
    expect(db.issues).toHaveLength(1);
  });

  it.each([
    ["agt_", "令牌", { summary: "错误码里出现了 agt_abcdef1234567890，请帮我看一下这个问题。" }],
    ["ss://", "节点链接", { summary: "我导入的是 ss://YWVzLTI1Ni1nY206cGFzcw== 这个链接，连接失败。" }],
    ["完整 IP", "IP", { summary: "服务器地址是 203.0.113.7，端口也连不上，重置也没用。" }],
    ["路径", "路径", { summary: "日志在 /Users/wesley/Library/Logs/veyl 下面，麻烦看一下。" }],
  ])("含 %s 的载荷被整份拒收（%s）", async (_label, _kind, issue) => {
    const { env, token } = await setup();
    const response = await route(submitRequest(token, validPayload({ issue })), env);
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).details).toMatchObject({ reason: "forbidden_content" });
    const list = await bodyOf(await route(new Request("https://cp.test/v1/issues"), env));
    expect((list.issues as Row[]).length).toBe(0);
  });

  it("标题过短返回 too_short", async () => {
    const { env, token } = await setup();
    const response = await route(
      submitRequest(token, validPayload({ issue: { title: "卡住" } })),
      env,
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).details).toMatchObject({ reason: "too_short" });
  });

  it("请求体超过 16 KiB 被拒绝", async () => {
    const { env, token } = await setup();
    const response = await route(
      submitRequest(token, validPayload({ issue: { repro: "x".repeat(20_000) } })),
      env,
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).details).toMatchObject({ reason: "body_too_large" });
  });

  it("超过设备上报上限返回 429", async () => {
    const { env, token } = await setup();
    let last: Response | null = null;
    for (let index = 0; index < 6; index += 1) {
      last = await route(
        submitRequest(token, validPayload(), { key: `key-${index}-abcdefgh` }),
        env,
      );
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toBe("3600");
  });

  it("ISSUE_SUBMIT_MODE=closed 时提交 503，公开读取不受影响", async () => {
    const { env, token } = await setup();
    const closedEnv = { ...env, ISSUE_SUBMIT_MODE: "closed" };
    const response = await route(submitRequest(token, validPayload()), closedEnv);
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({
      ok: false,
      reason: "issues_closed",
      retryable: true,
    });

    const listResponse = await route(new Request("https://cp.test/v1/issues"), closedEnv);
    expect(listResponse.status).toBe(200);
  });

  it("删除后的帖子不出现，详情返回 404", async () => {
    const { db, env, token } = await setup();
    const created = await bodyOf(await route(submitRequest(token, validPayload()), env));
    const issueId = String(created.issue_id);
    const row = db.issues.find((issue) => issue.id === issueId);
    if (!row) throw new Error("测试数据缺失");
    row.hidden_at = Date.now();

    const list = await bodyOf(await route(new Request("https://cp.test/v1/issues"), env));
    expect((list.issues as Row[]).length).toBe(0);

    const detail = await route(new Request(`https://cp.test/v1/issues/${issueId}`), env);
    expect(detail.status).toBe(404);
    expect(detail.headers.get("cache-control")).toContain("no-store");
  });

  it("运营写入的答复能读到，隐藏答复不出现", async () => {
    const { db, env, token } = await setup();
    const created = await bodyOf(await route(submitRequest(token, validPayload()), env));
    const issueId = String(created.issue_id);
    const now = Date.now();
    db.replies.push(
      {
        id: "rep_visible",
        issue_id: issueId,
        author: "admin",
        body: "已经修复，请更新到 1.0.1 后重试。",
        hidden_at: null,
        created_at: now,
      },
      {
        id: "rep_hidden",
        issue_id: issueId,
        author: "admin",
        body: "这条不该出现。",
        hidden_at: now,
        created_at: now + 1,
      },
    );

    const response = await route(
      new Request(`https://cp.test/v1/issues/${issueId}`),
      env,
    );
    const body = await bodyOf(response);
    expect(body.replies).toEqual([
      {
        author: "admin",
        body: "已经修复，请更新到 1.0.1 后重试。",
        created_at: expect.any(String),
      },
    ]);
  });

  it("帖子没有答复 / 删除接口", async () => {
    const { env, token } = await setup();
    const created = await bodyOf(await route(submitRequest(token, validPayload()), env));
    const issueId = String(created.issue_id);
    const response = await route(
      new Request(`https://cp.test/v1/issues/${issueId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      }),
      env,
    );
    expect(response.status).toBe(405);
  });

  it("分页与 platform 过滤", async () => {
    const { db, env, token } = await setup();
    for (let index = 0; index < 3; index += 1) {
      await route(
        submitRequest(
          token,
          validPayload({
            client: { platform: index === 2 ? "windows" : "macos" },
          }),
          { key: `page-key-${index}` },
        ),
        env,
      );
    }
    const rows = db.issues;
    rows[0].last_activity_at = 3000;
    rows[1].last_activity_at = 2000;
    rows[2].last_activity_at = 1000;

    const firstPage = await bodyOf(
      await route(new Request("https://cp.test/v1/issues?limit=2"), env),
    );
    const firstIssues = firstPage.issues as Row[];
    expect(firstIssues).toHaveLength(2);
    expect(firstIssues[0].id).toBe(rows[0].id);
    expect(firstPage.next_cursor).toBeTypeOf("string");

    const secondPage = await bodyOf(
      await route(
        new Request(
          `https://cp.test/v1/issues?limit=2&cursor=${encodeURIComponent(String(firstPage.next_cursor))}`,
        ),
        env,
      ),
    );
    expect((secondPage.issues as Row[]).length).toBe(1);
    expect((secondPage.issues as Row[])[0].id).toBe(rows[2].id);
    expect(secondPage.next_cursor).toBeNull();

    const windowsOnly = await bodyOf(
      await route(new Request("https://cp.test/v1/issues?platform=windows"), env),
    );
    expect((windowsOnly.issues as Row[]).length).toBe(1);
  });

  it("版本号形状的 build 不会被当 IP 拒收", async () => {
    const { env, token } = await setup();
    const response = await route(
      submitRequest(token, validPayload({ client: { build: "2026.11.22.1234" } })),
      env,
    );
    expect(response.status).toBe(201);
  });

  it("q 搜索词上限与工具一致（100 字）", async () => {
    const { env } = await setup();
    const accepted = await route(
      new Request(`https://cp.test/v1/issues?q=${encodeURIComponent("a".repeat(100))}`),
      env,
    );
    expect(accepted.status).toBe(200);

    const rejected = await route(
      new Request(`https://cp.test/v1/issues?q=${encodeURIComponent("a".repeat(101))}`),
      env,
    );
    expect(rejected.status).toBe(400);
    expect((await bodyOf(rejected)).details).toMatchObject({ reason: "invalid_query" });
  });

  it("缺少 CF-Connecting-IP 时用共享读取桶，不能绕过限流", async () => {
    const { env } = await setup();
    let last: Response | null = null;
    for (let index = 0; index < 61; index += 1) {
      last = await route(new Request("https://cp.test/v1/issues"), env);
    }
    if (!last) throw new Error("请求未发出");
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBe("60");
    const body = await bodyOf(last);
    expect(body.message).toBe("读取太频繁，请稍后再试");
    expect(body.details).toMatchObject({ reason: "rate_limited" });
  });
});

describe("网段前缀", () => {
  it("压缩 IPv6 先展开再取 /48", () => {
    expect(ipPrefix("2001:db8::5")).toBe("2001:db8:0::/48");
    expect(ipPrefix("2001:db8:1:2::5")).toBe("2001:db8:1::/48");
    expect(ipPrefix("2001:0DB8:0001:2::1")).toBe("2001:db8:1::/48");
    expect(ipPrefix("::1")).toBe("0:0:0::/48");
    expect(ipPrefix("203.0.113.7")).toBe("203.0.113.0/24");
    expect(ipPrefix("not-an-ip")).toBeNull();
  });
});
