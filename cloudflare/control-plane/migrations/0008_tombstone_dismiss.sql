-- 「余额不足停机」的墓碑行：用户忽略后不再出现在列表里。
-- 只追加一列；手动销毁的行不使用这一列。
ALTER TABLE servers ADD COLUMN dismissed_at INTEGER DEFAULT NULL;
