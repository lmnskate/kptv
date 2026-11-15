"""Ordered SQLite migration scripts.

Each script must be idempotent: it may be partially applied if a previous
run failed midway. The runner (devices/storage.py) records the migration
version after a script completes successfully, so new scripts should NOT
insert a row into the `migrations` table themselves (the initial script
predates this convention; its self-insert is harmless thanks to OR IGNORE).
"""


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
        # Registration timestamps for the stale-device GC (cleanup_stale_devices).
        # SQLite has no IF NOT EXISTS for ADD COLUMN; the failure window
        # (column added, version row not yet recorded) is a crash between two
        # statements, and a rerun then fails loudly instead of corrupting data.
        """
    ALTER TABLE devices ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
    """,
        # Per-device watch history (upstream /history is account-wide).
        # season/episode are 0 for movies — NOT NULL keeps the PK dedupe.
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
