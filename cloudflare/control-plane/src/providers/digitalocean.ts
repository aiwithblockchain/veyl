// DigitalOcean 建机与防火墙（§19.6）。只暴露我们会用到的最小面：
// 建 droplet、查状态与 IP、销毁、建防火墙并带上目标 droplet。
// 字段名以官方文档为准（docs.digitalocean.com/reference/api/reference/）。

const API = "https://api.digitalocean.com/v2";
const TIMEOUT_MS = 20_000;

export interface ProviderError {
  ok: false;
  status: number;
  reason: string;
  retryable: boolean;
  /** 上游响应体（截断 300 字、去掉换行）：`upstream_422` 之类的码看不出原因，靠它诊断。 */
  upstream?: string;
}

export type ProviderResult<T> = { ok: true; value: T } | ProviderError;

async function call<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<ProviderResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "veyl-control-plane/0.0.0",
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      const upstream = text.replace(/\s+/g, " ").trim().slice(0, 300);
      console.warn(
        `[digitalocean] ${init.method ?? "GET"} ${path} → ${response.status} ${upstream}`,
      );
      return {
        ok: false,
        status: response.status,
        reason: `upstream_${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
        upstream,
      };
    }
    if (text.trim() === "") return { ok: true, value: undefined as T };
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    console.warn(
      `[digitalocean] ${init.method ?? "GET"} ${path} → ${aborted ? "timeout" : "network"}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      ok: false,
      status: 0,
      reason: aborted ? "timeout" : "network",
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface DropletSummary {
  providerId: string;
  status: string;
  ipv4: string | null;
}

function summarise(droplet: {
  id: number;
  status?: string;
  networks?: { v4?: Array<{ ip_address: string; type: string }> };
}): DropletSummary {
  const publicV4 = droplet.networks?.v4?.find((entry) => entry.type === "public");
  return {
    providerId: String(droplet.id),
    status: droplet.status ?? "unknown",
    ipv4: publicV4?.ip_address ?? null,
  };
}

export async function createDroplet(
  token: string,
  input: {
    name: string;
    region: string;
    size: string;
    image: string;
    userData: string;
    tags: string[];
  },
): Promise<ProviderResult<DropletSummary>> {
  const result = await call<{ droplet: Parameters<typeof summarise>[0] }>(token, "/droplets", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      region: input.region,
      size: input.size,
      image: input.image,
      user_data: input.userData,
      tags: input.tags,
      ipv6: true,
      monitoring: true,
    }),
  });
  if (!result.ok) return result;
  return { ok: true, value: summarise(result.value.droplet) };
}

export async function getDroplet(
  token: string,
  providerId: string,
): Promise<ProviderResult<DropletSummary>> {
  const result = await call<{ droplet: Parameters<typeof summarise>[0] }>(
    token,
    `/droplets/${encodeURIComponent(providerId)}`,
  );
  if (!result.ok) return result;
  return { ok: true, value: summarise(result.value.droplet) };
}

export async function deleteDroplet(
  token: string,
  providerId: string,
): Promise<ProviderResult<void>> {
  return call<void>(token, `/droplets/${encodeURIComponent(providerId)}`, { method: "DELETE" });
}

/** DO 只接受字母、数字、点和连字符：机器 ID 是 base64url，可能带 `_`。 */
export function firewallName(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9.-]/g, "-")
    .replace(/^[.\-]+/, "")
    .replace(/[.\-]+$/, "");
  return (cleaned || "veyl-firewall").slice(0, 255);
}

/**
 * 节点端口的固定带（`shared-firewall.md` §3.1/§3.2）：共享防火墙只放行这一段，
 * `pickPort` 也只在这一段里分配。改带等于改规则，属于一次性迁移。
 */
export const NODE_PORT_START = 30000;
export const NODE_PORT_END = 30999;
/** agent 控制端口：固定且必须在端口带外，便于单独鉴权与限流。 */
export const AGENT_CONTROL_PORT = 32100;
/** 全局共享防火墙：dev / prod 共用一条，名称与 tag 固定，不按环境区分。 */
export const SHARED_FIREWALL_NAME = "veyl-shared-node-firewall";
export const SHARED_FIREWALL_TAG = "veyl:node";

interface FirewallRuleBody {
  protocol: "tcp" | "udp" | "icmp";
  ports: string;
  sources?: { addresses: string[] };
  destinations?: { addresses: string[] };
}

const ANY_ADDRESS = ["0.0.0.0/0", "::/0"];

/** 共享防火墙的固定规则（§3.1）：建机与测试都从这里取，避免各写一份。 */
export function sharedFirewallRules(): {
  inbound: FirewallRuleBody[];
  outbound: FirewallRuleBody[];
} {
  const band = `${NODE_PORT_START}-${NODE_PORT_END}`;
  return {
    inbound: [
      { protocol: "tcp", ports: band, sources: { addresses: ANY_ADDRESS } },
      { protocol: "udp", ports: band, sources: { addresses: ANY_ADDRESS } },
      { protocol: "tcp", ports: String(AGENT_CONTROL_PORT), sources: { addresses: ANY_ADDRESS } },
      // ICMP 入站：诊断用（ping 能区分「包没到 DO」与「到了被丢」）。DO 的 ICMP 端口写 "0"。
      { protocol: "icmp", ports: "0", sources: { addresses: ANY_ADDRESS } },
    ],
    outbound: [
      { protocol: "tcp", ports: "all", destinations: { addresses: ANY_ADDRESS } },
      { protocol: "udp", ports: "all", destinations: { addresses: ANY_ADDRESS } },
      { protocol: "icmp", ports: "0", destinations: { addresses: ANY_ADDRESS } },
    ],
  };
}

export async function deleteFirewall(token: string, firewallId: string): Promise<ProviderResult<void>> {
  return call<void>(token, `/firewalls/${encodeURIComponent(firewallId)}`, { method: "DELETE" });
}

/**
 * DO 只允许把**已存在**的 tag 挂到资源上。防火墙现在先于 Droplet 创建，
 * `veyl:node` 那时还不存在（Droplet 建机时顺带建 tag 发生在后面），所以要先建出来。
 * 重复创建 tag 时 DO 返回 422，按「已存在」处理。
 */
export async function ensureTag(token: string, tag: string): Promise<ProviderResult<void>> {
  const created = await call<unknown>(token, "/tags", {
    method: "POST",
    body: JSON.stringify({ name: tag }),
  });
  if (created.ok || created.status === 422) return { ok: true, value: undefined };
  return created;
}

export interface FirewallSummary {
  id: string;
  name: string;
  droplet_ids: number[];
  tags: string[];
}

/**
 * 列出本账户的全部防火墙。账户内最多 2 条（节点一条、临时 SSH 一条），
 * 一页 200 条就能看全，不需要翻页。销毁路径用它按确定性命名为存量机器找回规则；
 * `ensureSharedFirewall` 用它按固定名称找全局共享防火墙（DO 的列表接口不支持按名称过滤）。
 */
export async function listFirewalls(token: string): Promise<ProviderResult<FirewallSummary[]>> {
  const result = await call<{
    firewalls?: Array<{
      id?: unknown;
      name?: unknown;
      droplet_ids?: unknown;
      tags?: unknown;
    }>;
  }>(token, "/firewalls?per_page=200");
  if (!result.ok) return result;
  const firewalls: FirewallSummary[] = [];
  for (const raw of result.value?.firewalls ?? []) {
    if (typeof raw?.id !== "string" || typeof raw?.name !== "string") continue;
    firewalls.push({
      id: raw.id,
      name: raw.name,
      droplet_ids: Array.isArray(raw.droplet_ids)
        ? raw.droplet_ids.filter((id): id is number => typeof id === "number")
        : [],
      tags: Array.isArray(raw.tags)
        ? raw.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
    });
  }
  return { ok: true, value: firewalls };
}

/**
 * 全局只留一条共享防火墙（§3.1）：按固定名称找，找不到才创建。
 * Droplet 建机时都带 tag `veyl:node`，因此不需要把 droplet id 写进 `droplet_ids`。
 *
 * 命中后不看 tag、也不比对规则：人工可能往这条防火墙里加临时 SSH 规则，
 * 这里不覆盖、不修改。ensure 失败必须让建机整单失败——绝不留裸奔的机器。
 */
export async function ensureSharedFirewall(
  token: string,
): Promise<ProviderResult<{ id: string }>> {
  const listed = await listFirewalls(token);
  if (!listed.ok) return listed;

  const existing = listed.value.find((fw) => fw.name === SHARED_FIREWALL_NAME);
  if (existing) return { ok: true, value: { id: existing.id } };

  // 命中已有的说明 tag 早就挂着了；只有准备创建时才需要先把 tag 建出来。
  const tag = await ensureTag(token, SHARED_FIREWALL_TAG);
  if (!tag.ok) return tag;

  const rules = sharedFirewallRules();
  const created = await call<{ firewall?: { id?: unknown } }>(token, "/firewalls", {
    method: "POST",
    body: JSON.stringify({
      name: SHARED_FIREWALL_NAME,
      tags: [SHARED_FIREWALL_TAG],
      inbound_rules: rules.inbound,
      outbound_rules: rules.outbound,
    }),
  });
  if (!created.ok) return created;
  const createdId = created.value?.firewall?.id;
  if (createdId === undefined || createdId === null) {
    return {
      ok: false,
      status: 502,
      reason: "upstream_invalid_response",
      retryable: true,
    };
  }
  return { ok: true, value: { id: String(createdId) } };
}

/** 按 tag 反查本环境的 droplet，供 Cron 对账（§19.6.5）。 */export async function listDropletsByTag(
  token: string,
  tag: string,
): Promise<ProviderResult<DropletSummary[]>> {
  const result = await call<{ droplets: Array<Parameters<typeof summarise>[0]> }>(
    token,
    `/droplets?tag_name=${encodeURIComponent(tag)}&per_page=200`,
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.droplets.map(summarise) };
}
