-- 保留清理用索引（docs/design/traffic-billing.md §7.4）：
-- 按更新时间扫超龄 server_traffic 行，按销毁时间扫可清理的 servers 行。
--
-- 注意：0014 里「不随 servers 删除」那句注释已过时——现在 server_traffic 与
-- servers 都保留 45 天，之后一起清理（每台机器最大 last_seq 那行除外，它是去重基准）。
-- 已应用的迁移不改，说明写在这里。
CREATE INDEX server_traffic_updated ON server_traffic(updated_at);
CREATE INDEX servers_destroyed ON servers(destroyed_at);
