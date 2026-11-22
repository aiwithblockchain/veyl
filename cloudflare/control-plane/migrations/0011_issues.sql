-- 问题墙：用户上报的帖子与运营答复（issue-report-api.md §5.1）。
-- 不审核：提交即公开；hidden_at 非空表示运营删除，读者不可见（软删除）。

CREATE TABLE issues (
  id                   TEXT PRIMARY KEY,            -- iss_<12>，公开 slug
  account_id           TEXT NOT NULL,
  account_email_masked TEXT NOT NULL,               -- w***@gmail.com
  device_id            TEXT NOT NULL,
  server_id            TEXT,                        -- 内部关联，不公开
  idempotency_key      TEXT NOT NULL,
  title                TEXT NOT NULL,
  summary              TEXT NOT NULL,
  body                 TEXT NOT NULL,               -- 脱敏后的 JSON：expected/actual/repro/steps
  platform             TEXT NOT NULL,
  app_version          TEXT NOT NULL,               -- 提交时运行中的版本，公开显示
  os_version           TEXT,
  arch                 TEXT,
  stage                TEXT NOT NULL,
  error_code           TEXT,
  reply_count          INTEGER NOT NULL DEFAULT 0,
  last_activity_at     INTEGER NOT NULL,            -- 发帖或最后一次答复的时间，排序键
  hidden_at            INTEGER,                     -- 非空 = 运营删除，读者不可见
  created_at           INTEGER NOT NULL,
  ip_prefix            TEXT,
  UNIQUE (account_id, idempotency_key)
);

CREATE INDEX issues_public_idx ON issues (hidden_at, last_activity_at DESC);

CREATE TABLE issue_replies (
  id         TEXT PRIMARY KEY,                      -- rep_<12>
  issue_id   TEXT NOT NULL,
  author     TEXT NOT NULL,                         -- v1 恒为 'admin'；将来 'user'
  body       TEXT NOT NULL,
  hidden_at  INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX issue_replies_idx ON issue_replies (issue_id, created_at);
