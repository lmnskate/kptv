import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from brotli_asgi import BrotliMiddleware
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse

from config.settings import server
from devices.device import Device
from routers import auth, browse, library, media, playback, settings
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
        await proxy_service.close_session()


app = FastAPI(lifespan=lifespan)
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

# The SPA is developed in the repo-root client/ directory (outside the src/
# service build context); it is served statically here in development. Phase 5
# moves static serving to nginx.
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
    '/docs',
    '/openapi.json'
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
    if path in ('/client', '/client/') or path.endswith('.html'):
        # The SPA HTML must always revalidate: it carries the ?v=
        # cache-buster for js/css, and a stale HTML would keep the whole
        # client on the old version.
        response.headers['Cache-Control'] = 'no-cache, must-revalidate'

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
    if device is not None and device.user_agent is None:
        ua = request.headers.get('user-agent')
        if ua is not None:
            if transient:
                device.user_agent = ua
            else:
                device.update_user_agent(ua)

    try:
        return await execute_guarded(
            request,
            call_next,
            context='request'
        )
    finally:
        if device is not None and device.kp is not None:
            await device.kp.close_session()


@app.get('/')
async def root(
    request: Request
):
    query = str(request.url.query)

    return RedirectResponse('/client/' + ('?' + query if query else ''))


if __name__ == '__main__':
    uvicorn.run(
        app='main:app',
        host=server.bind_host,
        port=server.bind_port if server.bind_port is not None else server.port,
        proxy_headers=server.proxy_headers,
        workers=server.workers
    )
