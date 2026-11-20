import { afterEach, describe, expect, it, vi } from "vitest";

import devWorker from "../src/dev";
import type { Env } from "../src/index";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const route = (request: Request, env: Env) => devWorker.fetch(request, env, ctx);

function envWith(
  options: { firewallId?: string | null; found?: boolean; withDb?: boolean } = {},
): Env {
  const { firewallId = "fw_1", found = true, withDb = true } = options;
  const database = {
    prepare: () => ({
      bind: () => ({
        first: async () => (found ? { firewall_id: firewallId } : null),
      }),
    }),
  };
  return {
    ENVIRONMENT: "dev",
    DO_API_TOKEN: "tok",
    ...(withDb ? { DB: database as unknown as Env["DB"] } : {}),
  } as Env;
}

const ICMP_PUBLIC = {
  protocol: "icmp",
  ports: "0",
  sources: { addresses: ["0.0.0.0/0", "::/0"] },
};

function stubFirewall(firewall: unknown, puts: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts.push(String(init.body));
      }
      return new Response(JSON.stringify({ firewall }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const post = (query = "?id=srv_1") =>
  new Request(`https://example.com/v1/debug/firewall-icmp${query}`, { method: "POST" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("debug firewall-icmp", () => {
  it("生产环境不暴露调试路由", async () => {
    const res = await route(post(), {
      ENVIRONMENT: "production",
      DO_API_TOKEN: "tok",
    });
    expect(res.status).toBe(404);
  });

  it("非 POST 返回 405", async () => {
    const res = await route(
      new Request("https://example.com/v1/debug/firewall-icmp?id=srv_1"),
      envWith(),
    );
    expect(res.status).toBe(405);
  });

  it("缺 id 返回 400", async () => {
    const res = await route(post(""), envWith());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("missing_id");
  });

  it("缺 DB 返回 500", async () => {
    const res = await route(post(), envWith({ withDb: false }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("missing_db");
  });

  it("查不到服务器返回 404", async () => {
    const res = await route(post(), envWith({ found: false }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  it("服务器没有防火墙返回 422", async () => {
    const res = await route(post(), envWith({ firewallId: null }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("no_firewall");
  });

  it("已有面向全网的 icmp：不写回，changed=false", async () => {
    const puts: string[] = [];
    stubFirewall({ inbound_rules: [ICMP_PUBLIC], outbound_rules: [] }, puts);
    const res = await route(post(), envWith());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: boolean };
    expect(body).toMatchObject({ ok: true, changed: false });
    expect(puts).toHaveLength(0);
  });

  it("没有 icmp：追加全网规则，PUT 带上 droplet_ids 与 tags", async () => {
    const puts: string[] = [];
    const outbound = [{ protocol: "tcp", ports: "all", destinations: { addresses: ["0.0.0.0/0"] } }];
    stubFirewall(
      {
        name: "veyl-abc",
        inbound_rules: [{ protocol: "tcp", ports: "59281", sources: { addresses: ["0.0.0.0/0"] } }],
        outbound_rules: outbound,
        droplet_ids: [123],
        tags: ["veyl"],
      },
      puts,
    );

    const res = await route(post(), envWith());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: boolean; inbound_rules: unknown[] };
    expect(body).toMatchObject({ ok: true, changed: true });
    expect(body.inbound_rules).toHaveLength(2);

    expect(puts).toHaveLength(1);
    const put = JSON.parse(puts[0]) as {
      inbound_rules: Array<{ protocol: string }>;
      outbound_rules: unknown[];
      droplet_ids: number[];
      tags: string[];
    };
    expect(put.inbound_rules.map((rule) => rule.protocol)).toEqual(["tcp", "icmp"]);
    expect(put.outbound_rules).toEqual(outbound);
    expect(put.droplet_ids).toEqual([123]);
    expect(put.tags).toEqual(["veyl"]);
  });

  it("已有 icmp 但来源不是全网：仍追加一条全网规则", async () => {
    const puts: string[] = [];
    stubFirewall(
      {
        inbound_rules: [
          { protocol: "icmp", ports: "0", sources: { addresses: ["10.0.0.0/8"] } },
        ],
        outbound_rules: [],
        droplet_ids: [],
        tags: [],
      },
      puts,
    );
    const res = await route(post(), envWith());
    const body = (await res.json()) as { changed: boolean; inbound_rules: unknown[] };
    expect(body.changed).toBe(true);
    expect(body.inbound_rules).toHaveLength(2);
    expect(puts).toHaveLength(1);
  });
});
