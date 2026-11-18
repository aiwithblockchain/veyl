-- dev 专用：Dodo 回调样本（原始报文与请求头，写入前已脱敏）。
-- 生产环境代码路径不会写这张表（捕获入口以 ENVIRONMENT === 'dev' 为门）；
-- 表本身随迁移存在于所有环境，避免结构漂移。
-- 导出：node scripts/export-webhook-fixture.mjs（只连 dev），落到 test/fixtures/。
CREATE TABLE webhook_samples (
  id          TEXT PRIMARY KEY,   -- webhook-id，同一事件重投覆盖同一行
  kind        TEXT NOT NULL,      -- payload.type
  received_at INTEGER NOT NULL,
  headers     TEXT NOT NULL,      -- 脱敏后的请求头 JSON（签名头为 ***）
  body        TEXT NOT NULL       -- 脱敏后的原始报文
);
