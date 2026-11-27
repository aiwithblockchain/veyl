-- 叶证书到期时间（unix 秒），签发成功时由控制面写入（agent-signing-contract.md §3.1）。
-- 运维平台据此显示到期日，并判断续期是否卡住：续期正常的节点会在进入 30 天窗口后
-- 把这个值跳到两年后。可空——老的 agent 没走控制面签发，这一列就一直是 NULL。
ALTER TABLE servers ADD COLUMN cert_not_after INTEGER DEFAULT NULL;
