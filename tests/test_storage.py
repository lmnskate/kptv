import time

from devices import migrations, storage


def insert_device(conn, device_id, **columns):
    defaults = {
        'code': None,
        'refresh': None,
        'token': None,
        'settings': None,
        'user_agent': None,
        'created_at': int(time.time()),
    }
    defaults.update(columns)
    conn.execute(
        'INSERT INTO devices (id, code, refresh, token, settings, user_agent, created_at)'
        ' VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
        [
            device_id,
            defaults['code'],
            defaults['refresh'],
            defaults['token'],
            defaults['settings'],
            defaults['user_agent'],
            defaults['created_at'],
        ],
    )


class TestMigrations:
    def test_all_migrations_applied(self, fresh_db):
        count = fresh_db.execute('SELECT COUNT(*) FROM migrations').fetchone()[0]
        assert count == len(migrations.get_migrations())

    def test_expected_tables_exist(self, fresh_db):
        tables = {
            row[0]
            for row in fresh_db.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {'devices', 'device_history', 'domains', 'migrations'} <= tables

    def test_devices_have_created_at(self, fresh_db):
        columns = {row[1] for row in fresh_db.execute('PRAGMA table_info(devices)')}
        assert 'created_at' in columns


class TestDeviceCrud:
    def test_create_and_get(self, fresh_db):
        entry = storage.create_device({'id': 'tv-1', 'token': 't', 'refresh': 'r'})
        assert entry['id'] == 'tv-1'
        assert entry['token'] == 't'
        assert storage.get_device_by_id('tv-1')['refresh'] == 'r'

    def test_create_is_idempotent(self, fresh_db):
        storage.create_device({'id': 'tv-1', 'token': 't1'})
        assert storage.create_device({'id': 'tv-1', 'token': 't2'}) is None
        assert storage.get_device_by_id('tv-1')['token'] == 't1'

    def test_settings_json_roundtrip(self, fresh_db):
        storage.create_device({
            'id': 'tv-1',
            'settings': {'uhd': True, 'poster_size': 'small'},
        })
        assert storage.get_device_by_id('tv-1')['settings'] == {
            'uhd': True,
            'poster_size': 'small',
        }

    def test_settings_default_to_none(self, fresh_db):
        storage.create_device({'id': 'tv-1'})
        assert storage.get_device_by_id('tv-1')['settings'] is None

    def test_updates(self, fresh_db):
        storage.create_device({'id': 'tv-1'})
        storage.update_device_code('tv-1', 'ABC')
        storage.update_device_tokens('tv-1', 'tok', 'ref')
        storage.update_device_user_agent('tv-1', 'Tizen/5.5')
        storage.update_device_settings('tv-1', {'hdr': True})
        entry = storage.get_device_by_id('tv-1')
        assert entry['code'] == 'ABC'
        assert entry['token'] == 'tok'
        assert entry['refresh'] == 'ref'
        assert entry['user_agent'] == 'Tizen/5.5'
        assert entry['settings'] == {'hdr': True}

    def test_missing_device_is_none(self, fresh_db):
        assert storage.get_device_by_id('ghost') is None


class TestDomains:
    def test_add_and_get(self, fresh_db):
        assert storage.add_domain('cdn.test') == 'cdn.test'
        assert storage.get_domain('cdn.test') == 'cdn.test'
        assert storage.get_domain('missing.test') is None

    def test_add_is_deduped(self, fresh_db):
        storage.add_domain('cdn.test')
        assert storage.add_domain('cdn.test') is None


class TestHistory:
    def test_record_upserts_on_conflict(self, fresh_db):
        storage.record_device_history('tv-1', 100, 1, 2, position=300, duration=600)
        storage.record_device_history('tv-1', 100, 1, 2, position=500, duration=600)
        rows = storage.get_device_history('tv-1', 30, 0)
        assert len(rows) == 1
        assert rows[0]['position'] == 500

    def test_duration_keeps_max(self, fresh_db):
        storage.record_device_history('tv-1', 100, 0, 0, position=10, duration=600)
        storage.record_device_history('tv-1', 100, 0, 0, position=20, duration=300)
        assert storage.get_device_history('tv-1', 30, 0)[0]['duration'] == 600

    def test_episodes_collapse_to_newest(self, fresh_db):
        storage.record_device_history('tv-1', 100, 1, 1, position=1, duration=100)
        storage.record_device_history('tv-1', 100, 2, 1, position=1, duration=100)
        rows = storage.get_device_history('tv-1', 30, 0)
        assert len(rows) == 1
        assert (rows[0]['season'], rows[0]['episode']) == (2, 1)
        assert storage.count_device_history('tv-1') == 1

    def test_touch_never_overwrites_position(self, fresh_db):
        storage.record_device_history('tv-1', 100, 0, 0, position=300, duration=600)
        storage.touch_device_history('tv-1', 100, 0, 0, position=0, duration=650)
        row = storage.get_device_history('tv-1', 30, 0)[0]
        assert row['position'] == 300
        assert row['duration'] == 650

    def test_position_lookup(self, fresh_db):
        assert storage.get_device_history_position('tv-1', 100, 1, 5) is None
        storage.record_device_history('tv-1', 100, 1, 5, position=42, duration=100)
        assert storage.get_device_history_position('tv-1', 100, 1, 5) == 42

    def test_entry_is_the_newest_event_of_the_title(self, fresh_db):
        assert storage.get_device_history_entry('tv-1', 100) is None
        storage.record_device_history('tv-1', 100, 1, 1, position=10, duration=100)
        storage.record_device_history('tv-1', 100, 1, 5, position=42, duration=200)
        storage.record_device_history('tv-1', 200, 0, 0, position=1, duration=100)
        entry = storage.get_device_history_entry('tv-1', 100)
        assert (entry['season'], entry['episode']) == (1, 5)
        assert entry['position'] == 42
        assert entry['duration'] == 200

    def test_history_scoped_per_device(self, fresh_db):
        storage.record_device_history('tv-1', 100, 0, 0, position=1, duration=100)
        storage.record_device_history('tv-2', 200, 0, 0, position=1, duration=100)
        assert [r['item_id'] for r in storage.get_device_history('tv-1', 30, 0)] == [100]
        assert storage.count_device_history('tv-1') == 1

    def test_clear_wipes_only_one_device(self, fresh_db):
        storage.record_device_history('tv-1', 100, 0, 0, position=1, duration=100)
        storage.record_device_history('tv-2', 200, 0, 0, position=1, duration=100)
        storage.clear_device_history('tv-1')
        assert storage.count_device_history('tv-1') == 0
        assert storage.count_device_history('tv-2') == 1

    def test_ordering_newest_first_with_pagination(self, fresh_db):
        base = int(time.time())
        for i in range(5):
            fresh_db.execute(
                'INSERT INTO device_history'
                ' (device_id, item_id, season, episode, position, duration, updated_at)'
                ' VALUES (?1, ?2, 0, 0, 0, 100, ?3)',
                ['tv-1', i + 1, base - i],
            )
        assert [r['item_id'] for r in storage.get_device_history('tv-1', 2, 0)] == [1, 2]
        assert [r['item_id'] for r in storage.get_device_history('tv-1', 2, 4)] == [5]


class TestCleanup:
    def test_stale_unactivated_devices_removed(self, fresh_db):
        now = int(time.time())
        insert_device(fresh_db, 'old-pending', created_at=now - storage.UNACTIVATED_TTL - 10)
        insert_device(fresh_db, 'recent-pending', created_at=now - 60)
        insert_device(fresh_db, 'activated-old', token='t', created_at=now - storage.UNACTIVATED_TTL - 10)
        insert_device(fresh_db, 'legacy-no-created-at', created_at=0)

        storage.cleanup_stale_devices()

        ids = {row[0] for row in fresh_db.execute('SELECT id FROM devices')}
        assert 'old-pending' not in ids
        assert {'recent-pending', 'activated-old', 'legacy-no-created-at'} <= ids

    def test_history_capped_per_device(self, fresh_db):
        total = storage.DEVICE_HISTORY_KEEP + 50
        base = int(time.time())
        for i in range(total):
            fresh_db.execute(
                'INSERT INTO device_history'
                ' (device_id, item_id, season, episode, position, duration, updated_at)'
                ' VALUES (?1, ?2, 0, 0, 0, 100, ?3)',
                ['tv-1', i, base - (total - i)],
            )
        fresh_db.execute(
            'INSERT INTO device_history'
            ' (device_id, item_id, season, episode, position, duration, updated_at)'
            ' VALUES (\'tv-2\', 9999, 0, 0, 0, 100, ?1)',
            [base],
        )

        storage.cleanup_stale_devices()

        kept = storage.count_device_history('tv-1')
        assert storage.DEVICE_HISTORY_KEEP - 1 <= kept <= storage.DEVICE_HISTORY_KEEP
        assert storage.get_device_history('tv-1', 1, 0)[0]['item_id'] == total - 1
        assert storage.get_device_history('tv-1', 1, kept - 1)[0]['item_id'] == total - kept
        assert storage.count_device_history('tv-2') == 1
