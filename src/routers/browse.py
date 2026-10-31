import asyncio
from typing import Optional

from fastapi import APIRouter, Request

import viewmodels as vm
from routers.deps import error, registered
from services import proxy

router = APIRouter(
    prefix='/api/v1',
    tags=['browse']
)


async def _enrich(
    kp,
    items
):
    """/watching/* entries are shallow (no year/rating/plot), so swap them
    for the full items; keep the shallow one when the request fails. The
    new-episode counter (`new`) only exists on the shallow /watching/serials
    entries, so carry it over onto the full item."""
    detailed = await asyncio.gather(*[
        kp.api(f'/items/{i["id"]}', params={'nolinks': 1})
        for i in items
    ])

    result = []
    for shallow, full in zip(items, detailed):
        if full is None or 'item' not in full:
            result.append(shallow)
        else:
            item = full['item']
            if item.get('new') is None and shallow.get('new') is not None:
                item['new'] = shallow['new']
            result.append(item)

    return result


def _paged(
    result,
    page
):
    pagination = (result or {}).get('pagination') or {}

    return {
        'items': result.get('items', []) if result else [],
        'page': pagination.get('current', page),
        'has_more': pagination.get('current', page) < pagination.get('total', page)
    }


@router.get('/home')
async def home(
    request: Request
):
    """The landing screen: rails for resume, fresh, popular and
    the «смотрю» list, already shaped for rendering."""
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    kp = current.kp

    # /items/fresh and /items/popular require the mandatory `type` parameter,
    # so both are fetched (movies + serials) and merged.
    movies, serials, fresh_movies, fresh_serials, popular_movies, popular_serials, subscribed = await asyncio.gather(
        kp.api('/watching/movies'),
        kp.api('/watching/serials', params={'subscribed': 0}),
        kp.api('/items/fresh', params={'type': 'movie'}),
        kp.api('/items/fresh', params={'type': 'serial'}),
        kp.api('/items/popular', params={'type': 'movie'}),
        kp.api('/items/popular', params={'type': 'serial'}),
        kp.api('/watching/serials', params={'subscribed': 1})
    )

    continue_items = await _enrich(
        kp,
        (movies or {}).get('items', []) + (serials or {}).get('items', [])
    )
    fresh = (fresh_movies or {}).get('items', []) + (fresh_serials or {}).get('items', [])
    popular = (popular_movies or {}).get('items', []) + (popular_serials or {}).get('items', [])

    settings = current.settings
    rails = []
    if continue_items:
        rails.append({
            'id': 'continue',
            'title': 'Продолжить просмотр',
            'items': [vm.card(i, settings) for i in continue_items]
        })
    if fresh:
        rails.append({
            'id': 'fresh',
            'title': 'Новинки',
            'items': [vm.card(i, settings) for i in fresh]
        })
    if popular:
        rails.append({
            'id': 'popular',
            'title': 'Популярное',
            'items': [vm.card(i, settings) for i in popular]
        })
    subscribed_items = (subscribed or {}).get('items') or []
    if subscribed_items:
        rails.append({
            'id': 'watching',
            'title': 'Смотрю',
            'items': [vm.card(i, settings) for i in subscribed_items]
        })

    return {'rails': rails}


@router.get('/catalog')
async def catalog(
    request: Request,
    type: Optional[str] = None,
    genre: Optional[str] = None,
    country: Optional[str] = None,
    sort: Optional[str] = None,
    section: Optional[str] = None,
    page: int = 1
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    if section is not None and section not in ('fresh', 'popular'):
        return error(400, 'bad_section', 'Неизвестный раздел каталога')
    if section is not None and not type:
        return error(400, 'bad_request', 'Для раздела каталога нужен параметр type')

    params = {'page': page}
    if type:
        params['type'] = type
    if genre:
        params['genre'] = genre
    if country:
        params['country'] = country
    if sort:
        params['sort'] = sort

    path = f'/items/{section}' if section else '/items'
    result = await current.kp.api(path, params=params)
    if result is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    if current.kp.page_out_of_range(result, page):
        result['items'] = []

    paged = _paged(result, page)
    paged['items'] = [vm.card(i, current.settings) for i in paged['items']]

    return paged


@router.get('/search')
async def search(
    request: Request,
    q: str,
    page: int = 1
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    result = await current.kp.api(
        '/items/search',
        params={'q': q, 'page': page}
    )
    if result is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    if current.kp.page_out_of_range(result, page):
        result['items'] = []

    paged = _paged(result, page)
    paged['items'] = [vm.card(i, current.settings) for i in paged['items']]

    return paged


@router.get('/filters')
async def filters(
    request: Request
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    types, genres, countries = await asyncio.gather(
        current.kp.api('/types'),
        current.kp.api('/genres'),
        current.kp.api('/countries')
    )

    # The docs show these endpoints returning bare arrays, but the live API
    # has been seen wrapping them as {'items': [...]} — accept both.
    def _items(result):
        if isinstance(result, list):
            entries = result
        else:
            entries = (result or {}).get('items', [])
        return [
            {'id': i.get('id'), 'title': i.get('title')}
            for i in entries
        ]

    return {
        'types': _items(types),
        'genres': _items(genres),
        'countries': _items(countries),
    }


def _seasons_view(
    item
):
    seasons = []
    for season in item.get('seasons') or []:
        episodes = []
        for episode in season.get('episodes') or []:
            watching = episode.get('watching') or {}
            watched = episode.get('watched') == 1
            episodes.append({
                'n': episode.get('number'),
                'title': episode.get('title'),
                'duration': episode.get('duration'),
                'position': watching.get('time') or 0,
                'progress': vm.progress_pct(episode.get('duration'), watching.get('time')),
                'watched': watched,
                'thumbnail': proxy.make_proxy_url(episode['thumbnail']) if episode.get('thumbnail') else None,
            })
        seasons.append({
            'n': season.get('number'),
            'episodes': episodes,
        })

    return seasons


def _videos_view(
    item
):
    videos = []
    for video in item.get('videos') or []:
        watching = video.get('watching') or {}
        watched = video.get('watched') == 1
        videos.append({
            'number': video.get('number'),
            'title': video.get('title'),
            'duration': video.get('duration'),
            'position': watching.get('time') or 0,
            'progress': vm.progress_pct(video.get('duration'), watching.get('time')),
            'watched': watched,
            'thumbnail': proxy.make_proxy_url(video['thumbnail']) if video.get('thumbnail') else None,
        })

    return videos


@router.get('/items/{content_id}')
async def item_detail(
    request: Request,
    content_id: int
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    result = await current.kp.api(f'/items/{content_id}')
    if result is None or 'item' not in result:
        return error(404, 'not_found', 'Ничего не нашлось')

    item = result['item']
    settings = current.settings

    folders, similar, item_folders = await asyncio.gather(
        current.kp.api('/bookmarks'),
        current.kp.api('/items/similar', params={'id': content_id}),
        current.kp.api('/bookmarks/get-item-folders', params={'item': content_id})
    )

    # item['bookmarks'] is undocumented; get-item-folders is the documented
    # source — use it when the item itself doesn't carry the folders.
    in_folders = item.get('bookmarks')
    if in_folders is None:
        in_folders = (item_folders or {}).get('folders') or []

    detail = vm.card(item, settings)
    detail.update({
        'plot': item.get('plot'),
        'voice': item.get('voice'),
        'cast': item.get('cast'),
        'subscribed': item.get('subscribed') == 1,
        'bookmarks': [
            f.get('id')
            for f in in_folders
            if isinstance(f, dict)
        ],
        'bookmark_folders': [
            {'id': f.get('id'), 'title': f.get('title')}
            for f in (folders or {}).get('items', [])
        ],
        'similar': [
            vm.card(i, settings)
            for i in (similar or {}).get('items', [])
        ],
    })

    if item.get('videos') is not None:
        detail['videos'] = _videos_view(item)
    if item.get('seasons') is not None:
        detail['seasons'] = _seasons_view(item)

    return detail


@router.get('/collections')
async def collections(
    request: Request,
    page: int = 1
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    result = await current.kp.api('/collections', params={'page': page})
    if result is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    return {
        'items': [
            {
                'id': c.get('id'),
                'title': c.get('title'),
                'poster': vm.poster_url(c, current.settings),
            }
            for c in result.get('items', [])
        ],
        'page': (result.get('pagination') or {}).get('current', page),
        'has_more': (result.get('pagination') or {}).get('current', page) < (result.get('pagination') or {}).get('total', page),
    }


@router.get('/collections/{collection_id}')
async def collection_items(
    request: Request,
    collection_id: int
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    result = await current.kp.api(
        '/collections/view',
        params={'id': collection_id}
    )
    if result is None:
        return error(502, 'upstream', 'KinoPub недоступен')

    return {
        'items': [
            vm.card(i, current.settings)
            for i in result.get('items', [])
        ]
    }
