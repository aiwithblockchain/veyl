import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCatalogData } from "../src/index";
import regionFixture from "./fixtures/do-regions-2026-11-18.json";
import sizeFixture from "./fixtures/do-sizes-2026-11-18.json";

// 真实 DO API 响应摘录：地区 × 档位必须来自这里，不能靠「偏好处处一样」的推断。
const realRegions = regionFixture as {
  regions: Array<{ slug: string; name: string; available: boolean }>;
};
const realSizes = sizeFixture as unknown as {
  sizes: Array<{
    slug: string;
    memory: number;
    vcpus: number;
    price_hourly: number;
    price_monthly: number;
    transfer?: number;
    regions?: unknown;
  }>;
};

function stubDo(sizes = realSizes.sizes, regions = realRegions.regions) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const href = String(input);
      const body = href.includes("/regions") ? { regions } : { sizes };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

function cloneSizes() {
  return structuredClone(realSizes.sizes);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("catalog 的地区 × 档位", () => {
  it("真实 /sizes 快照：s-1vcpu-1gb 不含 sgp1，只含它真实支持的地区", async () => {
    stubDo();

    const catalog = await fetchCatalogData("do-token");
    expect(catalog).not.toBeNull();
    const plan = catalog!.plans.find((candidate) => candidate.id === "s-1vcpu-1gb");
    expect(plan).toBeTruthy();

    // DO 的真实约束：sgp1 没有 s-1vcpu-1gb（建机 422 的根因），而新加坡本身在售。
    expect(plan!.regions).not.toContain("sgp1");
    expect(catalog!.regions.some((region) => region.id === "sgp1")).toBe(true);
    expect(plan!.regions).toEqual(["ams3", "blr1", "fra1", "lon1", "sfo2", "sfo3", "tor1"]);
  });

  it("缺 regions 的套餐整条丢弃，不补空数组", async () => {
    const sizes = cloneSizes();
    delete sizes[1].regions; // s-1vcpu-1gb
    stubDo(sizes);

    const catalog = await fetchCatalogData("do-token");
    expect(catalog!.plans.map((plan) => plan.id)).toEqual([
      "s-1vcpu-512mb-10gb",
      "s-1vcpu-2gb",
    ]);
  });

  it("regions 不是数组的套餐整条丢弃", async () => {
    const sizes = cloneSizes();
    sizes[1].regions = "ams3,tor1";
    stubDo(sizes);

    const catalog = await fetchCatalogData("do-token");
    expect(catalog!.plans.some((plan) => plan.id === "s-1vcpu-1gb")).toBe(false);
  });

  it("地区列表里没有的 id 不下发（不能凭空多出地区）", async () => {
    const sizes = cloneSizes();
    sizes[1].regions = ["tor1", "xyz9", "tor1"];
    stubDo(sizes);

    const catalog = await fetchCatalogData("do-token");
    const plan = catalog!.plans.find((candidate) => candidate.id === "s-1vcpu-1gb");
    expect(plan!.regions).toEqual(["tor1"]);
  });

  it("三档都不合格时整个目录 503，不给半个目录", async () => {
    const sizes = cloneSizes().map((size) => {
      delete (size as { regions?: unknown }).regions;
      return size;
    });
    stubDo(sizes);

    expect(await fetchCatalogData("do-token")).toBeNull();
  });
});
