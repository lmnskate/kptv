from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

import viewmodels as vm
from devices import storage
from routers.browse import invalidate_home_cache
from routers.deps import error, registered
from routers.library import _drop_local_history_cache

router = APIRouter(
    prefix='/api/v1',
    tags=['playback']
)


class ProgressReport(BaseModel):
    id: int
    time: int
    season: Optional[int] = None
    episode: Optional[int] = None
    duration: Optional[int] = None


_hevc_synced = {}


async def _match_hevc_upstream(
    current,
    hevc
):
    if _hevc_synced.get(current.id) == hevc:
        return

    if len(_hevc_synced) > 256:
        _hevc_synced.clear()

    current.settings.hevc = hevc
    current.update_settings()
    await current.sync_settings_to_kp(['hevc'])
    _hevc_synced[current.id] = hevc


@router.get('/play/{content_id}')
async def play(
    request: Request,
    content_id: int,
    season: Optional[int] = None,
    episode: Optional[int] = None,
    hevc: Optional[bool] = None
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    if hevc is not None:
        await _match_hevc_upstream(
            current,
            hevc
        )

    result = await current.kp.api(f'/items/{content_id}')
    if result is None or 'item' not in result:
        return error(404, 'not_found', 'Ничего не нашлось')

    item = result['item']
    playable = vm.pick_playable(
        item,
        season=season,
        episode=episode
    )
    if playable is None or not vm.stream_url(playable):
        return error(404, 'no_video', 'Видео недоступно')

    storage.touch_device_history(
        current.id,
        content_id,
        playable.get('season'),
        playable.get('number'),
        (playable.get('watching') or {}).get('time') or 0,
        playable.get('duration') or 0
    )
    invalidate_home_cache(current.id)
    _drop_local_history_cache(current.id)

    info = vm.playable_info(item, playable)
    local_position = storage.get_device_history_position(
        current.id,
        content_id,
        playable.get('season'),
        playable.get('number')
    )
    if local_position:
        duration = playable.get('duration') or 0
        if duration and vm.progress_pct(duration, local_position) >= 95:
            local_position = 0
        info['position'] = local_position

    return info


@router.post('/progress')
async def progress(
    request: Request,
    body: ProgressReport
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    params = {'id': body.id, 'time': body.time}
    if body.season is not None:
        params['season'] = body.season
    if body.episode is not None:
        params['video'] = body.episode

    await current.kp.api('/watching/marktime', params)
    storage.record_device_history(
        current.id,
        body.id,
        body.season,
        body.episode,
        body.time,
        body.duration or 0
    )
    invalidate_home_cache(current.id)
    _drop_local_history_cache(current.id)

    return {'ok': True}
