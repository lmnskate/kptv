import asyncio
import hmac
import logging
import os
import sqlite3
import tempfile
import time
from pathlib import Path

import uvicorn
from fastapi import (Depends, FastAPI, Header, HTTPException, Query, Request,
                     UploadFile)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

import viewmodels as vm
from config.settings import server
from devices import storage
from devices.device import Device

logger = logging.getLogger(__name__)

PAGE_PATH = Path(__file__).resolve().parent / 'assets' / 'admin' / 'index.html'

HISTORY_PAGE_SIZE = 50

MAX_IMPORT_BYTES = 64 * 1024 * 1024

_server = None


class HistoryEntryDelete(BaseModel):
    item_id: int
    season: int = 0
    episode: int = 0


async def require_admin_token(
    authorization: str = Header(None),
    token: str = Query(None)
):
    expected = server.admin_token
    if not expected:
        return

    provided = token
    if authorization and authorization.lower().startswith('bearer '):
        provided = authorization[7:].strip()

    if not provided or not hmac.compare_digest(
        expected.encode('utf-8'),
        provided.encode('utf-8')
    ):
        raise HTTPException(
            status_code=401,
            detail='Неверный или отсутствующий токен администратора'
        )


async def http_error_envelope(
    request: Request,
    exc: StarletteHTTPException
):
    codes = {
        400: 'bad_request',
        401: 'unauthorized',
        404: 'not_found',
        405: 'method_not_allowed',
    }
    message = exc.detail if isinstance(exc.detail, str) else 'Ошибка запроса'

    return JSONResponse(
        {'error': {
            'code': codes.get(exc.status_code, 'http_error'),
            'message': message
        }},
        status_code=exc.status_code
    )


async def validation_error_envelope(
    request: Request,
    exc: RequestValidationError
):
    return JSONResponse(
        {'error': {
            'code': 'bad_request',
            'message': 'Некорректные параметры запроса'
        }},
        status_code=422
    )


def device_payload(
    entry
):
    settings = entry.get('settings') or {}
    flags = []
    if settings.get('uhd'):
        flags.append('uhd')
    if settings.get('hdr'):
        flags.append('hdr')
    if settings.get('hevc'):
        flags.append('hevc')
    poster_size = settings.get('poster_size')
    if poster_size and poster_size != 'medium':
        flags.append('posters=' + poster_size)

    return {
        'id': entry['id'],
        'user_agent': entry.get('user_agent'),
        'registered': bool(entry.get('refresh') or entry.get('token')),
        'settings': ' '.join(flags) if flags else 'defaults',
        'created_at': entry.get('created_at') or 0,
        'history_rows': storage.count_device_history_rows(entry['id']),
    }


def history_payload(
    row,
    enriched=None
):
    position = row['position']
    duration = row['duration']

    return {
        'item_id': row['item_id'],
        'season': row['season'],
        'episode': row['episode'],
        'position': position,
        'duration': duration,
        'progress': min(100, round(position * 100 / duration)) if duration else None,
        'updated_at': row['updated_at'],
        'title': enriched.get('title') if enriched else None,
        'poster': enriched.get('poster') if enriched else None,
    }


async def _history_enrichment(
    device_id,
    rows
):
    device = Device.by_id(device_id)
    if device is None or not device.registered() or not rows:
        return {}

    unique_ids = sorted({row['item_id'] for row in rows})
    detailed = await asyncio.gather(*[
        device.kp.api(f'/items/{item_id}', params={'nolinks': 1})
        for item_id in unique_ids
    ])

    result = {}
    for item_id, full in zip(unique_ids, detailed):
        if full is None or 'item' not in full:
            continue
        result[item_id] = {
            'title': full['item'].get('title'),
            'poster': vm.poster_url(full['item'], device.settings),
        }

    return result


def create_admin_app():
    app = FastAPI(
        title='KPTV Admin',
        docs_url=None,
        openapi_url=None,
    )
    app.add_exception_handler(StarletteHTTPException, http_error_envelope)
    app.add_exception_handler(RequestValidationError, validation_error_envelope)

    @app.get('/')
    async def index():
        return FileResponse(
            PAGE_PATH,
            media_type='text/html'
        )

    @app.get('/api/devices')
    async def list_devices(
        _=Depends(require_admin_token)
    ):
        return {
            'devices': [
                device_payload(entry)
                for entry in storage.list_devices()
            ]
        }

    @app.delete('/api/devices/{device_id}')
    async def delete_device(
        device_id: str,
        _=Depends(require_admin_token)
    ):
        removed = storage.delete_device(device_id)
        if not removed:
            raise HTTPException(status_code=404, detail='Устройство не найдено')
        await Device.drop_cache(device_id)
        logger.info('admin: device %s… deleted', device_id[:8])

        return {'ok': True}

    @app.post('/api/devices/{device_id}/reset')
    async def reset_device(
        device_id: str,
        _=Depends(require_admin_token)
    ):
        updated = storage.reset_device_settings(device_id)
        if not updated:
            raise HTTPException(status_code=404, detail='Устройство не найдено')
        await Device.drop_cache(device_id)
        logger.info('admin: device %s… settings reset', device_id[:8])

        return {'ok': True}

    @app.get('/api/devices/{device_id}/history')
    async def device_history(
        device_id: str,
        page: int = Query(1, ge=1),
        _=Depends(require_admin_token)
    ):
        offset = (page - 1) * HISTORY_PAGE_SIZE
        rows = storage.get_device_history_rows(
            device_id,
            HISTORY_PAGE_SIZE + 1,
            offset
        )
        has_more = len(rows) > HISTORY_PAGE_SIZE
        rows = rows[:HISTORY_PAGE_SIZE]
        enrichment = await _history_enrichment(device_id, rows)

        return {
            'items': [
                history_payload(row, enrichment.get(row['item_id']))
                for row in rows
            ],
            'page': page,
            'has_more': has_more,
        }

    @app.delete('/api/devices/{device_id}/history')
    async def delete_history_entry(
        device_id: str,
        payload: HistoryEntryDelete,
        _=Depends(require_admin_token)
    ):
        removed = storage.delete_device_history_entry(
            device_id,
            payload.item_id,
            payload.season,
            payload.episode
        )
        if not removed:
            raise HTTPException(status_code=404, detail='Запись не найдена')
        logger.info(
            'admin: device %s… history entry removed (item %s s%se%s)',
            device_id[:8],
            payload.item_id,
            payload.season,
            payload.episode
        )

        return {'ok': True}

    @app.get('/api/database/export')
    async def export_database(
        _=Depends(require_admin_token)
    ):
        path = await run_in_threadpool(_export_database)

        return FileResponse(
            path,
            media_type='application/octet-stream',
            filename='kptv-devices-{}.db'.format(
                time.strftime('%Y%m%d-%H%M%S')
            ),
            background=BackgroundTask(
                lambda: os.path.exists(path) and os.unlink(path)
            )
        )

    @app.post('/api/database/import')
    async def import_database(
        file: UploadFile,
        _=Depends(require_admin_token)
    ):
        data = await file.read()
        if len(data) > MAX_IMPORT_BYTES:
            raise HTTPException(
                status_code=413,
                detail='Файл слишком большой (более 64 МБ)'
            )
        try:
            backup_path = await run_in_threadpool(
                _import_database,
                data
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except sqlite3.DatabaseError:
            raise HTTPException(
                status_code=400,
                detail='Файл повреждён или не является базой данных SQLite'
            )
        except sqlite3.Error:
            logger.exception('admin: database import failed')
            raise HTTPException(
                status_code=500,
                detail='Не удалось импортировать базу данных'
            )

        await _flush_runtime_caches()
        device_count = storage.count_devices()
        logger.info(
            'admin: database imported (%d devices), pre-import backup: %s',
            device_count,
            backup_path
        )

        return {
            'ok': True,
            'devices': device_count,
            'backup': backup_path,
        }

    return app


def _export_database():
    fd, path = tempfile.mkstemp(
        prefix='kptv-export-',
        suffix='.db'
    )
    os.close(fd)
    target = sqlite3.connect(path)
    try:
        storage.connection.backup(target)
    finally:
        target.close()

    return path


def _import_database(
    data
):
    db_dir = os.path.dirname(server.sqlite_url) or '.'
    fd, uploaded_path = tempfile.mkstemp(
        suffix='.db',
        dir=db_dir
    )
    os.close(fd)
    try:
        with open(uploaded_path, 'wb') as handle:
            handle.write(data)

        uploaded = sqlite3.connect(uploaded_path)
        try:
            try:
                has_devices = uploaded.execute(
                    "SELECT 1 FROM sqlite_master "
                    "WHERE type = 'table' AND name = 'devices'"
                ).fetchone()
            except sqlite3.DatabaseError:
                raise ValueError('Файл не является базой данных SQLite')
            if has_devices is None:
                raise ValueError(
                    'Файл не похож на базу данных KPTV (нет таблицы devices)'
                )

            backup_path = '{}.pre-import-{}'.format(
                server.sqlite_url,
                time.strftime('%Y%m%d-%H%M%S')
            )
            safety = sqlite3.connect(backup_path)
            try:
                storage.connection.backup(safety)
            finally:
                safety.close()

            uploaded.backup(storage.connection)
            # A stack restart would run these on the imported file — an
            # in-place import must do the same for older-schema backups.
            storage._run_migrations()
            storage.cleanup_stale_devices()
        finally:
            uploaded.close()
    finally:
        os.unlink(uploaded_path)

    return backup_path


async def _flush_runtime_caches():
    # The database under the app just changed wholesale — everything derived
    # from it in process memory must go (mirrors the conftest fresh_db reset).
    from routers import browse, library
    from services import proxy as proxy_service

    await Device.close_all_sessions()
    proxy_service.KNOWN_DOMAINS.clear()
    proxy_service._PLAYLIST_CACHE.clear()
    browse._home_cache.clear()
    browse._search_cache.clear()
    library._local_history_cache.clear()


async def serve():
    global _server
    if not server.admin_port:
        return

    config = uvicorn.Config(
        create_admin_app(),
        host=server.admin_bind_host,
        port=server.admin_port,
        log_config=None,
        access_log=False,
    )
    _server = uvicorn.Server(config)
    # The main uvicorn owns the process signal handlers — a second SIGINT
    # handler here would override them and leave the main server running.
    _server.install_signal_handlers = lambda: None
    await _server.serve()


def shutdown():
    if _server is not None:
        _server.should_exit = True
