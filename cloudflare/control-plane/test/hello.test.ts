import { afterEach, describe, expect, it, vi } from "vitest";

import { route } from "../src/index";
import { FakeD1 } from "./helpers/fakeD1";

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
              transfer: 0.5,
              regions: ["sgp1", "nyc3", "fra1", "xyz9"],
            },
            {
              slug: "s-1vcpu-1gb",
              memory: 1024,
              vcpus: 1,
              price_hourly: 0.00893,
              price_monthly: 6,
              transfer: 1,
              regions: ["sgp1", "nyc3", "fra1"],
            },
            {
              slug: "s-1vcpu-2gb",
              memory: 2048,
              vcpus: 1,
              price_hourly: 0.01786,
              price_monthly: 12,
              transfer: 2,
              regions: ["nyc3"],
            },
          ],
        }),
        { status: 200 },
      );
    });

  const PRICES = JSON.stringify({
    "s-1vcpu-512mb-10gb": 20,
    "s-1vcpu-1gb": 30,
    "s-1vcpu-2gb": 60,
  });

  function catalogEnv(db?: FakeD1) {
    return {
      ENVIRONMENT: "production",
      DO_API_TOKEN: "t",
      PLAN_DAILY_PRICE_CENTS: PRICES,
      ...(db ? { DB: db as unknown as D1Database } : {}),
    };
  }

  /** D1 里存的是最终响应：已带售价的目录 JSON。 */
  const storedPayload = (regionId = "sgp1") =>
    JSON.stringify({
      currency: "USD",
      updated_at: new Date().toISOString(),
      regions: [{ id: regionId, name: "旧副本", continent: "asia" }],
      plans: [],
    });

  function seedRow(db: FakeD1, ageMs: number, regionId = "sgp1") {
    db.rows("catalog_cache").push({
      key: "v1",
      payload: storedPayload(regionId),
      updated_at: Date.now() - ageMs,
    });
  }

  it("无需登录即可读取地区与套餐", async () => {
    vi.stubGlobal("fetch", doMock());
    const res = await route(new Request("https://example.com/v1/catalog"), catalogEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currency: string;
      regions: Array<{ id: string; name: string; continent: string }>;
      plans: Array<{ id: string; monthly_usd: number; daily_price_cents: number; label: string; transfer_gib: number }>;
    };
    expect(body.currency).toBe("USD");
    expect(body.regions.map((r) => r.id)).toEqual(["sgp1", "nyc3"]);
    expect(body.regions[0].continent).toBe("asia");
    expect(body.regions.map((r) => r.name)).toEqual(["新加坡 1", "纽约 3"]);
    expect(body.plans).toEqual([
      { id: "s-1vcpu-512mb-10gb", label: "1 核 · 512 MB", hourly_usd: 0.0082, monthly_usd: 6, daily_price_cents: 20, transfer_gib: 500, regions: ["sgp1", "nyc3"] },
      { id: "s-1vcpu-1gb", label: "1 核 · 1 GB", hourly_usd: 0.0123, monthly_usd: 9, daily_price_cents: 30, transfer_gib: 1000, regions: ["sgp1", "nyc3"] },
      { id: "s-1vcpu-2gb", label: "1 核 · 2 GB", hourly_usd: 0.0247, monthly_usd: 18, daily_price_cents: 60, transfer_gib: 2000, regions: ["nyc3"] },
    ]);
  });

  it("transfer 缺失或非正数时记 0，不写死档位", async () => {
    const doMock = vi.fn(async (input: string | URL | Request) => {
      const href = String(input);
      if (href.includes("/regions")) {
        return new Response(
          JSON.stringify({ regions: [{ slug: "sgp1", name: "Singapore 1", available: true }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          sizes: [
            { slug: "s-1vcpu-512mb-10gb", memory: 512, vcpus: 1, price_hourly: 0.00595, price_monthly: 4, regions: ["sgp1"] },
            { slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1, price_hourly: 0.00893, price_monthly: 6, transfer: 0, regions: ["sgp1"] },
            { slug: "s-1vcpu-2gb", memory: 2048, vcpus: 1, price_hourly: 0.01786, price_monthly: 12, transfer: -1, regions: ["sgp1"] },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", doMock);
    const res = await route(new Request("https://example.com/v1/catalog"), catalogEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plans: Array<{ transfer_gib: number }> };
    expect(body.plans.map((plan) => plan.transfer_gib)).toEqual([0, 0, 0]);
  });

  it("上游失败时返回 503 且可重试", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const res = await route(new Request("https://example.com/v1/catalog"), catalogEnv());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { retryable: boolean };
    expect(body.retryable).toBe(true);
  });

  it("非 GET 返回 405", async () => {
    const res = await route(
      new Request("https://example.com/v1/catalog", { method: "POST" }),
      catalogEnv(),
    );
    expect(res.status).toBe(405);
  });

  it("目录在年龄内：直接返回 D1 的行，不访问上游", async () => {
    const db = new FakeD1();
    seedRow(db, 60_000, "sgp1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await route(new Request("https://example.com/v1/catalog"), catalogEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { regions: Array<{ id: string }> };
    expect(body.regions[0].id).toBe("sgp1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("目录过期：回源成功后写回 D1", async () => {
    const db = new FakeD1();
    seedRow(db, 6 * 60_000, "sgp1");
    vi.stubGlobal("fetch", doMock());

    const res = await route(new Request("https://example.com/v1/catalog"), catalogEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { regions: Array<{ id: string }> };
    expect(body.regions.map((region) => region.id)).toEqual(["sgp1", "nyc3"]);
    const row = db.rows("catalog_cache").find((entry) => entry.key === "v1")!;
    expect(String(row.payload)).toContain('"nyc3"');
    expect(Date.now() - Number(row.updated_at)).toBeLessThan(5_000);
  });

  it("目录过期且回源失败：503，旧行原地不动、不返回给调用方", async () => {
    const db = new FakeD1();
    seedRow(db, 6 * 60_000, "sgp1");
    const before = { ...db.rows("catalog_cache")[0] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const href = String(input);
        if (href.includes("/regions")) return new Response(JSON.stringify({ regions: [] }), { status: 200 });
        return new Response("boom", { status: 500 });
      }),
    );

    const res = await route(new Request("https://example.com/v1/catalog"), catalogEnv(db));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; retryable: boolean };
    expect(body.error).toBe("catalog_unavailable");
    expect(body.retryable).toBe(true);
    const row = db.rows("catalog_cache").find((entry) => entry.key === "v1")!;
    expect(row.payload).toBe(before.payload);
    expect(row.updated_at).toBe(before.updated_at);
    // 失败留了审计。
    expect(
      db.rows("audit_log").some((entry) => entry.action === "catalog.refresh_failed"),
    ).toBe(true);
  });

  it("回源失败立刻释放租约：紧接着的 fresh 能重新回源", async () => {
    const db = new FakeD1();
    seedRow(db, 6 * 60_000, "sgp1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const href = String(input);
        if (href.includes("/regions")) return new Response(JSON.stringify({ regions: [] }), { status: 200 });
        return new Response("boom", { status: 500 });
      }),
    );

    const failed = await route(
      new Request("https://example.com/v1/catalog?fresh=1"),
      catalogEnv(db),
    );
    expect(failed.status).toBe(503);
    // 失败不许继续占着 15 秒租约，否则 DO 恢复了用户还在吃 503。
    expect(db.rows("catalog_cache").some((entry) => entry.key === "v1:refresh")).toBe(false);

    vi.stubGlobal("fetch", doMock());
    const retried = await route(
      new Request("https://example.com/v1/catalog?fresh=1"),
      catalogEnv(db),
    );
    expect(retried.status).toBe(200);
    const row = db.rows("catalog_cache").find((entry) => entry.key === "v1")!;
    expect(String(row.payload)).toContain('"nyc3"');
  });

  it("页面加载不带 fresh：20 秒的缓存也直接返回，不回源", async () => {
    const db = new FakeD1();
    seedRow(db, 20_000, "sgp1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await route(new Request("https://example.com/v1/catalog"), catalogEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { regions: Array<{ id: string }> };
    expect(body.regions[0].id).toBe("sgp1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("条件写回命中 0 行：返回新数据并记 catalog.write_skipped", async () => {
    const db = new FakeD1();
    seedRow(db, 6 * 60_000, "sgp1");
    // 模拟读完之后另一个请求抢先写了更新的一版。
    db.beforeCatalogWrite = () => {
      db.beforeCatalogWrite = undefined;
      db.rows("catalog_cache")[0].updated_at = Date.now();
    };
    vi.stubGlobal("fetch", doMock());

    const res = await route(new Request("https://example.com/v1/catalog"), catalogEnv(db));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { regions: Array<{ id: string }> };
    expect(body.regions.map((region) => region.id)).toEqual(["sgp1", "nyc3"]);
    expect(
      db.rows("audit_log").some((entry) => entry.action === "catalog.write_skipped"),
    ).toBe(true);
  });

  it("上游少字段（缺价格）：503 且不写 D1", async () => {
    const db = new FakeD1();
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

    const res = await route(new Request("https://example.com/v1/catalog"), catalogEnv(db));

    expect(res.status).toBe(503);
    expect(db.rows("catalog_cache").some((entry) => entry.key === "v1")).toBe(false);
  });

  it("fresh=1 跳过年龄判断直接回源并写回", async () => {
    const db = new FakeD1();
    // 20 秒前：还在 5 分钟内，但已超过 fresh 的 10 秒防抖。
    seedRow(db, 20_000, "sgp1");
    vi.stubGlobal("fetch", doMock());

    const res = await route(
      new Request("https://example.com/v1/catalog?fresh=1"),
      catalogEnv(db),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { regions: Array<{ id: string }> };
    expect(body.regions.map((region) => region.id)).toEqual(["sgp1", "nyc3"]);
    const row = db.rows("catalog_cache").find((entry) => entry.key === "v1")!;
    expect(Date.now() - Number(row.updated_at)).toBeLessThan(5_000);
  });

  it("fresh=1 在 10 秒防抖内不重复回源", async () => {
    const db = new FakeD1();
    seedRow(db, 5_000, "sgp1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await route(
      new Request("https://example.com/v1/catalog?fresh=1"),
      catalogEnv(db),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { regions: Array<{ id: string }> };
    expect(body.regions[0].id).toBe("sgp1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("并发 fresh 只回源一次", async () => {
    let regionsCalls = 0;
    let sizesCalls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const href = String(input);
        if (href.includes("/regions")) {
          regionsCalls += 1;
          await gate;
          return new Response(
            JSON.stringify({ regions: [{ slug: "sgp1", name: "Singapore 1", available: true }] }),
            { status: 200 },
          );
        }
        if (href.includes("/sizes")) {
          sizesCalls += 1;
          await gate;
          return new Response(
            JSON.stringify({
              sizes: [
                {
                  slug: "s-1vcpu-1gb",
                  memory: 1024,
                  vcpus: 1,
                  price_hourly: 0.00893,
                  price_monthly: 6,
                  transfer: 1,
                  regions: ["sgp1"],
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    const env = catalogEnv(new FakeD1());
    const first = route(new Request("https://example.com/v1/catalog?fresh=1"), env);
    const second = route(new Request("https://example.com/v1/catalog?fresh=1"), env);
    // 两个请求都进入回源之后再放行。
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect([a.status, b.status]).toContain(200);
    expect(regionsCalls).toBe(1);
    expect(sizesCalls).toBe(1);
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
