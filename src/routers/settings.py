from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

import config.globals as g
from devices.device import KP_SETTING_KEYS
from routers.browse import invalidate_home_cache
from routers.deps import error, registered

router = APIRouter(
    prefix='/api/v1',
    tags=['settings']
)


class SettingsPatch(BaseModel):
    uhd: Optional[bool] = None
    hdr: Optional[bool] = None
    hevc: Optional[bool] = None
    poster_size: Optional[str] = None


@router.get('/settings')
async def settings_get(
    request: Request
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    account = await current.kp.api('/user')

    return {
        'settings': current.settings.to_dict(),
        'account': (account or {}).get('user'),
        # Shown in the client settings screen (about line).
        'version': g.APP_VERSION,
    }


@router.post('/settings')
async def settings_update(
    request: Request,
    patch: SettingsPatch
):
    current = registered(request)
    if current is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    changed_kp = []
    for attr in KP_SETTING_KEYS:
        value = getattr(patch, attr)
        if value is None:
            continue
        setattr(current.settings, attr, value)
        changed_kp.append(attr)
    if patch.poster_size is not None:
        current.settings.poster_size = patch.poster_size

    current.update_settings()
    # Poster size changes the shaped cards of the cached /home payload.
    invalidate_home_cache(current.id)

    if changed_kp:
        await current.sync_settings_to_kp(changed_kp)

    return {'settings': current.settings.to_dict()}
