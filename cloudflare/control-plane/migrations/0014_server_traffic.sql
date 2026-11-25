-- 节点流量计量与超支扣费（docs/design/traffic-billing.md §7.1）。
-- 每台机器 × UTC 自然月一行；销毁后保留作审计，不随 servers 删除。
-- 周期归属由控制面按收到上报的时间判定，agent 不传周期。
CREATE TABLE server_traffic (
  server_id      TEXT NOT NULL,
  cycle_id       TEXT NOT NULL,                 -- YYYY-MM（UTC 自然月）
  bytes          INTEGER NOT NULL DEFAULT 0,    -- 本周期已用出站字节
  released_bytes INTEGER NOT NULL DEFAULT 0,    -- 本周期已释放额度快照
  charged_cents  INTEGER NOT NULL DEFAULT 0,    -- 本周期已扣的超支金额
  last_seq       INTEGER NOT NULL DEFAULT 0,    -- 已接受的最大上报序号（按 server 去重，跨周期不清零）
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (server_id, cycle_id)
);
