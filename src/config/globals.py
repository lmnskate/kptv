import aiohttp

# Single source for the app version: surfaced in the FastAPI/Swagger title,
# the MSX start page, the client settings screen and the admin tooling.
APP_VERSION = '1.8.1'

# KinoPub API
BASE_URL = 'https://api.service-kp.com/v1'
OAUTH_URL = 'https://api.service-kp.com/oauth2/device'
OAUTH_REFRESH_URL = 'https://api.service-kp.com/oauth2/token'
TIMEOUT = aiohttp.ClientTimeout(total=15)

# Preferred stream protocols in fallback order (adaptive HLS first)
PROTOCOL_PRIORITY = ['hls4', 'hls2', 'hls', 'http']

# Known quality labels ordered by ascending resolution
QUALITY_ORDER = ['480p', '720p', '1080p', '2160p']
