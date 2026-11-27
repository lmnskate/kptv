import asyncio

from kinopub.client import KinoPub


class TimeoutSession:
    def __init__(self):
        self.calls = 0

    def get(self, url, params=None):
        self.calls += 1
        raise asyncio.TimeoutError()

    def request(self, method, url, json=None):
        self.calls += 1
        raise asyncio.TimeoutError()


def _client_with_session(monkeypatch, session):
    client = KinoPub('tok', 'ref')

    async def fake_get_session():
        return session

    monkeypatch.setattr(client, 'get_session', fake_get_session)

    return client


class TestRetryPolicy:
    def test_get_is_retried_once(self, monkeypatch):
        session = TimeoutSession()
        client = _client_with_session(monkeypatch, session)

        assert asyncio.run(client.api('/items')) is None
        assert session.calls == 2

    def test_post_is_not_retried(self, monkeypatch):
        session = TimeoutSession()
        client = _client_with_session(monkeypatch, session)

        result = asyncio.run(client.api(
            '/watching/toggle',
            {'id': 1},
            method='POST'
        ))
        assert result is None
        assert session.calls == 1
