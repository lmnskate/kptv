<div align="center">

**English** · [Русский](README.ru.md)

# KPTV

**Watch [KinoPub](https://kino.watch) on your Smart TV — a web client
(Samsung Tizen, LG webOS) with a FastAPI backend**

</div>

---

KPTV is a Smart TV client for KinoPub. The TV runs a web app built for remotes
(`client/`, nothing to install from an app store), and a FastAPI backend (`src/`)
sits between the TV and the KinoPub API — so the pair works in networks where
KinoPub itself is blocked. The TV only ever talks to your server.

Features: home rails with continue-watching, catalog, on-screen-keyboard search,
bookmark folders, per-device watch history, seasons/episodes, an HLS player with
quality/audio/subtitle switching and resume.

## What you need

- **A Linux server with Docker and the Compose plugin**, a public IP, in a
  region where kino.pub is reachable. A cheap VPS is fine.
- **A domain name** pointing at that IP — free [DuckDNS](https://www.duckdns.org)
  works. An IP alone won't do: the deployment is HTTPS-only.
- **KinoPub OAuth credentials** (client id/secret) for your account — request
  them from support@kino.pub.

## Install

Four steps from zero to a running server.

**1. Point the domain at the server.** Create the DNS record and open ports 80
and 443 in the firewall (plus the cloud provider's security group, if any):

```bash
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
```

**2. Install the stack:**

```bash
./kptv.sh install
```

This builds the images and creates `.env` from `.env.example`. Edit it now:

```
SERVER_HOST=<your-domain>     # the exact name from step 1
KP_CLIENT_ID=...              # from support@kino.pub
KP_CLIENT_SECRET=...
```

**3. Issue the TLS certificate.** One rule ties everything together: **the
certificate's domain, `SERVER_HOST` and the address the TV opens must be the
same name** — that is what keeps the client's media URLs same-origin and
mixed-content-free. `--cert-name kptv` is fixed (nginx looks the certificate up
by that name). Install certbot first (`sudo apt install certbot`):

```bash
sudo certbot certonly --standalone -d <your-domain> --cert-name kptv \
    --config-dir "$PWD/data/letsencrypt" \
    --work-dir "$PWD/data/letsencrypt/work" \
    --logs-dir "$PWD/data/letsencrypt/logs" \
    --pre-hook "docker compose stop nginx" \
    --deploy-hook "docker compose restart nginx"
```

The hooks are stored with the certificate, so renewal is a single cron line —
nginx is briefly stopped for the check and brought back up with the new
certificate when there is one:

```cron
0 3 * * * cd /path/to/kptv && certbot renew --config-dir "$PWD/data/letsencrypt" --work-dir "$PWD/data/letsencrypt/work" --logs-dir "$PWD/data/letsencrypt/logs"
```

**4. Start and check:**

```bash
./kptv.sh start
curl https://<your-domain>/msx/start.json
```

A JSON answer means the backend is up — proceed to the TV.

## Open it on the TV

- **Media Station X (recommended on Tizen):** MSX → Settings → Start Parameter →
  `https://<your-domain>/msx/start.json`. The start page opens with the KPTV
  tile focused; one OK press opens the client fullscreen. (Auto-opening without
  a keypress is impossible on Tizen — MSX opens `link:` targets via
  `window.open`, which the TV webview blocks without a user gesture.)
- **TV browser:** open `https://<your-domain>/client/`.

The first launch asks for activation: a code plus a QR, entered at
kino.pub/device. After that the device identity lives in the TV's localStorage —
no further logins.

## The admin panel

Devices are managed from a small web panel running on the server. It is **not
reachable from the internet**: its port is published only on the server's own
loopback address (`127.0.0.1:8001`). You open it from your computer through an
SSH tunnel:

```bash
ssh -L 8001:localhost:8001 <user>@<your-server>
```

What this does: `-L 8001:localhost:8001` forwards your computer's port 8001 to
the server's port 8001 through the encrypted SSH connection. Note that
`localhost` on the right side means **the server's** loopback, not yours. Keep
the terminal open and visit **http://localhost:8001** in your browser. Close the
terminal (or Ctrl+C) when you're done — the tunnel disappears with it.

The panel shows every device with its id, user-agent, activation state and
history size; opens each device's watch history (titles from KinoPub) and
deletes individual entries; resets a device's settings; deletes a device (its
local history is wiped too — the TV must re-activate). The header buttons
**«Экспорт БД»** and **«Импорт БД»** move the whole device database between
servers: the export is a live SQLite backup, the import saves a safety copy of
the current database first. None of this needs a stack restart.

Two cautions: the export file holds every device's KinoPub tokens — treat it as
a secret. And set `SERVER_ADMIN_TOKEN` in `.env` if you want the panel to ask
for a token on top of the tunnel (once per browser session).

## Day-to-day

```bash
./kptv.sh status     # containers, health, uptime, public URL
./kptv.sh backup     # consistent DB backup into ./backups/ (safe on a live server; keeps the 10 newest)
./kptv.sh restart    # recreate the containers, re-reading .env and conf/
./kptv.sh stop       # stop everything (all data is kept)
```

**Updating after code changes:**

- Backend changed (`src/`) → `./kptv.sh install` again (idempotent) → `./kptv.sh restart`
- Frontend (`client/`) or nginx config (`conf/`) changed → `./kptv.sh restart` is enough

## When things change

Step-by-step guides for the rare operational moments:

- [Moving to a new server](docs/moving-to-a-new-server.md) — new VPS: set it up,
  move the database, repoint the TVs
- [Restoring from a backup](docs/restoring-from-backup.md) — after a reinstall
  or a corrupted database
- [Changing IP or domain](docs/changing-ip-or-domain.md) — new provider IP or a
  new domain name

## Configuration

Everything is read from `.env`; `src/config/settings.py` has the authoritative
list.

| Variable | Default | What it sets |
|---|---|---|
| `SERVER_HOST` | — (required) | the domain the TVs use; must equal the certificate's name |
| `KP_CLIENT_ID` / `KP_CLIENT_SECRET` | — (required) | KinoPub OAuth credentials |
| `KP_PROTOCOL` | `hls4` | preferred stream protocol: `hls4`, `hls2`, `hls` or `http` (the rest are fallback) |
| `KP_QUALITY` | `1080p` | target quality: `2160p`, `1080p`, `720p`, `480p` |
| `KPTV_HTTP_PORT` / `KPTV_HTTPS_PORT` | `80` / `443` | host port mapping, if those ports are taken (compose only) |
| `KPTV_ADMIN_PORT` | `8001` | the admin panel's host-side port — still loopback-only, use a different value if 8001 is taken on the server (compose only) |
| `SERVER_ADMIN_TOKEN` | — (unset) | when set, the admin panel requires this token |
| `SERVER_DOCS` | off | `true` exposes Swagger/OpenAPI at `/docs` — leave off on an internet-facing server |

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
SQLite, no network and no real account needed:

```bash
.venv/bin/pip install -r tests/requirements.txt
.venv/bin/pytest
```

## Security

- The device id (`X-Device-Id` header / `?id=` parameter) **is** the credential:
  anyone who knows it controls the linked KinoPub account. Keep it private. All
  traffic is TLS-encrypted, so the id cannot be sniffed on the wire.
- `/api/v1/proxy` and `/api/v1/subtitle` relay only remembered KinoPub CDN
  domains (allowlist) — the proxy cannot be abused to reach arbitrary hosts.
- The admin panel is loopback-only by design — never publish its port on a
  public interface; the SSH tunnel is the intended way in.
- `.env` (OAuth credentials) and `data/` (device tokens) are gitignored. Backup
  and export files contain tokens — treat them as secrets too.

## Acknowledgments

[slonopot/kp-msx](https://github.com/slonopot/kp-msx) ·
[Media Station X](https://msx.benzac.de/) ·
[hls.js](https://github.com/video-dev/hls.js)
