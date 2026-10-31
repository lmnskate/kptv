import asyncio
import logging

import aiohttp

import config.globals as g
from config.settings import kp

logger = logging.getLogger(__name__)


class KinoPub:
    """Async client for the KinoPub API (api.service-kp.com/v1).

    Returns raw response dicts/lists — view shaping lives in viewmodels.py.
    Transparently refreshes OAuth tokens on 401 (per-device lock, so
    concurrent requests refresh once). A dead refresh token clears the stored
    pair so the device falls back to the activation flow."""

    _refresh_locks: dict = {}
    _refresh_locks_lock = asyncio.Lock()

    def __init__(
        self,
        token,
        refresh,
        device_id=None
    ):
        self.token = token
        self.refresh = refresh
        self.device_id = device_id
        self.session = None

    async def get_session(
        self
    ):
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession(
                headers={'Authorization': f'Bearer {self.token}'},
                timeout=g.TIMEOUT
            )

        return self.session

    async def close_session(
        self
    ):
        if self.session is not None and not self.session.closed:
            await self.session.close()
        self.session = None

    async def api(
        self,
        path,
        params=None,
        method='GET',
        retried=False
    ):
        if not self.token:
            # Registration needed (or a concurrent request already found the
            # stored pair dead and cleared it).
            return None

        session = await self.get_session()
        url = f'{g.BASE_URL}{path}'

        try:
            if method == 'GET':
                context = session.get(
                    url,
                    params=params
                )
            else:
                context = session.request(
                    method,
                    url,
                    json=params
                )

            async with context as response:
                if response.status == 401 and not retried:
                    if await self.refresh_tokens():
                        return await self.api(
                            path,
                            params=params,
                            method=method,
                            retried=True
                        )
                    return None

                if not (200 <= response.status < 300):
                    text = await response.text()
                    logger.warning(
                        'Unexpected status %s from %s: %s',
                        response.status,
                        url,
                        (text or '')[:300]
                    )

                    return None

                try:
                    return await response.json()
                except Exception as e:
                    logger.warning(
                        'Failed to parse JSON from %s: %s',
                        url,
                        e
                    )

                    return None
        except asyncio.TimeoutError:
            logger.warning('Timeout while requesting %s', url)
            return None
        except aiohttp.ClientError as e:
            logger.warning('HTTP client error while requesting %s: %s', url, e)
            return None
        except Exception:
            logger.exception('Unexpected error while requesting %s', url)
            return None

    @staticmethod
    def page_out_of_range(
        result,
        page
    ):
        # KinoPub clamps out-of-range pages to the last one instead of
        # returning an empty list, which would make infinite scroll loop.
        try:
            return page > result['pagination']['current']
        except (KeyError, TypeError):
            return False

    # --- OAuth device-code flow (no instance needed) ---

    @staticmethod
    async def get_codes():
        params = {
            'grant_type': 'device_code',
            'client_id': kp.client_id,
            'client_secret': kp.client_secret
        }
        try:
            async with aiohttp.ClientSession(timeout=g.TIMEOUT) as s:
                response = await s.post(
                    g.OAUTH_URL,
                    params=params
                )
                result = await response.json()

                return result['user_code'], result['code']
        except (aiohttp.ClientError, asyncio.TimeoutError, KeyError) as e:
            logger.warning('Failed to fetch registration codes: %s', e)
            return None

    @staticmethod
    async def check_registration(
        code
    ):
        params = {
            'grant_type': 'device_token',
            'client_id': kp.client_id,
            'client_secret': kp.client_secret,
            'code': code
        }
        try:
            async with aiohttp.ClientSession(timeout=g.TIMEOUT) as s:
                response = await s.post(
                    g.OAUTH_URL,
                    params=params
                )
                result = await response.json()
                if result.get('error') is not None:
                    # authorization_pending is the normal polling state;
                    # anything else (invalid_code, expired_token) is
                    # terminal — surface it so the UI can restart the flow.
                    if result['error'] == 'authorization_pending':
                        return None

                    return {'error': result['error']}

                return result
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            logger.warning('Failed to check device registration status: %s', e)
            return None

    # --- Token refresh with self-healing ---

    @classmethod
    async def _get_refresh_lock(
        cls,
        device_id
    ):
        lock = cls._refresh_locks.get(device_id)
        if lock is None:
            async with cls._refresh_locks_lock:
                lock = cls._refresh_locks.get(device_id)
                if lock is None:
                    lock = asyncio.Lock()
                    cls._refresh_locks[device_id] = lock

        return lock

    async def refresh_tokens(
        self
    ):
        if not self.device_id or not self.refresh:
            return False

        lock = await self._get_refresh_lock(self.device_id)
        async with lock:
            from devices.device import Device

            device = Device.by_id(self.device_id)
            if device is None:
                return False

            if device.token != self.token:
                # Another request already refreshed the pair — adopt it.
                # A dead pair comes back as (None, None): refuse the retry
                # instead of sending "Bearer None".
                self.token = device.token
                self.refresh = device.refresh
                await self.close_session()

                return bool(self.token)

            params = {
                'grant_type': 'refresh_token',
                'client_id': kp.client_id,
                'client_secret': kp.client_secret,
                'refresh_token': self.refresh
            }
            try:
                async with aiohttp.ClientSession(timeout=g.TIMEOUT) as s:
                    response = await s.post(
                        g.OAUTH_REFRESH_URL,
                        params=params
                    )
                    result = await response.json()
                    if result.get('error') is not None:
                        # The stored pair is dead server-side (the device was
                        # unlinked, the tokens were rotated elsewhere or the
                        # refresh window expired). Clear it so the device
                        # falls back to the registration flow instead of
                        # failing every request with 401.
                        logger.warning(
                            'Refresh for device %s failed (%s) — clearing tokens to force re-registration',
                            self.device_id,
                            result['error']
                        )
                        from devices.storage import update_device_tokens
                        update_device_tokens(
                            self.device_id,
                            None,
                            None
                        )
                        self.token = None
                        self.refresh = None
                        await self.close_session()

                        return False

                    from devices.storage import update_device_tokens
                    update_device_tokens(
                        self.device_id,
                        result['access_token'],
                        result['refresh_token']
                    )
                    self.token = result['access_token']
                    self.refresh = result['refresh_token']

                    await self.close_session()

                    return True
            except (aiohttp.ClientError, asyncio.TimeoutError, KeyError) as e:
                logger.warning('Failed to refresh access token: %s', e)
                return False
