// @ts-nocheck
// 这个文件用 Node 的 fs 读与 Rust 共用的 golden fixture；tsconfig 只有
// Cloudflare 类型，所以只在这个测试文件里关掉类型检查。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { route } from "../src/index";
import { SEED, seedBody, seedEtag } from "../src/seed";

const env = { ENVIRONMENT: "test" };
const SEED_PATH = "https://example.com/v1/seed";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type RawSeedNode = {
  name?: unknown;
  server?: unknown;
  port?: unknown;
  method?: unknown;
  password?: unknown;
};

/** 与 Rust `validate_seed_node` 同义的规则；返回 null 表示合法。 */
function nodeProblem(node: RawSeedNode): string | null {
  const server = typeof node.server === "string" ? node.server.trim() : "";
  if (!server || server.length > 253) return "server";
  if (server.includes("://") || /[\s/\\]/.test(server) || /[\u0000-\u001f]/.test(server)) {
    return "server_chars";
  }
  if (
    !Number.isInteger(node.port) ||
    (node.port as number) <= 0 ||
    (node.port as number) > 65535
  ) {
    return "port";
  }
  const method =
    typeof node.method === "string" ? node.method.trim().toLowerCase() : "";
  if (!SUPPORTED_METHODS.includes(method)) return "method";
  if (typeof node.password !== "string" || !node.password.trim()) return "password";
  return null;
}

const GOLDEN = JSON.parse(
  readFileSync(
    new URL("../../../seed/fixtures/seed.golden.json", import.meta.url),
    "utf8",
  ),
) as {
  valid: RawSeedNode[];
  invalid: { case: string; node: RawSeedNode }[];
};

/** 客户端 `nodes::SUPPORTED_METHODS` 的子集：种子只允许这些。 */
const SUPPORTED_METHODS = [
  "aes-128-gcm",
  "aes-192-gcm",
  "aes-256-gcm",
  "aes-128-ctr",
  "aes-192-ctr",
  "aes-256-ctr",
  "chacha20-ietf-poly1305",
  "xchacha20-ietf-poly1305",
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
];

describe("GET /v1/seed", () => {
  it("200 直出 JSON，ETag 是正文 sha256，带缓存头", async () => {
    const res = await route(new Request(SEED_PATH), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");

    const text = await res.text();
    expect(text).toBe(seedBody());
    const expected = `"sha256-${await sha256(text)}"`;
    expect(res.headers.get("etag")).toBe(expected);

    const body = JSON.parse(text) as typeof SEED;
    expect(body.version).toBe(SEED.version);
    expect(body.updated_at).toBe(SEED.updated_at);
    expect(body.nodes).toEqual(SEED.nodes);
  });

  it("字段顺序固定：version → updated_at → nodes，节点内 name → password", async () => {
    const text = await route(new Request(SEED_PATH), env).then((res) => res.text());
    expect(text.indexOf('"version"')).toBeLessThan(text.indexOf('"updated_at"'));
    expect(text.indexOf('"updated_at"')).toBeLessThan(text.indexOf('"nodes"'));
    const node = text.indexOf('"name"');
    expect(node).toBeLessThan(text.indexOf('"server"'));
    expect(text.indexOf('"server"')).toBeLessThan(text.indexOf('"port"'));
    expect(text.indexOf('"port"')).toBeLessThan(text.indexOf('"method"'));
    expect(text.indexOf('"method"')).toBeLessThan(text.indexOf('"password"'));
  });

  it("If-None-Match 命中返回 304、空 body，并保留 ETag 与缓存头", async () => {
    const etag = await seedEtag();
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
    const stale = await route(
      new Request(SEED_PATH, { headers: { "if-none-match": '"sha256-stale"' } }),
      env,
    );
    expect(stale.status).toBe(200);

    const plain = await route(new Request(SEED_PATH), env);
    expect(plain.status).toBe(200);
  });

  it("非 GET/HEAD 返回 405", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await route(new Request(SEED_PATH, { method }), env);
      expect(res.status).toBe(405);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("method_not_allowed");
    }
  });

  it("HEAD 返回 200、空 body，但带 ETag 与缓存头", async () => {
    const etag = await seedEtag();
    const res = await route(new Request(SEED_PATH, { method: "HEAD" }), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("HEAD 带命中的 If-None-Match 也返回 304", async () => {
    const etag = await seedEtag();
    const res = await route(
      new Request(SEED_PATH, {
        method: "HEAD",
        headers: { "if-none-match": etag },
      }),
      env,
    );
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(etag);
  });

  it("同一份数据两次序列化字节一致", async () => {
    const first = await route(new Request(SEED_PATH), env).then((res) => res.text());
    const second = await route(new Request(SEED_PATH), env).then((res) => res.text());
    expect(first).toBe(second);
  });
});

describe("SEED 数据形状", () => {
  it("version / updated_at / 节点都合法", () => {
    expect(Number.isInteger(SEED.version)).toBe(true);
    expect(SEED.version).toBeGreaterThan(0);
    expect(() => new Date(SEED.updated_at).toISOString()).not.toThrow();
    expect(SEED.nodes.length).toBeGreaterThan(0);
  });

  it("每台节点的字段与客户端规则一致", () => {
    for (const node of SEED.nodes) {
      expect(nodeProblem(node)).toBeNull();
    }
  });

  it("与 Rust 共用的 golden fixture 逐条一致", () => {
    expect(GOLDEN.valid.length).toBeGreaterThan(0);
    for (const node of GOLDEN.valid) {
      expect(nodeProblem(node)).toBeNull();
    }
    for (const item of GOLDEN.invalid) {
      expect(nodeProblem(item.node), item.case).not.toBeNull();
    }
  });
});
