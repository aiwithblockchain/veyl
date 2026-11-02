-- Veyl 本地库 · schema v1
--
-- 字段来源：docs/requirements.md §8、docs/architecture.md §7、
-- docs/contracts/tools.md §2.3 / §4.6 / §4.9、docs/contracts/catalog.md §6。
--
-- 凭据不进库：profiles.config_json 只存非凭据部分；完整配置（含凭据）写在
-- 磁盘 config/profile-<id>.json，权限 0600，由 config 模块负责。

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
    id          TEXT PRIMARY KEY,
    node_id     TEXT,
    name        TEXT NOT NULL,
    protocol    TEXT,              -- vless_reality | hysteria2
    region      TEXT,              -- ISO 3166-1 alpha-2
    -- 只存非凭据部分（server/port/tls/flow）；uuid、password 一律不进库。
    config_json TEXT NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    created_at  INTEGER NOT NULL
);

-- 同一时刻只允许一个活动配置。
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_one_active
    ON profiles (is_active) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS runtime_versions (
    version      TEXT PRIMARY KEY,
    path         TEXT NOT NULL,
    binary_path  TEXT NOT NULL,
    sha256       TEXT NOT NULL,
    -- CoreListVersions 会返回 active / standby / quarantined，
    -- CHECK 写窄了以后加状态就得迁移，这里一次放全。
    state        TEXT NOT NULL CHECK (
        state IN ('installed', 'standby', 'active', 'quarantined', 'failed')
    ),
    installed_at INTEGER NOT NULL
);

-- 异常退出后恢复系统代理的唯一依据；单行。
CREATE TABLE IF NOT EXISTS proxy_backup (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    platform     TEXT NOT NULL,
    endpoint     TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);

-- docs/contracts/catalog.md §6：列表与详情的离线缓存。
CREATE TABLE IF NOT EXISTS catalog_cache (
    cache_key   TEXT PRIMARY KEY,
    etag        TEXT,
    body_json   TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL,
    http_status INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    tool_json  TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session
    ON chat_messages (session_id, created_at);

CREATE TABLE IF NOT EXISTS tool_calls (
    id          TEXT PRIMARY KEY,
    session_id  TEXT,
    request_id  TEXT,
    tool_name   TEXT NOT NULL,
    args_json   TEXT NOT NULL,
    -- 0 拒绝 / 1 允许一次 / 2 允许本会话（含 Grant 自动放行）；
    -- NULL = 该工具不需要审批（只读或策略为 never），不能用 1 冒充。
    approved    INTEGER CHECK (approved IN (0, 1, 2)),
    result_json TEXT,
    is_error    INTEGER NOT NULL DEFAULT 0 CHECK (is_error IN (0, 1)),
    created_at  INTEGER NOT NULL,
    finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session
    ON tool_calls (session_id, created_at);
