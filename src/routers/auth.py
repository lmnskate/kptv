import re
from io import BytesIO

import qrcode
import qrcode.image.svg
from fastapi import APIRouter, Request
from starlette.responses import Response

from devices import storage
from devices.device import Device
from kinopub.client import KinoPub
from routers.deps import device, error

router = APIRouter(
    prefix='/api/v1/auth',
    tags=['auth']
)

QR_CODE_PATTERN = re.compile(r'^[0-9A-Za-z]{4,8}$')


@router.post('/code')
async def auth_code(
    request: Request
):
    """Start the KinoPub device-code flow: returns a short user code to enter
    at kino.pub (or scan via qr.svg)."""
    current = device(request)
    if current is None:
        return error(400, 'no_device', 'Не передан идентификатор устройства')

    if storage.get_device_by_id(current.id) is None:
        current = Device.create(current.id)
        request.state.device = current

    if current.registered():
        return error(409, 'already_registered', 'Устройство уже активировано')

    codes = await KinoPub.get_codes()
    if codes is None:
        return error(502, 'upstream', 'Сервис авторизации недоступен')

    user_code, device_code = codes
    current.update_code(device_code)

    return {'user_code': user_code}


@router.get('/poll')
async def auth_poll(
    request: Request
):
    """Poll until the user activates the code; stores tokens when done."""
    current = device(request)
    if current is None or current.code is None:
        return error(400, 'no_code', 'Сначала запросите код активации')

    result = await KinoPub.check_registration(current.code)
    if result is None:
        return {'status': 'pending'}
    if 'error' in result:
        # Activation failed for good (bad code / expired) — drop the stale
        # code so the next /code request starts a fresh flow.
        current.update_code(None)

        return error(
            410,
            'activation_expired',
            'Код активации истёк или отклонён — запросите новый'
        )

    await current.update_tokens(
        result['access_token'],
        result['refresh_token']
    )
    await current.notify()

    return {'status': 'active'}


@router.get('/qr.svg')
async def auth_qr(
    code: str
):
    """QR for phone scanning: opens the KinoPub device-linking page with the
    activation code prefilled. Unauthenticated by design — it only encodes a
    caller-supplied, regex-validated string."""
    if not QR_CODE_PATTERN.match(code):
        return error(400, 'bad_code', 'Некорректный код')

    img = qrcode.make(
        f'https://kino.pub/device?code={code}',
        image_factory=qrcode.image.svg.SvgImage,
        box_size=8,
        border=2
    )
    buf = BytesIO()
    img.save(buf)

    return Response(
        buf.getvalue(),
        media_type='image/svg+xml'
    )
