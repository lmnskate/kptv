import asyncio
import contextvars
import logging
import posixpath
import re
import time
from urllib.parse import unquote, urlencode, urljoin, urlparse

import aiohttp

from config.settings import server
from devices import storage

logger = logging.getLogger(__name__)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
}

CLIENT_TIMEOUT = aiohttp.ClientTimeout(
    connect=5,
    total=None,
    sock_read=30
)

MAX_RETRIES = 1
_PLAYLIST_CACHE_TTL = 5.0
_PLAYLIST_CACHE = {}

KNOWN_DOMAINS = set()

SESSION = None

# Set by the auth middleware for the duration of the request; media URLs
# (posters, HLS manifests, subtitles) are fetched by the browser/player
# without headers, so the device identity has to travel inside the URL.
current_device_id: contextvars.ContextVar = contextvars.ContextVar(
    'current_device_id',
    default=None
)


class UnknownDomainError(Exception):
    pass


async def init_session():
    global SESSION
    SESSION = aiohttp.ClientSession(
        headers=HEADERS,
        timeout=CLIENT_TIMEOUT
    )


async def get_session():
    if SESSION is None or SESSION.closed:
        await init_session()

    return SESSION


async def close_session():
    global SESSION
    if SESSION is not None and not SESSION.closed:
        await SESSION.close()
    SESSION = None


def _media_url(
    path,
    url
):
    domain = urlparse(url).netloc
    remember_domain(domain)
    params = {'url': url}
    device_id = current_device_id.get()
    if device_id is not None:
        params['id'] = device_id

    return f'{server.base_url}{path}?' + urlencode(params)


def make_proxy_url(
    url
):
    return _media_url(
        '/api/v1/proxy',
        url
    )


def make_subtitle_url(
    url
):
    return _media_url(
        '/api/v1/subtitle',
        url
    )


def domain_exists(
    domain
):
    if domain in KNOWN_DOMAINS:
        return True

    if storage.get_domain(domain) is not None:
        KNOWN_DOMAINS.add(domain)
        return True

    return False


def remember_domain(
    domain
):
    if not domain or domain_exists(domain):
        return

    storage.add_domain(domain)
    KNOWN_DOMAINS.add(domain)


def remember_url(
    url
):
    if url:
        remember_domain(urlparse(url).netloc)


def check_url(
    url
):
    domain = urlparse(url).netloc
    if not domain_exists(domain):
        raise UnknownDomainError('Unknown domain')

    return True


def _copy_response_headers(
    response,
    headers=None
):
    if headers is None:
        headers = {}

    for header in (
        'Content-Range',
        'Accept-Ranges',
        'Content-Length'
    ):
        if header in response.headers:
            headers[header] = response.headers[header]

    return headers


async def _fetch(
    method,
    url,
    headers,
    max_retries=MAX_RETRIES
):
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            session = await get_session()
            response = await session.request(
                method,
                url,
                headers=headers
            )
            if response.status >= 500 and attempt < max_retries:
                await response.release()
                continue
            return response
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            last_error = e
            if attempt < max_retries:
                continue
            raise last_error


def rewrite_domain(
    url,
    content
):
    domain_info = urlparse(url)
    base_url = f'{domain_info.scheme}://{domain_info.netloc}'
    if domain_info.path:
        base_url = urljoin(
            base_url + '/',
            posixpath.dirname(domain_info.path) + '/'
        )

    def _rewrite_url(
        ref
    ):
        if ref.startswith(server.base_url):
            return ref

        if ref.startswith(('http://', 'https://')):
            return make_proxy_url(ref)

        resolved = urljoin(base_url, ref)

        return make_proxy_url(resolved)

    def _rewrite_line(
        line
    ):
        if not line:
            return line

        if line.startswith('#'):
            return re.sub(
                r'URI="([^"]*)"',
                lambda m: f'URI="{_rewrite_url(m.group(1))}"',
                line
            )

        stripped = line.strip()
        if not stripped:
            return line

        return _rewrite_url(stripped)

    return '\n'.join(_rewrite_line(line) for line in content.splitlines()) + '\n'


def filter_audio_track(
    content,
    audio_name
):
    """Keep only the requested audio rendition (matched by NAME) in a master
    playlist — server-side audio switching for players without an
    audioTracks API."""
    lines = []
    for line in content.splitlines():
        if line.startswith('#EXT-X-MEDIA:') and 'TYPE=AUDIO' in line:
            match = re.search(
                r'NAME="([^"]*)"',
                line
            )
            name = match.group(1) if match else None
            if name != audio_name and unquote(name or '') != audio_name:
                continue
            if 'DEFAULT=' in line:
                line = re.sub(
                    r'DEFAULT=(YES|NO)',
                    'DEFAULT=YES',
                    line
                )
            else:
                line += ',DEFAULT=YES'
            if 'AUTOSELECT=' in line:
                line = re.sub(
                    r'AUTOSELECT=(YES|NO)',
                    'AUTOSELECT=YES',
                    line
                )
        lines.append(line)

    return '\n'.join(lines) + '\n'


def _is_vod_playlist(
    text
):
    return '#EXT-X-ENDLIST' in text


def _cache_playlist(
    cache_key,
    entry
):
    # Evict expired entries so the cache cannot grow unboundedly
    now = time.monotonic()
    if len(_PLAYLIST_CACHE) > 64:
        stale = [
            key for key, (cached_at, *_)
            in _PLAYLIST_CACHE.items()
            if now - cached_at >= _PLAYLIST_CACHE_TTL
        ]
        for key in stale:
            del _PLAYLIST_CACHE[key]

    _PLAYLIST_CACHE[cache_key] = entry


async def get(
    url,
    audio_name=None,
    client_headers=None
):
    request_headers = {}
    if client_headers and 'Range' in client_headers:
        request_headers['Range'] = client_headers['Range']

    cache_key = (url, audio_name)
    if not request_headers:
        cached = _PLAYLIST_CACHE.get(cache_key)
        if cached is not None:
            cached_at, content, content_type, response_headers = cached
            if time.monotonic() - cached_at < _PLAYLIST_CACHE_TTL:
                return 200, content_type, response_headers, content

    response = await _fetch('GET', url, request_headers)

    content_type = response.headers.get('content-type')
    response_headers = _copy_response_headers(response)

    is_text_playlist = ((
        content_type is not None and 'mpegurl' in content_type.lower()
    ) or urlparse(url).path.lower().split('?')[0].endswith('.m3u8'))

    if is_text_playlist:
        content = await response.read()
        await response.release()
        text_content = content.decode('utf-8')
        text_content = rewrite_domain(
            url,
            text_content
        )
        if audio_name:
            text_content = filter_audio_track(
                text_content,
                audio_name
            )

        encoded = text_content.encode('utf-8')
        if not request_headers and (audio_name or _is_vod_playlist(text_content)):
            _cache_playlist(cache_key, (
                time.monotonic(),
                encoded,
                content_type,
                response_headers
            ))

        return response.status, content_type, response_headers, encoded

    async def _chunks():
        try:
            async for chunk in response.content.iter_any():
                yield chunk
        finally:
            await response.release()

    return response.status, content_type, response_headers, _chunks()


async def head(
    url,
    client_headers=None
):
    request_headers = {}
    if client_headers and 'Range' in client_headers:
        request_headers['Range'] = client_headers['Range']

    response = await _fetch('HEAD', url, request_headers)
    content_type = response.headers.get('content-type')
    response_headers = _copy_response_headers(response)
    await response.release()

    return response.status, content_type, response_headers


def srt_to_vtt(
    content
):
    text = content.decode(
        'utf-8-sig',
        errors='replace'
    )
    if text.lstrip().startswith('WEBVTT'):
        return content

    text = re.sub(
        r'(\d{1,2}:\d{2}:\d{2}),(\d{3})',
        r'\1.\2',
        text
    )

    return ('WEBVTT\n\n' + text.lstrip()).encode('utf-8')


async def get_subtitle(
    url
):
    session = await get_session()
    async with session.get(url) as response:
        content = await response.read()

        if response.status != 200:
            return response.status, response.headers.get('content-type'), content

        return response.status, 'text/vtt', srt_to_vtt(content)
