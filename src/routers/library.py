import asyncio
import time
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

import viewmodels as vm
from routers.browse import _enrich
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


HISTORY_GROUPS_PER_PAGE = 30
# Safety net against enormous histories: the aggregation reads every page,
# which is bounded fan-out but still one upstream request per page.
HISTORY_MAX_PAGES = 50
HISTORY_FETCH_CONCURRENCY = 4
# The client sweeps pages sequentially right after opening the screen; the
# aggregate is expensive (all upstream history pages), so serve the sweep
# from a short per-device cache instead of re-fetching per page request.
_HISTORY_CACHE_TTL = 10
_history_cache: dict = {}


async def _history_pages(
    kp
):
    """All /history pages, newest first, with bounded concurrency. None when
    the first page fails (callers translate that to a 502)."""
    first = await kp.api('/history', params={'page': 1})
    if first is None:
        return None

    pages = [first]
    try:
        total = int((first.get('pagination') or {}).get('total') or 1)
    except (TypeError, ValueError):
        total = 1
    total = max(1, min(total, HISTORY_MAX_PAGES))

    if total > 1:
        semaphore = asyncio.Semaphore(HISTORY_FETCH_CONCURRENCY)

        async def _get(page):
            async with semaphore:
                return await kp.api('/history', params={'page': page})

        pages.extend(await asyncio.gather(*[_get(p) for p in range(2, total + 1)]))

    return pages


def _history_card(
    entry,
    settings
):
    """View-model of one viewing event: the event's own item/media dicts are
    full-fledged, and the newest event of a title is its resume point."""
    media = entry.get('media') or {}
    pct = vm.progress_pct(media.get('duration'), entry.get('time'))

    card = vm.card(entry.get('item') or {}, settings)
    # snumber is 0 for movies — keep it, multi-video movies use `number`.
    if media.get('snumber') is not None:
        card['media'] = {
            'season': media.get('snumber'),
            'number': media.get('number'),
            'title': media.get('title'),
        }
    if pct:
        card['progress'] = pct
    card['in_progress'] = 0 < pct < 100

    return card


def _history_groups(
    pages,
    settings
):
    """Group viewing events by title: one card per title. The newest event
    (max last_seen) defines recency, the subtitle and the progress bar, so a
    serial binged over a month renders as a single «Season · Episode» card
    instead of a screenful of per-episode rows. Entries arrive newest-first,
    but compare stamps anyway — ties keep first-seen order (stable sort)."""
    seen = set()
    groups: dict = {}
    order = []

    for page in pages:
        if not page:
            continue
        for entry in page.get('history') or []:
            # `counter` is a per-item view counter, NOT a unique event id —
            # it collides across items and even across episodes; identify an
            # event by item + media + timestamp instead. Clamped out-of-range
            # pages repeat the last page when the history shrinks mid-fetch,
            # the triple dedupes those repeats.
            media = entry.get('media') or {}
            key = (
                (entry.get('item') or {}).get('id'),
                media.get('id'),
                entry.get('last_seen')
            )
            if key in seen:
                continue
            seen.add(key)

            item = entry.get('item') or {}
            item_id = item.get('id')
            if item_id is None:
                continue
            stamp = entry.get('last_seen') or 0

            group = groups.get(item_id)
            if group is not None and stamp < group['stamp']:
                continue

            card = _history_card(entry, settings)
            card['watched_at'] = stamp
            if group is None:
                group = {'idx': len(order), 'card': card, 'stamp': stamp}
                order.append(item_id)
                groups[item_id] = group
            else:
                group['card'] = card
                group['stamp'] = stamp

    ordered = sorted(
        groups.values(),
        key=lambda g: (-g['stamp'], g['idx'])
    )

    return [g['card'] for g in ordered]


async def _history(
    current
):
    """The full history as one flat, recency-sorted card list (see the
    /history route). None when KinoPub is unreachable."""
    now = time.monotonic()
    cached = _history_cache.get(current.id)
    if cached is not None and now - cached[0] < _HISTORY_CACHE_TTL:
        return cached[1]

    kp = current.kp
    pages, movies, serials = await asyncio.gather(
        _history_pages(kp),
        kp.api('/watching/movies'),
        kp.api('/watching/serials', params={'subscribed': 0})
    )
    if pages is None:
        return None

    settings = current.settings
    cards = _history_groups(pages, settings)

    # Started titles carry no recency stamp upstream, so they cannot join the
    # chronological sort — they sit on top in KinoPub's own order. In
    # practice nearly every started title also has history events (that's
    # where its position lives), making this a rare edge case.
    known = {c['id'] for c in cards}
    started = [
        i for i in ((movies or {}).get('items') or []) + ((serials or {}).get('items') or [])
        if i.get('id') not in known
    ]
    if started:
        started = await _enrich(kp, started)
        started_cards = []
        for item in started:
            card = vm.card(item, settings)
            card['in_progress'] = True
            playable = vm.pick_playable(item)
            if playable is not None:
                position = (playable.get('watching') or {}).get('time') or 0
                pct = vm.progress_pct(playable.get('duration'), position)
                if playable.get('season') is not None:
                    card['media'] = {
                        'season': playable.get('season'),
                        'number': playable.get('number'),
                        'title': playable.get('title'),
                    }
                if pct:
                    card['progress'] = pct
            started_cards.append(card)
        cards = started_cards + cards

    _history_cache[current.id] = (now, cards)

    return cards


@router.get('/history')
async def history(
    request: Request,
    page: int = 1
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    cards = await _history(current)
    if cards is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    page = max(1, page)
    start = (page - 1) * HISTORY_GROUPS_PER_PAGE

    return {
        'items': cards[start:start + HISTORY_GROUPS_PER_PAGE],
        'page': page,
        'has_more': start + HISTORY_GROUPS_PER_PAGE < len(cards)
    }


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
