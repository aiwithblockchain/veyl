-- 真实阶段上报（2026-11-18）：cloud-init 依次回传 installing / verifying / active。
-- 两个时间只在首次进入该阶段时写入；旧机器保持 NULL（阶段未知）。
ALTER TABLE servers ADD COLUMN installing_at INTEGER DEFAULT NULL;
ALTER TABLE servers ADD COLUMN verifying_at INTEGER DEFAULT NULL;
-- 失败发生在哪个阶段（booting / installing / verifying / active）；旧机器为 NULL。
ALTER TABLE servers ADD COLUMN failure_stage TEXT DEFAULT NULL;
