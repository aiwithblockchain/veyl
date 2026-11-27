// @ts-nocheck
// 这个文件用 Node 的 fs 读与 Rust 共用的 golden fixture，并用 node:sqlite 跑真实迁移；
// tsconfig 只有 Cloudflare 类型，所以只在这个测试文件里关掉类型检查。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { route } from "../src/index";
import {
  SUPPORTED_METHODS,
  seedBody,
  sha256Hex,
  validateSeedNode,
  type Seed,
} from "../src/seed";
import { openMigratedDb, sqliteAvailable } from "./helpers/sqliteD1";

// Node 22 上 node:sqlite 需要 --experimental-sqlite；拿不到就跳过，不让环境差异变成红。
const hasSqlite = sqliteAvailable();
if (!hasSqlite) {
  console.warn("[seed] 跳过真实 SQL 用例：node:sqlite 不可用（Node 22 需要 --experimental-sqlite）");
}
const describeSqlite = hasSqlite ? describe : describe.skip;

const SEED_PATH = "https://example.com/v1/seed";

const SEED: Seed = {
  version: 3,
  updated_at: "2026-11-27T00:00:00Z",
  nodes: [
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
      password: "pw-b",
    },
  ],
};

const BODY = seedBody(SEED);

async function envWith(body = BODY, hash?: string) {
  const db = await openMigratedDb();
  const actualHash = hash ?? (await sha256Hex(body));
  db.run(
    "INSERT INTO seed_payload (id, version, updated_at, body, content_sha256, updated_by, stored_at) " +
      "VALUES (1, ?, ?, ?, ?, ?, ?)",
    SEED.version,
    SEED.updated_at,
    body,
    actualHash,
    "test",
    Date.now(),
  );
  return { ENVIRONMENT: "test", DB: db };
}

describeSqlite("GET /v1/seed（D1）", () => {
  it("200 原样返回 D1 正文，ETag 是正文 sha256，带缓存头", async () => {
    const env = await envWith();
    const res = await route(new Request(SEED_PATH), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");

    const text = await res.text();
    expect(text).toBe(BODY);
    expect(res.headers.get("etag")).toBe(`"sha256-${await sha256Hex(BODY)}"`);

    const body = JSON.parse(text) as Seed;
    expect(body).toEqual(SEED);
  });

  it("字段顺序固定：version → updated_at → nodes，节点内 name → password", async () => {
    const env = await envWith();
    const text = await route(new Request(SEED_PATH), env).then((res) => res.text());
    expect(text.indexOf('"version"')).toBeLessThan(text.indexOf('"updated_at"'));
    expect(text.indexOf('"updated_at"')).toBeLessThan(text.indexOf('"nodes"'));
    expect(text.indexOf('"name"')).toBeLessThan(text.indexOf('"server"'));
    expect(text.indexOf('"server"')).toBeLessThan(text.indexOf('"port"'));
    expect(text.indexOf('"port"')).toBeLessThan(text.indexOf('"method"'));
    expect(text.indexOf('"method"')).toBeLessThan(text.indexOf('"password"'));
  });

  it("If-None-Match 命中返回 304、空 body，并保留 ETag 与缓存头", async () => {
    const env = await envWith();
    const etag = `"sha256-${await sha256Hex(BODY)}"`;
    const res = await route(
      new Request(SEED_PATH, { headers: { "if-none-match": etag } }),
      env,
    );
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
  });

  it("ETag 不匹配或不带条件头仍返回 200", async () => {
    const env = await envWith();
    const stale = await route(
      new Request(SEED_PATH, { headers: { "if-none-match": '"sha256-stale"' } }),
      env,
    );
    expect(stale.status).toBe(200);

    const plain = await route(new Request(SEED_PATH), env);
    expect(plain.status).toBe(200);
  });

  it("HEAD 返回 200、空 body，但带 ETag 与缓存头", async () => {
    const env = await envWith();
    const res = await route(new Request(SEED_PATH, { method: "HEAD" }), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(`"sha256-${await sha256Hex(BODY)}"`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
  });

  it("HEAD 带命中的 If-None-Match 也返回 304", async () => {
    const env = await envWith();
    const etag = `"sha256-${await sha256Hex(BODY)}"`;
    const res = await route(
      new Request(SEED_PATH, { method: "HEAD", headers: { "if-none-match": etag } }),
      env,
    );
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(etag);
  });

  it("非 GET/HEAD 返回 405", async () => {
    const env = await envWith();
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await route(new Request(SEED_PATH, { method }), env);
      expect(res.status).toBe(405);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("method_not_allowed");
    }
  });

  it("空表返回 503 seed_unavailable，不是一个空节点列表", async () => {
    const db = await openMigratedDb();
    const res = await route(new Request(SEED_PATH), { ENVIRONMENT: "test", DB: db });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { error: string }).error).toBe("seed_unavailable");
  });

  it("D1 未绑定返回 503 seed_unavailable", async () => {
    const res = await route(new Request(SEED_PATH), { ENVIRONMENT: "test" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("seed_unavailable");
  });

  it("正文哈希与 content_sha256 不一致返回 500 seed_corrupt", async () => {
    const env = await envWith(BODY, "deadbeef");
    const res = await route(new Request(SEED_PATH), env);
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { error: string }).error).toBe("seed_corrupt");
  });

  it("同一份数据两次序列化字节一致", async () => {
    const env = await envWith();
    const first = await route(new Request(SEED_PATH), env).then((res) => res.text());
    const second = await route(new Request(SEED_PATH), env).then((res) => res.text());
    expect(first).toBe(second);
  });

  it("序列化字节锁定：固定字段顺序与紧凑分隔符", () => {
    expect(
      seedBody({
        version: 2,
        updated_at: "2026-11-27T06:55:36Z",
        nodes: [
          {
            name: "a",
            server: "203.0.113.10",
            port: 8388,
            method: "aes-256-gcm",
            password: "p",
          },
        ],
      }),
    ).toBe(
      '{"version":2,"updated_at":"2026-11-27T06:55:36Z","nodes":[{"name":"a","server":"203.0.113.10","port":8388,"method":"aes-256-gcm","password":"p"}]}',
    );
  });
});

type RawSeedNode = {
  name?: unknown;
  server?: unknown;
  port?: unknown;
  method?: unknown;
  password?: unknown;
};

const GOLDEN = JSON.parse(
  readFileSync(
    new URL("../../../seed/fixtures/seed.golden.json", import.meta.url),
    "utf8",
  ),
) as {
  valid: RawSeedNode[];
  invalid: { case: string; node: RawSeedNode }[];
};

describe("种子节点校验", () => {
  it("与 Rust 共用的 golden fixture 逐条一致", () => {
    expect(GOLDEN.valid.length).toBeGreaterThan(0);
    for (const node of GOLDEN.valid) {
      expect("node" in validateSeedNode(node), JSON.stringify(node)).toBe(true);
    }
    for (const item of GOLDEN.invalid) {
      expect("problem" in validateSeedNode(item.node), item.case).toBe(true);
    }
  });

  it("名称为空时回落到 server:port；方法统一小写", () => {
    const result = validateSeedNode({
      name: "   ",
      server: "203.0.113.10",
      port: 8388,
      method: "AES-256-GCM",
      password: "pw",
    });
    expect(!("node" in result)).toBe(false);
    if ("node" in result) {
      expect(result.node.name).toBe("203.0.113.10:8388");
      expect(result.node.method).toBe("aes-256-gcm");
    }
  });

  it("方法白名单与客户端清单一致", () => {
    expect(SUPPORTED_METHODS).toContain("2022-blake3-aes-256-gcm");
    const bad = validateSeedNode({
      name: "bad",
      server: "203.0.113.10",
      port: 8388,
      method: "rc4-md5",
      password: "pw",
    });
    expect("problem" in bad).toBe(true);
  });
});
