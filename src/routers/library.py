import asyncio
import time
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

import viewmodels as vm
from devices import storage
from routers.browse import invalidate_home_cache
from routers.deps import error, registered

router = APIRouter(
    prefix='/api/v1',
    tags=['library']
)


class FolderCreate(BaseModel):
    title: str


class BookmarkToggle(BaseModel):
    item: int
    folder: int


class WatchedToggle(BaseModel):
    id: int
    season: Optional[int] = None
    episode: Optional[int] = None


class SubscriptionToggle(BaseModel):
    id: int


@router.get('/bookmarks')
async def bookmark_folders(
    request: Request
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    result = await current.kp.api('/bookmarks')

    folders = [
        {'id': f.get('id'), 'title': f.get('title'), 'count': 0}
        for f in (result or {}).get('items', [])
    ]

    # Upstream's `views` field is a view counter, not the item count —
    # count the actual folder contents instead (folders are few).
    async def _count(folder_id):
        r = await current.kp.api(f'/bookmarks/{folder_id}')
        return len((r or {}).get('items', []))

    counts = await asyncio.gather(*[_count(f['id']) for f in folders])
    for f, count in zip(folders, counts):
        f['count'] = count

    return {'folders': folders}


@router.get('/bookmarks/{folder}')
async def bookmark_folder_items(
    request: Request,
    folder: int,
    page: int = 1
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    result = await current.kp.api(
        f'/bookmarks/{folder}',
        params={'page': page}
    )
    if result is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    if current.kp.page_out_of_range(result, page):
        result['items'] = []

    pagination = result.get('pagination') or {}

    return {
        'items': [vm.card(i, current.settings) for i in result.get('items', [])],
        'page': pagination.get('current', page),
        'has_more': pagination.get('current', page) < pagination.get('total', page)
    }


@router.post('/bookmarks/folders')
async def bookmark_folder_create(
    request: Request,
    body: FolderCreate
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    result = await current.kp.api(
        '/bookmarks/create',
        {'title': body.title},
        method='POST'
    )
    if result is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    return {'ok': True}


@router.post('/bookmarks/toggle')
async def bookmark_toggle(
    request: Request,
    body: BookmarkToggle
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    result = await current.kp.api(
        '/bookmarks/toggle-item',
        {
            'item': body.item,
            'folder': body.folder
        },
        method='POST'
    )
    if result is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    result = await current.kp.api(
        '/bookmarks/get-item-folders',
        params={'item': body.item}
    )
    if result is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    return {
        'ok': True,
        'bookmarks': [
            f.get('id')
            for f in (result or {}).get('folders', [])
        ]
    }


# Rows come from the local device_history table; only the cards are
# enriched upstream (one /items request per row), cached per (device, page)
# because the client sweeps pages sequentially when opening the screen.
HISTORY_PER_PAGE = 30
_LOCAL_HISTORY_TTL = 10
_local_history_cache: dict = {}


def _drop_local_history_cache(device_id):
    for key in [k for k in _local_history_cache if k[0] == device_id]:
        _local_history_cache.pop(key)


async def _local_history_page(
    current,
    page
):
    """One page of the device's local history as render-ready cards, or None
    when the enrichment source (KinoPub) is unreachable."""
    now = time.monotonic()
    key = (current.id, page)
    cached = _local_history_cache.get(key)
    if cached is not None and now - cached[0] < _LOCAL_HISTORY_TTL:
        return cached[1]

    start = (page - 1) * HISTORY_PER_PAGE
    rows = storage.get_device_history(current.id, HISTORY_PER_PAGE, start)
    total = storage.count_device_history(current.id)
    items = []

    if rows:
        detailed = await asyncio.gather(*[
            current.kp.api(f'/items/{r["item_id"]}', params={'nolinks': 1})
            for r in rows
        ])
        if all(full is None or 'item' not in full for full in detailed):
            return None

        settings = current.settings
        for row, full in zip(rows, detailed):
            # Titles withdrawn upstream just drop out of the local feed.
            if full is None or 'item' not in full:
                continue
            card = vm.card(full['item'], settings)
            if row['season']:
                card['media'] = {
                    'season': row['season'],
                    'number': row['episode'],
                }
            pct = vm.progress_pct(row['duration'], row['position'])
            if pct:
                card['progress'] = pct
            card['in_progress'] = 0 < pct < 100
            card['watched_at'] = row['updated_at']
            items.append(card)

    payload = {
        'items': items,
        'page': page,
        'has_more': start + HISTORY_PER_PAGE < total
    }
    if len(_local_history_cache) > 512:
        _local_history_cache.clear()
    _local_history_cache[key] = (now, payload)

    return payload


@router.get('/history')
async def history(
    request: Request,
    page: int = 1
):
    """The device's own watch history: upstream /history is account-wide."""
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    payload = await _local_history_page(current, max(1, page))
    if payload is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    return payload


@router.post('/history/clear')
async def history_clear(
    request: Request
):
    """Wipe the device's local rows only — the shared account history stays."""
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    storage.clear_device_history(current.id)
    _drop_local_history_cache(current.id)
    # The «continue» rail on /home is built from the wiped rows.
    invalidate_home_cache(current.id)

    return {'ok': True}


@router.post('/watching/toggle')
async def watched_toggle(
    request: Request,
    body: WatchedToggle
):
    """Mark a title/episode watched or unwatched."""
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    params = {'id': body.id}
    if body.season is not None:
        params['season'] = body.season
    if body.episode is not None:
        params['video'] = body.episode

    result = await current.kp.api('/watching/toggle', params)
    if result is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    return {'ok': True}


@router.post('/subscription/toggle')
async def subscription_toggle(
    request: Request,
    body: SubscriptionToggle
):
    """Subscribe/unsubscribe a title in the «смотрю» list."""
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    result = await current.kp.api(
        '/watching/togglewatchlist',
        {'id': body.id}
    )
    if result is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    return {'ok': True}
