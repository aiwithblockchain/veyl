import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureSharedFirewall,
  SHARED_FIREWALL_NAME,
  SHARED_FIREWALL_TAG,
} from "../src/providers/digitalocean";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureSharedFirewall", () => {
  it("没有同名防火墙时先建 tag 再按固定规则创建防火墙", async () => {
    const calls: string[] = [];
    let createdBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const href = String(input);
        if (href.includes("/firewalls?")) return json({ firewalls: [] });
        if (href.endsWith("/tags") && init?.method === "POST") {
          calls.push("tags");
          return json({ tag: { name: SHARED_FIREWALL_TAG } }, 201);
        }
        if (href.endsWith("/firewalls") && init?.method === "POST") {
          calls.push("firewalls");
          createdBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return json({ firewall: { id: "fw_new" } }, 202);
        }
        return new Response(null, { status: 204 });
      }),
    );

    const result = await ensureSharedFirewall("tok");

    expect(result).toEqual({ ok: true, value: { id: "fw_new" } });
    // tag 必须先于防火墙：DO 不允许挂不存在的 tag。
    expect(calls).toEqual(["tags", "firewalls"]);
    expect(createdBody).not.toBeNull();
    expect(createdBody!.name).toBe(SHARED_FIREWALL_NAME);
    expect(createdBody!.tags).toEqual([SHARED_FIREWALL_TAG]);
    // 按 tag 绑定，不把节点写死进 droplet_ids。
    expect(createdBody!.droplet_ids).toBeUndefined();
    const inbound = createdBody!.inbound_rules as Array<{ protocol: string; ports: string }>;
    expect(inbound.map((entry) => `${entry.protocol}:${entry.ports}`)).toEqual([
      "tcp:30000-30999",
      "udp:30000-30999",
      "tcp:32100",
      "icmp:0",
    ]);
    const outbound = createdBody!.outbound_rules as Array<{ protocol: string; ports: string }>;
    expect(outbound.map((entry) => `${entry.protocol}:${entry.ports}`)).toEqual([
      "tcp:all",
      "udp:all",
      "icmp:0",
    ]);
  });

  it("tag 已存在（DO 返回 422）时继续创建防火墙", async () => {
    let firewallPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const href = String(input);
        if (href.includes("/firewalls?")) return json({ firewalls: [] });
        if (href.endsWith("/tags") && init?.method === "POST") {
          return json({ id: "unprocessable_entity", message: "Tag already exists" }, 422);
        }
        if (href.endsWith("/firewalls") && init?.method === "POST") {
          firewallPosts += 1;
          return json({ firewall: { id: "fw_new" } }, 202);
        }
        return new Response(null, { status: 204 });
      }),
    );

    const result = await ensureSharedFirewall("tok");

    expect(result).toEqual({ ok: true, value: { id: "fw_new" } });
    expect(firewallPosts).toBe(1);
  });

  it("按名称命中即复用，不看 tag 与规则，也不再创建", async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const href = String(input);
        if (href.includes("/firewalls?")) {
          return json({
            firewalls: [
              {
                id: "fw_existing",
                // 人工可能加过 SSH 规则、去掉过 tag：只要名字对就认。
                name: SHARED_FIREWALL_NAME,
                tags: [],
                droplet_ids: [777],
                inbound_rules: [{ protocol: "tcp", ports: "22" }],
              },
            ],
          });
        }
        if (href.endsWith("/firewalls") && init?.method === "POST") posts.push(href);
        return new Response(null, { status: 204 });
      }),
    );

    const result = await ensureSharedFirewall("tok");

    expect(result).toEqual({ ok: true, value: { id: "fw_existing" } });
    expect(posts).toHaveLength(0);
  });

  it("列表查询失败时返回错误，调用方必须让建机整单失败", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ id: "server_error" }, 500)),
    );

    const result = await ensureSharedFirewall("tok");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("upstream_500");
      expect(result.retryable).toBe(true);
    }
  });

  it("创建失败时返回上游错误，不吞掉", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const href = String(input);
        if (href.includes("/firewalls?")) return json({ firewalls: [] });
        if (href.endsWith("/firewalls") && init?.method === "POST") {
          return json({ id: "forbidden" }, 403);
        }
        return new Response(null, { status: 204 });
      }),
    );

    const result = await ensureSharedFirewall("tok");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("upstream_403");
      expect(result.retryable).toBe(false);
    }
  });
});
