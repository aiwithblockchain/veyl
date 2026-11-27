//! 免费节点种子：正文存在 D1 `seed_payload`，Worker 原样读出。
//!
//! 更新判据是**正文内容哈希**，`version` / `updated_at` 只给人看。
//! 密码是公开的：免费节点只是测试试用资源，随时可换（`docs/design/seed-publishing.md`）。
//!
//! 正文由 `scripts/seed/publish-d1.ts` 生成并写入 D1；本模块只保留类型、校验与读取。

export type SeedNode = {
  name: string;
  server: string;
  port: number;
  method: string;
  password: string;
};

export type Seed = {
  version: number;
  updated_at: string;
  nodes: SeedNode[];
};

export const SEED_CACHE_CONTROL = "public, max-age=300, must-revalidate";

/** 客户端 `nodes::SUPPORTED_METHODS` 的子集：种子只允许这些（与 Rust 侧同一清单）。 */
export const SUPPORTED_METHODS = [
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
] as const;

export type SeedNodeValidation = { node: SeedNode } | { problem: string };

const SERVER_MAX_BYTES = 253;
/** Rust `char::is_control()`：C0、DEL 与 C1 都算控制字符。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * 按客户端 `validate_seed_node` 的规则校验一台节点。
 *
 * 发布脚本用它逐台检查；名称为空时回落到 `server:port`（与 Rust 一致），
 * 这样本地输入文件不必手写显示名。长度按 UTF-8 字节算（Rust 的 `str::len()`）。
 */
export function validateSeedNode(raw: unknown): SeedNodeValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { problem: "not_an_object" };
  }
  const input = raw as Record<string, unknown>;
  const server = typeof input.server === "string" ? input.server.trim() : "";
  if (!server || utf8Length(server) > SERVER_MAX_BYTES) return { problem: "server" };
  if (
    server.includes("://") ||
    /[\s/\\]/.test(server) ||
    CONTROL_CHARS.test(server)
  ) {
    return { problem: "server_chars" };
  }
  const port = input.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return { problem: "port" };
  }
  const method =
    typeof input.method === "string" ? input.method.trim().toLowerCase() : "";
  if (!(SUPPORTED_METHODS as readonly string[]).includes(method)) {
    return { problem: "method" };
  }
  if (typeof input.password !== "string" || !input.password.trim()) {
    return { problem: "password" };
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  return {
    node: {
      name: name || `${server}:${port}`,
      server,
      port,
      method,
      password: input.password,
    },
  };
}

/**
 * 固定字段顺序序列化。同一份数据每次必须得到同一串字节，
 * 否则 ETag 每次都变，客户端会误以为有新版本。
 */
export function seedBody(seed: Seed): string {
  return JSON.stringify({
    version: seed.version,
    updated_at: seed.updated_at,
    nodes: seed.nodes.map((node) => ({
      name: node.name,
      server: node.server,
      port: node.port,
      method: node.method,
      password: node.password,
    })),
  });
}

/** 正文 sha256（小写 hex）。D1 列、ETag 与客户端校验都用它。 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type SeedRow = {
  body: string;
  content_sha256: string;
};

/** 无行、未绑定或读取失败都按「暂时没有种子」处理，由调用方回 503。 */
async function readSeedRow(env: { DB?: D1Database }): Promise<SeedRow | null> {
  if (!env.DB) return null;
  try {
    return await env.DB.prepare(
      "SELECT body, content_sha256 FROM seed_payload WHERE id = 1",
    ).first<SeedRow>();
  } catch (error) {
    console.error("读取 seed_payload 失败", error);
    return null;
  }
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: false, error: code }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * `GET /v1/seed`：匿名只读，正文原样来自 D1。
 * `HEAD` 同状态与头，但 body 为空（契约要求 GET/HEAD）。
 * 非该路径返回 null，交给后面的路由链。
 */
export async function handleSeed(
  request: Request,
  env: { DB?: D1Database },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/seed") return null;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return errorResponse(405, "method_not_allowed");
  }

  const row = await readSeedRow(env);
  if (!row) return errorResponse(503, "seed_unavailable");

  // 读时再算一次：正文与哈希对不上说明写入或存储出了问题，不能把坏数据发给客户端。
  const hash = await sha256Hex(row.body);
  if (hash !== row.content_sha256) return errorResponse(500, "seed_corrupt");

  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": SEED_CACHE_CONTROL,
    etag: `"sha256-${hash}"`,
  });
  if (request.headers.get("if-none-match") === headers.get("etag")) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(method === "HEAD" ? null : row.body, {
    status: 200,
    headers,
  });
}
