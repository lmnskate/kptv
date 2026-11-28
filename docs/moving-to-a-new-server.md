**English** · [Русский](moving-to-a-new-server.ru.md)

# Moving to a New Server

A move is three things: set up the new server, move the database (devices and
their KinoPub tokens live in one SQLite file), point the TVs at the new address.

Do it while the old server still works — without a recent database copy the
activations cannot be recovered (see the last section).

## 1. Fresh backup on the old server

```bash
./kptv.sh backup
```

Lands in `backups/` on the old server. The file holds every device's KinoPub
tokens — treat it as a secret.

## 2. Set up the new server

1. Install Docker and the Compose plugin.
2. Copy the project there (a fresh `git clone` is fine) and run:

   ```bash
   ./kptv.sh install
   ```

3. Fill in `.env`. Decide the domain first (step 3) — `SERVER_HOST` must be the
   exact name the TVs will open.

## 3. Domain and certificate

The deployment is HTTPS-only, so the TVs need a domain, not an IP.

- **Same domain as before** (e.g. a DuckDNS name you keep): point its DNS record
  at the new server's IP, then issue the certificate on the new server exactly
  as in the README (Install, step 3) and run `./kptv.sh start`.
- **New domain:** issue the certificate for the new name, set `SERVER_HOST` to
  it, `./kptv.sh start`. The old server can keep running meanwhile.

## 4. Move the database

Open the admin panel on the old server and press **«Экспорт БД»**. The panel is
loopback-only, so open an SSH tunnel from your computer first and keep it open:

```bash
ssh -L 8001:localhost:8001 user@old-server
# then visit http://localhost:8001 in your browser
```

Save the downloaded file (a step-1 backup works too — both are the same
database). Then open the new server's panel the same way
(`ssh -L 8001:localhost:8001 user@new-server`, http://localhost:8001) and press
**«Импорт БД»**, picking the exported file. The import replaces the new server's
database entirely — a safety copy of it is kept next to the main file — and the
running server picks the new devices up without a restart.

Verify: the new server's panel lists all devices.

## 5. Point the TVs at the new address

- **MSX (Tizen):** MSX → Settings → Start Parameter →
  `https://<your-domain>/msx/start.json`.
- **TV browser:** open `https://<your-domain>/client/?id=<device-id>` once per
  TV (ids are listed in the admin panel — the tunnel above works the same way);
  afterwards the plain `/client/` URL is enough.

The `?id=` step matters: the client keeps its device id in localStorage per
origin, so on a new address it would otherwise generate a fresh id and land on
the activation screen.

## 6. Shut down the old server

Once every TV works against the new address:

```bash
./kptv.sh stop
```

Keep its backup files around for a while, just in case.

## If the old server is already dead

No backup — no devices: KinoPub activations cannot be recovered without the
tokens from the database. Every TV gets a fresh activation via the code + QR
screen. Mind the ~5-devices-per-account limit on KinoPub; delete the dead
server's devices in the KinoPub profile if you hit it.
