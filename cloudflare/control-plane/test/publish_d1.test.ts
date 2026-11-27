// 发布脚本的纯逻辑：校验、版本、SQL 转义、路径约束与「版本不递增」闸门。
import { describe, expect, it } from "vitest";

import {
  assertInputAllowed,
  collectNodes,
  nextVersion,
  parseArgs,
  resolveRelease,
  sqlText,
  summaryLines,
  upsertSql,
  type PublishOptions,
} from "../../../scripts/seed/publish-d1";
import { seedBody, sha256Hex } from "../src/seed";
import {
  openMigratedDb,
  sqliteAvailable,
  type SqliteD1,
} from "./helpers/sqliteD1";

const hasSqlite = sqliteAvailable();
const describeSqlite = hasSqlite ? describe : describe.skip;

const NODES = [
  {
    name: "东京 01",
    server: "203.0.113.10",
    port: 8388,
    method: "aes-256-gcm",
    password: "pw-a",
  },
  {
    name: "香港 01",
    server: "203.0.113.11",
    port: 8389,
    method: "chacha20-ietf-poly1305",
    password: "pw'b", // 单引号：必须双写后才能写入 SQLite
  },
];

describe("collectNodes", () => {
  it("合法节点全部收下；非法项只记序号与原因", () => {
    const { nodes, skipped } = collectNodes({
      nodes: [NODES[0], { server: "x", port: 0 }, NODES[1]],
    });
    expect(nodes.map((node) => node.server)).toEqual([
      "203.0.113.10",
      "203.0.113.11",
    ]);
    expect(skipped).toEqual([{ index: 1, problem: "port" }]);
  });

  it("空数组 / 全部非法 / 结构不对都中止", () => {
    expect(() => collectNodes({ nodes: [] })).toThrow(/没有任何可用节点/);
    expect(() => collectNodes({ nodes: [{ port: 0 }] })).toThrow(/没有任何可用节点/);
    expect(() => collectNodes({})).toThrow(/nodes/);
    expect(() => collectNodes(null)).toThrow(/nodes/);
  });
});

describe("版本与 SQL", () => {
  it("无行从 1 开始，否则 +1", () => {
    expect(nextVersion(null)).toBe(1);
    expect(nextVersion(5)).toBe(6);
  });

  it("空表首发可用显式 version / updated_at；已有行时传它们直接报错", () => {
    const now = "2026-11-27T09:00:00Z";
    expect(
      resolveRelease(null, { version: 2, updatedAt: "2026-11-27T06:55:36Z" }, now),
    ).toEqual({ version: 2, updatedAt: "2026-11-27T06:55:36Z" });
    expect(resolveRelease(null, { version: null, updatedAt: null }, now)).toEqual({
      version: 1,
      updatedAt: now,
    });
    expect(() =>
      resolveRelease(2, { version: 3, updatedAt: null }, now),
    ).toThrow(/只用于空表首发/);
    expect(() =>
      resolveRelease(2, { version: null, updatedAt: "2026-11-27T06:55:36Z" }, now),
    ).toThrow(/只用于空表首发/);
    expect(resolveRelease(2, { version: null, updatedAt: null }, now)).toEqual({
      version: 3,
      updatedAt: now,
    });
  });

  it("远程生产必须显式 --prod；--dev / --local 不需要", () => {
    expect(parseArgs(["--input", "x.json", "--dev"]).environment).toBe("dev");
    expect(parseArgs(["--input", "x.json", "--local"]).local).toBe(true);
    expect(parseArgs(["--input", "x.json", "--prod"]).environment).toBe("prod");
    expect(() => parseArgs(["--input", "x.json"])).toThrow(/--prod/);
    expect(() => parseArgs(["--input", "x.json", "--prod", "--dev"])).toThrow(
      /不能同时/,
    );
    expect(() => parseArgs(["--dev"])).toThrow(/--input/);
    expect(() =>
      parseArgs(["--input", "x.json", "--prod", "--version", "0"]),
    ).toThrow(/正整数/);
    expect(() =>
      parseArgs(["--input", "x.json", "--prod", "--updated-at", "not-a-date"]),
    ).toThrow(/ISO/);
  });

  it("单引号双写、NUL 拒绝", () => {
    expect(sqlText("pw'b")).toBe("'pw''b'");
    expect(() => sqlText("a\u0000b")).toThrow(/NUL/);
  });

  it("upsert 带版本递增守卫", () => {
    const seed = { version: 7, updated_at: "2026-11-27T00:00:00Z", nodes: [] };
    const sql = upsertSql(seed, '{"x":1}', "abc", "tester", 123);
    expect(sql).toContain("ON CONFLICT(id) DO UPDATE");
    expect(sql).toContain("WHERE excluded.version > seed_payload.version");
    expect(sql).toContain("'tester'");
  });
});

describe("输入路径约束", () => {
  it("仓库内未忽略的文件被拒绝", () => {
    expect(() => assertInputAllowed("cloudflare/control-plane/package.json")).toThrow(
      /未被忽略/,
    );
  });

  it("仓库内已忽略的文件放行", () => {
    expect(() => assertInputAllowed("scripts/seed/private_seeds.json")).not.toThrow();
  });

  it("仓库外的文件放行", () => {
    expect(() => assertInputAllowed("/tmp/veyl-seed-input.json")).not.toThrow();
  });
});

describe("摘要不含密码", () => {
  it("只打印版本 / 节点数 / 哈希", () => {
    const options: PublishOptions = {
      input: "x",
      environment: "prod",
      local: true,
      dryRun: true,
      updatedBy: "tester",
      version: null,
      updatedAt: null,
    };
    const text = summaryLines(
      options,
      {
        version: 2,
        updated_at: "2026-11-27T00:00:00Z",
        nodes: [{ name: "n", server: "203.0.113.10", port: 1, method: "aes-256-gcm", password: "S3CRET" }],
      },
      "abc",
      [],
    ).join("\n");
    expect(text).toContain("版本：2");
    expect(text).toContain("节点：1 个");
    expect(text).not.toContain("S3CRET");
  });
});

describe("首发正文与旧常量逐字节一致", () => {
  // 旧 cloudflare/control-plane/src/seed.ts 的 SEED 常量（version 2）。
  // 这条断言锁住首发迁移的字节：改了它，客户端会多做一次全量重拉、version 回退。
  const OLD_SEED = {
    version: 2,
    updated_at: "2026-11-27T06:55:36Z",
    nodes: [
      {
        name: "meshflux69 [美国1]",
        server: "64.177.43.69",
        port: 30322,
        method: "aes-256-gcm",
        password: "bGEnoY0DJGkqI0SG",
      },
      {
        name: "meshflux10 [美国2]",
        server: "64.177.57.184",
        port: 34517,
        method: "aes-256-gcm",
        password: "3MnI7ncpkRug7KAJ",
      },
    ],
  };

  it("seedBody 的 sha256 是 06f60478…，UTF-8 304 字节", async () => {
    const body = seedBody(OLD_SEED);
    expect(new TextEncoder().encode(body).length).toBe(304);
    expect(await sha256Hex(body)).toBe(
      "06f60478f5fabdc2a4c69f7817827162d29bfa3209596e24238d3ae9f3e109fb",
    );
  });
});

describeSqlite("版本不递增时 SQL 不落库", () => {
  async function run(db: SqliteD1, sql: string): Promise<number> {
    const result = await db.prepare(sql).run();
    return (result as { meta: { changes: number } }).meta.changes;
  }

  it("同版本第二次写入 changes=0", async () => {
    const db = await openMigratedDb();
    const seed = { version: 1, updated_at: "2026-11-27T00:00:00Z", nodes: NODES };
    const body = JSON.stringify({ version: seed.version, nodes: seed.nodes });
    const sql = upsertSql(seed, body, "hash-1", "tester", 1);
    expect(await run(db, sql)).toBe(1);
    expect(await run(db, sql)).toBe(0);
    const row = db.rows<{ version: number; body: string }>(
      "SELECT version, body FROM seed_payload WHERE id = 1",
    )[0];
    expect(row.version).toBe(1);
    expect(row.body).toBe(body);
  });
});
