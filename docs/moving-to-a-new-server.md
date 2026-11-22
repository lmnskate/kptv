# Moving to a New Server

Servers get blocked or relocated sometimes. A move is: set up the new
server, copy the database over, point the TVs at the new address.

If you only need the database part, see
[Restoring from a Backup](restoring-from-backup.md) — this document covers
the whole move.

## Step 1 — Fresh backup on the old server

Do this while the old server still works:

```bash
./kptv.sh backup
```

The backup lands in `backups/` on the old server. This file holds every
device's KinoPub tokens — treat it as a secret.

## Step 2 — Set up the new server

1. Install Docker and Docker Compose.
2. Copy the project there (a fresh `git clone` is fine) and run:

   ```bash
   ./kptv.sh install
   ```

3. Fill in `.env`. Decide the domain first (see the next step) —
   `SERVER_HOST` must be the exact domain the TVs will open.

## Step 3 — Domain and certificate

The deployment is HTTPS-only, so the TVs need a domain name, not an IP.
Two cases:

**Same domain as before** (e.g. a DuckDNS name you keep). Just point its
DNS record at the new server's IP, then issue the certificate on the new
server exactly as in the README (Domain and TLS section) and run
`./kptv.sh start`.

**New domain.** Issue a certificate for the new name on the new server,
set `SERVER_HOST` to it, `./kptv.sh start`. The old server can keep
running meanwhile.

## Step 4 — Move the database

On the old server, export the devices (or just use the backup from step 1 —
either file works, they are the same database):

```bash
./kptv.sh admin export devices.db
```

Copy the file to the new server and import it there:

```bash
scp devices.db user@new-server:/path/to/kptv/
./kptv.sh admin import devices.db   # on the new server; restarts its stack
```

Verify: `./kptv.sh admin list` on the new server should show all devices.

## Step 5 — Point the TVs at the new address

- **MSX (Tizen):** MSX → Settings → Start Parameter →
  `https://<your-domain>/msx/start.json`.
- **TV browser:** open `https://<your-domain>/client/?id=<device-id>` once
  per TV (device ids: `./kptv.sh admin list`). The client adopts the id from
  the URL, so the imported activation carries over; the plain `/client/`
  URL is enough afterwards.

The `?id=` step matters: the client keeps its device id in localStorage per
origin, so after an address change it would otherwise generate a fresh id
and land on the activation screen.

## Step 6 — Shut down the old server

Once every TV works against the new address:

```bash
./kptv.sh stop
```

Keep its backup files around for a while, just in case.

## If the old server is already dead

No backup — no devices: KinoPub activations cannot be recovered without the
tokens from the database. Every TV gets a fresh activation
(Settings → the code + QR screen). Note the ~5-devices-per-account limit on
KinoPub; delete the dead server's devices in the KinoPub profile if you hit
it.
