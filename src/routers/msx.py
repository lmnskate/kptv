"""MSX adapter — thin bridge to the web client.

/msx/start.json is a self-referential content page (`parameter: content:{self}`)
with a single preselected `control` tile whose `link:` action opens the web
client. The root action is `[settings:validate_links:0|home]`, NOT `link:` —
MSX opens link targets via window.open, which the Tizen webview blocks
without a user gesture, so a root `link:` silently dies on TV. `/msx/menu`
is a compatibility shim for TVs whose MSX still carries the old start
parameter. No device id is passed: the client keeps its own uuid
(localStorage)."""

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

from config.settings import server

router = APIRouter(prefix='/msx', tags=['msx'])

CLIENT_URL = f'{server.base_url}/client/'
# Bump LOGO_VERSION whenever the icon file changes: TVs cache images
# aggressively, a new query string forces a fresh fetch everywhere.
LOGO_VERSION = '2'
LOGO_URL = f'{server.base_url}/msx/logo.svg?v={LOGO_VERSION}'
LOGO_PATH = Path(__file__).resolve().parent.parent / 'assets' / 'msx' / 'logo.svg'


@router.get('/start.json')
async def start():
    return {
        'name': 'KPTV',
        'version': '1.0.1',
        'parameter': f'content:{server.base_url}/msx/start.json',
        'action': '[settings:validate_links:0|home]',
        'preselect': True,
        'launcher': {
            'parameter': f'link:{CLIENT_URL}',
            'image': LOGO_URL,
            'color': '#0b111a',
        },
        'pages': [
            {
                'items': [
                    {
                        'type': 'control',
                        'layout': '4,2,4,2',
                        'image': LOGO_URL,
                        # MSX places `label` on the left of control tiles and
                        # offers no alignment for it; `title` honors
                        # `alignment`/`centration` — dead-center name over
                        # the logo. `imageOverlay: 0` keeps the auto
                        # darkening overlay off the logo.
                        'title': 'KPTV',
                        'alignment': 'center',
                        'centration': 'title',
                        'imageOverlay': 0,
                        'action': f'link:{CLIENT_URL}',
                    },
                ],
            },
        ],
    }


@router.get('/menu')
async def menu():
    return {
        'reuse': False,
        'cache': False,
        'restore': False,
        'headline': 'KPTV',
        'action': 'settings:validate_links:0',
        'menu': [
            {
                'type': 'default',
                'label': 'KPTV',
                'image': LOGO_URL,
                'data': f'{server.base_url}/msx/start.json',
            },
        ],
    }


@router.get('/logo.svg')
async def logo():
    return FileResponse(
        LOGO_PATH,
        media_type='image/svg+xml',
    )
