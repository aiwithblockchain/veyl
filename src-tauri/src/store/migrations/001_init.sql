-- Veyl 本地库 · schema v1（重建，从零开始）
--
-- 产品尚未发布，不做任何数据迁移：旧表与旧逻辑直接删除，库整体重建。
--
-- 四张核心表：
--   configs       一套配置（名字 / 连接方式 / 分流策略 / 端口 / 当前节点）
--   nodes         节点（服务器 / 端口 / 加密方式 / 凭据引用）
--   config_nodes  配置与节点的多对多关系（一个节点可被多套配置引用）
--   issues        问题管理
--   layout        中间区域的 AI 布局持久化
--
-- 另外保留与配置格式无关的基础设施表：settings / runtime_versions /
-- proxy_backup / catalog_cache / chat_* / tool_calls。
--
-- 凭据不进库：nodes 只保存 secrets.enc 里的键（password_ref）。

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS configs (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,
    -- system_proxy：只给代理地址；tun：接管全部流量（批 5 才实现）
    connection_mode   TEXT NOT NULL CHECK (connection_mode IN ('system_proxy', 'tun')),
    -- direct：本地直连；proxy_all：全部走代理；proxy_selected：指定服务走代理
    routing_mode      TEXT NOT NULL CHECK (routing_mode IN ('direct', 'proxy_all', 'proxy_selected')),
    -- 本机代理端口；NULL = 由运行时自动挑选。tun 模式恒为 NULL。
    listen_port       INTEGER CHECK (listen_port BETWEEN 1 AND 65535),
    -- DNS 候选：{"mode":"auto"|"custom","local":[...],"remote":[...]}
    dns_json          TEXT NOT NULL DEFAULT '{"mode":"auto","local":[],"remote":[]}',
    -- TUN 内网排除网段（只存用户补充的部分）。
    tun_excludes_json TEXT NOT NULL DEFAULT '[]',
    current_node_id   TEXT REFERENCES nodes (id) ON DELETE SET NULL,
    is_active         INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    last_used_at      INTEGER
);

-- 同一时刻只允许一套激活配置。
CREATE UNIQUE INDEX IF NOT EXISTS idx_configs_one_active
    ON configs (is_active) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_configs_last_used
    ON configs (last_used_at DESC);

CREATE TABLE IF NOT EXISTS nodes (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    server        TEXT NOT NULL,
    port          INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    method        TEXT NOT NULL,
    -- secrets.enc 里的键；明文密码永不落库。
    password_ref  TEXT NOT NULL,
    source        TEXT NOT NULL CHECK (source IN ('seed', 'url', 'manual')),
    -- 去重键：sha256(name \x1f server \x1f port \x1f method) 的十六进制。
    source_key    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- 同一来源内不允许重复节点；不同来源可以有同名同地址的两条。
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_source_key
    ON nodes (source, source_key);
CREATE INDEX IF NOT EXISTS idx_nodes_server
    ON nodes (server, port);

CREATE TABLE IF NOT EXISTS config_nodes (
    config_id  TEXT NOT NULL REFERENCES configs (id) ON DELETE CASCADE,
    node_id    TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    position   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (config_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_config_nodes_config
    ON config_nodes (config_id, position);

CREATE INDEX IF NOT EXISTS idx_config_nodes_node
    ON config_nodes (node_id);

-- 问题管理（批 6）：同类问题合并计数，恢复后置 resolved。
CREATE TABLE IF NOT EXISTS issues (
    id              TEXT PRIMARY KEY,
    -- 合并键：coalesce(config_id,'') \x1f kind \x1f target。
    merge_key       TEXT NOT NULL UNIQUE,
    -- 配置被删时，挂在它上面的问题一并删除。
    config_id       TEXT REFERENCES configs (id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    target          TEXT NOT NULL DEFAULT '',
    severity        TEXT NOT NULL CHECK (severity IN ('P0', 'P1', 'P2')),
    status          TEXT NOT NULL CHECK (status IN ('open', 'handed_off', 'resolved', 'ignored')),
    mode            TEXT NOT NULL CHECK (mode IN ('system_proxy', 'tun')),
    title           TEXT NOT NULL,
    occurrences     INTEGER NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
    first_seen_at   INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    evidence_json   TEXT NOT NULL,
    session_id      TEXT REFERENCES chat_sessions (id) ON DELETE SET NULL,
    last_handoff_at INTEGER,
    resolved_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_issues_status
    ON issues (status, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_config
    ON issues (config_id, status);

-- 中间区域的布局持久化：AI 输出的布局描述，下次直接还原。
CREATE TABLE IF NOT EXISTS layout (
    config_id   TEXT PRIMARY KEY REFERENCES configs (id) ON DELETE CASCADE,
    revision    INTEGER NOT NULL DEFAULT 1,
    layout_json TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- 种子缓存元数据。种子原文（含节点密码）加密存放在 secrets.enc 的
-- `seed:<content_sha256>`；这里只保存可展示与判重信息。
CREATE TABLE IF NOT EXISTS seed_cache (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),
    content_sha256        TEXT NOT NULL,
    etag                  TEXT,
    source_version        TEXT,
    source_updated_at     TEXT,
    node_count            INTEGER NOT NULL,
    fetched_at            INTEGER NOT NULL,
    checked_at            INTEGER NOT NULL,
    new_version_available INTEGER NOT NULL DEFAULT 0 CHECK (new_version_available IN (0, 1))
);

CREATE TABLE IF NOT EXISTS runtime_versions (
    version      TEXT PRIMARY KEY,
    path         TEXT NOT NULL,
    binary_path  TEXT NOT NULL,
    sha256       TEXT NOT NULL,
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
    -- 审批机制已移除：该列保留给审计，写入恒为 NULL。
    approved    INTEGER CHECK (approved IN (0, 1, 2)),
    result_json TEXT,
    is_error    INTEGER NOT NULL DEFAULT 0 CHECK (is_error IN (0, 1)),
    created_at  INTEGER NOT NULL,
    finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session
    ON tool_calls (session_id, created_at);
