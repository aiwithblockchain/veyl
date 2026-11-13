import type { RuntimeSnapshot, RuntimeState } from "../agent/protocol";

export type RuntimePhase = "idle" | "starting" | "connected" | "stopping";

export function runtimePhase(state: RuntimeState): RuntimePhase {
  if (state === "starting" || state === "restarting") return "starting";
  if (state === "stopping") return "stopping";
  if (state === "running" || state === "degraded") return "connected";
  return "idle";
}

export interface RuntimeAuthorityMark {
  state: RuntimeState;
  at: number;
}

/**
 * 运行时状态的唯一权威：状态事件与本地 start/stop 成功结果共同维护。
 * `useVpnSession` 的 connection 与 App 的 runtime 视图都必须先过这里，
 * 免得一边按事件走、一边被滞后快照写回。
 */
export interface RuntimeAuthority {
  current(): RuntimeAuthorityMark | null;
  /** 状态事件是否生效；生效时同步推进权威标记。 */
  acceptEvent(payload: {
    from: RuntimeState;
    to: RuntimeState;
    emitted_at?: string;
  }): boolean;
  /**
   * 这条事件是否比权威时刻更新。重复/迟到事件仍会被 acceptEvent 接受（状态相同），
   * 但它们的快照可能带回旧的连接身份，不能拿来更新 config_id。
   */
  isNewer(payload: { emitted_at?: string }): boolean;
  /** start / stop 的本地结果：比任何既存事件都新。 */
  markLocal(state: RuntimeState, at?: number): void;
  /** 快照能否覆盖运行时状态：同一阶段，或比权威更新。 */
  acceptsSnapshot(snapshot: RuntimeSnapshot): boolean;
  markSnapshot(snapshot: RuntimeSnapshot): void;
}

function parseTime(value: string | null | undefined): number | null {
  const at = Date.parse(value ?? "");
  return Number.isFinite(at) ? at : null;
}

export function createRuntimeAuthority(): RuntimeAuthority {
  let mark: RuntimeAuthorityMark | null = null;
  // 最近一条被接受事件的时刻。App 与 hook 各订阅一次：两次都要算「新」，
  // 只有比它更旧的重复事件才是不能改写连接身份的旧数据。
  let latestEventAt: number | null = null;

  return {
    current: () => mark,

    acceptEvent(payload) {
      const at = parseTime(payload.emitted_at);
      if (mark) {
        // 同一条事件会被 App 与 hook 各订阅一次：落到同一状态且不更新就视为重复，直接接受。
        if (payload.to === mark.state && (at === null || at <= mark.at)) return true;
        if (at !== null && at < mark.at) return false;
        // 同一毫秒无法排序：只有 from 接续当前状态才算新的。
        // 边界：同一毫秒内 stopping→idle 反序时，后到的事件可能被当成陈旧，
        // 界面短暂停在 stopping，等下一次 refreshReal 自愈；概率很低，不做推断。
        if (at === mark.at && payload.from !== mark.state) return false;
      }
      // 兼容口径：解析不出 emitted_at（旧事件/测试）时一律接受，退化到修复前行为。
      if (at !== null && (latestEventAt === null || at > latestEventAt)) {
        latestEventAt = at;
      }
      mark = { state: payload.to, at: at ?? mark?.at ?? 0 };
      return true;
    },

    isNewer(payload) {
      const at = parseTime(payload.emitted_at);
      if (at === null || latestEventAt === null) return true;
      return at >= latestEventAt;
    },

    markLocal(state, at = Date.now()) {
      mark = { state, at };
    },

    acceptsSnapshot(snapshot) {
      if (!mark) return true;
      const at = parseTime(snapshot.last_transition_at);
      if (at !== null && at >= mark.at) return true;
      return runtimePhase(snapshot.state) === runtimePhase(mark.state);
    },

    markSnapshot(snapshot) {
      const at = parseTime(snapshot.last_transition_at);
      // 只前进不回拨：同阶段快照只更新 state，解析不出时刻时保持当前时刻。
      const nextAt = mark ? Math.max(mark.at, at ?? mark.at) : at ?? 0;
      mark = { state: snapshot.state, at: nextAt };
    },
  };
}
