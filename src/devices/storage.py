import fcntl
import json
import logging
import os
import sqlite3
import time

from config.settings import server
from devices import migrations

logger = logging.getLogger(__name__)

_db_dir = os.path.dirname(server.sqlite_url)
if _db_dir:
    os.makedirs(_db_dir, exist_ok=True)

connection = sqlite3.connect(
    server.sqlite_url,
    autocommit=True,
    check_same_thread=False
)

UNACTIVATED_TTL = 24 * 3600

DEVICE_HISTORY_KEEP = 1000


def cleanup_stale_devices():
    try:
        connection.execute(
            'DELETE FROM devices WHERE token IS NULL AND created_at > 0 '
            'AND created_at < ?1',
            [int(time.time()) - UNACTIVATED_TTL]
        )
        for (device_id,) in connection.execute(
            'SELECT DISTINCT device_id FROM device_history'
        ).fetchall():
            connection.execute(
                """
                DELETE FROM device_history
                WHERE device_id = ?1
                  AND updated_at <= COALESCE((
                      SELECT updated_at FROM device_history
                      WHERE device_id = ?1
                      ORDER BY updated_at DESC
                      LIMIT 1 OFFSET ?2), 0)
                """,
                [device_id, DEVICE_HISTORY_KEEP - 1]
            )
    except sqlite3.OperationalError:
        pass


def _acquire_migrations_lock():
    lock_path = f'{server.sqlite_url}.lock'
    lock_dir = os.path.dirname(lock_path) or '.'
    os.makedirs(lock_dir, exist_ok=True)
    lock_file = open(lock_path, 'w')
    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)

    return lock_file


def _release_migrations_lock(
    lock_file
):
    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    lock_file.close()


def _run_migrations():
    connection.execute(
        'CREATE TABLE IF NOT EXISTS migrations (id INT PRIMARY KEY, name TEXT)'
    )
    current_version = (
        connection.execute('SELECT MAX(id) FROM migrations').fetchone()[0] or 0
    )

    migrations_list = migrations.get_migrations()
    latest_version = len(migrations_list)
    if current_version >= latest_version:
        return

    lock_file = _acquire_migrations_lock()
    try:
        current_version = (
            connection.execute('SELECT MAX(id) FROM migrations').fetchone()[0] or 0
        )
        for i in range(current_version, latest_version):
            script = migrations_list[i]
            try:
                connection.executescript(script)
                connection.execute(
                    'INSERT OR IGNORE INTO migrations (id, name) VALUES (?1, ?2)',
                    [i + 1, script[:80]]
                )
                logger.info(
                    'SQLite DB schema is updated to v%d',
                    i + 1
                )
            except Exception:
                logger.exception(
                    'SQLite migration %d failed',
                    i + 1
                )
                raise
    finally:
        _release_migrations_lock(lock_file)


_run_migrations()
cleanup_stale_devices()


def _check_writable():
    try:
        connection.execute('CREATE TABLE IF NOT EXISTS _write_probe (id INT)')
        connection.execute('DROP TABLE IF EXISTS _write_probe')
    except sqlite3.OperationalError:
        logger.exception(
            'SQLite database %s is not writable; fix the ownership/permissions '
            'of the data directory (e.g. chown -R 1000:1000 data)',
            server.sqlite_url
        )
        raise


_check_writable()


def to_device_dict(
    row
):
    if row is None:
        return None

    return {
        'id': row[0],
        'code': row[1],
        'refresh': row[2],
        'token': row[3],
        'settings': None if row[4] is None else json.loads(row[4]),
        'user_agent': row[5],
        'created_at': row[6] if len(row) > 6 else 0
    }


def query_device(
    sql,
    params
):
    cursor = connection.execute(
        sql,
        params
    )

    return to_device_dict(
        cursor.fetchone()
    )


DEVICE_COLUMNS = 'id, code, refresh, token, settings, user_agent, created_at'


def get_device_by_id(
    device_id
):
    return query_device(
        f'SELECT {DEVICE_COLUMNS} FROM devices WHERE id = ?1',
        [device_id]
    )


def create_device(
    entry
):
    settings = entry.get('settings')
    created_at = entry.get('created_at') or int(time.time())
    return query_device(
        f"""
        INSERT OR IGNORE INTO devices ({DEVICE_COLUMNS})
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        RETURNING {DEVICE_COLUMNS}
        """,
        [
            entry.get('id'),
            entry.get('code'),
            entry.get('refresh'),
            entry.get('token'),
            None if settings is None else json.dumps(settings),
            entry.get('user_agent'),
            created_at
        ]
    )


def update_device_code(
    id,
    code
):
    return query_device(
        f'UPDATE devices SET code = ?2 WHERE id = ?1 RETURNING {DEVICE_COLUMNS}',
        [id, code]
    )


def update_device_tokens(
    id,
    token,
    refresh
):
    return query_device(
        f"""
        UPDATE devices SET token = ?2, refresh = ?3
        WHERE id = ?1 RETURNING {DEVICE_COLUMNS}
        """,
        [id, token, refresh]
    )


def update_device_user_agent(
    id,
    user_agent
):
    return query_device(
        f"""
        UPDATE devices SET user_agent = ?2
        WHERE id = ?1 RETURNING {DEVICE_COLUMNS}
        """,
        [id, user_agent]
    )


def update_device_settings(
    id,
    param
):
    return query_device(
        f"""
        UPDATE devices SET settings = ?2
        WHERE id = ?1 RETURNING {DEVICE_COLUMNS}
        """,
        [id, json.dumps(param)]
    )


def get_domain(
    domain
):
    cursor = connection.execute(
        'SELECT domain FROM domains WHERE domain = ?1',
        [domain]
    )

    row = cursor.fetchone()

    return None if row is None else row[0]


def add_domain(
    domain
):
    cursor = connection.execute(
        'INSERT OR IGNORE INTO domains (domain) VALUES (?1) RETURNING domain',
        [domain]
    )
    row = cursor.fetchone()

    return None if row is None else row[0]


def record_device_history(
    device_id,
    item_id,
    season,
    episode,
    position,
    duration
):
    connection.execute(
        """
        INSERT INTO device_history
            (device_id, item_id, season, episode, position, duration, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(device_id, item_id, season, episode) DO UPDATE SET
            position = excluded.position,
            duration = max(device_history.duration, excluded.duration),
            updated_at = excluded.updated_at
        """,
        [
            device_id,
            item_id,
            season or 0,
            episode or 0,
            position or 0,
            duration or 0,
            int(time.time())
        ]
    )


def touch_device_history(
    device_id,
    item_id,
    season,
    episode,
    position,
    duration
):
    connection.execute(
        """
        INSERT INTO device_history
            (device_id, item_id, season, episode, position, duration, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(device_id, item_id, season, episode) DO UPDATE SET
            duration = max(device_history.duration, excluded.duration),
            updated_at = excluded.updated_at
        """,
        [
            device_id,
            item_id,
            season or 0,
            episode or 0,
            position or 0,
            duration or 0,
            int(time.time())
        ]
    )


def get_device_history_position(
    device_id,
    item_id,
    season,
    episode
):
    cursor = connection.execute(
        """
        SELECT position FROM device_history
        WHERE device_id = ?1 AND item_id = ?2 AND season = ?3 AND episode = ?4
        """,
        [device_id, item_id, season or 0, episode or 0]
    )
    row = cursor.fetchone()

    return None if row is None else row[0]


def get_device_history_entry(
    device_id,
    item_id
):
    cursor = connection.execute(
        """
        SELECT season, episode, position, duration, updated_at
        FROM device_history
        WHERE device_id = ?1 AND item_id = ?2
        ORDER BY updated_at DESC, rowid DESC
        LIMIT 1
        """,
        [device_id, item_id]
    )
    row = cursor.fetchone()
    if row is None:
        return None

    return {
        'season': row[0],
        'episode': row[1],
        'position': row[2],
        'duration': row[3],
        'updated_at': row[4]
    }


def get_device_history(
    device_id,
    limit,
    offset
):
    cursor = connection.execute(
        """
        SELECT h.item_id, h.season, h.episode, h.position, h.duration, h.updated_at
        FROM device_history h
        WHERE h.device_id = ?1
          AND h.rowid = (
              SELECT h2.rowid FROM device_history h2
              WHERE h2.device_id = ?1 AND h2.item_id = h.item_id
              ORDER BY h2.updated_at DESC, h2.rowid DESC
              LIMIT 1
          )
        ORDER BY h.updated_at DESC, h.rowid DESC
        LIMIT ?2 OFFSET ?3
        """,
        [device_id, limit, offset]
    )

    return [
        {
            'item_id': row[0],
            'season': row[1],
            'episode': row[2],
            'position': row[3],
            'duration': row[4],
            'updated_at': row[5]
        }
        for row in cursor.fetchall()
    ]


def count_device_history(device_id):
    return connection.execute(
        'SELECT COUNT(DISTINCT item_id) FROM device_history WHERE device_id = ?1',
        [device_id]
    ).fetchone()[0]


def clear_device_history(device_id):
    connection.execute(
        'DELETE FROM device_history WHERE device_id = ?1',
        [device_id]
    )
