from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

import viewmodels as vm
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
    flag, so align it with what the client browser can actually decode."""
    if _hevc_synced.get(current.id) == hevc:
        return

    current.settings.hevc = hevc
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

    return vm.playable_info(item, playable)


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

    return {'ok': True}
