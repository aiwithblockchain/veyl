import { describe, expect, it } from "vitest";
import { formatTrialExpiry } from "./labels";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("formatTrialExpiry", () => {
  it("剩余 23 小时 59 分仍写「不到 1 天后到期」", () => {
    expect(formatTrialExpiry(at(23 * HOUR + 59 * 60_000), NOW)).toBe(
      "不到 1 天后到期",
    );
  });

  it("剩余 1 小时写「不到 1 天后到期」", () => {
    expect(formatTrialExpiry(at(HOUR), NOW)).toBe("不到 1 天后到期");
  });

  it("已过期（负毫秒差）返回 null，不说反话", () => {
    expect(formatTrialExpiry(at(-1), NOW)).toBeNull();
    expect(formatTrialExpiry(at(-DAY), NOW)).toBeNull();
  });

  it("向下取整：整 24 小时算 1 天，6 天 23 小时算 6 天", () => {
    expect(formatTrialExpiry(at(DAY), NOW)).toBe("1 天后到期");
    expect(formatTrialExpiry(at(6 * DAY + 23 * HOUR), NOW)).toBe("6 天后到期");
  });

  it("没有时间或解析失败返回 null", () => {
    expect(formatTrialExpiry(null, NOW)).toBeNull();
    expect(formatTrialExpiry("not-a-date", NOW)).toBeNull();
  });
});
