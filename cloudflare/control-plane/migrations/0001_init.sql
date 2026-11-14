-- M1 建机闭环：账户、设备、订单、服务器、凭据、幂等键、审计。
-- 设计见 docs/design/my-servers.md §19.4。D1 不强制外键，关系靠应用层校验。

CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  email       TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  merged_into TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX accounts_email ON accounts(email) WHERE email IS NOT NULL;

CREATE TABLE devices (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL,
  secret_hash        TEXT NOT NULL,
  platform           TEXT NOT NULL,
  app_version        TEXT NOT NULL,
  refresh_family     TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  revoked_at         INTEGER
);

-- 每次轮换留一条：既用于校验，也用于识别「旧令牌被重放」。
CREATE TABLE refresh_tokens (
  hash       TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX refresh_tokens_device ON refresh_tokens(device_id);

CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  region          TEXT NOT NULL,
  plan            TEXT NOT NULL,
  amount_usd      REAL NOT NULL,
  hourly_usd      REAL NOT NULL,
  state           TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  paid_at         INTEGER,
  expires_at      INTEGER,
  server_id       TEXT,
  failure_code    TEXT,
  failure_stage   TEXT
);
CREATE UNIQUE INDEX orders_idem ON orders(account_id, idempotency_key);

CREATE TABLE servers (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL,
  order_id               TEXT NOT NULL,
  provider               TEXT NOT NULL DEFAULT 'digitalocean',
  provider_id            TEXT,
  name                   TEXT NOT NULL,
  region                 TEXT NOT NULL,
  plan                   TEXT NOT NULL,
  hourly_usd             REAL NOT NULL,
  monthly_usd            REAL NOT NULL,
  state                  TEXT NOT NULL,
  node_port              INTEGER NOT NULL,
  ip                     TEXT,
  node_id                TEXT,
  enrollment_hash        TEXT,
  enrollment_used_at     INTEGER,
  enrollment_expires_at  INTEGER,
  firewall_id            TEXT,
  singbox_version        TEXT,
  agent_version          TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  destroyed_at           INTEGER
);
CREATE UNIQUE INDEX servers_enroll ON servers(enrollment_hash);

CREATE TABLE credentials (
  server_id    TEXT PRIMARY KEY,
  key_version  INTEGER NOT NULL,
  iv           TEXT NOT NULL,
  ciphertext   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  destroyed_at INTEGER
);

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

-- 固定窗口限流：设备注册按 IP，10 次/小时（§19.2.1）。
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
