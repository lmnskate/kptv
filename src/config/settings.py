from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# Project root: src/config/settings.py -> src/config -> src -> root
_PROJECT_ROOT = Path(__file__).resolve().parents[2]

_ENV_FILE_PATH = _PROJECT_ROOT / '.env'
_DEFAULT_SQLITE_URL = str(_PROJECT_ROOT / 'data' / 'kp-sqlite.db')


class ServerSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE_PATH,
        env_prefix='SERVER_',
        extra='ignore'
    )

    host: str
    port: int = 1234
    scheme: Literal['http', 'https'] = 'http'
    sqlite_url: str = _DEFAULT_SQLITE_URL
    # Where uvicorn actually listens (the Docker setup overrides both).
    bind_host: str = '0.0.0.0'
    bind_port: int | None = None
    workers: int = 1
    proxy_headers: bool = False

    @property
    def base_url(
        self
    ) -> str:
        if self.port in (80, 443):
            return f'{self.scheme}://{self.host}'

        return f'{self.scheme}://{self.host}:{self.port}'


class KPSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE_PATH,
        env_prefix='KP_',
        extra='ignore'
    )

    client_id: str
    client_secret: str
    protocol: Literal['hls', 'hls2', 'hls4', 'http'] = 'hls4'
    quality: Literal['2160p', '1080p', '720p', '480p'] = '1080p'


server = ServerSettings()
kp = KPSettings()
