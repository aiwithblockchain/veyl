// 建机：先确保全局共享防火墙存在，再建 droplet，把一次性 enrollment 令牌写进 cloud-init（§19.6）。
// 可重试失败（429/5xx/超时）只把服务器标成 error、订单退回 paid，交给每日 Cron 重试——
// 钱已经收了，订单不能停在终态。非可重试失败（其余 4xx）用户拿不到机器，直接退款关单。

import { buildCloudInit } from "./cloud_init";
import { randomId, sha256B64u } from "./lib/crypto";
import {
  createDroplet,
  deleteDroplet,
  ensureSharedFirewall,
  SHARED_FIREWALL_TAG,
} from "./providers/digitalocean";
import { recordLedgerEntry } from "./wallet";

export interface ProvisionEnv {
  DB: D1Database;
  DO_API_TOKEN?: string;
  ENROLL_BASE_URL?: string;
  ENVIRONMENT: string;
  /** agent 二进制：版本 / sha256 / 下载地址（控制面配置，cloud-init 只认这三个值）。 */
  AGENT_VERSION?: string;
  AGENT_SHA256?: string;
  AGENT_DOWNLOAD_URL?: string;
  /** agent 拉起后要装的 sing-box：版本 / sha256 / 下载地址。 */
  SING_BOX_VERSION?: string;
  SING_BOX_SHA256?: string;
  SING_BOX_DOWNLOAD_URL?: string;
}

/** 构建信息必须是「能真的下载并校验」的形状：占位符/手滑都让订单在建机前失败。 */
export function usableBuild(input: { version: string; sha256: string; url: string }): boolean {
  return (
    // 版本会被 agent 拼进下载目录名，只允许安全字符集。
    /^[0-9A-Za-z._-]{1,32}$/.test(input.version) &&
    /^[0-9a-f]{64}$/i.test(input.sha256) &&
    input.url.startsWith("https://")
  );
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
  | { ok: false; reason: string; retryable: boolean; refunded?: boolean };

/**
 * 一次性 enrollment token 的有效期，**同时是 agent 丢 state.json 后的重放窗口**。
 * 正常建机只要 2–3 分钟；原来的 45 分钟会让一台确定卡住的机器白占计费，2026-11-22 收紧到 20 分钟。
 * 取舍：恢复窗口也随之缩短到 20 分钟——丢状态基本发生在重启后的头几分钟，超过窗口的机器
 * 交给 sweepExpiredEnrollments 销毁重建，这是可接受的。
 */
const ENROLL_TTL_MS = 20 * 60 * 1000;

async function fail(
  env: ProvisionEnv,
  server: ServerToProvision,
  reason: string,
  options: { retryable?: boolean; upstream?: string } = {},
): Promise<ProvisionResult> {
  const retryable = options.retryable ?? true;
  const now = Date.now();
  const detail = JSON.stringify(
    options.upstream ? { reason, upstream: options.upstream } : { reason },
  );

  if (!retryable) return failPermanently(env, server, reason, detail, now);

  // at_ready 订单还没扣过钱，Cron 的补建只服务存量 upfront 单：
  // 重试性失败也直接关单，让用户重新下单，避免订单停在无人处理的 paid。
  const mode = await env.DB.prepare("SELECT charge_mode FROM orders WHERE id = ?")
    .bind(server.order_id)
    .first<{ charge_mode: string | null }>();
  if (mode?.charge_mode === "at_ready") {
    return failPermanently(env, server, reason, detail, now);
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE servers SET state = 'error', failure_code = ?, updated_at = ? WHERE id = ?")
      .bind(reason, now, server.id),
    env.DB.prepare(
      "UPDATE orders SET state = 'paid', failure_code = ?, failure_stage = 'creating' " +
        "WHERE id = ? AND state IN ('paid', 'provisioning')",
    ).bind(reason, server.order_id),
    env.DB.prepare(
      "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'provision.failed', ?)",
    ).bind(now, server.account_id, server.id, detail),
  ]);
  return { ok: false, reason, retryable: true };
}

/**
 * 非可重试失败：订单关掉（Cron 不再补建同一组参数），当天扣费原样退回。
 * 退款以 `(server_refund, server_id)` 为幂等键，与销毁退款共用同一把锁——
 * 服务器之后被销毁也不会退第二次。
 */
export async function failPermanently(
  env: { DB: D1Database },
  server: ServerToProvision,
  reason: string,
  detail: string,
  now: number,
): Promise<ProvisionResult> {
  const order = await env.DB.prepare("SELECT id, amount_cents, paid_via FROM orders WHERE id = ?")
    .bind(server.order_id)
    .first<{ id: string; amount_cents: number; paid_via: string | null }>();

  await env.DB.batch([
    env.DB.prepare("UPDATE servers SET state = 'error', failure_code = ?, updated_at = ? WHERE id = ?")
      .bind(reason, now, server.id),
    env.DB.prepare(
      "UPDATE orders SET state = 'failed', failure_code = ?, failure_stage = ? " +
        "WHERE id = ? AND state IN ('paid', 'provisioning')",
    ).bind(reason, "creating", server.order_id),
    env.DB.prepare(
      "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'provision.failed', ?)",
    ).bind(now, server.account_id, server.id, detail),
  ]);

  const refundCents = Number(order?.amount_cents ?? 0);
  // 没扣过钱就不能退：at_ready 在结算前失败属于这一类；存量 upfront 才有 charge 流水。
  const charged = await env.DB.prepare(
    "SELECT id FROM wallet_ledger WHERE ref_type = 'order' AND ref_id = ? AND kind = 'charge'",
  )
    .bind(server.order_id)
    .first<{ id: string }>();
  if (order?.paid_via !== "wallet" || refundCents <= 0 || !charged) {
    if (!charged) {
      await env.DB.prepare(
        "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'refund_skipped_no_charge', ?)",
      )
        .bind(now, server.account_id, server.id, JSON.stringify({ order_id: server.order_id, reason }))
        .run()
        .catch(() => {});
    }
    return { ok: false, reason, retryable: false, refunded: false };
  }
  const refund = await refundProvision(env, {
    accountId: server.account_id,
    orderId: server.order_id,
    serverId: server.id,
    amountCents: refundCents,
    reason,
    now,
  });
  if (refund.ok) return { ok: false, reason, retryable: false, refunded: true };

  // 退款失败不能静默：留证，计费 Cron 会按「扣了没退」的记录每轮重试。
  console.warn(`[provision] refund_failed order=${server.order_id} reason=${refund.reason}`);
  await env.DB.prepare(
    "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'provision.refund_failed', ?)",
  )
    .bind(
      now,
      server.account_id,
      server.id,
      JSON.stringify({ order_id: server.order_id, amount_cents: refundCents, error: refund.reason }),
    )
    .run()
    .catch(() => {});
  return { ok: false, reason, retryable: false, refunded: false };
}

export interface RefundEnv {
  DB: D1Database;
}

/**
 * 退回一台失败机器已扣的钱；同一 `(server_refund, server_id)` 只退一次。
 * 建机失败与计费 Cron 的补退共用：`duplicate` 说明钱已经在账上，按成功处理。
 */
export async function refundProvision(
  env: RefundEnv,
  input: {
    accountId: string;
    orderId: string;
    serverId: string;
    amountCents: number;
    reason: string;
    now?: number;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const refund = await recordLedgerEntry(env, {
    accountId: input.accountId,
    kind: "adjustment",
    amountCents: input.amountCents,
    refType: "server_refund",
    refId: input.serverId,
    note: `建机失败退款：${input.reason}`,
  });
  if (!refund.ok) {
    return refund.reason === "duplicate" ? { ok: true } : { ok: false, reason: refund.reason };
  }
  await env.DB.prepare(
    "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'provision.refunded', ?)",
  )
    .bind(
      input.now ?? Date.now(),
      input.accountId,
      input.serverId,
      JSON.stringify({
        order_id: input.orderId,
        amount_cents: input.amountCents,
        reason: input.reason,
      }),
    )
    .run()
    // 钱已经退了，审计写不进去不能反过来把主流程带崩。
    .catch(() => {});
  return { ok: true };
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
  const baseUrl = env.ENROLL_BASE_URL.replace(/\/$/, "");
  const agent = {
    version: env.AGENT_VERSION?.trim() ?? "",
    sha256: env.AGENT_SHA256?.trim() ?? "",
    url: env.AGENT_DOWNLOAD_URL?.trim() ?? "",
  };
  const singbox = {
    version: env.SING_BOX_VERSION?.trim() ?? "",
    sha256: env.SING_BOX_SHA256?.trim() ?? "",
    url: env.SING_BOX_DOWNLOAD_URL?.trim() ?? "",
  };
  // 缺任何一个都装不出 agent：宁可整单失败，也不建一台连不上控制面的机器。
  if (!usableBuild(agent) || !usableBuild(singbox)) {
    // 这些是构建信息（版本 / 公开下载地址 / sha 长度），不含任何凭据；没有它们分不清缺哪一项。
    console.warn(
      `[provision] agent_unconfigured server=${server.id}` +
        ` agent={version:${agent.version || "empty"},url:${agent.url || "empty"},sha_len:${agent.sha256.length}}` +
        ` singbox={version:${singbox.version || "empty"},url:${singbox.url || "empty"},sha_len:${singbox.sha256.length}}`,
    );
    return fail(env, server, "agent_unconfigured", { retryable: false });
  }
  // cloud-init 会把 token / URL / 版本拼进 shell：越权字符一律不建机（永久失败 + 退款）。
  let userData: string;
  try {
    userData = buildCloudInit({
      enrollToken,
      enrollUrl: `${baseUrl}/v1/agent/enroll`,
      failUrl: `${baseUrl}/v1/agent/fail`,
      controlUrl: baseUrl,
      agent,
    });
  } catch (error) {
    console.warn(`[provision] cloud_init_invalid server=${server.id} error=${String(error)}`);
    return fail(env, server, "cloud_init_invalid", { retryable: false });
  }

  // 防火墙先于 Droplet：ensure 失败就整单失败，绝不建出一台没有防火墙的机器（§3.4）。
  // Droplet 建机时就带 `veyl:node`，建好即受全局规则保护，没有先建机器后挂规则的裸奔窗口。
  const firewall = await ensureSharedFirewall(env.DO_API_TOKEN);
  if (!firewall.ok) {
    return fail(env, server, "firewall_failed", {
      retryable: firewall.retryable,
      upstream: firewall.upstream,
    });
  }

  const created = await createDroplet(env.DO_API_TOKEN, {
    // DO 要求 name 匹配 ^[a-zA-Z0-9]?[a-z0-9A-Z.\-]*[a-z0-9A-Z]$：
    // 随机 id 是 base64url，可能含 `_`，必须先替换掉，且末位要是字母或数字。
    name: `veyl-${server.id.replace(/^srv_/, "").slice(0, 12)}`
      .replace(/[^A-Za-z0-9.-]/g, "-")
      .replace(/[.-]$/, "0"),
    region: server.region,
    size: server.plan,
    image: "ubuntu-24-04-x64",
    userData,
    // tag 名只允许字母数字、下划线、连字符、冒号（^[a-zA-Z0-9_\-:]+$），不能有 `=`。
    // acct 用完整 account_id：这是「从云上机器反查用户」的唯一线索，不能截断。
    tags: [
      `veyl:srv:${server.id}`,
      `veyl:acct:${server.account_id}`,
      `veyl:env:${env.ENVIRONMENT}`,
      // 全局共享防火墙按这个 tag 覆盖所有节点，dev / prod 共用同一条。
      SHARED_FIREWALL_TAG,
    ],
  });

  if (!created.ok) {
    return fail(env, server, created.reason, {
      retryable: created.retryable,
      upstream: created.upstream,
    });
  }

  const now = Date.now();
  try {
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
  } catch (error) {
    // 机器已经建出来了但没记进库：立刻删掉，否则它会成为一台没有记录、无人管理的计费实例。
    await deleteDroplet(env.DO_API_TOKEN, created.value.providerId);
    return fail(env, server, "db_write_failed");
  }

  return { ok: true, providerId: created.value.providerId, ip: created.value.ipv4 };
}
