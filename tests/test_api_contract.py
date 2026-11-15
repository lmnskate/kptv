"""HTTP contract of /api/v1: auth device identification, error envelope,
registration flow, settings round-trip, pagination clamping, per-device
history and upstream-failure statuses. KinoPub is stubbed per device via
FakeKp; no network is touched."""

import pytest
from conftest import FakeKp, kp_item, seed_device

import config.globals as g
from devices import storage
from kinopub.client import KinoPub
from routers import auth as auth_router

DEVICE_HEADER = {'X-Device-Id': 'tv-tests-1'}


def error_code(response):
    return response.json()['error']['code']


class TestDeviceIdentification:
    def test_missing_device_id_is_400(self, client):
        response = client.get('/api/v1/settings')
        assert response.status_code == 400
        assert error_code(response) == 'no_device'

    def test_unknown_device_is_401_and_not_persisted(self, client, fresh_db):
        response = client.get('/api/v1/home', headers={'X-Device-Id': 'ghost-tv'})
        assert response.status_code == 401
        assert error_code(response) == 'not_registered'
        assert storage.get_device_by_id('ghost-tv') is None

    def test_device_id_query_param_accepted(self, client):
        response = client.get('/api/v1/settings?id=ghost-tv')
        assert response.status_code == 401
        assert error_code(response) == 'not_registered'

    def test_api_responses_never_cached(self, client):
        # a request that reaches a router — middleware rejections (no_device)
        # bypass the cache header by design
        response = client.get('/api/v1/auth/qr.svg?code=ABC123')
        assert response.headers['cache-control'] == 'no-store'


class TestRegistration:
    def test_code_flow_persists_device_row(self, client, monkeypatch):
        async def fake_get_codes():
            return ('USER1', 'device-code-1')

        monkeypatch.setattr(auth_router.KinoPub, 'get_codes', fake_get_codes)
        response = client.post('/api/v1/auth/code', headers={'X-Device-Id': 'new-tv'})
        assert response.status_code == 200
        assert response.json() == {'user_code': 'USER1'}
        entry = storage.get_device_by_id('new-tv')
        assert entry is not None
        assert entry['code'] == 'device-code-1'

    def test_code_flow_upstream_failure_is_502(self, client, monkeypatch):
        async def fake_get_codes():
            return None

        monkeypatch.setattr(auth_router.KinoPub, 'get_codes', fake_get_codes)
        response = client.post('/api/v1/auth/code', headers={'X-Device-Id': 'new-tv'})
        assert response.status_code == 502
        assert error_code(response) == 'upstream'

    def test_registered_device_gets_409(self, client, registered_device, monkeypatch):
        async def fake_get_codes():
            return ('USER1', 'device-code-1')

        monkeypatch.setattr(auth_router.KinoPub, 'get_codes', fake_get_codes)
        response = client.post(
            '/api/v1/auth/code',
            headers={'X-Device-Id': registered_device.id},
        )
        assert response.status_code == 409
        assert error_code(response) == 'already_registered'

    def test_rate_limit_after_five_requests(self, client, monkeypatch):
        async def fake_get_codes():
            return ('USER1', 'device-code-1')

        monkeypatch.setattr(auth_router.KinoPub, 'get_codes', fake_get_codes)
        statuses = [
            client.post('/api/v1/auth/code', headers={'X-Device-Id': f'rl-tv'}).status_code
            for _ in range(6)
        ]
        assert statuses == [200, 200, 200, 200, 200, 429]
        assert error_code(client.post('/api/v1/auth/code', headers={'X-Device-Id': 'rl-tv'})) == 'rate_limited'

    def test_poll_without_code_is_400(self, client):
        response = client.get('/api/v1/auth/poll', headers={'X-Device-Id': 'fresh-tv'})
        assert response.status_code == 400
        assert error_code(response) == 'no_code'

    def test_poll_pending(self, client, monkeypatch):
        async def fake_check(code):
            assert code == 'CODE42'
            return None

        monkeypatch.setattr(auth_router.KinoPub, 'check_registration', fake_check)
        storage.create_device({'id': 'poll-tv', 'code': 'CODE42'})
        response = client.get('/api/v1/auth/poll', headers={'X-Device-Id': 'poll-tv'})
        assert response.status_code == 200
        assert response.json() == {'status': 'pending'}

    def test_poll_activation_error_clears_code(self, client, monkeypatch):
        async def fake_check(code):
            return {'error': 'expired_token'}

        monkeypatch.setattr(auth_router.KinoPub, 'check_registration', fake_check)
        storage.create_device({'id': 'poll-tv', 'code': 'CODE42'})
        response = client.get('/api/v1/auth/poll', headers={'X-Device-Id': 'poll-tv'})
        assert response.status_code == 410
        assert error_code(response) == 'activation_expired'
        assert storage.get_device_by_id('poll-tv')['code'] is None

    def test_poll_success_stores_tokens(self, client, monkeypatch):
        async def fake_check(code):
            return {'access_token': 'AT', 'refresh_token': 'RT'}

        # update_tokens swaps in a real KinoPub instance whose notify() call
        # must not hit the network — neuter the class method for this test.
        async def fake_api(self, path, params=None, method='GET', **kwargs):
            return None

        monkeypatch.setattr(auth_router.KinoPub, 'check_registration', fake_check)
        monkeypatch.setattr(KinoPub, 'api', fake_api)
        storage.create_device({'id': 'poll-tv', 'code': 'CODE42'})
        response = client.get('/api/v1/auth/poll', headers={'X-Device-Id': 'poll-tv'})
        assert response.status_code == 200
        assert response.json() == {'status': 'active'}
        entry = storage.get_device_by_id('poll-tv')
        assert entry['token'] == 'AT'
        assert entry['refresh'] == 'RT'


class TestQr:
    def test_valid_code_returns_svg(self, client):
        response = client.get('/api/v1/auth/qr.svg?code=ABC123')
        assert response.status_code == 200
        assert response.headers['content-type'].startswith('image/svg+xml')
        assert b'<svg' in response.content

    @pytest.mark.parametrize('code', ['ab', 'ABCD12345', 'bad!code', ''])
    def test_invalid_code_is_400(self, client, code):
        response = client.get(f'/api/v1/auth/qr.svg?code={code}')
        assert response.status_code == 400
        assert error_code(response) == 'bad_code'


class TestSettings:
    def test_get_returns_settings_account_and_version(self, client, registered_device):
        registered_device.kp.responses['/user'] = {'user': {'username': 'tester'}}
        response = client.get('/api/v1/settings', headers=DEVICE_HEADER)
        assert response.status_code == 200
        body = response.json()
        assert body['version'] == g.APP_VERSION
        assert body['account'] == {'username': 'tester'}
        assert body['settings'] == {
            'uhd': False,
            'hevc': False,
            'hdr': False,
            'poster_size': 'big',
        }

    def test_account_unavailable_still_serves_settings(self, client, registered_device):
        registered_device.kp.responses['/user'] = None
        response = client.get('/api/v1/settings', headers=DEVICE_HEADER)
        assert response.status_code == 200
        assert response.json()['account'] is None

    def test_patch_persists_settings(self, client, registered_device):
        response = client.post(
            '/api/v1/settings',
            headers=DEVICE_HEADER,
            json={'uhd': True, 'poster_size': 'small'},
        )
        assert response.status_code == 200
        assert response.json()['settings']['uhd'] is True
        stored = storage.get_device_by_id(registered_device.id)['settings']
        assert stored['uhd'] is True
        assert stored['poster_size'] == 'small'

    def test_unregistered_cannot_read_settings(self, client):
        seed_device('pending-tv', registered=False)
        response = client.get('/api/v1/settings', headers={'X-Device-Id': 'pending-tv'})
        assert response.status_code == 401


class TestCatalog:
    def test_bad_section_is_400(self, client, registered_device):
        response = client.get('/api/v1/catalog?section=hot', headers=DEVICE_HEADER)
        assert response.status_code == 400
        assert error_code(response) == 'bad_section'

    def test_section_requires_type(self, client, registered_device):
        response = client.get('/api/v1/catalog?section=fresh', headers=DEVICE_HEADER)
        assert response.status_code == 400
        assert error_code(response) == 'bad_request'

    def test_upstream_failure_is_502(self, client, registered_device):
        registered_device.kp.responses['/items'] = None
        response = client.get('/api/v1/catalog', headers=DEVICE_HEADER)
        assert response.status_code == 502
        assert error_code(response) == 'upstream'

    def test_out_of_range_page_returns_empty_items(self, client, registered_device):
        registered_device.kp.responses['/items/fresh'] = {
            'items': [kp_item(1)],
            'pagination': {'current': 1, 'total': 1},
        }
        response = client.get(
            '/api/v1/catalog?type=movie&section=fresh&page=5',
            headers=DEVICE_HEADER,
        )
        assert response.status_code == 200
        body = response.json()
        assert body['items'] == []
        assert body['page'] == 1
        assert body['has_more'] is False

    def test_happy_path_shapes_cards_and_has_more(self, client, registered_device):
        registered_device.kp.responses['/items'] = {
            'items': [kp_item(1), kp_item(2)],
            'pagination': {'current': 1, 'total': 3},
        }
        response = client.get('/api/v1/catalog?type=movie', headers=DEVICE_HEADER)
        assert response.status_code == 200
        body = response.json()
        assert body['has_more'] is True
        assert [i['id'] for i in body['items']] == [1, 2]
        assert '/api/v1/proxy?url=' in body['items'][0]['poster']

    def test_filters_accept_bare_arrays_and_wrapped_items(self, client, registered_device):
        registered_device.kp.responses = {
            '/types': [{'id': 1, 'title': 'movie'}],
            '/genres': {'items': [{'id': 10, 'title': 'драма'}]},
            '/countries': None,
        }
        response = client.get('/api/v1/filters', headers=DEVICE_HEADER)
        assert response.status_code == 200
        body = response.json()
        assert body['types'] == [{'id': 1, 'title': 'movie'}]
        assert body['genres'] == [{'id': 10, 'title': 'драма'}]
        assert body['countries'] == []


class TestLibrary:
    def _device(self, fresh_db, device_id):
        device = seed_device(device_id)
        device.kp = FakeKp()
        return device

    def test_history_is_per_device(self, client, fresh_db):
        device_a = self._device(fresh_db, 'tv-A')
        device_b = self._device(fresh_db, 'tv-B')
        storage.record_device_history('tv-A', 100, 1, 2, position=300, duration=600)
        storage.record_device_history('tv-B', 200, 0, 0, position=10, duration=600)
        device_a.kp.responses['/items/100'] = {'item': kp_item(100, type='serial')}
        device_b.kp.responses['/items/200'] = {'item': kp_item(200)}

        body_a = client.get('/api/v1/history', headers={'X-Device-Id': 'tv-A'}).json()
        body_b = client.get('/api/v1/history', headers={'X-Device-Id': 'tv-B'}).json()

        assert [i['id'] for i in body_a['items']] == [100]
        assert body_a['items'][0]['media'] == {'season': 1, 'number': 2}
        assert body_a['items'][0]['progress'] == 50
        assert body_a['items'][0]['in_progress'] is True
        assert [i['id'] for i in body_b['items']] == [200]

    def test_history_unenriched_when_upstream_down(self, client, fresh_db):
        self._device(fresh_db, 'tv-A')
        storage.record_device_history('tv-A', 100, 0, 0, position=10, duration=600)
        response = client.get('/api/v1/history', headers={'X-Device-Id': 'tv-A'})
        assert response.status_code == 502
        assert error_code(response) == 'upstream'

    def test_history_clear_keeps_other_devices(self, client, fresh_db):
        self._device(fresh_db, 'tv-A')
        self._device(fresh_db, 'tv-B')
        storage.record_device_history('tv-A', 100, 0, 0, position=10, duration=600)
        storage.record_device_history('tv-B', 200, 0, 0, position=10, duration=600)
        response = client.post('/api/v1/history/clear', headers={'X-Device-Id': 'tv-A'})
        assert response.status_code == 200
        assert storage.count_device_history('tv-A') == 0
        assert storage.count_device_history('tv-B') == 1

    def test_watched_toggle_upstream_failure_is_502(self, client, registered_device):
        registered_device.kp.responses['/watching/toggle'] = None
        response = client.post(
            '/api/v1/watching/toggle',
            headers=DEVICE_HEADER,
            json={'id': 5},
        )
        assert response.status_code == 502
        assert error_code(response) == 'upstream'

    def test_subscription_toggle_upstream_failure_is_502(self, client, registered_device):
        registered_device.kp.responses['/watching/togglewatchlist'] = None
        response = client.post(
            '/api/v1/subscription/toggle',
            headers=DEVICE_HEADER,
            json={'id': 5},
        )
        assert response.status_code == 502
        assert error_code(response) == 'upstream'
