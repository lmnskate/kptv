<div align="center">

# KPTV

**Watch [KinoPub](https://kino.watch) on your Smart TV — a remote-friendly web client
(Samsung Tizen, LG webOS) with a FastAPI backend**

![Python](https://img.shields.io/badge/Python-3.13-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-async-009688?logo=fastapi&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-embedded-003B57?logo=sqlite&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)

[What you need](#what-you-need) •
[Install](#install) •
[Open it on the TV](#open-it-on-the-tv) •
[Day-to-day management](#day-to-day-management) •
[When things change](#when-things-change) •
[Configuration](#configuration) •
[Development](#development) •
[Security](#security)

</div>

---

KPTV is a Smart TV client for KinoPub. The TV runs a vanilla-JS app (`client/`,
built for remotes, nothing to install from an app store), and a Python/FastAPI
backend (`src/`) sits between the TV and the KinoPub API — so the pair works in
networks where KinoPub itself is blocked. The TV only ever talks to your server.

Highlights: home rails with continue-watching, catalog, on-screen-keyboard search,
bookmark folders, per-device history, seasons/episodes, an HLS player with
quality/audio/subtitle switching and resume, and HEVC auto-negotiation.

Descendant of [slonopot/kp-msx](https://github.com/slonopot/kp-msx), fully rewritten.
The API contract and project notes live in `AGENTS.md`.

## What you need

Before starting, make sure you have:

- **A Linux server with Docker and the Compose plugin**, with a public IP, in a
  region where kino.pub is reachable. A cheap VPS is fine.
- **A domain name** pointing at that IP. Free is fine —
  [DuckDNS](https://www.duckdns.org) or similar. An IP will not work: the
  deployment is HTTPS-only.
- **KinoPub OAuth credentials** — a client id/secret for your account, requested
  from support@kino.pub.

## Install

Five steps from zero to a running server.

**1. Point the domain at the server.** Create the DNS record (for DuckDNS: one
field on the site, propagates within minutes) and open ports 80 and 443:

```bash
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
```

(Plus the cloud provider's security group, if there is one.)

**2. Install the stack:**

```bash
./kptv.sh install
```

This builds the images and creates `.env` from `.env.example`. **Edit `.env`** now:

```
SERVER_HOST=<your-domain>     # the exact name from step 1
KP_CLIENT_ID=...              # from support@kino.pub
KP_CLIENT_SECRET=...
```

**3. Issue the TLS certificate** — one command, explained in
[Domain and TLS](#domain-and-tls) below.

**4. Start:**

```bash
./kptv.sh start
```

**5. Check:**

```bash
curl https://<your-domain>/msx/start.json
```

A JSON answer means everything works — proceed to [the TV](#open-it-on-the-tv).

### Domain and TLS

The deployment is HTTPS-only: nginx serves the app on `:443`, port 80 only
redirects to https, and `./kptv.sh start` refuses to run without a certificate.
One rule ties it all together: **the certificate's domain, `SERVER_HOST` and the
address the TV opens must be the same name** — that is what keeps the client's
media URLs same-origin and mixed-content-free.

Issue the certificate with certbot (`sudo apt install certbot` first). The
`--cert-name kptv` part is fixed — nginx looks the certificate up by that name.
`--standalone` spins up a temporary web server on port 80, so this works while
the stack is stopped:

```bash
sudo certbot certonly --standalone -d <your-domain> --cert-name kptv \
    --config-dir "$PWD/data/letsencrypt" \
    --work-dir "$PWD/data/letsencrypt/work" \
    --logs-dir "$PWD/data/letsencrypt/logs" \
    --pre-hook "docker compose stop nginx" \
    --deploy-hook "docker compose restart nginx"
```

For **renewal** a cron job is enough — the hooks are stored inside the
certificate, so a bare `renew` briefly stops nginx around the check and brings it
back with the new certificate when there is one:

```cron
0 3 * * * cd /path/to/kptv && certbot renew --config-dir "$PWD/data/letsencrypt" --work-dir "$PWD/data/letsencrypt/work" --logs-dir "$PWD/data/letsencrypt/logs"
```

The certificate lives at `./data/letsencrypt/live/kptv/` (gitignored), mounted
into nginx read-only; the private key never leaves the host. To switch to a
different domain later, re-run the same command with the new `-d`, update
`SERVER_HOST` and restart.

## Open it on the TV

**Media Station X (recommended on Tizen).** MSX → Settings → Start Parameter →
`https://<your-domain>/msx/start.json`. Opening MSX lands on the start page with
the KPTV tile focused; one OK press opens the client fullscreen. (Auto-opening
without a keypress is impossible on Tizen — MSX opens `link:` targets via
`window.open`, which the TV webview blocks without a user gesture.)

**TV browser.** Open `https://<your-domain>/client/` in the TV's built-in browser.

The first launch asks for activation: a code plus a QR, entered at
kino.pub/device. After that the device identity lives in the TV's localStorage —
no further logins.

## Day-to-day management

```bash
./kptv.sh status     # containers, health, uptime, public URL
./kptv.sh backup     # consistent DB backup into ./backups/ (safe on a live server)
./kptv.sh restart    # recreate the containers, re-reading .env and conf/
./kptv.sh stop       # stop everything (all data is kept)
```

**Updating after code changes:**

- Backend changed (`src/`) → `./kptv.sh install` again (it is idempotent) → `./kptv.sh restart`
- Frontend (`client/`) or nginx config (`conf/`) changed → `./kptv.sh restart` is enough

**Devices** — registered TVs, their KinoPub tokens and settings:

```bash
./kptv.sh admin list          # table of registered devices
./kptv.sh admin delete ID     # delete a device (its TV must re-activate)
./kptv.sh admin reset ID      # reset a device's settings to defaults
./kptv.sh admin export FILE   # dump the device DB to FILE (contains tokens — a secret)
./kptv.sh admin import FILE   # replace the device DB with FILE (restarts the stack)
```

## When things change

Step-by-step guides for the rare operational moments live in `docs/`:

- [Moving to a new server](docs/moving-to-a-new-server.md) — new VPS: set it up,
  move the database, repoint the TVs
- [Restoring from a backup](docs/restoring-from-backup.md) — after a reinstall or
  a corrupted database
- [Changing IP or domain](docs/changing-ip-or-domain.md) — new provider IP or a
  new domain name

Quick answers to the usual symptoms:

| Symptom | Cause / fix |
|---|---|
| TV says the site is unreachable | DNS still points at the old IP — check `nslookup <your-domain>` |
| Certificate warning in the browser | the cert is for another name — reissue it for the name the TV opens |
| TV shows the activation screen | the TV lost its device id (every new origin gets a fresh one) — open `/client/?id=<device-id>` once (ids: `./kptv.sh admin list`), or just activate it again |

## Configuration

Everything is read from `.env`; `src/config/settings.py` has the authoritative
list.

| Variable | Default | What it sets |
|---|---|---|
| `SERVER_HOST` | — (required) | the domain the TVs use; must equal the certificate's name |
| `KP_CLIENT_ID` / `KP_CLIENT_SECRET` | — (required) | KinoPub OAuth credentials |
| `KP_PROTOCOL` | `hls4` | preferred stream protocol: `hls4`, `hls2`, `hls` or `http` (the rest are fallback) |
| `KP_QUALITY` | `1080p` | target quality: `2160p`, `1080p`, `720p`, `480p` |
| `SERVER_PORT` / `SERVER_SCHEME` | `443` / `https` | how the public URL is built (`.env.example` ships these) |
| `KPTV_HTTP_PORT` / `KPTV_HTTPS_PORT` | `80` / `443` | host port mapping, if those ports are taken (compose only) |
| `SERVER_DOCS` | off | `true` exposes Swagger/OpenAPI at `/docs` — leave off on an internet-facing server |

Rarely changed (the Docker deployment overrides them): `SERVER_BIND_HOST`,
`SERVER_BIND_PORT`, `SERVER_SQLITE_URL` (defaults to `./data/kp-sqlite.db`),
`SERVER_WORKERS` (must stay 1), `SERVER_PROXY_HEADERS`.

## Development

No Docker needed; Python 3.13+:

```bash
python -m venv .venv
.venv/bin/pip install -r src/requirements.txt
cp .env.example .env   # edit SERVER_HOST, KP_CLIENT_ID, KP_CLIENT_SECRET;
                       # for dev also set SERVER_PORT=1234 (it binds that port)
.venv/bin/python src/main.py
curl http://localhost:1234/msx/start.json   # smoke check, no device id needed
```

Tests — the KinoPub client is stubbed, each test runs on a fresh in-memory
SQLite, no network and no real account needed (the production DB is never
touched):

```bash
.venv/bin/pip install -r tests/requirements.txt
.venv/bin/pytest
```

Coverage: the media-proxy allowlist and playlist rewriting, SRT→WebVTT,
viewmodels and stream selection, SQLite migrations and history, the `/api/v1`
HTTP contract. The TV client JS has no automated tests yet.

## Security

- The device id (`X-Device-Id` header / `?id=` parameter) **is** the credential:
  anyone who knows it controls the linked KinoPub account. Keep it private. All
  traffic is TLS-encrypted, so the id cannot be sniffed on the wire.
- `/api/v1/proxy` and `/api/v1/subtitle` relay only remembered KinoPub CDN
  domains (allowlist) — the proxy cannot be abused to reach arbitrary hosts.
- CORS is wide open (`*`) because TV players require it — the device id is the
  only gate, which is why it must stay secret.
- `.env` (OAuth credentials) and `data/` (device tokens) are gitignored. Backup
  and export files contain tokens — treat them as secrets too.

## Project layout

```
src/                # the app service: code + Dockerfile (compose build context)
    main.py         # FastAPI app: middleware, static mounts, lifespan
    config/         # .env settings, upstream constants
    kinopub/        # async KinoPub API client (raw dicts, token self-healing)
    devices/        # device storage (SQLite), per-device settings
    services/       # allowlist media proxy, HLS playlist rewriting
    routers/        # HTTP endpoints under /api/v1 (+ the /msx adapter)
    viewmodels.py   # raw KinoPub dicts -> render-ready payloads
client/             # the Smart TV SPA (vanilla ES5 JS, no build step)
cli/                # the `./kptv.sh admin` command tree
tests/              # pytest suite
docs/               # the how-to guides
conf/               # nginx config (HTTPS-only: app on 443, redirect on 80)
data/ backups/      # SQLite DB, TLS certificate, backups (gitignored)
kptv.sh             # management script
docker-compose.yml  # server + nginx
```

## Acknowledgments

[slonopot/kp-msx](https://github.com/slonopot/kp-msx) ·
[Media Station X](https://msx.benzac.de/) ·
[hls.js](https://github.com/video-dev/hls.js)
