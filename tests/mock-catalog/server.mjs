#!/usr/bin/env node
// 节点目录服务 mock。零依赖，供集成测试与 E2E 使用。
// 启动：node tests/mock-catalog/server.mjs --port 18090
// 故障注入：请求加 ?_fault=timeout|500|malformed|slow&ms=3000，或请求头 X-Mock-Fault。

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 18090;

const allNodes = JSON.parse(readFileSync(join(FIXTURES, "nodes.json"), "utf8"));
const etag = "v" + createHash("sha256").update(JSON.stringify(allNodes)).digest("hex").slice(0, 8);

const stats = { devices: 0, catalog: 0, nodeFetches: 0, health: 0, faults: 0 };
const devices = new Map();

function publicNode(n) {
  return {
    id: n.id,
    name: n.name,
    region: n.region,
    city: n.city,
    protocol: n.protocol,
    latency_ms: n.health.latency_ms,
    health_score: n.health.score,
    tags: n.tags,
  };
}

function send(res, code, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(payload);
}

let requestSeq = 0;
function envelope(res, code, data, headers = {}) {
  requestSeq += 1;
  return send(
    res,
    code,
    {
      contract_version: "1.0.8",
      ok: true,
      request_id: `mock_${requestSeq}`,
      data,
    },
    headers,
  );
}

function failEnvelope(res, code, errorCode, message, details = null) {
  requestSeq += 1;
  return send(res, code, {
    contract_version: "1.0.8",
    ok: false,
    request_id: `mock_${requestSeq}`,
    error: { code: errorCode, message, retryable: false, details },
  });
}

function faultOf(req, url) {
  return url.searchParams.get("_fault") || req.headers["x-mock-fault"] || null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const fault = faultOf(req, url);

  if (fault) stats.faults++;

  // 测试断言用的观测点
  if (path === "/__stats") return send(res, 200, stats);
  if (path === "/__reset") {
    stats.devices = stats.catalog = stats.nodeFetches = stats.health = stats.faults = 0;
    devices.clear();
    return send(res, 200, { ok: true });
  }
  if (path === "/__health") return send(res, 200, { ok: true, etag });

  if (fault === "timeout") {
    // 故意不回包，用于验证客户端 5 秒超时降级
    setTimeout(() => res.socket?.destroy(), 30000);
    return;
  }
  if (fault === "500") return failEnvelope(res, 500, "INTERNAL", "mock_internal_error");
  if (fault === "malformed") return send(res, 200, '{"nodes": [', { "content-type": "application/json" });
  if (fault === "slow") {
    const ms = Number(url.searchParams.get("ms") || 3000);
    return setTimeout(() => send(res, 200, { nodes: [] }), ms);
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // 设备注册
    if (req.method === "POST" && path === "/v1/devices") {
      stats.devices++;
      const id = `dev_${String(stats.devices).padStart(6, "0")}`;
      const token = `tok_${createHash("sha256").update(id + Date.now()).digest("hex").slice(0, 32)}`;
      devices.set(token, id);
      const now = new Date();
      return envelope(res, 201, {
        device_id: id,
        device_token: token,
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 180 * 86400_000).toISOString(),
      });
    }

    // 节点列表：不返回 server / credentials / tls
    if (req.method === "GET" && path === "/v1/catalog/nodes") {
      stats.catalog++;
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer ") || !devices.has(auth.slice(7))) {
        return failEnvelope(res, 401, "DEVICE_TOKEN_INVALID", "设备 token 无效或已撤销");
      }
      if (req.headers["if-none-match"] === `"${etag}"` || req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      const region = url.searchParams.get("region");
      const protocol = url.searchParams.get("protocol");
      const limit = Number(url.searchParams.get("limit") || 50);

      let list = allNodes.filter((n) => n.enabled !== false && n.health.score > 0);
      if (region) list = list.filter((n) => n.region === region);
      if (protocol) list = list.filter((n) => n.protocol === protocol);
      list = list.slice(0, limit).map(publicNode);

      return envelope(
        res,
        200,
        { etag, nodes: list, next_cursor: null, fetched_at: new Date().toISOString() },
        { etag },
      );
    }

    // 完整节点（profile_import / vpn_connect 用）；契约路径是 /v1/catalog/nodes/{id}
    const nodeMatch = path.match(/^\/v1\/(?:catalog\/)?nodes\/([^/]+)$/);
    if (req.method === "GET" && nodeMatch) {
      stats.nodeFetches++;
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer ") || !devices.has(auth.slice(7))) {
        return failEnvelope(res, 401, "DEVICE_TOKEN_INVALID", "设备 token 无效或已撤销");
      }
      const node = allNodes.find((n) => n.id === decodeURIComponent(nodeMatch[1]));
      if (!node) return failEnvelope(res, 404, "NODE_NOT_FOUND", "节点不存在或已下线");
      return envelope(res, 200, {
        etag,
        node,
        fetched_at: new Date().toISOString(),
      });
    }

    if (req.method === "POST" && path === "/v1/health/report") {
      stats.health++;
      res.writeHead(204).end();
      return;
    }

    // 供 manifest 使用：下载一个本地生成的归档（含恶意归档），用于安全解压用例
    if (req.method === "GET" && path === "/__file") {
      const name = url.searchParams.get("name") || "";
      if (!/^[a-z0-9._-]+$/i.test(name)) return send(res, 400, { error: "bad_name" });
      const file = join(FIXTURES, "generated", name);
      if (!existsSync(file)) return send(res, 404, { error: "asset_not_found", name });
      const buf = readFileSync(file);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": buf.length });
      return res.end(buf);
    }

    // manifest-bad-url 用的 404 下游
    if (path.startsWith("/v1/download/")) {
      return send(res, 404, { error: "asset_not_found" });
    }

    failEnvelope(res, 404, "NOT_FOUND", "not_found", { path });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-catalog] listening on http://127.0.0.1:${PORT} (etag=${etag})`);
});
