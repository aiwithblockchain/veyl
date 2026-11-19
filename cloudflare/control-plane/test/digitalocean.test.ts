import { afterEach, describe, expect, it, vi } from "vitest";

import { createFirewall } from "../src/providers/digitalocean";

describe("createFirewall", () => {
  afterEach(() => {
  vi.unstubAllGlobals();
});

  it("入站放行节点端口（tcp/udp）与 ICMP，出站规则不变", async () => {
    let body: {
      inbound_rules: Array<{ protocol: string; ports: string }>;
      outbound_rules: Array<{ protocol: string; ports: string }>;
    } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ firewall: { id: 42 } }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const result = await createFirewall("tok", {
      name: "veyl-abc",
      port: 59281,
      providerId: "123",
    });

    expect(result).toEqual({ ok: true, value: { id: "42" } });
    expect(body).not.toBeNull();
    const inbound = body!.inbound_rules;
    expect(inbound.map((rule) => rule.protocol)).toEqual(["tcp", "udp", "icmp"]);
    expect(inbound[0].ports).toBe("59281");
    expect(inbound[2].ports).toBe("0");
    // 出站不动：tcp/udp/icmp 各一条。
    expect(body!.outbound_rules.map((rule) => rule.protocol)).toEqual(["tcp", "udp", "icmp"]);
  });
});
