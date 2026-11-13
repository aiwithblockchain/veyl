/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTINENT_LABELS,
  MOCK_MY_SERVER_REGIONS,
  MockMyServerService,
} from "./mockMyServerService";

describe("套餐可售地区", () => {
  it("vc2-1c-1gb 只列 31 个可售地区", () => {
    expect(MOCK_MY_SERVER_REGIONS).toHaveLength(31);
  });

  it("不含不可售地区；前置顺序不变", () => {
    const ids = MOCK_MY_SERVER_REGIONS.map((region) => region.id);
    ["bkk", "sgn", "zrh"].forEach((id) => expect(ids).not.toContain(id));
    expect(ids.slice(0, 4)).toEqual(["nrt", "kix", "icn", "sgp"]);
    expect(ids[7]).toBe("lax");
  });

  it("每个地区都有已知大陆分组", () => {
    MOCK_MY_SERVER_REGIONS.forEach((region) =>
      expect(CONTINENT_LABELS[region.continent]).toBeTruthy(),
    );
  });
});

describe("mock 默认数据", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("没有存档时默认种四台：可用、安装中、出错、可用", () => {
    const { servers } = new MockMyServerService().list();
    expect(servers.map((server) => server.name)).toEqual([
      "东京 · Vultr",
      "洛杉矶 · Vultr",
      "新加坡 · Vultr",
      "圣保罗 · Vultr",
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
