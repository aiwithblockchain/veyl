-- 订阅（Dodo 订阅产品）：一次性付款已废弃，机器是否可用由订阅本期截止时间决定。
-- servers.paid_until 是「本期有效到什么时候」，来自 payment.service_periods[].ends_at。

CREATE TABLE subscriptions (
  id                   TEXT PRIMARY KEY,   -- Dodo subscription id
  account_id           TEXT NOT NULL,
  order_id             TEXT,
  server_id            TEXT,
  product_id           TEXT,
  status               TEXT NOT NULL,      -- active | past_due | on_hold | paused | cancelled | expired
  current_period_end   INTEGER,            -- 本期结束（Unix 毫秒）
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX subscriptions_account ON subscriptions(account_id);
CREATE INDEX subscriptions_order ON subscriptions(order_id);
