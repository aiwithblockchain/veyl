import { useEffect, useState } from "react";

/** 从 ISO 时刻起算的秒数，每秒刷新；没有起点时返回 null。 */
export function useElapsedSeconds(since: string | null): number | null {
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    if (!since) return;
    setTick(Date.now());
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [since]);

  if (!since) return null;
  const start = Date.parse(since);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((tick - start) / 1000));
}
