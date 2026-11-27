-- 免费节点种子正文（design/seed-publishing.md §1）。
--
-- 单行 JSON：客户端按正文哈希判更新，按节点行存会在读时重新序列化，
-- 顺序 / 空格一变字节就变；整份正文存一行，发布是一条原子 upsert。
-- 节点数据由 scripts/seed/publish-d1.ts 写入，迁移只建表。
CREATE TABLE IF NOT EXISTS seed_payload (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  body TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  stored_at INTEGER NOT NULL
);
