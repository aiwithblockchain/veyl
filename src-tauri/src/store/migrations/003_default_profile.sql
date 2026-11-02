-- 003：默认配置包元数据。包体本身加密存在 secrets.enc，库里只放可展示信息。
CREATE TABLE IF NOT EXISTS default_profile (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),
    provider_id           TEXT NOT NULL,
    name                  TEXT,
    package_hash          TEXT NOT NULL,
    source_updated_at     TEXT,
    outbound_tags         TEXT NOT NULL,
    node_count            INTEGER NOT NULL DEFAULT 0,
    applied_at            INTEGER NOT NULL,
    checked_at            INTEGER NOT NULL,
    new_version_available INTEGER NOT NULL DEFAULT 0,
    previous_provider_id  TEXT,
    previous_name         TEXT,
    previous_hash         TEXT,
    previous_source_updated_at TEXT,
    previous_outbound_tags TEXT,
    previous_node_count   INTEGER,
    previous_applied_at   INTEGER
);
