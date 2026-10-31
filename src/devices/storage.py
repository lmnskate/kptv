import fcntl
import json
import logging
import os
import sqlite3

from config.settings import server
from devices import migrations

logger = logging.getLogger(__name__)

# sqlite3.connect() does not create missing parent directories itself
_db_dir = os.path.dirname(server.sqlite_url)
if _db_dir:
    os.makedirs(_db_dir, exist_ok=True)

connection = sqlite3.connect(
    server.sqlite_url,
    autocommit=True,
    check_same_thread=False
)


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


def _check_writable():
    # Fail fast at startup instead of surfacing "attempt to write a readonly
    # database" later. A typical cause is a bind-mounted data directory owned
    # by root while the container runs as uid 1000.
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
        'user_agent': row[5]
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


DEVICE_COLUMNS = 'id, code, refresh, token, settings, user_agent'


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
    return query_device(
        f"""
        INSERT OR IGNORE INTO devices ({DEVICE_COLUMNS})
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        RETURNING {DEVICE_COLUMNS}
        """,
        [
            entry.get('id'),
            entry.get('code'),
            entry.get('refresh'),
            entry.get('token'),
            None if settings is None else json.dumps(settings),
            entry.get('user_agent')
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
