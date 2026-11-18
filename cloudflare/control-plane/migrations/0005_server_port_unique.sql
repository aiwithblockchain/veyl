-- 同一账户下活着的服务器不能共用端口。
-- pickPort 是「读集合 → 随机挑」：两个并发建机会读到同一份集合、选中同一个端口。
-- 部分索引：已销毁的行保留 node_port 供审计，不参与约束（否则端口会被历史永久占用）。
CREATE UNIQUE INDEX servers_account_port ON servers(account_id, node_port) WHERE destroyed_at IS NULL;
