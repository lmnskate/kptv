import os
import sqlite3
import sys
import tempfile
from pathlib import Path

_scratch_db = tempfile.mkstemp(prefix='kptv-tests-', suffix='.db')[1]
os.environ['SERVER_SQLITE_URL'] = _scratch_db
# The admin panel binds a TCP port from the app lifespan — never in tests.
os.environ['SERVER_ADMIN_PORT'] = '0'
os.environ.setdefault('SERVER_HOST', 'kptv.tests')
os.environ.setdefault('KP_CLIENT_ID', 'tests-client-id')
os.environ.setdefault('KP_CLIENT_SECRET', 'tests-client-secret')

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'src'))

import pytest
from fastapi.testclient import TestClient

from devices import storage
from devices.device import Device
from devices.settings import DeviceSettings
from kinopub.client import KinoPub
from main import app
from routers import auth as auth_router
from routers import browse as browse_router
from routers import library as library_router
from services import proxy


def apply_migrations(conn):
    from devices import migrations

    conn.execute(
        'CREATE TABLE IF NOT EXISTS migrations (id INT PRIMARY KEY, name TEXT)'
    )
    for i, script in enumerate(migrations.get_migrations()):
        conn.executescript(script)
        conn.execute(
            'INSERT OR IGNORE INTO migrations (id, name) VALUES (?1, ?2)',
            [i + 1, script[:80]]
        )


@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    conn = sqlite3.connect(':memory:', autocommit=True, check_same_thread=False)
    apply_migrations(conn)
    monkeypatch.setattr(storage, 'connection', conn)
    Device._cache.clear()
    proxy.KNOWN_DOMAINS.clear()
    proxy._PLAYLIST_CACHE.clear()
    auth_router._code_requests.clear()
    auth_router._qr_requests.clear()
    browse_router._home_cache.clear()
    browse_router._search_cache.clear()
    library_router._local_history_cache.clear()
    yield conn
    conn.close()


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        yield test_client


class FakeKp:
    def __init__(self, responses=None):
        self.responses = responses or {}
        self.calls = []

    async def api(self, path, params=None, method='GET', **kwargs):
        self.calls.append({
            'path': path,
            'params': params,
            'method': method,
        })
        value = self.responses.get(path)
        if callable(value):
            return value(params)
        return value

    async def close_session(self):
        return None

    @staticmethod
    def page_out_of_range(result, page):
        return KinoPub.page_out_of_range(result, page)


def seed_device(device_id, registered=True, settings=None):
    storage.create_device({
        'id': device_id,
        'token': f'tok-{device_id}' if registered else None,
        'refresh': f'ref-{device_id}' if registered else None,
        'settings': settings,
    })
    return Device.by_id(device_id)


@pytest.fixture()
def registered_device(fresh_db):
    device = seed_device('tv-tests-1')
    fake = FakeKp()
    device.kp = fake
    return device


@pytest.fixture()
def device_settings():
    return DeviceSettings(None)


def kp_item(item_id=1, **overrides):
    item = {
        'id': item_id,
        'type': 'movie',
        'title': f'Тестовый фильм {item_id}',
        'year': 2020,
        'kinopoisk_rating': 7.5,
        'imdb_rating': 7.0,
        'posters': {
            'small': f'https://cdn.kino.test/posters/{item_id}/small.jpg',
            'big': f'https://cdn.kino.test/posters/{item_id}/big.jpg',
            'wide': f'https://cdn.kino.test/posters/{item_id}/wide.jpg',
        },
        'quality': 1080,
        'watched': 0,
    }
    item.update(overrides)
    return item
