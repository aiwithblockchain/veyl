-- 手机端导出令牌：账户级一条，长期有效，轮换即失效。
-- token_hash 用于认证查找；iv/ciphertext 用于把同一个令牌回显给桌面。
-- 与其他控制面表一致，不声明外键（现有 D1 schema 全部用列关联）。
CREATE TABLE mobile_tokens (
  account_id   TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1,
  iv           TEXT NOT NULL,
  ciphertext   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  rotated_at   INTEGER,
  last_used_at INTEGER
);

CREATE UNIQUE INDEX mobile_tokens_hash ON mobile_tokens(token_hash);
