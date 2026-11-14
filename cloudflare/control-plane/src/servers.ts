// 服务器：enrollment 回传、列表、详情、销毁、凭据下发（§19.5 / §19.7 / §19.8）。
// 控制面是唯一事实源；客户端拿到的凭据必须能被内置公钥验签。

import { authenticate, isResponse, type MaybeAuthEnv } from "./auth";
import { randomId, sealSecret, sha256B64u, signDetached, openSecret } from "./lib/crypto";
import { apiError, json } from "./lib/http";
import { createFirewall, deleteDroplet } from "./providers/digitalocean";

const CREDENTIAL_KEY_ID = "cp-2026-11";
const CREDENTIAL_TTL_MS = 5 * 60 * 1000;

export interface ServersEnv extends MaybeAuthEnv {
  DO_API_TOKEN?: string;
  CREDENTIAL_SIGNING_JWK?: string;
  CREDENTIAL_ENC_KEY?: string;
}

interface ServerRow {
  id: string;
  account_id: string;
  order_id: string;
  provider: string;
  provider_id: string | null;
  name: string;
  region: string;
  plan: string;
  hourly_usd: number;
  monthly_usd: number;
  state: string;
  node_port: number;
  ip: string | null;
  node_id: string | null;
  enrollment_hash: string | null;
  enrollment_used_at: number | null;
  enrollment_expires_at: number | null;
  firewall_id: string | null;
  singbox_version: string | null;
  created_at: number;
  updated_at: number;
  destroyed_at: number | null;
  failure_code?: string | null;
}

function serverView(row: ServerRow) {
  return {
    server_id: row.id,
    name: row.name,
    region: row.region,
    plan: row.plan,
    state: row.state,
    created_at: new Date(row.created_at).toISOString(),
    ip: row.ip,
    port: row.state === "destroyed" ? null : row.node_port,
    node_id: row.node_id,
    hourly_usd: row.hourly_usd,
    monthly_usd: row.monthly_usd,
    failure: row.failure_code
      ? { stage: row.state, code: row.failure_code, message: "这台服务器没有创建成功", retryable: false }
      : null,
  };
}

async function loadServer(
  db: D1Database,
  accountId: string,
  serverId: string,
): Promise<ServerRow | null> {
  return db
    .prepare("SELECT * FROM servers WHERE id = ? AND account_id = ?")
    .bind(serverId, accountId)
    .first<ServerRow>();
}

async function destroyInstance(env: ServersEnv, row: ServerRow, reason: string): Promise<void> {
  if (!env.DB) return;
  const now = Date.now();
  await env.DB.prepare("UPDATE servers SET state = 'destroyed', destroyed_at = ?, updated_at = ? WHERE id = ?")
    .bind(now, now, row.id)
    .run();
  await env.DB.prepare("UPDATE credentials SET destroyed_at = ? WHERE server_id = ?")
    .bind(now, row.id)
    .run();

  if (env.DO_API_TOKEN && row.provider_id) {
    await deleteDroplet(env.DO_API_TOKEN, row.provider_id);
  }
  await env.DB.prepare(
    "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'server.destroy', ?)",
  )
    .bind(now, row.account_id, row.id, JSON.stringify({ reason }))
    .run();
}

/** POST /v1/enroll/{token}：实例回传端口与密码。token 自身就是幂等键，只能消费一次。 */
async function enroll(request: Request, env: ServersEnv, token: string): Promise<Response> {
  if (!env.DB) return json({ ok: false, reason: "unavailable" }, 503);
  const db = env.DB;

  let body: { port?: unknown; password?: unknown; version?: unknown; active?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, reason: "invalid_json" }, 400);
  }

  const hash = await sha256B64u(token);
  const row = await db
    .prepare("SELECT * FROM servers WHERE enrollment_hash = ?")
    .bind(hash)
    .first<ServerRow>();
  if (!row) return json({ ok: false, reason: "unknown_token" }, 404);
  if (row.enrollment_used_at !== null) return json({ ok: false, reason: "already_used" }, 409);
  if (row.enrollment_expires_at !== null && row.enrollment_expires_at < Date.now()) {
    await destroyInstance(env, row, "enrollment_expired");
    return json({ ok: false, reason: "expired" }, 410);
  }

  const port = Number(body.port);
  const password = typeof body.password === "string" ? body.password : "";
  const version = typeof body.version === "string" ? body.version : "";
  if (port !== row.node_port) {
    await destroyInstance(env, row, "port_mismatch");
    return json({ ok: false, reason: "port_mismatch" }, 409);
  }
  if (body.active !== true || password.length < 8) {
    await destroyInstance(env, row, "service_inactive");
    return json({ ok: false, reason: "service_inactive" }, 409);
  }

  // 原子消费：并发或重放只有一次能成功。
  const consumed = await db
    .prepare(
      "UPDATE servers SET enrollment_used_at = ?, enrollment_hash = NULL, updated_at = ? " +
        "WHERE id = ? AND enrollment_hash = ? AND enrollment_used_at IS NULL",
    )
    .bind(Date.now(), Date.now(), row.id, hash)
    .run();
  const changed = (consumed as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changed === 0) return json({ ok: false, reason: "already_used" }, 409);

  if (!env.CREDENTIAL_ENC_KEY) return json({ ok: false, reason: "storage_unavailable" }, 503);
  const sealed = await sealSecret(
    env.CREDENTIAL_ENC_KEY,
    JSON.stringify({ host: row.ip, port, password, method: "aes-256-gcm" }),
  );
  await db
    .prepare(
      "INSERT INTO credentials (server_id, key_version, iv, ciphertext, created_at) VALUES (?, 1, ?, ?, ?) " +
        "ON CONFLICT(server_id) DO UPDATE SET iv = excluded.iv, ciphertext = excluded.ciphertext, destroyed_at = NULL",
    )
    .bind(row.id, sealed.iv, sealed.ciphertext, Date.now())
    .run();

  let firewallId: string | null = null;
  if (env.DO_API_TOKEN && row.provider_id) {
    const firewall = await createFirewall(env.DO_API_TOKEN, {
      name: `veyl-${row.id.replace(/^srv_/, "").slice(0, 12)}`,
      port,
      providerId: row.provider_id,
    });
    if (!firewall.ok) {
      await destroyInstance(env, row, firewall.reason);
      return json({ ok: false, reason: "firewall_failed" }, 502);
    }
    firewallId = firewall.value.id;
  }

  const nodeId = randomId("nd_", 12);
  await db.batch([
    db.prepare(
      "UPDATE servers SET state = 'active', node_id = ?, firewall_id = ?, singbox_version = ?, updated_at = ? WHERE id = ?",
    ).bind(nodeId, firewallId, version, Date.now(), row.id),
    db.prepare("UPDATE orders SET state = 'ready' WHERE id = ?").bind(row.order_id),
    db.prepare(
      "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'enroll.ok', ?)",
    ).bind(Date.now(), row.account_id, row.id, JSON.stringify({ version })),
  ]);

  return json({ ok: true, node_id: nodeId });
}

async function listServers(request: Request, env: ServersEnv): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const result = await env.DB.prepare(
    "SELECT * FROM servers WHERE account_id = ? AND state != 'destroyed' ORDER BY created_at DESC",
  )
    .bind(identity.accountId)
    .all<ServerRow>();
  return json({ servers: (result.results ?? []).map(serverView) });
}

async function getServer(request: Request, env: ServersEnv, serverId: string): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const row = await loadServer(env.DB, identity.accountId, serverId);
  if (!row) return apiError("NOT_FOUND", "没有这台服务器");
  return json(serverView(row));
}

async function destroy(request: Request, env: ServersEnv, serverId: string): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const row = await loadServer(env.DB, identity.accountId, serverId);
  if (!row) return apiError("NOT_FOUND", "没有这台服务器");
  if (row.state === "destroyed") return new Response(null, { status: 204 });

  await env.DB.prepare("UPDATE servers SET state = 'destroying', updated_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run();
  await destroyInstance(env, row, "user");
  return new Response(null, { status: 204 });
}

async function credentials(request: Request, env: ServersEnv, serverId: string): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });
  if (!env.CREDENTIAL_SIGNING_JWK || !env.CREDENTIAL_ENC_KEY) {
    return apiError("INTERNAL", "控制面还没配置凭据签名", { reason: "credential_key_missing" });
  }

  const row = await loadServer(env.DB, identity.accountId, serverId);
  if (!row) return apiError("NOT_FOUND", "没有这台服务器");
  if (row.state !== "active" && row.state !== "healthy") {
    return apiError("PRECONDITION_FAILED", "这台服务器还没准备好", { reason: "not_ready" });
  }

  const sealed = await env.DB.prepare(
    "SELECT iv, ciphertext FROM credentials WHERE server_id = ? AND destroyed_at IS NULL",
  )
    .bind(row.id)
    .first<{ iv: string; ciphertext: string }>();
  if (!sealed) return apiError("PRECONDITION_FAILED", "这台服务器没有可用凭据", { reason: "no_credentials" });

  const opened = await openSecret(env.CREDENTIAL_ENC_KEY, sealed);
  if (!opened) return apiError("INTERNAL", "凭据读取失败", { reason: "credential_corrupt" });
  const secret = JSON.parse(opened) as { host: string; port: number; password: string; method: string };

  const issuedAt = Date.now();
  const payload = JSON.stringify({
    server_id: row.id,
    node_id: row.node_id,
    host: secret.host ?? row.ip,
    port: secret.port,
    method: secret.method,
    password: secret.password,
    issued_at: new Date(issuedAt).toISOString(),
    expires_at: new Date(issuedAt + CREDENTIAL_TTL_MS).toISOString(),
  });
  const signature = await signDetached(env.CREDENTIAL_SIGNING_JWK, payload);

  return json({ payload, signature, key_id: CREDENTIAL_KEY_ID });
}

export async function handleServers(request: Request, env: ServersEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const post = request.method === "POST";

  if (parts[0] === "v1" && parts[1] === "enroll" && parts.length === 3 && post) {
    return enroll(request, env, parts[2]);
  }
  if (parts[0] !== "v1" || parts[1] !== "servers") return null;

  if (parts.length === 2 && request.method === "GET") return listServers(request, env);
  if (parts.length === 3 && request.method === "GET") return getServer(request, env, parts[2]);
  if (parts.length === 4 && post) {
    if (parts[3] === "destroy") return destroy(request, env, parts[2]);
    if (parts[3] === "credentials") return credentials(request, env, parts[2]);
    if (parts[3] === "rebuild") {
      return apiError("PRECONDITION_FAILED", "重建还没接入", {
        reason: "rebuild_not_supported",
      });
    }
  }
  return null;
}
