import aiohttp

APP_VERSION = '1.10.0'

BASE_URL = 'https://api.service-kp.com/v1'
OAUTH_URL = 'https://api.service-kp.com/oauth2/device'
OAUTH_REFRESH_URL = 'https://api.service-kp.com/oauth2/token'
TIMEOUT = aiohttp.ClientTimeout(total=15)

PROTOCOL_PRIORITY = ['hls4', 'hls2', 'hls', 'http']

QUALITY_ORDER = ['480p', '720p', '1080p', '2160p']
