-- 登录门禁与支付（docs/design/login-and-payment.md §4.7）。
-- 验证码只存哈希；支付流水与 webhook 事件各自做主键去重；
-- servers(order_id) 唯一索引是「一个订单只建一台机器」的最后一道保险。

CREATE TABLE email_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_ip    TEXT
);

CREATE TABLE payments (
  id          TEXT PRIMARY KEY,
  order_id    TEXT,
  account_id  TEXT,
  amount_usd  REAL NOT NULL,
  currency    TEXT NOT NULL,
  status      TEXT NOT NULL,
  raw_digest  TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE webhook_events (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  processed_at INTEGER,
  order_id     TEXT,
  payment_id   TEXT,
  status       TEXT NOT NULL
);

CREATE TABLE unmatched_payments (
  payment_id   TEXT PRIMARY KEY,
  email_hash   TEXT,
  amount_usd   REAL NOT NULL,
  currency     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  replayed_at  INTEGER
);

ALTER TABLE orders ADD COLUMN checkout_session_id TEXT;
ALTER TABLE orders ADD COLUMN checkout_url TEXT;
ALTER TABLE orders ADD COLUMN paid_via TEXT;
ALTER TABLE servers ADD COLUMN paid_until INTEGER;

CREATE UNIQUE INDEX servers_order ON servers(order_id);
