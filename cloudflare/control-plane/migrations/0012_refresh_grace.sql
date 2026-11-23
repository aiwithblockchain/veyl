-- 刷新令牌宽限的限次：一枚旧令牌最多被赎回一次。
-- 双开允许第二路把同一枚令牌换出一次；它再出现就是重放，整族作废。
ALTER TABLE refresh_tokens ADD COLUMN redeemed_count INTEGER NOT NULL DEFAULT 0;
