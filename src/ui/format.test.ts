import { describe, expect, it } from "vitest";
import { formatCheckedAgo, formatClock, formatTraffic } from "./format";

describe("formatTraffic", () => {
  it("1023 B 显示字节，1024 B 起按 KB 取整", () => {
    expect(formatTraffic(0)).toBe("0 B");
    expect(formatTraffic(1023)).toBe("1023 B");
    expect(formatTraffic(1024)).toBe("1 KB");
  });

  it("MB / GB 保留两位小数精度，末尾 0 收敛", () => {
    expect(formatTraffic(1024 * 1024)).toBe("1.0 MB");
    expect(formatTraffic(1.2 * 1024 * 1024)).toBe("1.2 MB");
    expect(formatTraffic(1.04 * 1024 ** 3)).toBe("1.04 GB");
    expect(formatTraffic(1.0 * 1024 ** 3)).toBe("1.0 GB");
    expect(formatTraffic(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("KB 上限 1023，1048575 进 MB，1023.99 MB 不被抬成 1024", () => {
    expect(formatTraffic(1023 * 1024)).toBe("1023 KB");
    expect(formatTraffic(1024 * 1024 - 1)).toBe("1.0 MB");
    expect(formatTraffic(1023.99 * 1024 * 1024)).toBe("1023.99 MB");
  });

  it("非有限值显示破折号", () => {
    expect(formatTraffic(Number.NaN)).toBe("—");
    expect(formatTraffic(Infinity)).toBe("—");
  });
});

describe("formatClock", () => {
  it("按 HH:MM:SS 补零", () => {
    expect(formatClock(0)).toBe("00:00:00");
    expect(formatClock(61)).toBe("00:01:01");
    expect(formatClock(12 * 60 + 47)).toBe("00:12:47");
    expect(formatClock(3600 + 5)).toBe("01:00:05");
  });

  it("非有限或负数按 00:00:00", () => {
    expect(formatClock(Number.NaN)).toBe("00:00:00");
    expect(formatClock(-5)).toBe("00:00:00");
    expect(formatClock(Infinity)).toBe("00:00:00");
  });
});

describe("formatCheckedAgo", () => {
  const now = Date.parse("2026-11-05T10:00:00Z");

  it("5 秒内是刚刚检测，之后按秒/分钟", () => {
    expect(formatCheckedAgo("2026-11-05T09:59:58Z", now)).toBe("刚刚检测");
    expect(formatCheckedAgo("2026-11-05T09:59:48Z", now)).toBe("12 秒前检测");
    expect(formatCheckedAgo("2026-11-05T09:58:00Z", now)).toBe("2 分钟前检测");
  });

  it("缺失或无效时显示确认中", () => {
    expect(formatCheckedAgo(null, now)).toBe("确认中…");
    expect(formatCheckedAgo("not-a-date", now)).toBe("确认中…");
  });
});
