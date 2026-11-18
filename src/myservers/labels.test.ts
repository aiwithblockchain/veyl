import { describe, expect, it } from "vitest";
import { formatBuildDuration, formatTrialExpiry, stateTone } from "./labels";

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

describe("stateTone", () => {
  it("进行中的四个状态是中性色，不是警告", () => {
    for (const state of ["creating", "booting", "installing", "verifying"] as const) {
      expect(stateTone(state)).toBe("idle");
    }
  });

  it("出错与已失效仍是红色", () => {
    expect(stateTone("error")).toBe("err");
    expect(stateTone("gone")).toBe("err");
  });

  it("可用 / 使用中仍是绿色，销毁类是中性色", () => {
    expect(stateTone("healthy")).toBe("ok");
    expect(stateTone("active")).toBe("ok");
    expect(stateTone("destroying")).toBe("idle");
    expect(stateTone("destroyed")).toBe("idle");
  });
});

describe("formatBuildDuration", () => {
  const created = "2026-11-18T10:00:00.000Z";

  it("按分秒报创建用时", () => {
    expect(formatBuildDuration(created, "2026-11-18T10:02:55.000Z")).toBe(
      "2 分 55 秒",
    );
  });

  it("不到一分钟只报秒", () => {
    expect(formatBuildDuration(created, "2026-11-18T10:00:40.000Z")).toBe("40 秒");
  });

  it("没有 ready_at 或时间解析失败返回 null", () => {
    expect(formatBuildDuration(created, null)).toBeNull();
    expect(formatBuildDuration(created, "not-a-date")).toBeNull();
  });
});
