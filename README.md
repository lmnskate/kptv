<div align="center">

# KPTV

**Watch [KinoPub](https://kino.pub) on your Smart TV — own flagship web client
(Samsung Tizen, LG webOS) with a FastAPI backend**

![Python](https://img.shields.io/badge/Python-3.13-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-async-009688?logo=fastapi&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-embedded-003B57?logo=sqlite&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Version](https://img.shields.io/badge/version-1.0.0-e8b339)

[Quick Start](#quick-start) •
[Connecting a TV](#connecting-a-tv) •
[Management](#management) •
[Configuration](#configuration) •
[Moving to a New Server](#moving-to-a-new-server) •
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
- Collections, search with an on-screen RU/EN keyboard, bookmark folders,
  history grouped per title with progress bars
- Detail pages: seasons/episodes, similar titles, per-episode progress
- HLS player: quality / audio track / subtitles, ±10 s seek, next episode,
  resume where you left off (cross-device via KinoPub)
- Codec auto-negotiation: the browser reports its real HEVC support and
  KinoPub serves HEVC or AVC manifests accordingly
- Per-device settings (UHD / HDR / HEVC) synced with KinoPub
- Relaunch button in settings: restarts the client and clears its caches

Descendant of [slonopot/kp-msx](https://github.com/slonopot/kp-msx), fully
rewritten. The API contract (upstream KinoPub + KPTV `/api/v1/*`) and the
project notes live in `AGENTS.md`; `docs/kp-client-plan.md` is the retired
original phased plan (historical context).

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

Production deployment is Docker Compose (see [Management](#management)) and
speaks **HTTPS only** — see [Domain and TLS](#domain-and-tls).

## Connecting a TV

**Media Station X (recommended on Tizen).** Point the MSX start parameter at
the server — MSX → Settings → Start Parameter →
`https://<your-domain>/msx/start.json`. Opening MSX lands on the start page
with the KPTV tile already focused; one OK press opens the client fullscreen.
Auto-opening without a keypress is not possible on Tizen (MSX opens `link:`
targets via `window.open`, which the TV webview blocks without a user
gesture). See `src/routers/msx.py` for how the start page is built.

**TV browser.** Open `https://<your-domain>/client/` in the TV's built-in
browser.

The client asks for activation (code + QR) the first time; the device identity
is kept in localStorage.

## Management

```bash
./kptv.sh install   # build/pull the images, prepare the data dirs (creates .env to edit)
./kptv.sh start     # start the stack (requires: install + a certificate)
./kptv.sh restart   # recreate containers, re-reading .env and conf/
./kptv.sh status    # container status (state, health, uptime, ports)
./kptv.sh stop      # stop everything (data is kept)
./kptv.sh backup    # consistent DB backup into ./backups/ (safe on a live DB)
./kptv.sh admin     # device management — list / export / import (run it for help)
```

The stack: `server` (FastAPI app, internal `:8000`) + `nginx` (public `:443`
with TLS; `:80` only redirects to https). State
lives in `./data` (SQLite) and survives rebuilds and updates.
`conf/` and `client/` are bind-mounted — config and frontend changes apply
with `./kptv.sh restart`, no rebuild. Backend (image) changes need a rebuild:
run `./kptv.sh install` again (it is idempotent).

`./kptv.sh admin` is a small command tree of its own:

```bash
./kptv.sh admin list            # table of registered devices
./kptv.sh admin export FILE     # dump the device DB (incl. tokens) to FILE
./kptv.sh admin import FILE     # replace the device DB with FILE (restarts the stack)
```

## Configuration

Everything is read from environment variables / `.env`
(`src/config/settings.py` for the authoritative list).

Required:

- `SERVER_HOST` — domain name of your server, reachable from the TV; all
  absolute URLs handed to the client are built from it, and the TLS
  certificate must be issued for this exact name. The deployment is
  HTTPS-only, so an IP will not do here — see below for a free domain.
- `KP_CLIENT_ID`, `KP_CLIENT_SECRET` — KinoPub OAuth app credentials,
  request from support@kino.pub

Preset for the Docker deployment (change only if you deviate from the
defaults):

- `SERVER_PORT` — `443`
- `SERVER_SCHEME` — `https`

Commonly changed:

- `KP_PROTOCOL` — preferred streaming protocol: `hls4` (default), `hls2`,
  `hls` or `http`; lower-priority protocols are used as fallback
- `KP_QUALITY` — target quality: `1080p` (default), `2160p`, `720p`, `480p`

Rarely needed (Docker overrides them): `SERVER_BIND_HOST`, `SERVER_BIND_PORT`,
`SERVER_SQLITE_URL` (defaults to `./data/kp-sqlite.db`), `SERVER_WORKERS`,
`SERVER_PROXY_HEADERS`. Port overrides if 80/443 are taken on the host:
`KPTV_HTTP_PORT`, `KPTV_HTTPS_PORT` (compose only).

### Domain and TLS

The Docker deployment speaks HTTPS only: nginx serves the app on `:443` and
refuses to start without a certificate — `./kptv.sh start` checks for it and
prints the exact command to issue one. Port 80 only redirects to https.

**Getting a domain.** Any domain works; a free one is enough. Services like
[DuckDNS](https://www.duckdns.org) (or no-ip.com and similar) give you a
subdomain — say `<your-domain-fqdn>` — for free: sign in (a GitHub/Google
account is enough), create the name, and point it at your server's public IP.
DuckDNS names just need an occasional re-confirmation click to stay yours.

**Setup, from scratch:**

1. Point the domain at your server's IP; open ports 80 and 443 on the
   firewall (`sudo ufw allow 80/tcp && sudo ufw allow 443/tcp`, plus the
   cloud provider's security group if any).
2. `./kptv.sh install` — builds the images, creates `.env` and the data
   directories. Then edit `.env`: `SERVER_HOST=<your-domain-fqdn>`
   (`SERVER_PORT`/`SERVER_SCHEME` are already 443/https).
3. Install certbot if needed (`sudo apt install certbot`) and issue the
   certificate — under the fixed name `kptv`. `--standalone` spins up its
   own temporary web server on port 80, so this works while the stack is
   still stopped:

   ```bash
   sudo certbot certonly --standalone -d <your-domain-fqdn> --cert-name kptv \
       --config-dir "$PWD/data/letsencrypt" \
       --work-dir "$PWD/data/letsencrypt/work" \
       --logs-dir "$PWD/data/letsencrypt/logs" \
       --pre-hook "docker compose stop nginx" \
       --deploy-hook "docker compose restart nginx"
   ```

4. `./kptv.sh start`.
5. Renewal — cron. The hooks are stored inside the certificate, so a bare
   `renew` is enough; nginx is briefly stopped around the renewal and comes
   back with the new certificate:

   ```cron
   0 3 * * * cd /path/to/kptv && certbot renew --config-dir "$PWD/data/letsencrypt" --work-dir "$PWD/data/letsencrypt/work" --logs-dir "$PWD/data/letsencrypt/logs"
   ```

Notes:

- The certificate lives at `./data/letsencrypt/live/kptv/` (gitignored) and
  is mounted into nginx read-only; the private key never leaves the host.
- `SERVER_HOST`, the certificate's `-d` name and the domain the TV opens
  must be one and the same — this is exactly what keeps the client's media
  URLs same-origin and mixed-content-free.
- Moving to a different domain: re-run the command from step 3 with the new
  `-d` (same `--cert-name kptv`), update `SERVER_HOST`,
  `./kptv.sh restart`.

## Moving to a New Server

Servers get blocked sometimes. Everything a client needs lives in one SQLite
database — devices, KinoPub tokens, settings, the proxy allowlist — so a
server move is a database move plus a new address on the clients.

1. Stand up the new server: clone the repo, fill `.env` (same
   `SERVER_HOST`/domain as before, or a new one — issue its certificate),
   `./kptv.sh install`, issue the certificate, `./kptv.sh start`.
2. Move the devices (KinoPub tokens) to it:
   - old server: `./kptv.sh admin export devices.db`
   - new server: `./kptv.sh admin import devices.db` (restarts its stack)
3. Point the clients at the new address:
   - **MSX**: Settings → Start Parameter →
     `https://<your-domain>/msx/start.json`.
   - **TV browser**: open `https://<your-domain>/client/?id=<device-id>`
     once per TV (device ids: `./kptv.sh admin list`). The client adopts
     the id from the URL, so the imported activation carries over; the
     plain `/client/` URL is enough afterwards.

Notes:

- The `?id=` step matters because the client keeps its device id in
  localStorage per origin — after an address change it would otherwise
  generate a fresh id and land on the activation screen.
- `admin export` must be recent: if the old server is already unreachable,
  the devices cannot be moved and every TV needs a fresh activation.
- The export holds every device's KinoPub tokens — treat it as a secret.
- `admin export` / `admin import` are safe on a live stack.

## Security

- The device id (`X-Device-Id` header / `?id=` query param) **is** the
  credential: anyone who knows it controls the linked KinoPub account. Keep
  it private. All traffic to the server is TLS-encrypted, so the id and the
  client JS cannot be sniffed or tampered with on the wire.
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
    main.py         # FastAPI app, middleware (device auth, cache control)
    config/         # Settings (.env), upstream constants
    kinopub/        # Async KinoPub API client (raw dicts, token self-healing)
    devices/        # Device storage (SQLite), per-device settings
    services/       # Allowlist media proxy, HLS playlist rewriting
    routers/        # HTTP endpoints under /api/v1 (+ /msx adapter)
    viewmodels.py   # Raw KinoPub dicts -> render-ready payloads
client/             # Smart TV SPA (vanilla ES5 JS, no build step)
    index.html
    css/ js/        # js/hls.min.js is vendored and lazy-loaded at first playback
cli/                # kptv.sh admin subcommand tree (list/export/import devices)
docs/               # API contract + historical plan
conf/               # nginx config (HTTPS-only: app on 443, redirect on 80)
data/               # SQLite DB + letsencrypt (bind-mounted, gitignored)
backups/            # DB backups (gitignored)
kptv.sh             # Management script
docker-compose.yml  # server + nginx
```

## Acknowledgments

[slonopot/kp-msx](https://github.com/slonopot/kp-msx) ·
[Media Station X](https://msx.benzac.de/) ·
[hls.js](https://github.com/video-dev/hls.js)
