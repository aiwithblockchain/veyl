import { describe, expect, it } from "vitest";
import type { RuntimeSnapshot, RuntimeState } from "../agent/protocol";
import { createRuntimeAuthority } from "./runtimeAuthority";

function snapshot(state: RuntimeState, at: string): RuntimeSnapshot {
  return { state, last_transition_at: at } as RuntimeSnapshot;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("createRuntimeAuthority", () => {
  it("同阶段快照只更新状态，不回拨时刻", () => {
    const authority = createRuntimeAuthority();
    authority.markLocal("running", 2000);

    const stale = snapshot("running", iso(1000));
    expect(authority.acceptsSnapshot(stale)).toBe(true);
    authority.markSnapshot(stale);

    expect(authority.current()).toEqual({ state: "running", at: 2000 });
  });

  it("快照缺时刻时保持当前时刻", () => {
    const authority = createRuntimeAuthority();
    authority.markLocal("idle", 3000);

    authority.markSnapshot(snapshot("idle", ""));

    expect(authority.current()).toEqual({ state: "idle", at: 3000 });
  });

  it("时刻落在两个实例之间的事件：共享权威下两边判断一致", () => {
    const authority = createRuntimeAuthority();
    authority.markLocal("running", 2000);

    // 比权威旧的事件被拒绝。
    expect(
      authority.acceptEvent({ from: "idle", to: "starting", emitted_at: iso(1500) }),
    ).toBe(false);
    // 更新的事件接受，时刻前进。
    expect(
      authority.acceptEvent({ from: "running", to: "stopping", emitted_at: iso(2500) }),
    ).toBe(true);
    expect(authority.current()).toEqual({ state: "stopping", at: 2500 });
  });

  it("同一条事件被两个订阅者各处理一次时，第二次按重复接受", () => {
    const authority = createRuntimeAuthority();
    const event = { from: "idle" as const, to: "starting" as const, emitted_at: iso(1000) };

    expect(authority.acceptEvent(event)).toBe(true);
    expect(authority.acceptEvent(event)).toBe(true);
    expect(authority.current()).toEqual({ state: "starting", at: 1000 });
  });

  it("重复事件的快照不算「更新」：不能用它改写连接身份", () => {
    const authority = createRuntimeAuthority();
    const event = { from: "idle" as const, to: "running" as const, emitted_at: iso(1000) };

    expect(authority.isNewer(event)).toBe(true);
    authority.acceptEvent(event);
    // App 与 hook 各订阅一次：同一条事件的第二个订阅者仍然按「新」处理。
    expect(authority.isNewer(event)).toBe(true);
    expect(authority.acceptEvent(event)).toBe(true);
    // 更旧的重复事件不能改写身份。
    expect(authority.isNewer({ emitted_at: iso(999) })).toBe(false);
    expect(authority.isNewer({ emitted_at: iso(1001) })).toBe(true);
    // 解析不出时刻时不能判定为旧，退化到修复前行为。
    expect(authority.isNewer({})).toBe(true);
  });
});
