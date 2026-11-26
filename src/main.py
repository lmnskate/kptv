import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from brotli_asgi import BrotliMiddleware
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse

import config.globals as g
from config.settings import server
from devices.device import Device
from routers import auth, browse, library, media, msx, playback, settings
from services import proxy as proxy_service

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent


@asynccontextmanager
async def lifespan(
    app
):
    await proxy_service.get_session()
    try:
        yield
    finally:
        await Device.close_all_sessions()
        await proxy_service.close_session()


app = FastAPI(
    title='KPTV',
    version=g.APP_VERSION,
    lifespan=lifespan,
    # The service is internet-facing; Swagger/OpenAPI are opt-in
    # (SERVER_DOCS=true) so the schema is not public by default.
    docs_url='/docs' if server.docs else None,
    openapi_url='/openapi.json' if server.docs else None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=False,
    allow_methods=['*'],
    allow_headers=['*']
)
app.add_middleware(
    GZipMiddleware,
    minimum_size=1000
)
app.add_middleware(
    BrotliMiddleware,
    minimum_size=1000
)

app.include_router(auth.router)
app.include_router(browse.router)
app.include_router(library.router)
app.include_router(playback.router)
app.include_router(settings.router)
app.include_router(media.router)
app.include_router(msx.router)

# The SPA lives in the repo-root client/ directory (outside the src/ build
# context); compose bind-mounts it so the app serves /client/ the same way
# in production (docker-compose.yml).
CLIENT_DIR = BASE_DIR.parent / 'client'
if CLIENT_DIR.is_dir():
    app.mount(
        '/client',
        StaticFiles(directory=CLIENT_DIR, html=True),
        name='client'
    )


UNAUTHORIZED_PATHS = frozenset([
    '/',
    '/api/v1/auth/qr.svg',
    '/msx/start.json',
    '/msx/menu',
    '/msx/logo.svg',
])
if server.docs:
    UNAUTHORIZED_PATHS = UNAUTHORIZED_PATHS.union([
        '/docs',
        '/openapi.json',
    ])

REGISTRATION_PATHS = frozenset([
    '/api/v1/auth/code',
    '/api/v1/auth/poll'
])


def cors_json_response(
    data,
    status=200
):
    response = JSONResponse(
        data,
        status_code=status
    )
    response.headers['Access-Control-Allow-Origin'] = '*'

    return response


async def execute_guarded(
    request: Request,
    call_next,
    context: str
):
    try:
        return await call_next(request)
    except BaseExceptionGroup:
        logger.exception(
            'Unhandled BaseExceptionGroup in %s on %s',
            context,
            request.url.path
        )
        return cors_json_response(
            {'error': {'code': 'internal', 'message': 'Внутренняя ошибка сервера'}},
            status=500
        )
    except Exception:
        logger.exception(
            'Unhandled error in %s on %s',
            context,
            request.url.path
        )
        return cors_json_response(
            {'error': {'code': 'internal', 'message': 'Внутренняя ошибка сервера'}},
            status=500
        )


# Framework-level rejections (unknown paths, wrong methods, invalid
# parameters) must wear the same {"error": {...}} envelope the client
# handles — FastAPI's default HTML/detail bodies would bypass the client's
# error parsing and surface as silent failures on TVs.
@app.exception_handler(StarletteHTTPException)
async def http_error_envelope(
    request: Request,
    exc: StarletteHTTPException
):
    codes = {
        404: 'not_found',
        405: 'method_not_allowed',
    }
    messages = {
        404: 'Не найдено',
        405: 'Метод не поддерживается',
    }

    return cors_json_response(
        {'error': {
            'code': codes.get(exc.status_code, 'http_error'),
            'message': messages.get(exc.status_code, str(exc.detail))
        }},
        status=exc.status_code
    )


@app.exception_handler(RequestValidationError)
async def validation_error_envelope(
    request: Request,
    exc: RequestValidationError
):
    errors = exc.errors()
    loc = '.'.join(str(p) for p in errors[0].get('loc', [])) if errors else ''
    message = 'Некорректные параметры запроса' + (f': {loc}' if loc else '')

    return cors_json_response(
        {'error': {'code': 'bad_request', 'message': message}},
        status=422
    )


@app.middleware('http')
async def cache_client_html(
    request: Request,
    call_next
):
    response = await execute_guarded(
        request,
        call_next,
        context='cache_client_html'
    )

    path = str(request.url.path)
    if path.startswith('/api/'):
        # API responses must never be cached: TV webviews (Tizen/MSX)
        # aggressively cache XHR GETs without validators and then serve
        # stale 401/410 auth responses forever.
        response.headers['Cache-Control'] = 'no-store'
    elif path in ('/client', '/client/') or path.endswith('.html'):
        # The SPA HTML must always revalidate: it carries the ?v=
        # cache-buster for js/css, and a stale HTML would keep the whole
        # client on the old version.
        response.headers['Cache-Control'] = 'no-cache, must-revalidate'
    elif path.endswith(('/js/app.js', '/js/api.js', '/css/client.css')):
        # Our own code changes every release; stale TV/browser caches have
        # bitten us before. hls.min.js (vendored, immutable) keeps the
        # default heuristic caching.
        response.headers['Cache-Control'] = 'no-cache, must-revalidate'
    elif path.startswith('/msx/'):
        # MSX start pages and the logo: TV webviews cache them heuristically
        # for a long time and keep showing stale tiles after edits. The
        # payloads are tiny, so always revalidate.
        response.headers['Cache-Control'] = 'no-store'

    return response


@app.middleware('http')
async def device_auth(
    request: Request,
    call_next
):
    """Identifies the calling device (the credential) and loads it onto
    request.state. The device id travels in the X-Device-Id header (the web
    client) or the ?id= query param (MSX compatibility)."""
    if request.method == 'OPTIONS':
        return await call_next(request)

    path = str(request.url.path)
    device_id = request.query_params.get('id') or request.headers.get('x-device-id')

    if device_id is None and path not in UNAUTHORIZED_PATHS and not path.startswith('/client'):
        return cors_json_response(
            {'error': {'code': 'no_device', 'message': 'Не передан идентификатор устройства'}},
            status=400
        )

    request.state.device = None
    transient = False
    if device_id is not None:
        request.state.device = Device.by_id(device_id)
        if request.state.device is None:
            if path in REGISTRATION_PATHS:
                request.state.device = Device.create(device_id)
            else:
                # Transient in-memory device: keeps the unregistered flow
                # working without persisting rows for arbitrary ids.
                request.state.device = Device({'id': device_id})
                transient = True

    device = request.state.device
    if device is not None:
        proxy_service.current_device_id.set(device.id)
    if device is not None:
        # Record the User-Agent on first sight and keep it current: the same
        # id can move between the TV app and a browser, and the stored UA is
        # what the KinoPub profile shows for the device.
        ua = request.headers.get('user-agent')
        if ua is not None and ua != device.user_agent:
            if transient:
                device.user_agent = ua
            else:
                device.update_user_agent(ua)

    # Device instances (and their aiohttp sessions) are cached across
    # requests for connection reuse — nothing to close here; the lifespan
    # closes everything at shutdown.
    return await execute_guarded(
        request,
        call_next,
        context='request'
    )


@app.get('/')
async def root(
    request: Request
):
    query = str(request.url.query)

    return RedirectResponse('/client/' + ('?' + query if query else ''))


if __name__ == '__main__':
    if server.workers != 1:
        logger.warning(
            'SERVER_WORKERS=%s: the per-process in-memory caches and token '
            'refresh locks assume a single worker — keep SERVER_WORKERS=1',
            server.workers
        )
    # Device ids travel in media URL query strings; the default uvicorn
    # access log would write them to disk. nginx logs $uri (no args).
    logging.getLogger('uvicorn.access').setLevel(logging.WARNING)

    uvicorn.run(
        app='main:app',
        host=server.bind_host,
        port=server.bind_port if server.bind_port is not None else server.port,
        proxy_headers=server.proxy_headers,
        workers=server.workers
    )
