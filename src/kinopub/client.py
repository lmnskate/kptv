import asyncio
import logging

import aiohttp

import config.globals as g
from config.settings import kp

logger = logging.getLogger(__name__)


class KinoPub:
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
        retried=False,
        attempts=0
    ):
        if not self.token:
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
            if attempts < 1 and method == 'GET':
                return await self.api(
                    path,
                    params=params,
                    method=method,
                    retried=retried,
                    attempts=attempts + 1
                )

            return None
        except aiohttp.ClientError as e:
            logger.warning('HTTP client error while requesting %s: %s', url, e)
            if attempts < 1 and method == 'GET':
                return await self.api(
                    path,
                    params=params,
                    method=method,
                    retried=retried,
                    attempts=attempts + 1
                )

            return None
        except Exception:
            logger.exception('Unexpected error while requesting %s', url)
            return None

    @staticmethod
    def page_out_of_range(
        result,
        page
    ):
        try:
            return page > result['pagination']['current']
        except (KeyError, TypeError):
            return False


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

                return (
                    result['user_code'],
                    result['code'],
                    result.get('expires_in')
                )
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
                    if result['error'] == 'authorization_pending':
                        return None

                    return {'error': result['error']}

                return result
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            logger.warning('Failed to check device registration status: %s', e)
            return None


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

            if not self.refresh:
                return False

            if device.token != self.token:
                self.token = device.token
                self.refresh = device.refresh
                await self.close_session()

                return bool(self.token)

            from devices.storage import update_device_tokens

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
                        logger.warning(
                            'Refresh for device %s failed (%s) — clearing tokens to force re-registration',
                            self.device_id,
                            result['error']
                        )
                        update_device_tokens(
                            self.device_id,
                            None,
                            None
                        )
                        self.token = None
                        self.refresh = None
                        cached = Device._cache.get(self.device_id)
                        if cached is not None:
                            cached.token = None
                            cached.refresh = None
                        await self.close_session()

                        return False

                    update_device_tokens(
                        self.device_id,
                        result['access_token'],
                        result['refresh_token']
                    )
                    self.token = result['access_token']
                    self.refresh = result['refresh_token']
                    cached = Device._cache.get(self.device_id)
                    if cached is not None:
                        cached.token = self.token
                        cached.refresh = self.refresh

                    await self.close_session()

                    return True
            except (aiohttp.ClientError, asyncio.TimeoutError, KeyError) as e:
                logger.warning('Failed to refresh access token: %s', e)
                return False
