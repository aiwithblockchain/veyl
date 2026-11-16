/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { CONTINENT_LABELS } from "./labels";
import {
  MOCK_MY_SERVER_REGIONS,
  MockMyServerService,
} from "./mockMyServerService";

describe("套餐可售地区", () => {
  it("与 DO 目录一致：16 个地区、中文名", () => {
    expect(MOCK_MY_SERVER_REGIONS).toHaveLength(16);
    expect(MOCK_MY_SERVER_REGIONS[0]).toEqual({
      id: "sgp1",
      name: "新加坡 1",
      continent: "asia",
    });
  });

  it("不含已下线的旧地区；顺序稳定", () => {
    const ids = MOCK_MY_SERVER_REGIONS.map((region) => region.id);
    ["nrt", "lax", "gru", "bkk"].forEach((id) => expect(ids).not.toContain(id));
    expect(ids.slice(0, 4)).toEqual(["sgp1", "blr1", "nyc1", "nyc2"]);
    expect(ids[7]).toBe("tor1");
  });

  it("每个地区都有已知大陆分组", () => {
    MOCK_MY_SERVER_REGIONS.forEach((region) =>
      expect(CONTINENT_LABELS[region.continent]).toBeTruthy(),
    );
  });
});

describe("mock 目录套餐", () => {
  it("三档次序与价格和控制面一致", () => {
    const { plans } = new MockMyServerService().catalog();
    expect(plans).toEqual([
      {
        id: "s-1vcpu-512mb-10gb",
        label: "1 核 · 512 MB",
        hourly_usd: 0.00595,
        monthly_usd: 6,
        daily_price_cents: 20,
        transfer_gib: 500,
      },
      {
        id: "s-1vcpu-1gb",
        label: "1 核 · 1 GB",
        hourly_usd: 0.00893,
        monthly_usd: 9,
        daily_price_cents: 30,
        transfer_gib: 1000,
      },
      {
        id: "s-1vcpu-2gb",
        label: "1 核 · 2 GB",
        hourly_usd: 0.01786,
        monthly_usd: 18,
        daily_price_cents: 60,
        transfer_gib: 2000,
      },
    ]);
  });
});

describe("mock 默认数据", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("没有存档时是空库，不预置演示服务器", () => {
    const { servers } = new MockMyServerService().list();
    expect(servers).toEqual([]);
  });

  it("账号默认未登录，钱包要求先登录", () => {
    const service = new MockMyServerService();
    expect(service.account()).toMatchObject({ logged_in: false, email: null });
    expect(() => service.wallet()).toThrow();
  });
});
