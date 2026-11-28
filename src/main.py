import asyncio
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

import admin_panel
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
    admin_task = None
    if server.admin_port:
        admin_task = asyncio.create_task(admin_panel.serve())
        admin_task.add_done_callback(_admin_stopped)
    try:
        yield
    finally:
        if admin_task is not None:
            admin_panel.shutdown()
            await asyncio.gather(
                admin_task,
                return_exceptions=True
            )
        await Device.close_all_sessions()
        await proxy_service.close_session()


def _admin_stopped(
    task
):
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error('Admin panel server failed: %s', exc)
    else:
        logger.info('Admin panel server stopped')


app = FastAPI(
    title='KPTV',
    version=g.APP_VERSION,
    lifespan=lifespan,
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
        response.headers['Cache-Control'] = 'no-store'
    elif path in ('/client', '/client/') or path.endswith('.html'):
        response.headers['Cache-Control'] = 'no-cache, must-revalidate'
    elif path.endswith(('/js/app.js', '/js/api.js', '/css/client.css')):
        response.headers['Cache-Control'] = 'no-cache, must-revalidate'
    elif path.startswith('/msx/'):
        response.headers['Cache-Control'] = 'no-store'

    return response


@app.middleware('http')
async def device_auth(
    request: Request,
    call_next
):
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
                request.state.device = Device({'id': device_id})
                transient = True

    device = request.state.device
    if device is not None:
        proxy_service.current_device_id.set(device.id)
    if device is not None:
        ua = request.headers.get('user-agent')
        if ua is not None and ua != device.user_agent:
            if transient:
                device.user_agent = ua
            else:
                device.update_user_agent(ua)

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
    logging.getLogger('uvicorn.access').setLevel(logging.WARNING)

    uvicorn.run(
        app='main:app',
        host=server.bind_host,
        port=server.bind_port if server.bind_port is not None else server.port,
        proxy_headers=server.proxy_headers,
        workers=server.workers
    )
