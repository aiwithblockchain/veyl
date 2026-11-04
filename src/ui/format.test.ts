import { describe, expect, it } from "vitest";
import { formatDuration, formatTraffic } from "./format";

describe("formatDuration", () => {
  it("59 秒显示刚刚，60 秒起按分钟", () => {
    expect(formatDuration(0)).toBe("刚刚");
    expect(formatDuration(59)).toBe("刚刚");
    expect(formatDuration(60)).toBe("1 分钟");
  });

  it("59 分、1 小时、1 小时 12 分、24 小时", () => {
    expect(formatDuration(59 * 60)).toBe("59 分钟");
    expect(formatDuration(60 * 60)).toBe("1 小时");
    expect(formatDuration(60 * 60 + 12 * 60)).toBe("1 小时 12 分钟");
    expect(formatDuration(24 * 60 * 60)).toBe("24 小时");
  });
});

describe("formatTraffic", () => {
  it("1023 B 显示字节，1024 B 起按 KB 取整", () => {
    expect(formatTraffic(0)).toBe("0 B");
    expect(formatTraffic(1023)).toBe("1023 B");
    expect(formatTraffic(1024)).toBe("1 KB");
  });

  it("MB / GB 保留一位小数，1024 MB 切到 GB", () => {
    expect(formatTraffic(1024 * 1024)).toBe("1.0 MB");
    expect(formatTraffic(1.2 * 1024 * 1024)).toBe("1.2 MB");
    expect(formatTraffic(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
});
