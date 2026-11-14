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
        monthly_usd: 4,
      },
      {
        id: "s-1vcpu-1gb",
        label: "1 核 · 1 GB",
        hourly_usd: 0.00893,
        monthly_usd: 6,
      },
      {
        id: "s-1vcpu-2gb",
        label: "1 核 · 2 GB",
        hourly_usd: 0.01786,
        monthly_usd: 12,
      },
    ]);
  });
});

describe("mock 默认数据", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("没有存档时默认种四台：可用、安装中、出错、可用", () => {
    const { servers } = new MockMyServerService().list();
    expect(servers.map((server) => server.name)).toEqual([
      "新加坡 1 · DigitalOcean",
      "纽约 1 · DigitalOcean",
      "法兰克福 1 · DigitalOcean",
      "多伦多 1 · DigitalOcean",
    ]);
    expect(servers.map((server) => server.state)).toEqual([
      "healthy",
      "installing",
      "error",
      "healthy",
    ]);
  });

  it("seed 覆盖默认；空 seed 是显式空库", () => {
    localStorage.setItem("veyl.mock.myServers.seed", "verifying,healthy");
    expect(new MockMyServerService().list().servers).toHaveLength(2);

    localStorage.removeItem("veyl.mock.myServers");
    localStorage.setItem("veyl.mock.myServers.seed", "");
    expect(new MockMyServerService().list().servers).toHaveLength(0);
  });
});
