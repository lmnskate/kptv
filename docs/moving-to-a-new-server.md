# Moving to a New Server

Servers get blocked or relocated sometimes. A move is three things: set up the
new server, move the database (devices and their KinoPub tokens live in one
SQLite file), point the TVs at the new address.

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
  as in the README (Install → Domain and TLS) and run `./kptv.sh start`.
- **New domain:** issue the certificate for the new name, set `SERVER_HOST` to
  it, `./kptv.sh start`. The old server can keep running meanwhile.

## 4. Move the database

On the old server, export the devices (the step-1 backup works too — both files
are the same database):

```bash
./kptv.sh admin export devices.db
```

Copy the file to the new server and import it there:

```bash
scp devices.db user@new-server:/path/to/kptv/
./kptv.sh admin import devices.db   # on the new server; restarts its stack
```

Verify: `./kptv.sh admin list` on the new server shows all devices.

## 5. Point the TVs at the new address

- **MSX (Tizen):** MSX → Settings → Start Parameter →
  `https://<your-domain>/msx/start.json`.
- **TV browser:** open `https://<your-domain>/client/?id=<device-id>` once per
  TV (device ids: `./kptv.sh admin list`); afterwards the plain `/client/` URL
  is enough.

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
