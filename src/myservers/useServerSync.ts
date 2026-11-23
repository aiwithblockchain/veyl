import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentBridge,
  MyServer,
  ServerSyncChanged,
  SyncIntervalMinutes,
} from "../agent/bridge";
import { uiLog } from "../log/uiLog";

interface Options {
  bridge: AgentBridge;
  /** null = 设置还没读回来；0 = 只手动。两者都不排定时、不做启动同步。 */
  intervalMinutes: SyncIntervalMinutes | null;
  /** 未登录不发请求：读不到账户时也不做启动同步。 */
  enabled: boolean;
  /** 账户代次：登出/登录/换号时递增；迟到结果不能落到新的账户态上。 */
  accountEpoch: number;
  /** 同步返回的服务器列表落到界面：不额外再发一次 list。 */
  applyServers?: (servers: MyServer[]) => void;
  /** 只把有变化的节点交给提示层；无变化不调用。 */
  onChanged: (changed: ServerSyncChanged[]) => void;
}

/** 节点配置同步：定时 + 手动共用一个 in-flight 守卫；失败不动本地数据。 */
export function useServerSync({
  bridge,
  intervalMinutes,
  enabled,
  accountEpoch,
  applyServers,
  onChanged,
}: Options) {
  const [busy, setBusy] = useState(false);
  // 最近一次成功同步的时刻；不持久化，重启即 null。
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  // 最近一次真正跑完的尝试结果：界面据此给成功/失败反馈；换号后清空。
  const [lastResult, setLastResult] = useState<"ok" | "error" | null>(null);
  const [lastResultAt, setLastResultAt] = useState<number | null>(null);
  const busyRef = useRef(false);
  // 只有成功同步才推进；初值 0 = 「很久以前」，首轮触发后即按间隔判断。
  const lastRunAtRef = useRef(0);
  // 启动同步只做一次：之后改间隔只重建定时器。
  const startedRef = useRef(false);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const applyServersRef = useRef(applyServers);
  applyServersRef.current = applyServers;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const accountEpochRef = useRef(accountEpoch);
  accountEpochRef.current = accountEpoch;

  const syncNow = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    // 未登录不发账户命令（§11）：定时器已按 enabled 停掉，手动触发也不能漏。
    if (!enabledRef.current) {
      uiLog("info", "server sync skipped reason=signed_out", "servers");
      return false;
    }
    busyRef.current = true;
    setBusy(true);
    const startedEpoch = accountEpochRef.current;
    const startedEnabled = enabledRef.current;
    try {
      const data = await bridge.myServerSync();
      // 迟到结果：已登出或账户代次变了就不落地，留给新账户自己跑。
      if (
        !startedEnabled ||
        !enabledRef.current ||
        accountEpochRef.current !== startedEpoch
      ) {
        return false;
      }
      lastRunAtRef.current = Date.now();
      setLastSyncedAt(lastRunAtRef.current);
      setLastResult("ok");
      setLastResultAt(lastRunAtRef.current);
      applyServersRef.current?.(data.servers);
      if (data.changed.length > 0) onChangedRef.current(data.changed);
      return true;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "unknown";
      console.warn("[server-sync] sync failed", code);
      uiLog("warn", `server sync failed code=${code}`, "servers");
      // 迟到的失败同样不能算到新账户头上。
      if (enabledRef.current && accountEpochRef.current === startedEpoch) {
        setLastResult("error");
        setLastResultAt(Date.now());
      }
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [bridge]);

  // 启动同步每个账户各一次：换账号后新账户要有自己的首轮。
  const prevEpochRef = useRef(accountEpoch);
  useEffect(() => {
    if (prevEpochRef.current === accountEpoch) return;
    prevEpochRef.current = accountEpoch;
    startedRef.current = false;
    // 换账号后不能显示上一个账号的同步时间，也不能沿用它的成功/失败结果。
    setLastSyncedAt(null);
    setLastResult(null);
    setLastResultAt(null);
  }, [accountEpoch]);

  useEffect(() => {
    if (!enabled) return;
    if (intervalMinutes === null || intervalMinutes <= 0) return;
    if (!startedRef.current) {
      startedRef.current = true;
      void syncNow();
    }
    const intervalMs = intervalMinutes * 60_000;
    const due = () => Date.now() - lastRunAtRef.current >= intervalMs;
    // 休眠会让 tick 迟到：醒来先按上次成功时刻判断，不盲目补跑。
    const timer = window.setInterval(() => {
      if (due()) void syncNow();
    }, intervalMs);
    const onVisibility = () => {
      if (document.visibilityState === "visible" && due()) void syncNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMinutes, syncNow, accountEpoch]);

  return { syncNow, busy, lastSyncedAt, lastResult, lastResultAt };
}
