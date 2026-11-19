import { describe, expect, it } from "vitest";
import {
  billingNoticeText,
  formatBuildDuration,
  serverDetailState,
  serverRailState,
  serverTone,
  stateTone,
  trialAvailableHint,
  trialEmptyHint,
  trialGroupHint,
  trialPhase,
} from "./labels";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/**
 * 试用口径的唯一测试出处：节点卡组标题与「我的服务器」空态都读这里。
 * 组件测试只验证接线，取整与三态互斥全部在这一份里定。
 */
describe("试用口径：五种输入", () => {
  it("available：还没起算，空态写试用 7 天，组标题写试用中", () => {
    expect(trialPhase("available", null, NOW)).toEqual({ kind: "available" });
    expect(trialEmptyHint("available", 2, null, NOW)).toBe(
      "还有 2 个免费节点，试用 7 天。",
    );
    expect(trialGroupHint(null, null, NOW)).toBe("试用中");
  });

  it("active：有效未来时间按剩余天数向下取整，两处数字相同", () => {
    const expires = at(6 * DAY + 23 * HOUR);
    expect(trialPhase("active", expires, NOW)).toEqual({
      kind: "counting",
      days: 6,
    });
    expect(trialEmptyHint("active", 2, expires, NOW)).toBe(
      "还有 2 个免费节点，6 天后到期。",
    );
    expect(trialGroupHint(null, expires, NOW)).toBe("6 天后到期");
  });

  it("expired：过去时间归为 ended，空态不显示，组标题写已到期", () => {
    expect(trialPhase("active", at(-1), NOW)).toEqual({ kind: "ended" });
    expect(trialEmptyHint("active", 2, at(-1), NOW)).toBeNull();
    expect(trialGroupHint(null, at(-1), NOW)).toBe("已到期");
  });

  it("无时间戳：空态不显示，组标题写试用中", () => {
    expect(trialPhase("active", null, NOW)).toEqual({ kind: "unknown" });
    expect(trialEmptyHint("active", 2, null, NOW)).toBeNull();
    expect(trialGroupHint(null, null, NOW)).toBe("试用中");
  });

  it("非法时间：与无时间戳同口径，不编造天数", () => {
    expect(trialPhase("active", "not-a-date", NOW)).toEqual({
      kind: "unknown",
    });
    expect(trialEmptyHint("active", 2, "not-a-date", NOW)).toBeNull();
    expect(trialGroupHint(null, "not-a-date", NOW)).toBe("试用中");
  });

  it("三种展示互斥：同一时刻只有一种能写出来", () => {
    const empty = trialEmptyHint("active", 2, at(6 * DAY), NOW);
    const group = trialGroupHint(null, at(6 * DAY), NOW);
    expect(empty).toBe("还有 2 个免费节点，6 天后到期。");
    expect(empty).not.toContain("试用 7 天");
    expect(group).toBe("6 天后到期");
    expect(group).not.toBe("试用中");
    expect(group).not.toBe("已到期");

    expect(trialEmptyHint("available", 2, null, NOW)).not.toContain("天后到期");
    expect(trialGroupHint(null, null, NOW)).not.toContain("天后到期");
    expect(trialGroupHint(null, at(-1), NOW)).not.toContain("天后到期");
  });
});

describe("试用口径：边界", () => {
  it("整 24 小时算 1 天，少 1 毫秒只写不到 1 天", () => {
    expect(trialGroupHint(null, at(DAY), NOW)).toBe("1 天后到期");
    expect(trialEmptyHint("active", 2, at(DAY), NOW)).toBe(
      "还有 2 个免费节点，1 天后到期。",
    );
    expect(trialGroupHint(null, at(DAY - 1), NOW)).toBe("不到 1 天后到期");
  });

  it("到期时刻当下与之前都算 ended，不写 0 天后", () => {
    expect(trialPhase("active", at(0), NOW)).toEqual({ kind: "ended" });
    expect(trialGroupHint(null, at(0), NOW)).toBe("已到期");
    expect(trialEmptyHint("active", 2, at(0), NOW)).toBeNull();
  });

  it("剩余不足 24 小时写不到 1 天，不写今天", () => {
    expect(trialGroupHint(null, at(23 * HOUR + 59 * 60_000), NOW)).toBe(
      "不到 1 天后到期",
    );
    expect(trialEmptyHint("active", 1, at(HOUR), NOW)).toBe(
      "还有 1 个免费节点，不到 1 天后到期。",
    );
  });

  it("空串时间戳按无时间处理", () => {
    expect(trialPhase("active", "", NOW)).toEqual({ kind: "unknown" });
    expect(trialEmptyHint("active", 2, "", NOW)).toBeNull();
  });

  it("数量为 0 或更少时整句不显示，状态与时间都不参与", () => {
    expect(trialEmptyHint("available", 0, null, NOW)).toBeNull();
    expect(trialEmptyHint("active", 0, at(6 * DAY), NOW)).toBeNull();
    expect(trialEmptyHint("active", -1, at(6 * DAY), NOW)).toBeNull();
  });

  it("expired 状态不信未来时间：状态已过期就按 ended", () => {
    expect(trialPhase("expired", at(6 * DAY), NOW)).toEqual({ kind: "ended" });
    expect(trialEmptyHint("expired", 2, at(6 * DAY), NOW)).toBeNull();
    expect(trialGroupHint("expired", at(6 * DAY), NOW)).toBe("已到期");
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

  it("满一小时换算成小时与分钟，不再报 120 分", () => {
    expect(formatBuildDuration(created, "2026-11-18T12:00:00.000Z")).toBe(
      "2 小时 0 分",
    );
    expect(formatBuildDuration(created, "2026-11-18T11:03:05.000Z")).toBe(
      "1 小时 3 分",
    );
  });

  it("没有 ready_at 或时间解析失败返回 null", () => {
    expect(formatBuildDuration(created, null)).toBeNull();
    expect(formatBuildDuration(created, "not-a-date")).toBeNull();
  });
});

describe("左栏常驻试用提示", () => {
  it("active：写还剩几个免费节点可用与几天到期", () => {
    expect(trialAvailableHint("active", 2, at(6 * DAY), NOW)).toBe(
      "还有 2 个免费节点可用，6 天后到期。",
    );
  });

  it("available：还没起算时写试用 7 天", () => {
    expect(trialAvailableHint("available", 2, null, NOW)).toBe(
      "还有 2 个免费节点可用，试用 7 天。",
    );
  });

  it("已过期、没有节点或拿不到时间：不显示", () => {
    expect(trialAvailableHint("expired", 2, at(6 * DAY), NOW)).toBeNull();
    expect(trialAvailableHint("active", 0, at(6 * DAY), NOW)).toBeNull();
    expect(trialAvailableHint("active", 2, at(-1), NOW)).toBeNull();
    expect(trialAvailableHint("active", 2, null, NOW)).toBeNull();
  });
});

describe("serverTone / serverRailState：欠费压过机器状态", () => {
  it("past_due：点变 warn，词写已欠费", () => {
    const server = { state: "active" as const, billing_state: "past_due" as const };
    expect(serverTone(server)).toBe("warn");
    expect(serverRailState(server)).toBe("已欠费");
  });

  it("expired：点变 warn，词写已停用", () => {
    const server = { state: "active" as const, billing_state: "expired" as const };
    expect(serverTone(server)).toBe("warn");
    expect(serverRailState(server)).toBe("已停用");
  });

  it("进行中的机器 billing_state 是 pending：不受欠费覆盖", () => {
    const server = { state: "installing" as const, billing_state: "pending" as const };
    expect(serverTone(server)).toBe("idle");
    expect(serverRailState(server)).toBe("安装中");
    // 详情页用长词，与进度块步骤一致。
    expect(serverDetailState(server)).toBe("安装服务端");
  });

  it("欠费词两个界面同源：详情与左栏都写「已欠费」", () => {
    const server = { state: "active" as const, billing_state: "past_due" as const };
    expect(serverDetailState(server)).toBe("已欠费");
    expect(serverDetailState(server)).toBe(serverRailState(server));
  });
});

describe("billingNoticeText", () => {
  it("past_due 不写相对时间词「今天」，宽限天数照旧", () => {
    const noGrace = billingNoticeText(
      { billing_state: "past_due", grace_ends_at: null },
      NOW,
    );
    expect(noGrace).toContain("最近一次扣费没成功");
    expect(noGrace).not.toContain("今天");

    const withGrace = billingNoticeText(
      { billing_state: "past_due", grace_ends_at: at(2 * DAY) },
      NOW,
    );
    expect(withGrace).toContain("最近一次扣费没成功");
    expect(withGrace).toContain("宽限还剩 2 天");
    expect(withGrace).not.toContain("今天");
  });

  it("expired 那段保持不变", () => {
    const text = billingNoticeText(
      { billing_state: "expired", grace_ends_at: null },
      NOW,
    );
    expect(text).toContain("服务已停用");
  });
});
