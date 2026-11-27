import asyncio
import logging

import aiohttp
from fastapi import APIRouter
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

from routers.deps import error, registered
from services import proxy

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix='/api/v1',
    tags=['media']
)



@router.head('/proxy')
async def proxy_head(
    request: Request
):
    if registered(request) is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    url = request.query_params.get('url')
    if not url:
        return Response(
            status_code=400
        )

    try:
        proxy.check_url(url)
    except proxy.UnknownDomainError:
        logger.warning('Proxy HEAD request to unknown domain: %.200s', url)
        return Response(
            status_code=403
        )

    try:
        code, content_type, response_headers = await proxy.head(
            url,
            client_headers=request.headers
        )
    except proxy.UnknownDomainError:
        logger.warning('Proxy HEAD refused redirect for: %.200s', url)
        return Response(
            status_code=502
        )
    except (aiohttp.ClientError, asyncio.TimeoutError):
        logger.warning('Proxy upstream HEAD request failed: %.200s', url)
        return Response(
            status_code=502
        )

    return Response(
        status_code=code,
        media_type=content_type,
        headers=response_headers
    )


@router.get('/proxy')
async def proxy_request(
    request: Request
):
    if registered(request) is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    url = request.query_params.get('url')
    if not url:
        return Response(
            status_code=400
        )

    try:
        proxy.check_url(url)
    except proxy.UnknownDomainError:
        logger.warning('Proxy request to unknown domain: %.200s', url)
        return Response(
            status_code=403
        )

    try:
        code, content_type, response_headers, contents = await proxy.get(
            url,
            audio_name=request.query_params.get('audio'),
            client_headers=request.headers
        )
    except proxy.UnknownDomainError:
        logger.warning('Proxy refused redirect for: %.200s', url)
        return Response(
            status_code=502
        )
    except (aiohttp.ClientError, asyncio.TimeoutError):
        logger.warning('Proxy upstream request failed: %.200s', url)
        return Response(
            status_code=502
        )

    if isinstance(contents, bytes):
        return Response(
            contents,
            code,
            media_type=content_type,
            headers=response_headers
        )

    return StreamingResponse(
        contents,
        status_code=code,
        media_type=content_type,
        headers=response_headers
    )


@router.get('/subtitle')
async def subtitle_request(
    request: Request
):
    if registered(request) is None:
        return error(401, 'not_registered', 'Устройство не активировано')

    url = request.query_params.get('url')
    if not url:
        return Response(
            status_code=400
        )

    try:
        proxy.check_url(url)
    except proxy.UnknownDomainError:
        logger.warning('Subtitle request to unknown domain: %.200s', url)
        return Response(
            status_code=403
        )

    try:
        code, content_type, contents = await proxy.get_subtitle(url)
    except proxy.UnknownDomainError:
        logger.warning('Subtitle refused redirect for: %.200s', url)
        return Response(
            status_code=502
        )
    except (aiohttp.ClientError, asyncio.TimeoutError):
        logger.warning('Subtitle upstream request failed: %.200s', url)
        return Response(
            status_code=502
        )

    return Response(
        contents,
        code,
        media_type=content_type
    )
