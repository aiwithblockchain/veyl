//! 免费节点种子：仓库里这份是唯一真源，随 Worker 一起部署。
//!
//! 更新判据是**正文内容哈希**，`version` / `updated_at` 只给人看。
//! 密码是公开的：免费节点只是测试试用资源，随时可换（`docs/design/seed-publishing.md` §9）。

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

export const SEED: Seed = {
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

/**
 * 固定字段顺序序列化。同一份数据每次必须得到同一串字节，
 * 否则 ETag 每次都变，客户端会误以为有新版本。
 */
export function seedBody(seed: Seed = SEED): string {
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

let cachedEtag: Promise<string> | null = null;

/** `"sha256-<hex>"`，按正文算；isolate 存活期间只算一次。 */
export function seedEtag(): Promise<string> {
  if (!cachedEtag) {
    cachedEtag = (async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(seedBody()),
      );
      const hex = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return `"sha256-${hex}"`;
    })();
  }
  return cachedEtag;
}

export const SEED_CACHE_CONTROL = "public, max-age=300, must-revalidate";

/**
 * `GET /v1/seed`：匿名只读，Worker 直出 JSON。
 * `HEAD` 同状态与头，但 body 为空（契约要求 GET/HEAD）。
 * 非该路径返回 null，交给后面的路由链。
 */
export async function handleSeed(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/seed") return null;
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": SEED_CACHE_CONTROL,
  });
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response(
      JSON.stringify({ ok: false, error: "method_not_allowed" }),
      { status: 405, headers },
    );
  }

  const etag = await seedEtag();
  headers.set("etag", etag);
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(method === "HEAD" ? null : seedBody(), {
    status: 200,
    headers,
  });
}
