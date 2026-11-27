import asyncio
from urllib.parse import quote

import pytest

from config.settings import server
from services import proxy


class FakeResponse:
    def __init__(self, status=200, headers=None, body=b''):
        self.status = status
        self.headers = headers or {}
        self._body = body
        self.content = self

    async def read(self):
        return self._body

    async def release(self):
        return None

    async def iter_any(self):
        yield self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None


class FakeSession:
    def __init__(self, handler):
        self.handler = handler
        self.requests = []

    @property
    def closed(self):
        return False

    async def request(self, method, url, headers=None, allow_redirects=False):
        self.requests.append({'method': method, 'url': url, 'headers': headers or {}})
        return self.handler(method, url, headers or {})

    def get(self, url, allow_redirects=False):
        self.requests.append({'method': 'GET', 'url': url, 'headers': {}})
        return self.handler('GET', url, {})


def proxied(url):
    return f'{server.base_url}/api/v1/proxy?url={quote(url, safe="")}'


class TestSrtToVtt:
    def test_converts_timecodes_and_adds_header(self):
        srt = b'1\n00:00:01,000 --> 00:00:02,500\nHello\n'
        out = proxy.srt_to_vtt(srt)
        assert out.startswith(b'WEBVTT\n\n')
        assert b'00:00:01.000 --> 00:00:02.500' in out

    def test_strips_bom(self):
        out = proxy.srt_to_vtt(b'\xef\xbb\xbf1\n00:00:01,000 --> 00:00:02,000\nX\n')
        assert out.startswith(b'WEBVTT')

    def test_already_vtt_passes_through_untouched(self):
        vtt = b'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nX\n'
        assert proxy.srt_to_vtt(vtt) == vtt


class TestAllowlist:
    def test_unknown_domain_rejected(self):
        with pytest.raises(proxy.UnknownDomainError):
            proxy.check_url('https://evil.example/video.mp4')

    def test_remembered_domain_allowed(self):
        proxy.remember_domain('cdn.kino.test')
        assert proxy.check_url('https://cdn.kino.test/video.mp4') is True

    def test_domain_persisted_to_storage(self, fresh_db):
        proxy.remember_domain('cdn.kino.test')
        row = fresh_db.execute(
            "SELECT domain FROM domains WHERE domain = 'cdn.kino.test'"
        ).fetchone()
        assert row is not None

    def test_scheme_relative_url_has_no_domain_and_is_rejected(self):
        with pytest.raises(proxy.UnknownDomainError):
            proxy.check_url('file:///etc/passwd')

    def test_loopback_is_rejected_until_remembered(self):
        with pytest.raises(proxy.UnknownDomainError):
            proxy.check_url('http://127.0.0.1:8080/admin')
        proxy.remember_domain('127.0.0.1:8080')
        assert proxy.check_url('http://127.0.0.1:8080/admin') is True

    def test_make_proxy_url_carries_device_id_from_contextvar(self):
        token = proxy.current_device_id.set('tv-42')
        try:
            url = proxy.make_proxy_url('https://cdn.kino.test/a.m3u8')
        finally:
            proxy.current_device_id.reset(token)
        assert url.startswith(f'{server.base_url}/api/v1/proxy?')
        assert 'id=tv-42' in url

    def test_make_proxy_url_without_device_id(self):
        url = proxy.make_proxy_url('https://cdn.kino.test/a.m3u8')
        assert url.startswith(f'{server.base_url}/api/v1/proxy?')
        assert 'id=' not in url

    def test_make_subtitle_url_uses_subtitle_route(self):
        url = proxy.make_subtitle_url('https://cdn.kino.test/a.srt')
        assert url.startswith(f'{server.base_url}/api/v1/subtitle?')


class TestRewriteDomain:
    def test_absolute_and_relative_segments_routed_through_proxy(self):
        content = (
            '#EXTM3U\n'
            '#EXT-X-STREAM-INF:BANDWIDTH=1000\n'
            'https://cdn.other.test/path/master.m3u8\n'
            'relative/seg2.ts\n'
            '/root/seg3.ts\n'
        )
        out = proxy.rewrite_domain('https://cdn.kino.test/hls/list.m3u8', content)
        assert proxied('https://cdn.other.test/path/master.m3u8') in out
        assert proxied('https://cdn.kino.test/hls/relative/seg2.ts') in out
        assert proxied('https://cdn.kino.test/root/seg3.ts') in out
        assert 'cdn.other.test/path/master.m3u8\n' not in out

    def test_audio_uri_attribute_rewritten(self):
        content = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/rus.m3u8",NAME="RUS"\n'
        out = proxy.rewrite_domain('https://cdn.kino.test/hls/list.m3u8', content)
        assert f'URI="{proxied("https://cdn.kino.test/hls/audio/rus.m3u8")}"' in out

    def test_comment_lines_without_uri_kept(self):
        content = '#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg.ts\n'
        out = proxy.rewrite_domain('https://cdn.kino.test/hls/list.m3u8', content)
        assert '#EXT-X-TARGETDURATION:6' in out

    def test_already_proxied_urls_pass_through(self):
        inner = proxied('https://cdn.kino.test/seg.ts')
        content = f'#EXTM3U\n{inner}\n'
        out = proxy.rewrite_domain('https://cdn.kino.test/hls/list.m3u8', content)
        assert out.count(inner) == 1


class TestFilterAudioTrack:
    def test_keeps_only_requested_track_and_marks_default(self):
        content = (
            '#EXTM3U\n'
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="RUS",DEFAULT=NO,AUTOSELECT=NO,URI="rus.m3u8"\n'
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",NAME="ENG",DEFAULT=YES,URI="eng.m3u8"\n'
            '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="g"\n'
            'v.m3u8\n'
        )
        out = proxy.filter_audio_track(content, 'RUS')
        assert 'NAME="RUS"' in out
        assert 'NAME="ENG"' not in out
        rus_line = next(l for l in out.splitlines() if 'NAME="RUS"' in l)
        assert 'DEFAULT=YES' in rus_line
        assert 'AUTOSELECT=YES' in rus_line

    def test_url_encoded_name_matches(self):
        content = (
            '#EXTM3U\n'
            '#EXT-X-MEDIA:TYPE=AUDIO,NAME="%D0%A0%D1%83%D1%81",URI="r.m3u8"\n'
        )
        out = proxy.filter_audio_track(content, 'Рус')
        assert '%D0%A0%D1%83%D1%81' in out


class TestFetchRedirects:
    def test_redirect_hop_revalidated_against_allowlist(self, monkeypatch):
        proxy.remember_domain('cdn.kino.test')

        def handler(method, url, headers):
            if url == 'https://cdn.kino.test/start.m3u8':
                return FakeResponse(302, {'Location': 'https://internal.local/secret.m3u8'})
            return FakeResponse(200, {}, b'x')

        monkeypatch.setattr(proxy, 'SESSION', FakeSession(handler))
        with pytest.raises(proxy.UnknownDomainError):
            asyncio.run(proxy._fetch('GET', 'https://cdn.kino.test/start.m3u8', {}))

    def test_redirect_to_remembered_domain_followed(self, monkeypatch):
        proxy.remember_domain('cdn.kino.test')
        proxy.remember_domain('cdn2.kino.test')

        def handler(method, url, headers):
            if url == 'https://cdn.kino.test/start.m3u8':
                return FakeResponse(302, {'Location': '//cdn2.kino.test/final.m3u8'})
            return FakeResponse(200, {'content-type': 'video/mp4'}, b'data')

        fake = FakeSession(handler)
        monkeypatch.setattr(proxy, 'SESSION', fake)
        status, _, _ = asyncio.run(proxy.head('https://cdn.kino.test/start.m3u8'))
        assert status == 200
        assert [r['url'] for r in fake.requests] == [
            'https://cdn.kino.test/start.m3u8',
            'https://cdn2.kino.test/final.m3u8',
        ]

    def test_redirect_loop_capped_at_max_redirects(self, monkeypatch):
        proxy.remember_domain('cdn.kino.test')

        def handler(method, url, headers):
            return FakeResponse(302, {'Location': '/loop.m3u8'})

        fake = FakeSession(handler)
        monkeypatch.setattr(proxy, 'SESSION', fake)
        response = asyncio.run(proxy._fetch('GET', 'https://cdn.kino.test/loop.m3u8', {}))
        assert response.status == 302
        assert len(fake.requests) == proxy.MAX_REDIRECTS + 1

    def test_range_header_forwarded(self, monkeypatch):
        proxy.remember_domain('cdn.kino.test')

        def handler(method, url, headers):
            assert method == 'HEAD'
            assert headers.get('Range') == 'bytes=0-99'
            return FakeResponse(200, {'Content-Length': '100'}, b'')

        monkeypatch.setattr(proxy, 'SESSION', FakeSession(handler))
        status, _, response_headers = asyncio.run(
            proxy.head('https://cdn.kino.test/video.mp4', {'Range': 'bytes=0-99'})
        )
        assert status == 200
        assert response_headers['Content-Length'] == '100'


class TestGetPlaylist:
    VOD = b'#EXTM3U\n#EXT-X-ENDLIST\nseg1.ts\nseg2.ts\n'

    def test_playlist_rewritten_and_cached(self, monkeypatch):
        proxy.remember_domain('cdn.kino.test')
        calls = []

        def handler(method, url, headers):
            calls.append(url)
            return FakeResponse(
                200,
                {'content-type': 'application/vnd.apple.mpegurl', 'Content-Length': '42'},
                self.VOD,
            )

        monkeypatch.setattr(proxy, 'SESSION', FakeSession(handler))
        url = 'https://cdn.kino.test/vod/list.m3u8'

        status, content_type, response_headers, content = asyncio.run(proxy.get(url))
        assert status == 200
        assert 'mpegurl' in content_type
        assert response_headers['Content-Length'] == str(len(content))
        assert proxied('https://cdn.kino.test/vod/seg1.ts').encode() in content
        assert b'\nseg1.ts\n' not in content

        asyncio.run(proxy.get(url))
        assert calls == [url]

    def test_range_request_bypasses_cache(self, monkeypatch):
        proxy.remember_domain('cdn.kino.test')
        calls = []

        def handler(method, url, headers):
            calls.append((url, headers.get('Range')))
            return FakeResponse(200, {'content-type': 'application/vnd.apple.mpegurl'}, self.VOD)

        monkeypatch.setattr(proxy, 'SESSION', FakeSession(handler))
        url = 'https://cdn.kino.test/vod/list.m3u8'
        asyncio.run(proxy.get(url, client_headers={'Range': 'bytes=0-10'}))
        asyncio.run(proxy.get(url, client_headers={'Range': 'bytes=0-10'}))
        assert calls == [(url, 'bytes=0-10'), (url, 'bytes=0-10')]

    def test_audio_filter_applied_to_master_playlist(self, monkeypatch):
        proxy.remember_domain('cdn.kino.test')
        master = (
            b'#EXTM3U\n'
            b'#EXT-X-MEDIA:TYPE=AUDIO,NAME="RUS",URI="r.m3u8"\n'
            b'#EXT-X-MEDIA:TYPE=AUDIO,NAME="ENG",URI="e.m3u8"\n'
            b'v.m3u8\n'
        )

        def handler(method, url, headers):
            return FakeResponse(200, {'content-type': 'application/vnd.apple.mpegurl'}, master)

        monkeypatch.setattr(proxy, 'SESSION', FakeSession(handler))
        _, _, _, content = asyncio.run(
            proxy.get('https://cdn.kino.test/master.m3u8', audio_name='ENG')
        )
        assert b'NAME="ENG"' in content
        assert b'NAME="RUS"' not in content

    def test_playlist_cache_key_includes_device_id(self, monkeypatch):
        proxy.remember_domain('cdn.kino.test')
        calls = []

        def handler(method, url, headers):
            calls.append(url)
            return FakeResponse(200, {'content-type': 'application/vnd.apple.mpegurl'}, self.VOD)

        monkeypatch.setattr(proxy, 'SESSION', FakeSession(handler))
        url = 'https://cdn.kino.test/vod/list.m3u8'
        token = proxy.current_device_id.set('tv-A')
        try:
            asyncio.run(proxy.get(url))
            proxy.current_device_id.set('tv-B')
            asyncio.run(proxy.get(url))
        finally:
            proxy.current_device_id.reset(token)
        assert len(calls) == 2


class TestGetSubtitle:
    def test_srt_converted_to_vtt(self, monkeypatch):
        proxy.remember_domain('cdn.kino.test')

        def handler(method, url, headers):
            return FakeResponse(200, {'content-type': 'application/x-subrip'}, b'1\n00:00:01,000 --> 00:00:02,000\nHi\n')

        monkeypatch.setattr(proxy, 'SESSION', FakeSession(handler))
        status, content_type, content = asyncio.run(
            proxy.get_subtitle('https://cdn.kino.test/subs.srt')
        )
        assert status == 200
        assert content_type == 'text/vtt'
        assert content.startswith(b'WEBVTT')

    def test_subtitle_redirect_revalidated(self, monkeypatch):
        proxy.remember_domain('cdn.kino.test')

        def handler(method, url, headers):
            return FakeResponse(302, {'Location': 'http://127.0.0.1/x.srt'})

        monkeypatch.setattr(proxy, 'SESSION', FakeSession(handler))
        with pytest.raises(proxy.UnknownDomainError):
            asyncio.run(proxy.get_subtitle('https://cdn.kino.test/subs.srt'))

    def test_upstream_error_status_passthrough(self, monkeypatch):
        proxy.remember_domain('cdn.kino.test')

        def handler(method, url, headers):
            return FakeResponse(404, {'content-type': 'text/plain'}, b'nope')

        monkeypatch.setattr(proxy, 'SESSION', FakeSession(handler))
        status, content_type, _ = asyncio.run(
            proxy.get_subtitle('https://cdn.kino.test/missing.srt')
        )
        assert status == 404
        assert content_type == 'text/plain'
