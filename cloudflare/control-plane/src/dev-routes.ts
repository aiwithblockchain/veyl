// 开发环境的诊断路由。**只在 dev 入口（src/dev.ts）装配**，生产入口 src/index.ts 不 import 本模块，
// 因此这些路由不会被编进生产包——比字符串门禁更强：即使 ENVIRONMENT 写错，生产也没有这些路径。
//
// 原先这里的 Vultr 诊断路由（vultr / vultr-browser / vultr-ua / vultr-public / probes）随供应商
// 换成 DigitalOcean 一并删除。

import { buildCloudInit } from "./cloud_init";
import { deleteDroplet } from "./providers/digitalocean";
import { runBilling } from "./billing";
import { startTopupSession } from "./topups";
import { balanceCents } from "./wallet";
import { doGet, json, PLAN_SLUGS, USER_AGENT, type Env } from "./index";

/**
 * 处理 `/v1/debug/*`。非 dev 环境一律返回 null，交给生产入口——入口层已经保证只有 dev 会装这个模块，
 * 这一句是第二道闸。
 */
export async function handleDevRoutes(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (env.ENVIRONMENT !== "dev") return null;

  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/debug/")) return null;

  // DigitalOcean API 是否接受 Cloudflare Worker 出口（不带 key，401 即代表可达）。
  if (url.pathname === "/v1/debug/do") {
    try {
      const res = await fetch("https://api.digitalocean.com/v2/regions", {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      });
      const text = await res.text();
      return json({
        ok: res.ok,
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: text.slice(0, 160),
      });
    } catch (error) {
      return json({ ok: false, status: 0, error: `network: ${String(error)}` }, 502);
    }
  }

  // 按 provider_id 查一台 droplet 的真实状态与 IP（排查卡在 booting 的机器）。
  if (url.pathname === "/v1/debug/droplet") {
    if (!env.DO_API_TOKEN) return json({ ok: false, error: "missing_secret" }, 500);
    const id = url.searchParams.get("id");
    if (!id) return json({ ok: false, error: "missing_id" }, 400);
    const res = await fetch(
      `https://api.digitalocean.com/v2/droplets/${encodeURIComponent(id)}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${env.DO_API_TOKEN}`,
          "User-Agent": USER_AGENT,
        },
      },
    );
    const text = await res.text();
    if (!res.ok) return json({ ok: false, status: res.status, body: text.slice(0, 200) }, 502);
    const body = JSON.parse(text) as {
      droplet?: {
        status?: string;
        created_at?: string;
        networks?: { v4?: Array<{ ip_address: string; type: string }> };
      };
    };
    return json({
      ok: true,
      status: body.droplet?.status ?? null,
      created_at: body.droplet?.created_at ?? null,
      ips: (body.droplet?.networks?.v4 ?? []).map((n) => ({ ip: n.ip_address, type: n.type })),
    });
  }

  // 给已有服务器的防火墙补一条入站 ICMP（诊断用）。新建机器已经默认带。
  if (url.pathname === "/v1/debug/firewall-icmp") {
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    if (!env.DO_API_TOKEN) return json({ ok: false, error: "missing_secret" }, 500);
    if (!env.DB) return json({ ok: false, error: "missing_db" }, 500);
    const id = url.searchParams.get("id");
    if (!id) return json({ ok: false, error: "missing_id" }, 400);

    const row = await env
      .DB.prepare("SELECT firewall_id FROM servers WHERE id = ?")
      .bind(id)
      .first<{ firewall_id: string | null }>();
    if (!row) return json({ ok: false, error: "not_found" }, 404);
    const firewallId = row.firewall_id;
    if (!firewallId) return json({ ok: false, error: "no_firewall" }, 422);

    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${env.DO_API_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    const endpoint = `https://api.digitalocean.com/v2/firewalls/${encodeURIComponent(firewallId)}`;

    const current = await fetch(endpoint, { headers });
    const currentText = await current.text();
    if (!current.ok) {
      return json(
        { ok: false, error: "upstream", status: current.status, body: currentText.slice(0, 200) },
        502,
      );
    }
    const firewall = (
      JSON.parse(currentText) as {
        firewall?: {
          name?: string;
          inbound_rules?: unknown[];
          outbound_rules?: unknown[];
          droplet_ids?: unknown[];
          tags?: unknown[];
        };
      }
    ).firewall;
    const inboundRules = firewall?.inbound_rules ?? [];
    // 只认「面向全网的 icmp」：来源不是全网的规则满足不了 ping 诊断，仍要追加。
    const publicIcmp = (rule: unknown) => {
      const entry = rule as { protocol?: string; sources?: { addresses?: unknown } };
      if (entry.protocol !== "icmp") return false;
      const addresses = Array.isArray(entry.sources?.addresses) ? entry.sources.addresses : [];
      return addresses.includes("0.0.0.0/0") && addresses.includes("::/0");
    };
    if (inboundRules.some(publicIcmp)) {
      return json({ ok: true, changed: false, inbound_rules: inboundRules });
    }

    const icmp = {
      protocol: "icmp",
      ports: "0",
      sources: { addresses: ["0.0.0.0/0", "::/0"] },
    };
    const nextInbound = [...inboundRules, icmp];
    // DO 的 PUT 是全量替换：出站、droplet_ids 与 tags 必须原样带上，
    // 不能赌「省略 = 保持不变」——真被清空，正在跑的机器会瞬间失去防火墙。
    const updated = await fetch(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: firewall?.name,
        inbound_rules: nextInbound,
        outbound_rules: firewall?.outbound_rules ?? [],
        droplet_ids: firewall?.droplet_ids ?? [],
        tags: firewall?.tags ?? [],
      }),
    });
    const updatedText = await updated.text();
    if (!updated.ok) {
      return json(
        { ok: false, error: "upstream", status: updated.status, body: updatedText.slice(0, 200) },
        502,
      );
    }
    return json({ ok: true, changed: true, inbound_rules: nextInbound });
  }

  // 输出当前版本的 cloud-init 脚本，供手动建机调试（lab=1 时不关 SSH、不回传）。
  if (url.pathname === "/v1/debug/cloud-init") {
    const port = Number(url.searchParams.get("port") ?? "0");
    const enroll = url.searchParams.get("enroll") ?? "";
    if (!port || !enroll) return json({ ok: false, error: "missing_params" }, 400);
    let script = buildCloudInit({ port, enrollUrl: enroll });
    if (url.searchParams.get("lab") === "1") {
      script = script
        .replace(/^systemctl (stop|disable) ssh.*$/gm, "# (lab) 保留 SSH")
        .replace("report() {", "report() { return 0; # lab：不回传");
    }
    return new Response(script, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // 确认 Worker 能正常发起对外 HTTPS 子请求，并显示出口 IP。
  if (url.pathname === "/v1/debug/egress") {
    try {
      const res = await fetch("https://api.ipify.org?format=json", {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      });
      const text = await res.text();
      return json({ ok: res.ok, status: res.status, body: text.slice(0, 200) });
    } catch (error) {
      return json({ ok: false, status: 0, error: `network: ${String(error)}` }, 502);
    }
  }

  // 验证 DO_API_TOKEN 的 region/size/image 读权限，并给出向导所需的目录。
  if (url.pathname === "/v1/debug/do-catalog") {
    if (!env.DO_API_TOKEN) return json({ ok: false, error: "missing_secret" }, 500);

    const [regions, sizes, images] = await Promise.all([
      doGet("/regions?per_page=200", env.DO_API_TOKEN),
      doGet("/sizes?per_page=200", env.DO_API_TOKEN),
      doGet("/images?type=distribution&per_page=200", env.DO_API_TOKEN),
    ]);

    const regionList =
      (regions.data as { regions?: Array<{ slug: string; name: string; available: boolean }> })
        ?.regions ?? [];
    const sizeList =
      (sizes.data as {
        sizes?: Array<{
          slug: string;
          memory: number;
          vcpus: number;
          price_hourly: number;
          price_monthly: number;
          transfer?: number;
          regions: string[];
        }>;
      })?.sizes ?? [];
    const imageList =
      (images.data as {
        images?: Array<{ slug: string | null; id: number; name: string }>;
      })?.images ?? [];

    const available = regionList.filter((r) => r.available).map((r) => r.slug);
    const ubuntu = imageList.find((i) => i.slug === "ubuntu-24-04-x64");

    return json(
      {
        ok: regions.ok && sizes.ok && images.ok,
        endpoints: {
          regions: { status: regions.status, ok: regions.ok, error: regions.error },
          sizes: { status: sizes.status, ok: sizes.ok, error: sizes.error },
          images: { status: images.status, ok: images.ok, error: images.error },
        },
        regions: { count: available.length, slugs: available },
        // 每个在售套餐的真实可用地区：联调/验收直接看这里，不看推断。
        plans: PLAN_SLUGS.map((slug) => {
          const size = sizeList.find((s) => s.slug === slug);
          return size
            ? {
                slug,
                regions: size.regions ?? null,
                memory: size.memory,
                vcpus: size.vcpus,
                price_hourly: size.price_hourly,
                price_monthly: size.price_monthly,
                transfer: size.transfer ?? null,
              }
            : null;
        }),
        sizes: {
          count: sizeList.length,
          cheapest: sizeList
            .slice()
            .sort((a, b) => a.price_monthly - b.price_monthly)
            .slice(0, 5)
            .map((s) => ({
              slug: s.slug,
              vcpus: s.vcpus,
              memory_mb: s.memory,
              usd_per_month: s.price_monthly,
            })),
        },
        ubuntu_24_04: ubuntu
          ? { id: ubuntu.id, slug: ubuntu.slug, name: ubuntu.name }
          : null,
      },
      regions.ok && sizes.ok && images.ok ? 200 : 502,
    );
  }

  // 清库前把在跑的实验机销毁，避免留下无人计费的实例。
  if (url.pathname === "/v1/debug/destroy") {
    if (!env.DB || !env.DO_API_TOKEN) return json({ ok: false, error: "not_configured" }, 503);
    const serverId = url.searchParams.get("server") ?? "";
    const row = await env.DB.prepare("SELECT id, provider_id FROM servers WHERE id = ?")
      .bind(serverId)
      .first<{ id: string; provider_id: string | null }>();
    if (!row) return json({ ok: false, error: "server_missing" }, 404);
    if (!row.provider_id) return json({ ok: true, deleted: false, reason: "no_provider_id" });
    const result = await deleteDroplet(env.DO_API_TOKEN, row.provider_id);
    await env.DB.prepare("UPDATE servers SET state = 'destroyed', destroyed_at = ?, updated_at = ? WHERE id = ?")
      .bind(Date.now(), Date.now(), row.id)
      .run();
    return json({ ok: result.ok, provider_id: row.provider_id, reason: result.ok ? undefined : result.reason });
  }

  // 没有界面时手动造一个邮箱账户，配合下面的充值调试入口联调支付。
  if (url.pathname === "/v1/debug/account") {
    if (!env.DB) return json({ ok: false, error: "db_unavailable" }, 503);
    const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) return json({ ok: false, error: "email_required" }, 400);
    const existing = await env.DB.prepare("SELECT id, email, balance_cents FROM accounts WHERE email = ?")
      .bind(email)
      .first<{ id: string; email: string; balance_cents: number }>();
    if (existing) return json({ ok: true, created: false, ...existing });
    const accountId = `acct_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await env.DB.prepare("INSERT INTO accounts (id, kind, email, status, created_at, balance_cents) VALUES (?, 'email', ?, 'active', ?, 0)")
      .bind(accountId, email, Date.now())
      .run();
    return json({ ok: true, created: true, id: accountId, email, balance_cents: 0 });
  }

  // 没有界面时手动开一笔充值 / 查余额，用真实收银台联调。
  if (url.pathname === "/v1/debug/topup" || url.pathname === "/v1/debug/wallet") {
    if (!env.DB) return json({ ok: false, error: "db_unavailable" }, 503);
    const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
    if (!email) return json({ ok: false, error: "email_required" }, 400);
    const account = await env.DB.prepare("SELECT id, email FROM accounts WHERE email = ?")
      .bind(email)
      .first<{ id: string; email: string }>();
    if (!account) return json({ ok: false, error: "account_missing" }, 404);

    if (url.pathname === "/v1/debug/wallet") {
      return json({ ok: true, account_id: account.id, balance_cents: await balanceCents(env, account.id) });
    }
    const cents = Number(url.searchParams.get("cents"));
    if (!Number.isInteger(cents)) return json({ ok: false, error: "cents_required" }, 400);
    // 默认走真实 Dodo test 收银台；加 ?fake=1 直接入账，用于没有收银台时的快速联调。
    const mode = url.searchParams.get("fake") === "1" ? "fake" : "dodo";
    const started = await startTopupSession(env, { accountId: account.id, email: account.email, cents, mode });
    return json(started);
  }

  // 手动跑一次每日任务（续费/补建/对账），不必等 Cron。
  if (url.pathname === "/v1/debug/billing") {
    if (!env.DB) return json({ ok: false, error: "db_unavailable" }, 503);
    return json({ ok: true, report: await runBilling(env) });
  }

  // 逐个探测 token 的读权限边界（能读 / 被拒），确认最小权限刚好够用。
  if (url.pathname === "/v1/debug/do-scopes") {
    if (!env.DO_API_TOKEN) return json({ ok: false, error: "missing_secret" }, 500);

    const probes: Array<[string, string]> = [
      ["regions", "/regions?per_page=1"],
      ["sizes", "/sizes?per_page=1"],
      ["images", "/images?per_page=1"],
      ["droplets", "/droplets?per_page=1"],
      ["firewalls", "/firewalls?per_page=1"],
      ["account", "/account"],
      ["billing_balance", "/customers/my/balance"],
    ];

    const results: Record<string, { status: number; verdict: string; error?: string }> = {};
    await Promise.all(
      probes.map(async ([name, path]) => {
        const r = await doGet(path, env.DO_API_TOKEN!);
        results[name] = {
          status: r.status,
          verdict: r.ok ? "allowed" : r.status === 403 ? "denied" : "error",
          error: r.error,
        };
      }),
    );

    return json({ ok: true, results });
  }

  return json({ ok: false, error: "not_found" }, 404);
}
