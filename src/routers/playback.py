from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

import viewmodels as vm
from devices import storage
from routers.deps import error, registered

router = APIRouter(
    prefix='/api/v1',
    tags=['playback']
)


class ProgressReport(BaseModel):
    id: int
    time: int
    season: Optional[int] = None
    episode: Optional[int] = None


# Last supportHevc value pushed to KinoPub per device, so /play does not
# POST the device settings on every single playback.
_hevc_synced = {}


async def _match_hevc_upstream(
    current,
    hevc
):
    """KinoPub generates HEVC or AVC manifests based on the device capability
    flag, so align it with what the client browser can actually decode.
    The new value is persisted locally too: the in-process memo only skips
    the upstream POST, it must not be the only place the flag lives."""
    if _hevc_synced.get(current.id) == hevc:
        return

    # The memo is per-process; guard against unbounded growth if ids churn.
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
    """Resolve a title to a playable stream: picks the episode/video (explicit
    or first unfinished), chooses the best file by quality/protocol, and
    returns proxied URLs plus subtitles (WebVTT via /api/v1/subtitle)."""
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

    info = vm.playable_info(item, playable)
    # Per-device resume: the local row knows where THIS device stopped.
    local_position = storage.get_device_history_position(
        current.id,
        content_id,
        playable.get('season'),
        playable.get('number')
    )
    if local_position:
        info['position'] = local_position

    return info


@router.post('/progress')
async def progress(
    request: Request,
    body: ProgressReport
):
    """Cross-device resume: report the playback position."""
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
        0
    )

    return {'ok': True}
