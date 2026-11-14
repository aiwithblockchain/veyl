import { afterEach, describe, expect, it, vi } from "vitest";

import { route } from "../src/index";

const env = { ENVIRONMENT: "test" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("control plane hello", () => {
  it("GET / 返回服务身份与环境", async () => {
    const res = await route(new Request("https://example.com/"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      service: string;
      env: string;
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("veyl-control-plane");
    expect(body.env).toBe("test");
  });

  it("GET /health 同样可用", async () => {
    const res = await route(new Request("https://example.com/health"), env);
    expect(res.status).toBe(200);
  });

  it("未知路径返回 404", async () => {
    const res = await route(new Request("https://example.com/nope"), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

describe("vultr debug route", () => {
  it("生产环境不暴露调试路由", async () => {
    const res = await route(new Request("https://example.com/v1/debug/vultr"), {
      ENVIRONMENT: "production",
      VULTR_API_KEY: "key",
    });
    expect(res.status).toBe(404);
  });

  it("dev 但没有 secret 时返回 500", async () => {
    const res = await route(new Request("https://example.com/v1/debug/vultr"), {
      ENVIRONMENT: "dev",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_secret");
  });

  it("dev 命中 Vultr 时只返回账户摘要，不含邮箱", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            account: {
              name: "Wesley",
              email: "secret@example.com",
              balance: "12.34",
              pending_charges: "0.01",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const res = await route(new Request("https://example.com/v1/debug/vultr"), {
      ENVIRONMENT: "dev",
      VULTR_API_KEY: "key",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      account: Record<string, string>;
    };
    expect(body.ok).toBe(true);
    expect(body.account.name).toBe("Wesley");
    expect(body.account.balance).toBe("12.34");
    expect(JSON.stringify(body)).not.toContain("secret@example.com");
  });

  it("Vultr 拒绝时返回 502 且带上游错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );

    const res = await route(new Request("https://example.com/v1/debug/vultr"), {
      ENVIRONMENT: "dev",
      VULTR_API_KEY: "bad",
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; status: number };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(401);
  });
});

describe("do catalog debug route", () => {
  it("生产环境不暴露", async () => {
    const res = await route(new Request("https://example.com/v1/debug/do-catalog"), {
      ENVIRONMENT: "production",
      DO_API_TOKEN: "t",
    });
    expect(res.status).toBe(404);
  });

  it("dev 但没有 DO_API_TOKEN 时返回 500", async () => {
    const res = await route(new Request("https://example.com/v1/debug/do-catalog"), {
      ENVIRONMENT: "dev",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_secret");
  });

  it("dev 命中时返回地区、最低价套餐与 Ubuntu 镜像，且不回显 token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const href = String(input);
        if (href.includes("/regions")) {
          return new Response(
            JSON.stringify({
              regions: [
                { slug: "nyc3", name: "New York 3", available: true },
                { slug: "sgp1", name: "Singapore 1", available: true },
                { slug: "old1", name: "Retired", available: false },
              ],
            }),
            { status: 200 },
          );
        }
        if (href.includes("/sizes")) {
          return new Response(
            JSON.stringify({
              sizes: [
                { slug: "s-2vcpu-2gb", memory: 2048, vcpus: 2, price_monthly: 18, regions: [] },
                { slug: "s-1vcpu-512mb-10gb", memory: 512, vcpus: 1, price_monthly: 4, regions: [] },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            images: [
              { slug: "ubuntu-22-04-x64", id: 1, name: "22.04" },
              { slug: "ubuntu-24-04-x64", id: 2, name: "24.04" },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    const res = await route(new Request("https://example.com/v1/debug/do-catalog"), {
      ENVIRONMENT: "dev",
      DO_API_TOKEN: "do-secret-token",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      regions: { count: number; slugs: string[] };
      sizes: { cheapest: Array<{ slug: string; usd_per_month: number }> };
      ubuntu_24_04: { id: number; slug: string } | null;
    };
    expect(body.ok).toBe(true);
    expect(body.regions.slugs).toEqual(["nyc3", "sgp1"]);
    expect(body.sizes.cheapest[0].slug).toBe("s-1vcpu-512mb-10gb");
    expect(body.ubuntu_24_04).toEqual({ id: 2, slug: "ubuntu-24-04-x64", name: "24.04" });
    expect(JSON.stringify(body)).not.toContain("do-secret-token");
  });
});

describe("public catalog", () => {
  const doMock = () =>
    vi.fn(async (input: string | URL | Request) => {
      const href = String(input);
      if (href.includes("/regions")) {
        return new Response(
          JSON.stringify({
            regions: [
              { slug: "sgp1", name: "Singapore 1", available: true },
              { slug: "nyc3", name: "New York 3", available: true },
              { slug: "xyz9", name: "Unknown", available: true },
              { slug: "fra1", name: "Frankfurt 1", available: false },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          sizes: [
            {
              slug: "s-1vcpu-512mb-10gb",
              memory: 512,
              vcpus: 1,
              price_hourly: 0.00595,
              price_monthly: 4,
            },
            {
              slug: "s-1vcpu-1gb",
              memory: 1024,
              vcpus: 1,
              price_hourly: 0.00893,
              price_monthly: 6,
            },
            {
              slug: "s-1vcpu-2gb",
              memory: 2048,
              vcpus: 1,
              price_hourly: 0.01786,
              price_monthly: 12,
            },
          ],
        }),
        { status: 200 },
      );
    });

  it("无需登录即可读取地区与套餐", async () => {
    vi.stubGlobal("fetch", doMock());
    const res = await route(new Request("https://example.com/v1/catalog"), {
      ENVIRONMENT: "production",
      DO_API_TOKEN: "t",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currency: string;
      regions: Array<{ id: string; name: string; continent: string }>;
      plans: Array<{ id: string; monthly_usd: number; label: string }>;
    };
    expect(body.currency).toBe("USD");
    expect(body.regions.map((r) => r.id)).toEqual(["sgp1", "nyc3"]);
    expect(body.regions[0].continent).toBe("asia");
    expect(body.regions.map((r) => r.name)).toEqual(["新加坡 1", "纽约 3"]);
    expect(body.plans).toEqual([
      { id: "s-1vcpu-512mb-10gb", label: "1 核 · 512 MB", hourly_usd: 0.00595, monthly_usd: 4 },
      { id: "s-1vcpu-1gb", label: "1 核 · 1 GB", hourly_usd: 0.00893, monthly_usd: 6 },
      { id: "s-1vcpu-2gb", label: "1 核 · 2 GB", hourly_usd: 0.01786, monthly_usd: 12 },
    ]);
  });

  it("上游失败时返回 503 且可重试", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const res = await route(new Request("https://example.com/v1/catalog"), {
      ENVIRONMENT: "production",
      DO_API_TOKEN: "t",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { retryable: boolean };
    expect(body.retryable).toBe(true);
  });

  it("非 GET 返回 405", async () => {
    const res = await route(
      new Request("https://example.com/v1/catalog", { method: "POST" }),
      { ENVIRONMENT: "production", DO_API_TOKEN: "t" },
    );
    expect(res.status).toBe(405);
  });

  it("上游少字段（缺价格）时返回 503 且不写缓存", async () => {
    const put = vi.fn(async () => undefined);
    vi.stubGlobal("caches", { default: { match: async () => undefined, put } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const href = String(input);
        if (href.includes("/regions")) {
          return new Response(
            JSON.stringify({ regions: [{ slug: "sgp1", name: "Singapore 1", available: true }] }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ sizes: [{ slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1 }] }), {
          status: 200,
        });
      }),
    );

    const res = await route(new Request("https://example.com/v1/catalog"), {
      ENVIRONMENT: "production",
      DO_API_TOKEN: "t",
    });
    expect(res.status).toBe(503);
    expect(put).not.toHaveBeenCalled();
  });

  it("上游抖动时回退到旧副本", async () => {
    const staleBody = JSON.stringify({
      currency: "USD",
      updated_at: new Date(Date.now() - 3600_000).toISOString(),
      regions: [{ id: "sgp1", name: "Singapore 1", continent: "asia" }],
      plans: [{ id: "s-1vcpu-1gb", label: "1 核 · 1 GB", hourly_usd: 0.00893, monthly_usd: 6 }],
    });
    vi.stubGlobal("caches", {
      default: {
        match: async () => new Response(staleBody, { status: 200 }),
        put: async () => undefined,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));

    const res = await route(new Request("https://example.com/v1/catalog"), {
      ENVIRONMENT: "production",
      DO_API_TOKEN: "t",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-catalog-stale")).toBe("true");
    const body = (await res.json()) as { regions: Array<{ id: string }> };
    expect(body.regions[0].id).toBe("sgp1");
  });

  it("副本仍新鲜时直接返回，不再访问上游", async () => {
    const freshBody = JSON.stringify({
      currency: "USD",
      updated_at: new Date().toISOString(),
      regions: [{ id: "nyc3", name: "New York 3", continent: "north_america" }],
      plans: [{ id: "s-1vcpu-1gb", label: "1 核 · 1 GB", hourly_usd: 0.00893, monthly_usd: 6 }],
    });
    vi.stubGlobal("caches", {
      default: {
        match: async () => new Response(freshBody, { status: 200 }),
        put: async () => undefined,
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await route(new Request("https://example.com/v1/catalog"), {
      ENVIRONMENT: "production",
      DO_API_TOKEN: "t",
    });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("do scopes debug route", () => {
  it("生产环境不暴露", async () => {
    const res = await route(new Request("https://example.com/v1/debug/do-scopes"), {
      ENVIRONMENT: "production",
      DO_API_TOKEN: "t",
    });
    expect(res.status).toBe(404);
  });

  it("区分 allowed 与 denied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const href = String(input);
        const denied = href.includes("/account") || href.includes("/customers/");
        return denied
          ? new Response("forbidden", { status: 403 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const res = await route(new Request("https://example.com/v1/debug/do-scopes"), {
      ENVIRONMENT: "dev",
      DO_API_TOKEN: "do-secret-token",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Record<string, { verdict: string }>;
    };
    expect(body.results.droplets.verdict).toBe("allowed");
    expect(body.results.firewalls.verdict).toBe("allowed");
    expect(body.results.account.verdict).toBe("denied");
    expect(body.results.billing_balance.verdict).toBe("denied");
  });
});
