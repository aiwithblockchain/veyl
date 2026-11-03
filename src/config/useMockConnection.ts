import { useCallback, useEffect, useRef, useState } from "react";

export type MockConnectionState = "idle" | "starting" | "connected" | "stopping";

const START_DELAY = 700;
const STOP_DELAY = 400;

/** 批 2 的假连接：按钮与状态先跑通，批 1 的 runtime_start / runtime_stop 接上后替换。 */
export function useMockConnection() {
  const [state, setState] = useState<MockConnectionState>("idle");
  const [connectedConfigId, setConnectedConfigId] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const start = useCallback(
    (configId: string) => {
      clearTimer();
      setConnectedConfigId(null);
      setState("starting");
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setConnectedConfigId(configId);
        setState("connected");
      }, START_DELAY);
    },
    [clearTimer],
  );

  const stop = useCallback(() => {
    clearTimer();
    setState("stopping");
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setConnectedConfigId(null);
      setState("idle");
    }, STOP_DELAY);
  }, [clearTimer]);

  return { state, connectedConfigId, start, stop };
}
