-- 订阅口径补齐（设计 §4.8）：支付流水记订阅与本期，订单记订阅，订阅记最后一次事件用于乱序判定。

ALTER TABLE payments ADD COLUMN subscription_id TEXT;
ALTER TABLE payments ADD COLUMN period_end INTEGER;
ALTER TABLE orders ADD COLUMN subscription_id TEXT;
ALTER TABLE subscriptions ADD COLUMN last_event_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN last_event_id TEXT;
