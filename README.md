<div align="center">

# KPTV

**Watch [KinoPub](https://kino.pub) on your Smart TV — own flagship web client
(Samsung Tizen, LG webOS) with a FastAPI backend**

![Python](https://img.shields.io/badge/Python-3.13-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-async-009688?logo=fastapi&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-embedded-003B57?logo=sqlite&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)

[Quick Start](#quick-start) •
[Management](#management) •
[Configuration](#configuration) •
[Security](#security) •
[Project Structure](#project-structure)

</div>

---

KPTV is a Smart TV client for KinoPub: a vanilla-JS SPA (`client/`) designed
for TV remotes, backed by a Python/FastAPI BFF (`src/`, all endpoints under
`/api/v1/*`). The server sits between the TV and the KinoPub API, so the pair
works in networks where KinoPub itself is not reachable — the TV only ever
talks to this server.

**Features**

- Home screen: hero title + rails (continue watching, new, popular, «смотрю»)
- Catalog: movies / serials as short rails, each capped by a «Смотреть все»
  card that opens a paginated poster grid
- Collections: a separate tab, paginated grid, drill into a collection's items
- Search with an on-screen RU/EN/digits keyboard
- Bookmarks (folders), history grouped one-card-per-title with progress bars
- Detail pages: seasons/episodes, similar titles, per-episode progress
- HLS player: quality / audio track / subtitles, ±10 s seek, next episode,
  resume where you left off (cross-device via KinoPub)
- Codec auto-negotiation: the browser reports its real HEVC support and
  KinoPub serves HEVC or AVC manifests accordingly — HEVC-only titles stay
  playable in browsers without hardware HEVC
- Per-device settings (UHD / HDR / HEVC / poster size) synced with KinoPub

Descendant of [slonopot/kp-msx](https://github.com/slonopot/kp-msx), fully
rewritten. `docs/api.md` is the API contract; `docs/kp-client-plan.md` is the
original phased plan (kept as historical context).

## Quick Start

Development (no Docker):

```bash
python -m venv .venv
.venv/bin/pip install -r src/requirements.txt
cp .env.example .env   # edit SERVER_HOST, KP_CLIENT_ID, KP_CLIENT_SECRET
.venv/bin/python src/main.py
```

Open `http://<SERVER_HOST>:<SERVER_PORT>/client/` in a browser, or
`curl http://localhost:1234/openapi.json` for a smoke check.
Requires Python 3.13+.

Production deployment is Docker Compose (below).

## Management

```bash
./kptv.sh start     # build and start the stack
./kptv.sh status    # stack status + the TV entry point
./kptv.sh logs      # follow logs (optionally: ./kptv.sh logs server)
./kptv.sh restart   # recreate containers, re-reading .env and conf/
./kptv.sh stop      # stop everything (data is kept)
./kptv.sh update    # rebuild the image from source and restart (after code changes)
./kptv.sh backup    # consistent DB backup into ./backups/ (safe on a live DB)
./kptv.sh shell     # shell inside the server container
```

The stack: `server` (FastAPI app, internal `:8000`) + `nginx` (public
`:1234`). State lives in `./data` (SQLite) and survives rebuilds and updates.
`conf/nginx.conf` and `client/` are bind-mounted — config and frontend
changes apply with `./kptv.sh restart`, no rebuild. Backend (image) changes
need `./kptv.sh update`.

## Configuration

Everything is read from environment variables / `.env`
(`src/config/settings.py` for the authoritative list).

Required:

- `SERVER_HOST` — IP or domain of your server, reachable from the TV; all
  absolute URLs handed to the client are built from it
- `KP_CLIENT_ID`, `KP_CLIENT_SECRET` — KinoPub OAuth app credentials,
  request from support@kino.pub

Commonly changed:

- `SERVER_PORT` — public port (default `1234`)
- `SERVER_SCHEME` — `http` (default) or `https` if TLS is terminated in front
- `KP_PROTOCOL` — preferred streaming protocol: `hls4` (default), `hls2`,
  `hls` or `http`; lower-priority protocols are used as fallback
- `KP_QUALITY` — target quality: `1080p` (default), `2160p`, `720p`, `480p`

Rarely needed (Docker overrides them): `SERVER_BIND_HOST`, `SERVER_BIND_PORT`,
`SERVER_SQLITE_URL` (defaults to `./data/kp-sqlite.db`), `SERVER_WORKERS`,
`SERVER_PROXY_HEADERS`.

## Security

- The device id (`X-Device-Id` header / `?id=` query param) **is** the
  credential: anyone who knows it controls the linked KinoPub account. Keep
  it private.
- `/api/v1/proxy` and `/api/v1/subtitle` are relays restricted to remembered
  KinoPub CDN domains (allowlist). Restrict access at the firewall level if
  that matters to you.
- CORS is wide open (`*`) because TV players require it — the device id is
  the only gate, treat it as a secret.
- `.env` holds the OAuth client credentials; device tokens live in the
  SQLite DB. Both are gitignored.

## Project Structure

```
src/                # App service: code + Dockerfile + requirements.txt (compose build context)
    main.py         # FastAPI app, middleware (device auth, compression)
    config/         # Settings (.env), upstream constants
    kinopub/        # Async KinoPub API client (raw dicts, token self-healing)
    devices/        # Device storage (SQLite), per-device settings
    services/       # Allowlist media proxy, HLS playlist rewriting
    routers/        # HTTP endpoints under /api/v1
    viewmodels.py   # Raw KinoPub dicts -> render-ready payloads
client/             # Smart TV SPA (vanilla ES5 JS, no build step)
    index.html
    css/ js/        # js/hls.min.js is vendored and lazy-loaded at first playback
docs/               # API contract + historical plan
conf/               # nginx config
data/               # SQLite DB (bind-mounted, gitignored)
backups/            # DB backups (gitignored)
kptv.sh             # Management script
docker-compose.yml  # server + nginx
```

## Acknowledgments

[slonopot/kp-msx](https://github.com/slonopot/kp-msx) ·
[Media Station X](https://msx.benzac.de/) ·
[hls.js](https://github.com/video-dev/hls.js)
