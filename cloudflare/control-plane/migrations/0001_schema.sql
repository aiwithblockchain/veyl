-- Veyl 控制面结构（从 0 开始，单一基线）。
-- 产品尚未发布，没有用户数据：改结构就改这一份，重建库后重新应用，不写增量迁移。
-- 设计见 docs/design/my-servers.md §19 与 docs/design/login-and-payment.md。

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,              -- device | email
  email         TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  merged_into   TEXT,                       -- 并入邮箱账户的旧匿名账户
  balance_cents INTEGER NOT NULL DEFAULT 0, -- USD 分，永远非负
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX accounts_email ON accounts(email) WHERE email IS NOT NULL;

CREATE TABLE devices (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  secret_hash    TEXT NOT NULL,
  platform       TEXT NOT NULL,
  app_version    TEXT NOT NULL,
  refresh_family TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  revoked_at     INTEGER
);

CREATE TABLE refresh_tokens (
  hash       TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX refresh_tokens_device ON refresh_tokens(device_id);

CREATE TABLE email_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,               -- sha256(code + ":" + email)
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_ip    TEXT
);

CREATE TABLE orders (
  id                   TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL,
  region               TEXT NOT NULL,
  plan                 TEXT NOT NULL,
  amount_usd           REAL NOT NULL,
  amount_cents         INTEGER NOT NULL,    -- 下单时的售价快照
  hourly_usd           REAL NOT NULL,
  state                TEXT NOT NULL,       -- pending_payment | paid | provisioning | ready | cancelled | failed
  idempotency_key      TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  paid_at              INTEGER,
  expires_at           INTEGER,
  server_id            TEXT,
  failure_code         TEXT,
  failure_stage        TEXT,
  checkout_session_id  TEXT,
  checkout_url         TEXT,
  paid_via             TEXT,                -- wallet | dodo | fake
  subscription_id      TEXT
);
CREATE UNIQUE INDEX orders_idem ON orders(account_id, idempotency_key);

CREATE TABLE servers (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL,
  order_id              TEXT NOT NULL,
  provider              TEXT NOT NULL DEFAULT 'digitalocean',
  provider_id           TEXT,
  name                  TEXT NOT NULL,
  region                TEXT NOT NULL,
  plan                  TEXT NOT NULL,
  hourly_usd            REAL NOT NULL,
  monthly_usd           REAL NOT NULL,
  plan_price_cents      INTEGER NOT NULL DEFAULT 0, -- 购机时的月价快照，续费按它扣
  state                 TEXT NOT NULL,
  billing_state         TEXT NOT NULL DEFAULT 'active', -- active | past_due | expired
  node_port             INTEGER NOT NULL,
  ip                    TEXT,
  node_id               TEXT,
  enrollment_hash       TEXT,
  enrollment_used_at    INTEGER,
  enrollment_expires_at INTEGER,
  firewall_id           TEXT,
  singbox_version       TEXT,
  agent_version         TEXT,
  paid_until            INTEGER NOT NULL DEFAULT 0,  -- 本期有效到什么时候
  failure_code          TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  destroyed_at          INTEGER
);
CREATE UNIQUE INDEX servers_enroll ON servers(enrollment_hash);
CREATE UNIQUE INDEX servers_order ON servers(order_id);

CREATE TABLE credentials (
  server_id    TEXT PRIMARY KEY,
  key_version  INTEGER NOT NULL,
  iv           TEXT NOT NULL,
  ciphertext   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  destroyed_at INTEGER
);

-- 钱包：余额是账本的结果，账本只追加。
CREATE TABLE wallet_ledger (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL,
  kind                TEXT NOT NULL,       -- topup | charge | adjustment
  amount_cents        INTEGER NOT NULL,    -- 正入负出
  balance_after_cents INTEGER NOT NULL,
  ref_type            TEXT NOT NULL,       -- dodo_payment | order | server_period | manual
  ref_id              TEXT NOT NULL,
  note                TEXT,
  created_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX wallet_ledger_ref ON wallet_ledger(ref_type, ref_id);
CREATE INDEX wallet_ledger_account ON wallet_ledger(account_id, created_at);

CREATE TABLE topups (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL,
  denomination_cents  INTEGER NOT NULL,
  product_id          TEXT,
  checkout_session_id TEXT,
  checkout_url        TEXT,
  status              TEXT NOT NULL,       -- pending | paid | failed
  created_at          INTEGER NOT NULL,
  paid_at             INTEGER
);
CREATE INDEX topups_account ON topups(account_id, created_at);
CREATE UNIQUE INDEX topups_session ON topups(checkout_session_id);

-- 支付流水：Dodo payment id 唯一，webhook 重放不能重复记账。
CREATE TABLE payments (
  id              TEXT PRIMARY KEY,
  order_id        TEXT,
  subscription_id TEXT,
  account_id      TEXT,
  amount_usd      REAL NOT NULL,
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL,           -- succeeded | failed
  period_end      INTEGER,
  raw_digest      TEXT NOT NULL,
  received_at     INTEGER NOT NULL
);

CREATE TABLE webhook_events (
  id           TEXT PRIMARY KEY,           -- webhook-id
  kind         TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  processed_at INTEGER,
  order_id     TEXT,
  payment_id   TEXT,
  status       TEXT NOT NULL               -- received | processed | failed
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

-- 订阅：M1 不启用（收费走预付费余额），表留着以便以后支持自动续费。
CREATE TABLE subscriptions (
  id                   TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL,
  order_id             TEXT,
  server_id            TEXT,
  product_id           TEXT,
  status               TEXT NOT NULL,
  current_period_end   INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  last_event_at        INTEGER NOT NULL DEFAULT 0,
  last_event_id        TEXT
);
CREATE INDEX subscriptions_account ON subscriptions(account_id);
CREATE INDEX subscriptions_order ON subscriptions(order_id);

CREATE TABLE idempotency_keys (
  account_id   TEXT NOT NULL,
  endpoint     TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status       INTEGER NOT NULL,
  response     TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, endpoint, key)
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  account_id TEXT,
  server_id  TEXT,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
