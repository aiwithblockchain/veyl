import { describe, expect, it } from "vitest";
import {
  pushRateSample,
  rateChart,
  rateLabel,
  shouldPushRateSample,
  type RateSample,
} from "./rateSeries";

const sample = (up: number, down: number): RateSample => ({ up, down });

describe("pushRateSample 环形缓冲", () => {
  it("只保留最近 capacity 个样本", () => {
    let samples: RateSample[] = [];
    for (let index = 0; index < 35; index += 1) {
      samples = pushRateSample(samples, sample(index, index), 30);
    }
    expect(samples).toHaveLength(30);
    expect(samples[0]).toEqual(sample(5, 5));
    expect(samples[29]).toEqual(sample(34, 34));
  });

  it("非有限值按 0 记", () => {
    expect(pushRateSample([], sample(Number.NaN, Infinity))).toEqual([
      { up: 0, down: 0 },
    ]);
  });

  it("默认容量 30", () => {
    let samples: RateSample[] = [];
    for (let index = 0; index < 40; index += 1) samples = pushRateSample(samples, sample(1, 1));
    expect(samples).toHaveLength(30);
  });
});

describe("rateChart", () => {
  it("没有样本只画贴底基线", () => {
    const chart = rateChart([], 100, 40);
    expect(chart.line).toBe("M0,38 L100,38");
    expect(chart.area).toBe("");
  });

  it("样本从右往左排，不满时左端留空", () => {
    const chart = rateChart([sample(1, 1), sample(1, 1)], 100, 40);
    // 两个点铺满宽度；起点在 0，终点在 100。
    expect(chart.line.startsWith("M0.0")).toBe(true);
    expect(chart.line).toContain("L100.0");
  });

  it("峰值归一化到顶部以内", () => {
    const chart = rateChart([sample(5, 5), sample(10, 10)], 100, 40);
    const ys = chart.line
      .replace("M", "")
      .split(" L")
      .map((pair) => Number(pair.split(",")[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(4);
    expect(Math.max(...ys)).toBeLessThanOrEqual(38);
    expect(ys[1]).toBeLessThan(ys[0]);
  });

  it("area 闭合到基线", () => {
    const chart = rateChart([sample(3, 3)], 100, 40);
    expect(chart.area.endsWith("Z")).toBe(true);
    expect(chart.area).toContain("L100,38");
  });
});

describe("rateLabel", () => {
  it("没有样本返回 null，有样本给最新一条", () => {
    expect(rateLabel([])).toBeNull();
    expect(rateLabel([sample(1, 2), sample(3, 4)])).toEqual({ up: 3, down: 4 });
  });
});

describe("shouldPushRateSample", () => {
  it("时间戳推进才记新样本", () => {
    expect(shouldPushRateSample(null, "2026-11-05T10:00:00Z")).toBe(true);
    expect(
      shouldPushRateSample("2026-11-05T10:00:00Z", "2026-11-05T10:00:00Z"),
    ).toBe(false);
    expect(
      shouldPushRateSample("2026-11-05T10:00:00Z", "2026-11-05T10:00:02Z"),
    ).toBe(true);
  });

  it("没有时间戳的流量不记样本", () => {
    expect(shouldPushRateSample(null, "")).toBe(false);
    expect(shouldPushRateSample("2026-11-05T10:00:00Z", null)).toBe(false);
    expect(shouldPushRateSample(null, undefined)).toBe(false);
  });
});
