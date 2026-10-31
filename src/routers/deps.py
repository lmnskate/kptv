"""Shared router helpers: device access and the unified error format."""

from fastapi import Request
from starlette.responses import JSONResponse


def error(
    status,
    code,
    message
):
    return JSONResponse(
        {'error': {'code': code, 'message': message}},
        status_code=status
    )


def device(
    request: Request
):
    return request.state.device


def registered(
    request: Request
):
    current = device(request)
    if current is None:
        return None

    return current if current.registered() else None
