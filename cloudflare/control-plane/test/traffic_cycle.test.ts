import { describe, expect, it } from "vitest";

import { releasedBytes } from "../src/traffic_cycle";

const GIB = 1024 ** 3;
const DAY_MS = 24 * 3600 * 1000;
const NOW = Date.parse("2026-11-26T12:00:00Z");
const CYCLE = "2026-11";
const MONTH_START = Date.parse("2026-11-01T00:00:00Z");

/** 100 GiB 月额度、按 28 天释放：一天的份额 = floor(100 GiB / 28)。 */
const ONE_DAY_100GIB = 3_834_792_228;
const LIMIT_100GIB_26D = 99_704_597_942;
const LIMIT_100GIB_23D = 88_200_221_257;

function server(overrides: Partial<Parameters<typeof releasedBytes>[0]> = {}) {
  return {
    transfer_gib: 100,
    ready_at: null as number | null,
    billing_anchor_at: MONTH_START,
    created_at: MONTH_START,
    destroyed_at: null as number | null,
    ...overrides,
  };
}

describe("releasedBytes · 起算点", () => {
  it("结算前的 pending 机器：billing_anchor_at = 0 必须当缺失，按建机时刻只给一天份", () => {
    // orders.ts 建 pending 行时 daily_price_cents / billing_anchor_at 都是 0，ready_at 为 null。
    const pending = server({
      ready_at: null,
      billing_anchor_at: 0,
      created_at: Date.parse("2026-11-26T10:00:00Z"),
    });
    expect(releasedBytes(pending, CYCLE, NOW)).toBe(ONE_DAY_100GIB);
  });

  it("billing_anchor_at = 0 但 ready_at 有值：用 ready_at，不受 0 影响", () => {
    const machine = server({
      ready_at: Date.parse("2026-11-20T00:00:00Z"),
      billing_anchor_at: 0,
      created_at: Date.parse("2026-11-26T10:00:00Z"),
    });
    // 11 月 20 日 0 点到 26 日 12 点 = 6 个整天 → 7 天份。
    expect(releasedBytes(machine, CYCLE, NOW)).toBe(26_843_545_600);
  });

  it("两个时刻都为正时 ready_at 优先，billing_anchor_at 次之，created_at 兜底", () => {
    const withReady = server({
      ready_at: Date.parse("2026-11-10T00:00:00Z"),
      billing_anchor_at: Date.parse("2026-11-20T00:00:00Z"),
      created_at: Date.parse("2026-11-26T10:00:00Z"),
    });
    // 11 月 10 日 0 点起算 = 16 个整天 → 17 天份。
    expect(releasedBytes(withReady, CYCLE, NOW)).toBe(65_191_467_885);

    const withAnchor = server({
      ready_at: null,
      billing_anchor_at: Date.parse("2026-11-20T00:00:00Z"),
      created_at: Date.parse("2026-11-26T10:00:00Z"),
    });
    expect(releasedBytes(withAnchor, CYCLE, NOW)).toBe(26_843_545_600);
  });

  it("上个月建机、本周期两个时刻都没有：仍从周期开始起算（老行行为不变）", () => {
    const old = server({
      ready_at: null,
      billing_anchor_at: Date.parse("2026-10-05T00:00:00Z"),
      created_at: Date.parse("2026-10-05T00:00:00Z"),
    });
    expect(releasedBytes(old, CYCLE, NOW)).toBe(LIMIT_100GIB_26D);
  });

  it("销毁：周期开始前销毁不计额度，周期内销毁按 destroyed_at 截止", () => {
    expect(
      releasedBytes(server({ destroyed_at: Date.parse("2026-10-20T00:00:00Z") }), CYCLE, NOW),
    ).toBe(0);
    expect(
      releasedBytes(server({ destroyed_at: NOW - 3 * DAY_MS }), CYCLE, NOW),
    ).toBe(LIMIT_100GIB_23D);
  });

  it("额度未知（transfer_gib = 0）：不释放任何额度", () => {
    expect(releasedBytes(server({ transfer_gib: 0 }), CYCLE, NOW)).toBe(0);
  });
});
