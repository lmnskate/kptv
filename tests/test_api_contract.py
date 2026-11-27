import time

import pytest
from conftest import FakeKp, kp_item, seed_device

import config.globals as g
from devices import storage
from kinopub.client import KinoPub
from routers import auth as auth_router
from routers import library as library_router

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
        response = client.get('/api/v1/auth/qr.svg?code=ABC123')
        assert response.headers['cache-control'] == 'no-store'


class TestRegistration:
    def test_code_flow_persists_device_row(self, client, monkeypatch):
        async def fake_get_codes():
            return ('USER1', 'device-code-1', 1800)

        monkeypatch.setattr(auth_router.KinoPub, 'get_codes', fake_get_codes)
        response = client.post('/api/v1/auth/code', headers={'X-Device-Id': 'new-tv'})
        assert response.status_code == 200
        assert response.json() == {'user_code': 'USER1', 'expires_in': 1800}
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
            return ('USER1', 'device-code-1', 1800)

        monkeypatch.setattr(auth_router.KinoPub, 'get_codes', fake_get_codes)
        response = client.post(
            '/api/v1/auth/code',
            headers={'X-Device-Id': registered_device.id},
        )
        assert response.status_code == 409
        assert error_code(response) == 'already_registered'

    def test_rate_limit_after_five_requests(self, client, monkeypatch):
        async def fake_get_codes():
            return ('USER1', 'device-code-1', 1800)

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


class TestPlay:
    def _item(self, item_id):
        item = kp_item(item_id)
        item['videos'] = [{
            'number': 1,
            'duration': 3000,
            'files': [{'quality': '1080p', 'url': {'hls4': 'https://cdn.kino.test/v.m3u8'}}],
        }]
        return item

    def test_stream_url_is_the_direct_cdn_link(self, client, registered_device):
        registered_device.kp.responses['/items/7'] = {'item': self._item(7)}
        response = client.get('/api/v1/play/7', headers=DEVICE_HEADER)
        assert response.status_code == 200
        body = response.json()
        assert body['url'] == 'https://cdn.kino.test/v.m3u8'
        assert body['subtitles'] == [] or all(
            '/api/v1/subtitle?url=' in s['url'] for s in body['subtitles']
        )


class TestItemDetail:
    def test_resume_point_from_local_history(self, client, registered_device):
        registered_device.kp.responses['/items/7'] = {'item': kp_item(7, type='serial')}
        storage.record_device_history(registered_device.id, 7, 2, 5, position=300, duration=600)
        response = client.get('/api/v1/items/7', headers=DEVICE_HEADER)
        assert response.status_code == 200
        assert response.json()['resume'] == {
            'season': 2,
            'number': 5,
            'position': 300,
            'progress': 50,
        }

    def test_movie_resume_has_no_season(self, client, registered_device):
        registered_device.kp.responses['/items/8'] = {'item': kp_item(8)}
        storage.record_device_history(registered_device.id, 8, 0, 0, position=100, duration=1000)
        body = client.get('/api/v1/items/8', headers=DEVICE_HEADER).json()
        assert body['resume'] == {
            'season': None,
            'number': None,
            'position': 100,
            'progress': 10,
        }

    def test_no_history_no_resume(self, client, registered_device):
        registered_device.kp.responses['/items/9'] = {'item': kp_item(9)}
        body = client.get('/api/v1/items/9', headers=DEVICE_HEADER).json()
        assert 'resume' not in body


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
        assert body['items'][0]['poster'] == 'https://cdn.kino.test/posters/1/big.jpg'

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


class TestSearch:
    def _stub_pool(self, device, items, total=1):
        device.kp.responses['/items/search'] = {
            'items': items,
            'pagination': {'current': 1, 'total': total},
        }

    def test_ranked_by_relevance_then_popularity(self, client, registered_device):
        self._stub_pool(registered_device, [
            kp_item(1, title='Мстители: Финал', year=2019, views=900),
            kp_item(2, title='Мстители', year=2012, views=5000),
            kp_item(3, title='Новые мстители', year=2025, views=10),
            kp_item(4, title='Мстители: Война бесконечности', year=2018, views=3000),
        ])
        response = client.get('/api/v1/search?q=мстители', headers=DEVICE_HEADER)
        assert response.status_code == 200
        ids = [i['id'] for i in response.json()['items']]
        assert ids == [2, 4, 1, 3]

    def test_original_title_half_matches(self, client, registered_device):
        self._stub_pool(registered_device, [
            kp_item(1, title='Чужой / Alien', views=100),
            kp_item(2, title='Alien: Romulus / Чужой: Ромул', views=500),
        ])
        response = client.get('/api/v1/search?q=alien', headers=DEVICE_HEADER)
        ids = [i['id'] for i in response.json()['items']]
        assert ids == [1, 2]

    def test_pool_paginates_locally(self, client, registered_device):
        self._stub_pool(registered_device, [
            kp_item(i, title=f'Фильм {i}', views=i)
            for i in range(1, 31)
        ])
        page1 = client.get('/api/v1/search?q=фильм', headers=DEVICE_HEADER).json()
        assert len(page1['items']) == 25
        assert page1['has_more'] is True
        page2 = client.get('/api/v1/search?q=фильм&page=2', headers=DEVICE_HEADER).json()
        assert [i['id'] for i in page2['items']] == [5, 4, 3, 2, 1]
        assert page2['has_more'] is False
        assert len(registered_device.kp.calls) == 1

    def test_fetches_upstream_pages_up_to_cap(self, client, registered_device):
        def search_page(params):
            start = (params['page'] - 1) * 50
            return {
                'items': [
                    kp_item(i, title=f'Фильм {i}', views=i)
                    for i in range(start + 1, start + 51)
                ],
                'pagination': {'current': params['page'], 'total': 3},
            }

        registered_device.kp.responses['/items/search'] = search_page
        body = client.get('/api/v1/search?q=фильм', headers=DEVICE_HEADER).json()
        assert len(registered_device.kp.calls) == 2
        assert body['items'][0]['id'] == 100
        assert body['has_more'] is True

    def test_blank_query_returns_empty(self, client, registered_device):
        response = client.get('/api/v1/search?q=!!!', headers=DEVICE_HEADER)
        assert response.status_code == 200
        assert response.json() == {'items': [], 'page': 1, 'has_more': False}
        assert registered_device.kp.calls == []

    def test_upstream_failure_is_502(self, client, registered_device):
        registered_device.kp.responses['/items/search'] = None
        response = client.get('/api/v1/search?q=мстители', headers=DEVICE_HEADER)
        assert response.status_code == 502
        assert error_code(response) == 'upstream'


class TestHome:
    def _stub_rails(self, device):
        device.kp.responses['/items/fresh'] = {'items': [kp_item(50)]}
        device.kp.responses['/items/popular'] = {'items': [kp_item(51)]}
        device.kp.responses['/items'] = {'items': [kp_item(52)]}
        device.kp.responses['/watching/serials'] = {'items': [kp_item(60, type='serial')]}

    def test_continue_rail_comes_from_local_history(self, client, registered_device):
        self._stub_rails(registered_device)
        storage.record_device_history(registered_device.id, 100, 1, 2, position=300, duration=600)
        storage.record_device_history(registered_device.id, 200, 0, 0, position=150, duration=600)
        registered_device.kp.responses['/items/100'] = {'item': kp_item(100, type='serial')}
        registered_device.kp.responses['/items/200'] = {'item': kp_item(200)}

        response = client.get('/api/v1/home', headers=DEVICE_HEADER)
        assert response.status_code == 200
        rails = {r['id']: r for r in response.json()['rails']}
        continue_items = rails['continue']['items']
        assert [i['id'] for i in continue_items] == [200, 100]
        assert continue_items[0]['progress'] == 25
        assert 'media' not in continue_items[0]
        assert continue_items[1]['media'] == {'season': 1, 'number': 2}
        assert continue_items[1]['progress'] == 50
        assert [i['id'] for i in rails['watching']['items']] == [60]

    def test_continue_rail_ignores_account_wide_watching(self, client, registered_device):
        registered_device.kp.responses['/watching/movies'] = {'items': [kp_item(70)]}
        registered_device.kp.responses['/watching/serials'] = {'items': [kp_item(71, type='serial')]}
        response = client.get('/api/v1/home', headers=DEVICE_HEADER)
        assert response.status_code == 200
        rails = {r['id']: r for r in response.json()['rails']}
        assert 'continue' not in rails
        called = [c['path'] for c in registered_device.kp.calls]
        assert '/watching/movies' not in called

    def test_continue_drops_titles_withdrawn_upstream(self, client, registered_device):
        storage.record_device_history(registered_device.id, 100, 0, 0, position=10, duration=600)
        registered_device.kp.responses['/items/100'] = None
        response = client.get('/api/v1/home', headers=DEVICE_HEADER)
        assert response.status_code == 200
        rails = {r['id']: r for r in response.json()['rails']}
        assert 'continue' not in rails

    def test_play_and_progress_refresh_continue_rail(self, client, registered_device):
        item = kp_item(100)
        item['videos'] = [{
            'number': 1,
            'duration': 3000,
            'files': [{'quality': '1080p', 'url': {'hls4': 'https://cdn.kino.test/v.m3u8'}}],
        }]
        registered_device.kp.responses['/items/100'] = {'item': item}

        response = client.get('/api/v1/home', headers=DEVICE_HEADER)
        assert 'continue' not in {r['id'] for r in response.json()['rails']}

        client.get('/api/v1/play/100', headers=DEVICE_HEADER)
        client.post(
            '/api/v1/progress',
            headers=DEVICE_HEADER,
            json={'id': 100, 'time': 600, 'episode': 1},
        )

        response = client.get('/api/v1/home', headers=DEVICE_HEADER)
        rails = {r['id']: r for r in response.json()['rails']}
        assert [i['id'] for i in rails['continue']['items']] == [100]
        assert rails['continue']['items'][0]['progress'] == 20


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


class TestMediaGuards:
    def test_proxy_requires_a_registered_device(self, client, fresh_db):
        response = client.get(
            '/api/v1/proxy?url=https://cdn.kino.test/v.m3u8',
            headers={'X-Device-Id': 'ghost-tv'},
        )
        assert response.status_code == 401
        assert error_code(response) == 'not_registered'

    def test_subtitle_requires_a_registered_device(self, client, fresh_db):
        response = client.get(
            '/api/v1/subtitle?url=https://cdn.kino.test/v.srt',
            headers={'X-Device-Id': 'ghost-tv'},
        )
        assert response.status_code == 401
        assert error_code(response) == 'not_registered'

    def test_unknown_domain_is_403_for_registered_devices(self, client, registered_device):
        response = client.get(
            '/api/v1/proxy?url=https://evil.test/v.m3u8',
            headers=DEVICE_HEADER,
        )
        assert response.status_code == 403


class TestErrorEnvelope:
    def test_unknown_path_is_a_json_404(self, client, registered_device):
        response = client.get('/api/v1/nope', headers=DEVICE_HEADER)
        assert response.status_code == 404
        assert error_code(response) == 'not_found'

    def test_invalid_path_param_is_a_json_422(self, client, registered_device):
        response = client.get('/api/v1/items/abc', headers=DEVICE_HEADER)
        assert response.status_code == 422
        assert error_code(response) == 'bad_request'


class TestRegistrationHygiene:
    def test_code_request_prunes_stale_unactivated_rows(self, client, monkeypatch):
        async def fake_get_codes():
            return ('USER1', 'device-code-1', 1800)

        monkeypatch.setattr(auth_router.KinoPub, 'get_codes', fake_get_codes)
        storage.create_device({
            'id': 'stale-tv',
            'created_at': int(time.time()) - 25 * 3600,
        })
        response = client.post('/api/v1/auth/code', headers={'X-Device-Id': 'fresh-tv'})
        assert response.status_code == 200
        assert storage.get_device_by_id('stale-tv') is None

    def test_poll_success_clears_the_code(self, client, monkeypatch):
        async def fake_check(code):
            return {'access_token': 'AT', 'refresh_token': 'RT'}

        async def fake_api(self, path, params=None, method='GET', **kwargs):
            return None

        monkeypatch.setattr(auth_router.KinoPub, 'check_registration', fake_check)
        monkeypatch.setattr(KinoPub, 'api', fake_api)
        storage.create_device({'id': 'poll-tv', 'code': 'CODE42'})
        response = client.get('/api/v1/auth/poll', headers={'X-Device-Id': 'poll-tv'})
        assert response.json() == {'status': 'active'}
        assert storage.get_device_by_id('poll-tv')['code'] is None

    def test_qr_is_rate_limited(self, client):
        statuses = [
            client.get('/api/v1/auth/qr.svg?code=ABC123').status_code
            for _ in range(6)
        ]
        assert statuses == [200, 200, 200, 200, 200, 429]


class TestSettingsValidation:
    def test_bad_poster_size_is_422(self, client, registered_device):
        response = client.post(
            '/api/v1/settings',
            headers=DEVICE_HEADER,
            json={'poster_size': 'huge'},
        )
        assert response.status_code == 422
        assert error_code(response) == 'bad_request'

    def test_hevc_patch_is_ignored(self, client, registered_device):
        response = client.post(
            '/api/v1/settings',
            headers=DEVICE_HEADER,
            json={'hevc': True},
        )
        assert response.status_code == 200
        assert response.json()['settings']['hevc'] is False


class TestBookmarks:
    def test_folder_counts_come_from_the_folder_payload(self, client, registered_device):
        registered_device.kp.responses['/bookmarks'] = {'items': [
            {'id': 1, 'title': 'Смотреть позже', 'count': 22},
            {'id': 2, 'title': 'Избранное', 'count': 3},
        ]}
        response = client.get('/api/v1/bookmarks', headers=DEVICE_HEADER)
        assert response.status_code == 200
        assert response.json()['folders'] == [
            {'id': 1, 'title': 'Смотреть позже', 'count': 22},
            {'id': 2, 'title': 'Избранное', 'count': 3},
        ]
        assert [c['path'] for c in registered_device.kp.calls] == ['/bookmarks']

    def test_folders_upstream_failure_is_502(self, client, registered_device):
        registered_device.kp.responses['/bookmarks'] = None
        response = client.get('/api/v1/bookmarks', headers=DEVICE_HEADER)
        assert response.status_code == 502
        assert error_code(response) == 'upstream'

    def test_toggle_accepts_folder_objects_and_bare_ids(self, client, registered_device):
        registered_device.kp.responses['/bookmarks/toggle-item'] = {'ok': True}
        registered_device.kp.responses['/bookmarks/get-item-folders'] = {
            'folders': [{'id': 2}, 3],
        }
        response = client.post(
            '/api/v1/bookmarks/toggle',
            headers=DEVICE_HEADER,
            json={'item': 7, 'folder': 2},
        )
        assert response.status_code == 200
        assert response.json()['bookmarks'] == [2, 3]

    def test_item_detail_bookmarks_accept_objects_and_bare_ids(self, client, registered_device):
        registered_device.kp.responses['/items/7'] = {
            'item': kp_item(7, bookmarks=[{'id': 2}, 3])
        }
        body = client.get('/api/v1/items/7', headers=DEVICE_HEADER).json()
        assert body['bookmarks'] == [2, 3]


class TestResumeRules:
    def _playable_item(self, item_id):
        item = kp_item(item_id)
        item['videos'] = [{
            'number': 1,
            'duration': 3000,
            'files': [{'quality': '1080p', 'url': {'hls4': 'https://cdn.kino.test/v.m3u8'}}],
        }]
        return item

    def test_continue_rail_drops_finished_titles(self, client, registered_device):
        registered_device.kp.responses['/items/fresh'] = {'items': [kp_item(50)]}
        registered_device.kp.responses['/items/popular'] = {'items': [kp_item(51)]}
        registered_device.kp.responses['/items'] = {'items': [kp_item(52)]}
        registered_device.kp.responses['/watching/serials'] = {'items': []}
        storage.record_device_history(
            registered_device.id, 100, 0, 0, position=590, duration=600
        )
        registered_device.kp.responses['/items/100'] = {'item': kp_item(100)}
        response = client.get('/api/v1/home', headers=DEVICE_HEADER)
        assert response.status_code == 200
        assert 'continue' not in {r['id'] for r in response.json()['rails']}

    def test_play_restarts_a_finished_local_position(self, client, registered_device):
        registered_device.kp.responses['/items/7'] = {'item': self._playable_item(7)}
        storage.record_device_history(
            registered_device.id, 7, 0, 1, position=2950, duration=3000
        )
        response = client.get('/api/v1/play/7', headers=DEVICE_HEADER)
        assert response.status_code == 200
        assert response.json()['position'] == 0

    def test_unfinished_local_position_wins(self, client, registered_device):
        item = self._playable_item(8)
        item['videos'][0]['watching'] = {'time': 10}
        registered_device.kp.responses['/items/8'] = {'item': item}
        storage.record_device_history(
            registered_device.id, 8, 0, 1, position=900, duration=3000
        )
        body = client.get('/api/v1/play/8', headers=DEVICE_HEADER).json()
        assert body['position'] == 900

    def test_progress_stores_the_reported_duration(self, client, registered_device):
        client.post(
            '/api/v1/progress',
            headers=DEVICE_HEADER,
            json={'id': 55, 'time': 100, 'duration': 3600},
        )
        entry = storage.get_device_history_entry(registered_device.id, 55)
        assert entry['position'] == 100
        assert entry['duration'] == 3600

    def test_play_and_progress_drop_the_local_history_cache(self, client, registered_device):
        registered_device.kp.responses['/items/7'] = {'item': self._playable_item(7)}
        storage.record_device_history(
            registered_device.id, 7, 0, 1, position=10, duration=3000
        )

        def cached_pages():
            return [
                key for key in library_router._local_history_cache
                if key[0] == registered_device.id
            ]

        assert client.get('/api/v1/history', headers=DEVICE_HEADER).status_code == 200
        assert cached_pages()

        client.get('/api/v1/play/7', headers=DEVICE_HEADER)
        assert not cached_pages()

        client.get('/api/v1/history', headers=DEVICE_HEADER)
        assert cached_pages()
        client.post(
            '/api/v1/progress',
            headers=DEVICE_HEADER,
            json={'id': 7, 'time': 100, 'episode': 1, 'duration': 3000},
        )
        assert not cached_pages()
