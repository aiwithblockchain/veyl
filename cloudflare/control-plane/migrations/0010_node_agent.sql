-- 节点 agent（node-agent-mcp.md §5）：
-- 1) server_token 每个服务器一把，只存哈希（明文只下发一次）；
-- 2) agent 登记的控制端口与 TLS 信任材料（自签 CA 优先，指纹兜底）；
-- 3) 最后的活跃时间与最近一次失败原文，用于「agent 失联」类排查。
ALTER TABLE servers ADD COLUMN server_token_hash TEXT DEFAULT NULL;
ALTER TABLE servers ADD COLUMN control_port INTEGER DEFAULT NULL;
ALTER TABLE servers ADD COLUMN cert_fingerprint TEXT DEFAULT NULL;
ALTER TABLE servers ADD COLUMN ca_pem TEXT DEFAULT NULL;
ALTER TABLE servers ADD COLUMN last_seen_at INTEGER DEFAULT NULL;
ALTER TABLE servers ADD COLUMN last_error TEXT DEFAULT NULL;

CREATE UNIQUE INDEX servers_agent_token ON servers(server_token_hash);
