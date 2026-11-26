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
    provider_gone_at: null as number | null,
    // 默认「已续到明天」：额度天数被已付天数封顶，专门测上限的用例自己覆盖它。
    paid_until: NOW + DAY_MS as number | null,
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

  it("created_at 也是 0（老行/脏数据）：锚点退到 end，只剩一天份额", () => {
    const broken = server({
      ready_at: null,
      billing_anchor_at: 0,
      created_at: 0,
      destroyed_at: null,
    });
    expect(releasedBytes(broken, CYCLE, NOW)).toBe(ONE_DAY_100GIB);
  });
});

describe("releasedBytes · 日边界 00:00", () => {
  it("同一天建的机器，不管几点建，额度都在同一个 00:00 涨一格", () => {
    const morning = server({
      ready_at: Date.parse("2026-11-10T08:00:00Z"),
      billing_anchor_at: Date.parse("2026-11-10T08:00:00Z"),
      created_at: Date.parse("2026-11-10T08:00:00Z"),
    });
    const evening = server({
      ready_at: Date.parse("2026-11-10T20:00:00Z"),
      billing_anchor_at: 0,
      created_at: Date.parse("2026-11-10T20:00:00Z"),
    });
    const at = Date.parse("2026-11-11T09:00:00Z");

    // 旧口径按各自的建机时刻起算：早上那台 2 份、晚上那台 1 份。
    expect(releasedBytes(morning, CYCLE, at)).toBe(7_669_584_457);
    expect(releasedBytes(evening, CYCLE, at)).toBe(7_669_584_457);
  });

  it("额度在 00:00 那一刻涨一格，不是按建机时刻的相位", () => {
    const machine = server({
      ready_at: Date.parse("2026-11-10T08:00:00Z"),
      billing_anchor_at: 0,
      created_at: Date.parse("2026-11-10T08:00:00Z"),
    });
    expect(releasedBytes(machine, CYCLE, Date.parse("2026-11-10T23:59:59Z"))).toBe(ONE_DAY_100GIB);
    expect(releasedBytes(machine, CYCLE, Date.parse("2026-11-11T00:00:00Z"))).toBe(7_669_584_457);
  });
});

describe("releasedBytes · 额度被已付天数封顶", () => {
  const SAME_DAY = {
    ready_at: Date.parse("2026-11-10T23:59:00Z"),
    billing_anchor_at: Date.parse("2026-11-10T00:00:00Z"),
    created_at: Date.parse("2026-11-10T23:59:00Z"),
  };

  it("23:59 建、00:05 销毁：付 1 天就只给 1 份，不能拿 2 份", () => {
    const machine = server({
      ...SAME_DAY,
      paid_until: Date.parse("2026-11-11T00:00:00Z"),
      destroyed_at: Date.parse("2026-11-11T00:05:00Z"),
    });
    // 存活天数算出来是 1 个整天（2 份），但钱只付了 1 天。
    expect(releasedBytes(machine, CYCLE, Date.parse("2026-11-11T00:05:00Z"))).toBe(ONE_DAY_100GIB);
  });

  it("跨过 00:00 且已预扣：额度从 1 份变 2 份（上限不压已付的那一天）", () => {
    const running = {
      ready_at: Date.parse("2026-11-10T10:00:00Z"),
      billing_anchor_at: Date.parse("2026-11-10T00:00:00Z"),
      created_at: Date.parse("2026-11-10T10:00:00Z"),
      paid_until: Date.parse("2026-11-12T00:00:00Z"), // 23:00 预扣了第二天
    };
    expect(releasedBytes(server(running), CYCLE, Date.parse("2026-11-10T23:59:00Z"))).toBe(
      ONE_DAY_100GIB,
    );
    expect(releasedBytes(server(running), CYCLE, Date.parse("2026-11-11T00:00:00Z"))).toBe(
      7_669_584_457,
    );
  });

  it("付 1 天、活 3 天（没续上）：额度停在 1 份，不随存活天数涨", () => {
    const machine = server({
      ready_at: Date.parse("2026-11-10T10:00:00Z"),
      billing_anchor_at: Date.parse("2026-11-10T00:00:00Z"),
      created_at: Date.parse("2026-11-10T10:00:00Z"),
      paid_until: Date.parse("2026-11-11T00:00:00Z"),
    });
    expect(releasedBytes(machine, CYCLE, Date.parse("2026-11-13T10:00:00Z"))).toBe(ONE_DAY_100GIB);
  });
});

describe("releasedBytes · 从未结算就被销毁", () => {
  // 建机阶段就能销（destroy 只拦 destroyed），而 `+1` 的预付天会让每台幽灵机白拿 1/28：
  // 造 28 台再立刻销毁 = 一个月的额度，是正收益的套利。
  it("建机一小时就销毁：不释放任何额度", () => {
    const ghost = server({
      ready_at: null,
      billing_anchor_at: 0,
      created_at: NOW - 3600 * 1000,
      destroyed_at: NOW,
    });
    expect(releasedBytes(ghost, CYCLE, NOW)).toBe(0);
  });

  it("跨整天边界的幽灵机同样是 0（修复前至少留下 1/28）", () => {
    const ghost = server({
      ready_at: null,
      billing_anchor_at: 0,
      created_at: Date.parse("2026-11-24T00:00:00Z"),
      destroyed_at: Date.parse("2026-11-26T06:00:00Z"),
    });
    expect(releasedBytes(ghost, CYCLE, NOW)).toBe(0);
  });

  it("已结算后正常销毁：额度按 destroyed_at 截止，不能被一起归零", () => {
    const machine = server({
      ready_at: Date.parse("2026-11-01T00:00:00Z"),
      destroyed_at: NOW - 3 * DAY_MS,
    });
    expect(releasedBytes(machine, CYCLE, NOW)).toBe(LIMIT_100GIB_23D);
  });
});

describe("releasedBytes · 失联封顶", () => {
  it("周期内失联：额度停在失联时刻，之后不再涨", () => {
    const gone = server({ provider_gone_at: NOW - 3 * DAY_MS });
    expect(releasedBytes(gone, CYCLE, NOW)).toBe(LIMIT_100GIB_23D);
    // 同一台机器再过 20 天查也不变：这不是「按 now 现算」的量。
    expect(releasedBytes(gone, CYCLE, NOW + 20 * DAY_MS)).toBe(LIMIT_100GIB_23D);
  });

  it("周期开始前就失联：本周期不释放，下个周期也不会白送一份", () => {
    const gone = server({ provider_gone_at: Date.parse("2026-10-20T00:00:00Z") });
    expect(releasedBytes(gone, CYCLE, NOW)).toBe(0);
    expect(releasedBytes(gone, "2026-12", Date.parse("2026-12-10T00:00:00Z"))).toBe(0);
  });

  it("失联早于销毁：取更早的那个", () => {
    const both = server({
      provider_gone_at: NOW - 5 * DAY_MS,
      destroyed_at: NOW - DAY_MS,
    });
    // NOW − 5 天 = 11 月 21 日 12 点 → 20 个整天 → 21 天份 = 100 GiB × 21/28。
    expect(releasedBytes(both, CYCLE, NOW)).toBe(80_530_636_800);
  });
});
