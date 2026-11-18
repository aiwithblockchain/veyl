-- 全局目录缓存（2026-11-18）：目录只有一份，年龄判断放在 D1 上，不再依赖
-- 每个边缘数据中心各自的缓存副本。
--   key = 'v1'            → payload 是已带售价的最终目录 JSON，updated_at 为 Unix 毫秒
--   key = 'v1:refresh'    → 回源租约；payload 为空，updated_at 是租约开始时间
CREATE TABLE catalog_cache (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
