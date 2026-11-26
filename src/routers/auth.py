import re
import time
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

# POST /code is internet-facing and creates a DB row + an upstream OAuth call
# per request — bound the damage from scripts poking the endpoint. The QR
# endpoint renders on demand too, so it gets its own bucket.
CODE_RATE_LIMIT = 5
CODE_RATE_WINDOW = 600
_code_requests: dict = {}
_qr_requests: dict = {}


def _rate_limit_exceeded(
    store,
    key
):
    now = time.monotonic()
    window = [
        stamp for stamp in store.get(key, [])
        if now - stamp < CODE_RATE_WINDOW
    ]
    if window:
        store[key] = window
    else:
        # Drop empty windows so idle keys don't pile up forever.
        store.pop(key, None)
    if len(store) > 1024:
        # Evict the least-recently-active keys — clearing everything would
        # also forgive an attacker mid-burst.
        stale = sorted(store, key=lambda k: store[k][-1])[:len(store) - 1024]
        for k in stale:
            del store[k]

    if len(window) >= CODE_RATE_LIMIT:
        return True
    window.append(now)
    store[key] = window

    return False


@router.post('/code')
async def auth_code(
    request: Request
):
    """Start the KinoPub device-code flow: returns a short user code to enter
    at kino.pub (or scan via qr.svg)."""
    current = device(request)
    if current is None:
        return error(400, 'no_device', 'Не передан идентификатор устройства')

    client_host = request.client.host if request.client else 'unknown'
    if _rate_limit_exceeded(_code_requests, client_host):
        return error(429, 'rate_limited', 'Слишком много запросов — попробуйте позже')

    # The import-time GC only runs at startup; prune unactivated registration
    # rows here too so a long-lived process doesn't accumulate them.
    storage.cleanup_stale_devices()

    if storage.get_device_by_id(current.id) is None:
        current = Device.create(current.id)
        request.state.device = current

    if current.registered():
        return error(409, 'already_registered', 'Устройство уже активировано')

    codes = await KinoPub.get_codes()
    if codes is None:
        return error(502, 'upstream', 'Сервис авторизации недоступен')

    user_code, device_code, expires_in = codes
    current.update_code(device_code)

    return {'user_code': user_code, 'expires_in': expires_in}


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
    # The device code is single-use; drop it so a later poll can't replay
    # the activation flow on an already-registered device.
    current.update_code(None)
    await current.notify()

    return {'status': 'active'}


@router.get('/qr.svg')
async def auth_qr(
    request: Request,
    code: str
):
    """QR for phone scanning: opens the KinoPub device-linking page with the
    activation code prefilled. Unauthenticated by design — it only encodes a
    caller-supplied, regex-validated string."""
    if not QR_CODE_PATTERN.match(code):
        return error(400, 'bad_code', 'Некорректный код')

    client_host = request.client.host if request.client else 'unknown'
    if _rate_limit_exceeded(_qr_requests, client_host):
        return error(429, 'rate_limited', 'Слишком много запросов — попробуйте позже')

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
