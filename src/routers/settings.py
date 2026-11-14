from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

from devices.device import KP_SETTING_KEYS
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

    if changed_kp:
        await current.sync_settings_to_kp(changed_kp)

    return {'settings': current.settings.to_dict()}
