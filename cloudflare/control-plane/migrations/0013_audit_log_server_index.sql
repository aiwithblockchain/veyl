-- 服务器创建记录按服务器查审计（my-server-events.md §1.1）。
-- 只追加索引，不改已应用迁移。
CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log(server_id, at);
