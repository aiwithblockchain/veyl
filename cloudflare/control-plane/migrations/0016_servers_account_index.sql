-- 账号维度的服务器扫描（Felix 用 EXPLAIN 验证，2026-11-26）：
-- 现有 servers 索引只有 `(account_id, node_port) WHERE destroyed_at IS NULL` 这个部分索引，
-- 带 `WHERE account_id = ?` 的查询用不上，计划退化成全表扫 + 每行 `id = ?` 搜索。
--
-- 加这条之后 `servers WHERE account_id = ?` 走 SEARCH ... USING INDEX servers_account；
-- 收益最大的两条路径：
--   1) 账单流水的机器归属（`GET /v1/billing/ledger` 的 LEFT JOIN servers）；
--   2) `MyServer` 流量四字段的按账号聚合查询（列表每次请求一次）；
--   3) 节点流量上报里的 `accountTotals`（每次上报都跑）。
CREATE INDEX servers_account ON servers(account_id);
