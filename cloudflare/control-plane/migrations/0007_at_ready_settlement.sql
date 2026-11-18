-- 就绪后扣款（契约 2.39.0）：
-- 1) 订单区分新旧口径，Cron 的补建与退款只处理存量 upfront 单；
-- 2) 服务器在结算前没有「已付到」的时刻，paid_until 必须允许 NULL。
--    SQLite 不能直接去掉 NOT NULL，这里重建 servers 并原样搬数据（含 0003/0004 的列）。
ALTER TABLE orders ADD COLUMN charge_mode TEXT NOT NULL DEFAULT 'upfront';

CREATE TABLE servers_new (
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
  daily_price_cents     INTEGER NOT NULL,
  billing_anchor_at     INTEGER NOT NULL,
  transfer_gib          INTEGER NOT NULL DEFAULT 0,
  state                 TEXT NOT NULL,
  billing_state         TEXT NOT NULL DEFAULT 'active',
  node_port             INTEGER NOT NULL,
  ip                    TEXT,
  node_id               TEXT,
  enrollment_hash       TEXT,
  enrollment_used_at    INTEGER,
  enrollment_expires_at INTEGER,
  firewall_id           TEXT,
  singbox_version       TEXT,
  agent_version         TEXT,
  paid_until            INTEGER DEFAULT NULL,
  failure_code          TEXT,
  failure_stage         TEXT DEFAULT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  destroyed_at          INTEGER,
  ready_at              INTEGER DEFAULT NULL,
  installing_at         INTEGER DEFAULT NULL,
  verifying_at          INTEGER DEFAULT NULL
);

INSERT INTO servers_new (
  id, account_id, order_id, provider, provider_id, name, region, plan, hourly_usd, monthly_usd,
  daily_price_cents, billing_anchor_at, transfer_gib, state, billing_state, node_port, ip, node_id,
  enrollment_hash, enrollment_used_at, enrollment_expires_at, firewall_id, singbox_version,
  agent_version, paid_until, failure_code, failure_stage, created_at, updated_at, destroyed_at,
  ready_at, installing_at, verifying_at
)
SELECT
  id, account_id, order_id, provider, provider_id, name, region, plan, hourly_usd, monthly_usd,
  daily_price_cents, billing_anchor_at, transfer_gib, state, billing_state, node_port, ip, node_id,
  enrollment_hash, enrollment_used_at, enrollment_expires_at, firewall_id, singbox_version,
  agent_version, paid_until, failure_code, failure_stage, created_at, updated_at, destroyed_at,
  ready_at, installing_at, verifying_at
FROM servers;

DROP TABLE servers;
ALTER TABLE servers_new RENAME TO servers;

CREATE UNIQUE INDEX servers_enroll ON servers(enrollment_hash);
CREATE UNIQUE INDEX servers_order ON servers(order_id);
CREATE UNIQUE INDEX servers_account_port ON servers(account_id, node_port) WHERE destroyed_at IS NULL;
