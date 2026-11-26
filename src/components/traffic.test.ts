import { describe, expect, it } from "vitest";
import {
  dailyBoundaryFormatter,
  formatDailyBoundaryTime,
  formatTrafficGib,
  formatTrafficGibValue,
  formatTrafficPercent,
  formatTrafficReset,
  trafficPoolTomorrowBytes,
  trafficTomorrowBytes,
} from "./traffic";

const GIB = 1024 ** 3;

describe("流量单位与清零点", () => {
  it("字节按 GiB 换算，整数不带小数", () => {
    expect(formatTrafficGib(6 * GIB)).toBe("6 GiB");
    expect(formatTrafficGib(0)).toBe("0 GiB");
    expect(formatTrafficGib(512 * 1024 ** 2)).toBe("0.5 GiB");
    expect(formatTrafficGib(1.5 * GIB)).toBe("1.5 GiB");
    // 100 以上取整，避免 "128.6 GiB" 这种噪声。
    expect(formatTrafficGib(128.6 * GIB)).toBe("129 GiB");
    // 有量但不足 0.1 GiB 时不显示成 0。
    expect(formatTrafficGib(1024 ** 2)).toBe("<0.1 GiB");
    // 成对写法只取数值部分。
    expect(formatTrafficGibValue(15.25 * GIB)).toBe("15.3");
  });

  it("取整边界、负数与非有限值", () => {
    // 99.96 保留一位是 100.0：正常四舍五入到 100，不是向上取整到 101。
    expect(formatTrafficGib(99.96 * GIB)).toBe("100 GiB");
    expect(formatTrafficGib(99.94 * GIB)).toBe("99.9 GiB");
    expect(formatTrafficGib(-5 * GIB)).toBe("0 GiB");
    // 非有限值不伪装成 0，写「—」。
    expect(formatTrafficGib(Number.NaN)).toBe("—");
    expect(formatTrafficGib(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatTrafficGibValue(Number.NaN)).toBe("—");
  });

  it("清零点按本地日渲染；空串与非法值返回 null", () => {
    expect(formatTrafficReset("", "zh")).toBeNull();
    expect(formatTrafficReset("not-a-date", "zh")).toBeNull();

    const at = new Date(2026, 11, 1, 0, 0, 0).toISOString();
    expect(formatTrafficReset(at, "zh")).toBe("12月1日");
    expect(formatTrafficReset(at, "en")).toBe("Dec 1");
  });

  it("已用比例：一位小数、0 与极小值、额度未知", () => {
    const limit = 536 * GIB;
    // 2.2 / 536 ≈ 0.41% → 0.4
    expect(formatTrafficPercent(2.2 * GIB, limit)).toBe("0.4");
    expect(formatTrafficPercent(0, limit)).toBe("0");
    // 有量但不足 0.1%。
    expect(formatTrafficPercent(1024 ** 2, limit)).toBe("<0.1");
    expect(formatTrafficPercent(200 * GIB, 400 * GIB)).toBe("50");
    expect(formatTrafficPercent(399.6 * GIB, 400 * GIB)).toBe("99.9");
    // 额度未知与非有限值不伪装成 0%。
    expect(formatTrafficPercent(12 * GIB, 0)).toBe("—");
    expect(formatTrafficPercent(Number.NaN, 400 * GIB)).toBe("—");
    expect(formatTrafficPercent(12 * GIB, Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("每日增量时刻：固定时区下 00:00 UTC 是 08:00，且强制 h23", () => {
    const formatter = dailyBoundaryFormatter("zh");
    expect(formatter.resolvedOptions().hourCycle).toBe("h23");
    // 固定时区 + 固定输入：不拿 formatter 自己算期望值。
    expect(
      dailyBoundaryFormatter("zh", "Asia/Shanghai").format(
        new Date(Date.UTC(2026, 10, 27, 0, 0, 0)),
      ),
    ).toBe("08:00");
    expect(
      dailyBoundaryFormatter("en", "Asia/Shanghai").format(
        new Date(Date.UTC(2026, 10, 27, 0, 0, 0)),
      ),
    ).toBe("08:00");
    // UTC 时区下是午夜，h23 必须是 00:00 而不是 24:00。
    expect(
      dailyBoundaryFormatter("en", "UTC").format(
        new Date(Date.UTC(2026, 10, 27, 0, 0, 0)),
      ),
    ).toBe("00:00");

    // 「下一个 00:00 UTC」的取值：同一 UTC 日内不同时刻指向同一个零点。
    const noon = Date.UTC(2026, 10, 26, 12, 0, 0);
    const time = formatDailyBoundaryTime("zh", noon);
    expect(time).toMatch(/^\d{2}:\d{2}$/);
    expect(formatDailyBoundaryTime("zh", noon + 6 * 3600 * 1000)).toBe(time);
  });
});

describe("明天新增额度", () => {
  const machine = (
    over: Partial<{
      state: "healthy" | "destroyed";
      transfer_gib: number;
      traffic_limit_bytes: number;
    }> = {},
  ) => ({
    state: "healthy" as const,
    transfer_gib: 1000,
    traffic_limit_bytes: 0,
    ...over,
  });

  it("日额度 = 月额度 / 28，受剩余额度封顶", () => {
    // 1000 GiB / 28 ≈ 35.71 GiB。
    expect(trafficTomorrowBytes(machine())).toBeCloseTo((1000 * GIB) / 28);
    // 已释放 980 GiB，只剩 20 GiB，明天只加 20。
    expect(
      trafficTomorrowBytes(
        machine({ traffic_limit_bytes: 980 * GIB }),
      ),
    ).toBeCloseTo(20 * GIB);
  });

  it("transfer_gib = 0 或脏值：贡献 0", () => {
    expect(trafficTomorrowBytes(machine({ transfer_gib: 0 }))).toBe(0);
    expect(
      trafficTomorrowBytes(machine({ transfer_gib: Number.NaN })),
    ).toBe(0);
    expect(
      trafficTomorrowBytes(machine({ traffic_limit_bytes: Number.NaN })),
    ).toBe(0);
  });

  it("到 28 天封顶的机器贡献 0，已销毁的不计", () => {
    expect(
      trafficTomorrowBytes(
        machine({ traffic_limit_bytes: 1000 * GIB }),
      ),
    ).toBe(0);

    const servers = [
      machine(),
      machine({ state: "destroyed" }),
      machine({ traffic_limit_bytes: 1000 * GIB }),
    ];
    // 只有第一台贡献 35.7 GiB：销毁与封顶都不加。
    expect(trafficPoolTomorrowBytes(servers)).toBeCloseTo((1000 * GIB) / 28);
  });
});
