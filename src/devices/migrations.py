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
    """
    ]
