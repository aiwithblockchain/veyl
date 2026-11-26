-- 计费改按 UTC 自然日（design/traffic-billing.md §4.0）：锚点与「已付到」都对齐到 00:00。
--
-- **一次性迁移，不要重复执行、也不要照抄到以后**：它依赖「现在几乎没有存量数据」这个前提
-- （2026-11-26 统计：prod 0 台、dev 2 台），把已有的非零点锚点直接 floor 到当天 00:00。
-- 之后再改口径必须走回填脚本，不能再用一条 UPDATE 拍平。
--
-- 新写入的行由代码保证对齐（`settleOrder` 写 `dayStartOf(readyAt)` 与次日 00:00，
-- 补扣每次 +1 天），这里只收拾历史行。
--
-- 影响的既有行：
--   - `billing_anchor_at`：建机时刻（如 11-26 10:00）→ 当天 00:00；
--   - `paid_until`：已付到的时刻（如 11-27 02:01）→ 当天 00:00。
--
-- 实际影响（**不是**「不会多收」的保证）：
--   1) 计费网格从「建机时刻 + n×24h」挪到 00:00，对齐后第一次扣费最多会**提前 12 小时**发生；
--   2) 销毁退款的整天边界跟着挪，销毁时点靠近零点的，可能因此**少退一天**；
--   3) 两边都 floor 只保证「已付天数」按整天重算，不保证金额与旧口径逐笔相等。
UPDATE servers
   SET billing_anchor_at = (billing_anchor_at / 86400000) * 86400000
 WHERE billing_anchor_at > 0;

UPDATE servers
   SET paid_until = (paid_until / 86400000) * 86400000
 WHERE paid_until > 0;
