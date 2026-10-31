import asyncio
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

import viewmodels as vm
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

    await current.kp.api(
        '/bookmarks/create',
        {'title': body.title},
        method='POST'
    )

    return {'ok': True}


@router.post('/bookmarks/toggle')
async def bookmark_toggle(
    request: Request,
    body: BookmarkToggle
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    await current.kp.api(
        '/bookmarks/toggle-item',
        {
            'item': body.item,
            'folder': body.folder
        },
        method='POST'
    )

    result = await current.kp.api(
        '/bookmarks/get-item-folders',
        params={'item': body.item}
    )

    return {
        'ok': True,
        'bookmarks': [
            f.get('id')
            for f in (result or {}).get('folders', [])
        ]
    }


@router.get('/history')
async def history(
    request: Request,
    page: int = 1
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    result = await current.kp.api('/history', params={'page': page})
    if result is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    entries = []
    for entry in result.get('history', []):
        media = entry.get('media') or {}
        entries.append(
            vm.card(
                entry.get('item') or {},
                current.settings,
                media={
                    'season': media.get('snumber'),
                    'number': media.get('number'),
                    'title': media.get('title'),
                    'duration': media.get('duration'),
                    'time': entry.get('time'),
                }
            )
        )

    if page == 1:
        # /history only contains finished media; started-but-unfinished
        # movies/serials live in /watching, so merge them in.
        movies, serials = await asyncio.gather(
            current.kp.api('/watching/movies'),
            current.kp.api('/watching/serials', params={'subscribed': 0})
        )
        started = await browse_enrich(
            current.kp,
            (movies or {}).get('items', []) + (serials or {}).get('items', [])
        )
        seen = {i['id'] for i in started}
        entries = [
            vm.card(i, current.settings)
            for i in started
        ] + [
            i for i in entries if i['id'] not in seen
        ]

    pagination = result.get('pagination') or {}

    return {
        'items': entries,
        'page': pagination.get('current', page),
        'has_more': pagination.get('current', page) < pagination.get('total', page)
    }


async def browse_enrich(
    kp,
    items
):
    from routers.browse import _enrich

    return await _enrich(kp, items)


@router.post('/history/clear')
async def history_clear(
    request: Request
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    await current.kp.api('/watching/clearhistory', method='POST')

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

    await current.kp.api('/watching/toggle', params)

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

    await current.kp.api(
        '/watching/togglewatchlist',
        {'id': body.id}
    )

    return {'ok': True}
