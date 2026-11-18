-- 服务器详情补「创建用时」：激活成功那一刻写一次；旧机器保持 NULL（用时未知，
-- 不许拿 created_at 伪造）。纯新增列，带 DEFAULT NULL。
ALTER TABLE servers ADD COLUMN ready_at INTEGER DEFAULT NULL;
