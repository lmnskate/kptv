import os
import sqlite3

import pytest
from conftest import FakeKp, kp_item
from fastapi.testclient import TestClient

from admin_panel import create_admin_app
from config import settings
from devices import storage
from devices.device import Device


@pytest.fixture()
def admin_client(monkeypatch):
    monkeypatch.setattr(settings.server, 'admin_token', None)
    with TestClient(create_admin_app()) as client:
        yield client


@pytest.fixture()
def admin_client_with_token(monkeypatch):
    monkeypatch.setattr(settings.server, 'admin_token', 'secret-token')
    with TestClient(create_admin_app()) as client:
        yield client


def seeded_device(device_id, registered=True, settings_dict=None):
    return storage.create_device({
        'id': device_id,
        'token': 'tok-' + device_id if registered else None,
        'refresh': 'ref-' + device_id if registered else None,
        'settings': settings_dict,
    })


def fake_kp_device(device_id, responses=None):
    device = Device.by_id(device_id)
    device.kp = FakeKp(responses or {})
    return device


def test_devices_list_empty(admin_client):
    response = admin_client.get('/api/devices')

    assert response.status_code == 200
    assert response.json() == {'devices': []}


def test_devices_list_shapes_payload(admin_client, fresh_db):
    seeded_device(
        'tv-admin-1',
        settings_dict={'uhd': True, 'poster_size': 'big'}
    )
    seeded_device('tv-admin-2', registered=False)
    storage.record_device_history('tv-admin-1', 42, 1, 3, 100, 3600)

    response = admin_client.get('/api/devices')

    assert response.status_code == 200
    devices = {
        device['id']: device
        for device in response.json()['devices']
    }
    assert set(devices) == {'tv-admin-1', 'tv-admin-2'}
    assert devices['tv-admin-1']['registered'] is True
    assert devices['tv-admin-1']['settings'] == 'uhd posters=big'
    assert devices['tv-admin-1']['history_rows'] == 1
    assert devices['tv-admin-2']['registered'] is False
    assert devices['tv-admin-2']['settings'] == 'defaults'


def test_delete_device_removes_rows_and_cache(admin_client, fresh_db):
    seeded_device('tv-admin-1')
    device = Device.by_id('tv-admin-1')
    assert device is not None
    storage.record_device_history('tv-admin-1', 42, 0, 0, 100, 3600)

    response = admin_client.delete('/api/devices/tv-admin-1')

    assert response.status_code == 200
    assert storage.get_device_by_id('tv-admin-1') is None
    assert storage.count_device_history_rows('tv-admin-1') == 0
    assert 'tv-admin-1' not in Device._cache


def test_delete_missing_device_404(admin_client, fresh_db):
    response = admin_client.delete('/api/devices/nope')

    assert response.status_code == 404
    assert response.json()['error']['code'] == 'not_found'


def test_reset_device_clears_settings_and_cache(admin_client, fresh_db):
    seeded_device(
        'tv-admin-1',
        settings_dict={'uhd': True}
    )
    Device.by_id('tv-admin-1')

    response = admin_client.post('/api/devices/tv-admin-1/reset')

    assert response.status_code == 200
    entry = storage.get_device_by_id('tv-admin-1')
    assert entry['settings'] is None
    assert 'tv-admin-1' not in Device._cache


def test_reset_missing_device_404(admin_client, fresh_db):
    response = admin_client.post('/api/devices/nope/reset')

    assert response.status_code == 404


def test_history_lists_raw_rows(admin_client, fresh_db):
    seeded_device('tv-admin-1')
    fake_kp_device('tv-admin-1')
    storage.record_device_history('tv-admin-1', 10, 0, 0, 300, 3600)
    storage.record_device_history('tv-admin-1', 20, 2, 5, 90, 1800)

    response = admin_client.get('/api/devices/tv-admin-1/history')

    assert response.status_code == 200
    payload = response.json()
    assert payload['page'] == 1
    assert payload['has_more'] is False
    items = payload['items']
    assert [item['item_id'] for item in items] == [20, 10]
    first = items[0]
    assert first['season'] == 2
    assert first['episode'] == 5
    assert first['progress'] == 5
    assert first['title'] is None
    assert first['poster'] is None
    second = items[1]
    assert second['progress'] == 8


def test_history_enriches_titles_and_posters(admin_client, fresh_db):
    seeded_device('tv-admin-1')
    fake_kp_device('tv-admin-1', {
        '/items/10': {'item': kp_item(10)},
        '/items/20': {'item': kp_item(20)},
    })
    storage.record_device_history('tv-admin-1', 10, 0, 0, 300, 3600)
    storage.record_device_history('tv-admin-1', 20, 2, 5, 90, 1800)

    response = admin_client.get('/api/devices/tv-admin-1/history')

    items = response.json()['items']
    assert items[0]['title'] == 'Тестовый фильм 20'
    assert items[0]['poster'] == 'https://cdn.kino.test/posters/20/big.jpg'
    assert items[1]['title'] == 'Тестовый фильм 10'


def test_history_skips_enrichment_when_unregistered(admin_client, fresh_db):
    seeded_device('tv-admin-1', registered=False)
    storage.record_device_history('tv-admin-1', 10, 0, 0, 300, 3600)

    response = admin_client.get('/api/devices/tv-admin-1/history')

    assert response.json()['items'][0]['title'] is None
    assert response.json()['items'][0]['poster'] is None


def test_history_delete_single_entry(admin_client, fresh_db):
    seeded_device('tv-admin-1')
    storage.record_device_history('tv-admin-1', 10, 1, 2, 300, 3600)
    storage.record_device_history('tv-admin-1', 20, 0, 0, 90, 1800)

    response = admin_client.request(
        'DELETE',
        '/api/devices/tv-admin-1/history',
        json={'item_id': 10, 'season': 1, 'episode': 2}
    )

    assert response.status_code == 200
    rows = storage.get_device_history_rows('tv-admin-1', 10, 0)
    assert [row['item_id'] for row in rows] == [20]


def test_history_delete_missing_entry_404(admin_client, fresh_db):
    seeded_device('tv-admin-1')

    response = admin_client.request(
        'DELETE',
        '/api/devices/tv-admin-1/history',
        json={'item_id': 999}
    )

    assert response.status_code == 404


def test_history_progress_none_without_duration(admin_client, fresh_db):
    seeded_device('tv-admin-1')
    fake_kp_device('tv-admin-1')
    storage.record_device_history('tv-admin-1', 10, 0, 0, 300, 0)

    response = admin_client.get('/api/devices/tv-admin-1/history')

    assert response.json()['items'][0]['progress'] is None


def test_token_required_when_configured(admin_client_with_token, fresh_db):
    seeded_device('tv-admin-1')

    response = admin_client_with_token.get('/api/devices')

    assert response.status_code == 401
    assert response.json()['error']['code'] == 'unauthorized'

    response = admin_client_with_token.get(
        '/api/devices',
        headers={'Authorization': 'Bearer wrong'}
    )

    assert response.status_code == 401

    response = admin_client_with_token.get(
        '/api/devices',
        headers={'Authorization': 'Bearer secret-token'}
    )

    assert response.status_code == 200
    assert len(response.json()['devices']) == 1


def test_token_accepted_as_query_param(admin_client_with_token, fresh_db):
    response = admin_client_with_token.get('/api/devices?token=secret-token')

    assert response.status_code == 200


def test_index_page_served(admin_client):
    response = admin_client.get('/')

    assert response.status_code == 200
    assert 'text/html' in response.headers['content-type']


def test_export_downloads_valid_sqlite(admin_client, fresh_db, tmp_path):
    seeded_device('tv-admin-1')
    storage.record_device_history('tv-admin-1', 42, 0, 0, 100, 3600)

    response = admin_client.get('/api/database/export')

    assert response.status_code == 200
    assert 'application/octet-stream' in response.headers['content-type']
    assert 'attachment' in response.headers['content-disposition']
    target = tmp_path / 'export.db'
    target.write_bytes(response.content)
    conn = sqlite3.connect(str(target))
    try:
        assert conn.execute(
            "SELECT 1 FROM devices WHERE id = 'tv-admin-1'"
        ).fetchone() is not None
        assert conn.execute(
            'SELECT COUNT(*) FROM device_history'
        ).fetchone()[0] == 1
    finally:
        conn.close()


def test_import_replaces_database_and_flushes_cache(admin_client, fresh_db, tmp_path):
    seeded_device('tv-old')
    assert Device.by_id('tv-old') is not None
    exported = admin_client.get('/api/database/export').content

    fresh_db.execute('DELETE FROM devices')
    fresh_db.execute('DELETE FROM device_history')
    assert storage.count_devices() == 0

    response = admin_client.post(
        '/api/database/import',
        files={
            'file': ('devices.db', exported, 'application/octet-stream')
        }
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload['ok'] is True
    assert payload['devices'] == 1
    assert payload['backup'].endswith('.db') is False
    assert os.path.exists(payload['backup'])
    os.unlink(payload['backup'])
    assert storage.get_device_by_id('tv-old') is not None
    assert 'tv-old' not in Device._cache


def test_import_rejects_garbage(admin_client, fresh_db):
    response = admin_client.post(
        '/api/database/import',
        files={'file': ('x.db', b'not a database', 'application/octet-stream')}
    )

    assert response.status_code == 400
    assert storage.count_devices() == 0


def test_import_rejects_sqlite_without_devices(admin_client, fresh_db, tmp_path):
    foreign = tmp_path / 'foreign.db'
    conn = sqlite3.connect(str(foreign))
    conn.execute('CREATE TABLE something_else (id INT)')
    conn.close()

    response = admin_client.post(
        '/api/database/import',
        files={
            'file': ('foreign.db', foreign.read_bytes(), 'application/octet-stream')
        }
    )

    assert response.status_code == 400


def test_database_endpoints_respect_token(admin_client_with_token, fresh_db):
    response = admin_client_with_token.get('/api/database/export')

    assert response.status_code == 401

    response = admin_client_with_token.post(
        '/api/database/import',
        files={'file': ('x.db', b'x', 'application/octet-stream')}
    )

    assert response.status_code == 401


def test_import_applies_pending_migrations(admin_client, fresh_db, tmp_path):
    from devices import migrations

    legacy = tmp_path / 'legacy.db'
    conn = sqlite3.connect(str(legacy))
    conn.execute(
        'CREATE TABLE IF NOT EXISTS migrations (id INT PRIMARY KEY, name TEXT)'
    )
    conn.executescript(migrations.get_migrations()[0])
    conn.execute(
        "INSERT INTO devices (id, token, refresh) VALUES ('tv-legacy', 'tok', 'ref')"
    )
    conn.commit()
    conn.close()

    response = admin_client.post(
        '/api/database/import',
        files={'file': ('legacy.db', legacy.read_bytes(), 'application/octet-stream')}
    )

    assert response.status_code == 200
    assert response.json()['devices'] == 1

    devices = admin_client.get('/api/devices').json()['devices']

    assert devices[0]['id'] == 'tv-legacy'
    assert devices[0]['history_rows'] == 0


def test_history_progress_capped_at_100(admin_client, fresh_db):
    seeded_device('tv-admin-1')
    fake_kp_device('tv-admin-1')
    storage.record_device_history('tv-admin-1', 10, 0, 0, 7200, 3600)

    response = admin_client.get('/api/devices/tv-admin-1/history')

    assert response.json()['items'][0]['progress'] == 100
