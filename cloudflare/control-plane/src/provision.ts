// 建机：先建 droplet，把一次性 enrollment 令牌写进 cloud-init（§19.6）。
// 失败一律把服务器与订单标为失败，不留下“创建中”的僵尸行。

import { buildCloudInit } from "./cloud_init";
import { randomId, sha256B64u } from "./lib/crypto";
import { createDroplet } from "./providers/digitalocean";

export interface ProvisionEnv {
  DB: D1Database;
  DO_API_TOKEN?: string;
  ENROLL_BASE_URL?: string;
  ENVIRONMENT: string;
}

export interface ServerToProvision {
  id: string;
  account_id: string;
  order_id: string;
  region: string;
  plan: string;
  node_port: number;
}

export type ProvisionResult =
  | { ok: true; providerId: string; ip: string | null }
  | { ok: false; reason: string; retryable: boolean };

const ENROLL_TTL_MS = 45 * 60 * 1000;

async function fail(
  env: ProvisionEnv,
  server: ServerToProvision,
  reason: string,
): Promise<ProvisionResult> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE servers SET state = 'error', updated_at = ? WHERE id = ?")
      .bind(now, server.id),
    env.DB.prepare(
      "UPDATE orders SET state = 'failed', failure_code = ?, failure_stage = 'creating' WHERE id = ?",
    ).bind(reason, server.order_id),
    env.DB.prepare(
      "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'provision.failed', ?)",
    ).bind(now, server.account_id, server.id, JSON.stringify({ reason })),
  ]);
  return { ok: false, reason, retryable: true };
}

export async function provisionServer(
  env: ProvisionEnv,
  server: ServerToProvision,
): Promise<ProvisionResult> {
  if (!env.DO_API_TOKEN || !env.ENROLL_BASE_URL) {
    return fail(env, server, "provider_unconfigured");
  }

  const enrollToken = randomId("enr_", 32);
  const enrollHash = await sha256B64u(enrollToken);
  const enrollUrl = `${env.ENROLL_BASE_URL.replace(/\/$/, "")}/v1/enroll/${enrollToken}`;
  const userData = buildCloudInit({ port: server.node_port, enrollUrl });

  const created = await createDroplet(env.DO_API_TOKEN, {
    name: `veyl-${server.id.replace(/^srv_/, "").slice(0, 12)}`,
    region: server.region,
    size: server.plan,
    image: "ubuntu-24-04-x64",
    userData,
    tags: [`veyl:srv=${server.id}`, `veyl:acct=${server.account_id.slice(0, 9)}`, `veyl:env=${env.ENVIRONMENT}`],
  });

  if (!created.ok) return fail(env, server, created.reason);

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE servers SET provider_id = ?, ip = ?, state = 'booting', enrollment_hash = ?, " +
        "enrollment_expires_at = ?, updated_at = ? WHERE id = ?",
    ).bind(
      created.value.providerId,
      created.value.ipv4,
      enrollHash,
      now + ENROLL_TTL_MS,
      now,
      server.id,
    ),
    env.DB.prepare(
      "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'provision.created', ?)",
    ).bind(
      now,
      server.account_id,
      server.id,
      JSON.stringify({ provider_id: created.value.providerId, region: server.region }),
    ),
  ]);

  return { ok: true, providerId: created.value.providerId, ip: created.value.ipv4 };
}
