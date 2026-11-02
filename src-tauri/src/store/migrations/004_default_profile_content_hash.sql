-- 004：用「原始响应字节的 sha256」判断包是否变化。
-- package_hash 是发布方的版本标签，不是哈希，只作展示。
-- 已有行的 content_sha256 为空串，下一次刷新会强制重算并写回。
ALTER TABLE default_profile ADD COLUMN content_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE default_profile ADD COLUMN previous_content_sha256 TEXT;
