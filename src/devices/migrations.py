def get_migrations():
    return [
        """
    CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        code TEXT,
        refresh TEXT,
        token TEXT,
        settings TEXT NULL,
        user_agent TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS domains (domain TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO migrations VALUES (1, 'initial');
    """,
        """
    ALTER TABLE devices ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
    """,
        """
    CREATE TABLE IF NOT EXISTS device_history (
        device_id TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        season INTEGER NOT NULL DEFAULT 0,
        episode INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        duration INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, item_id, season, episode)
    );

    CREATE INDEX IF NOT EXISTS idx_device_history_updated
        ON device_history(device_id, updated_at);
    """,
    ]
