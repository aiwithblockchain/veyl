-- 服务端失败原因：界面要能回答「这台为什么没建成」。
-- 之前只写在 orders 上，servers 行没有任何失败字段，serverView 的 failure 永远是 null。
ALTER TABLE servers ADD COLUMN failure_code TEXT;
