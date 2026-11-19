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

/** 防火墙在建机之后创建：把 droplet id 直接写进 `droplet_ids`，因此不需要 firewall:update。 */
/** DO 只接受字母、数字、点和连字符：机器 ID 是 base64url，可能带 `_`。 */
export function firewallName(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9.-]/g, "-")
    .replace(/^[.\-]+/, "")
    .replace(/[.\-]+$/, "");
  return (cleaned || "veyl-firewall").slice(0, 255);
}

export async function createFirewall(
  token: string,
  input: { name: string; port: number; providerId: string },
): Promise<ProviderResult<{ id: string }>> {
  const rule = (protocol: "tcp" | "udp") => ({
    protocol,
    ports: String(input.port),
    sources: { addresses: ["0.0.0.0/0", "::/0"] },
  });
  // ICMP 入站：诊断用（ping 能区分「包没到 DO」与「到了被丢」）。DO 的 ICMP 端口写 "0"。
  const icmp = {
    protocol: "icmp",
    ports: "0",
    sources: { addresses: ["0.0.0.0/0", "::/0"] },
  };

  const result = await call<{ firewall: { id: string } }>(token, "/firewalls", {
    method: "POST",
    body: JSON.stringify({
      name: firewallName(input.name),
      inbound_rules: [rule("tcp"), rule("udp"), icmp],
      outbound_rules: [
        { protocol: "tcp", ports: "all", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
        { protocol: "udp", ports: "all", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
        { protocol: "icmp", ports: "0", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
      ],
      droplet_ids: [Number(input.providerId)],
    }),
  });
  if (!result.ok) return result;
  return { ok: true, value: { id: String(result.value.firewall.id) } };
}

export async function deleteFirewall(token: string, firewallId: string): Promise<ProviderResult<void>> {
  return call<void>(token, `/firewalls/${encodeURIComponent(firewallId)}`, { method: "DELETE" });
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
