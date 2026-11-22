# Restoring from a Backup

Use this when the server was reinstalled, the database got corrupted, or you
are standing up a fresh copy from scratch. Everything — devices, KinoPub
tokens, settings, history — lives in a single SQLite file,
`data/kp-sqlite.db`. Restoring it is easy.

## What you need

- A backup file, e.g. `backups/kp-sqlite-20261104-110206.db`.
  Backups are made with `./kptv.sh backup` (safe on a running server).
- A clean copy of the project on the target server (`./kptv.sh install`
  already done, `.env` filled in).

## Steps

1. Copy the backup file to the target server, into the project folder:

   ```bash
   scp kp-sqlite-20261104-110206.db user@new-server:/path/to/kptv/
   ```

2. On the target server, import the database and restart the stack:

   ```bash
   ./kptv.sh admin import kp-sqlite-20261104-110206.db
   ```

   The command stops the stack, replaces `data/kp-sqlite.db` with your file
   and brings everything back up.

3. Check the devices are there:

   ```bash
   ./kptv.sh admin list
   ```

4. Open the client on the TV. If the server address did not change,
   everything just works — no re-activation needed. If the address did
   change, point the TVs at it once — see
   [Changing IP or Domain](changing-ip-or-domain.md), the section about TVs.

## Important

- Import **replaces** the current database entirely. Anything already
  configured on the target server will be gone.
- The backup holds every device's KinoPub tokens — it is a secret.
  Do not publish it or send it in the clear (scp is fine; messengers
  and email are not).
- The backup must be recent: if the old server is already unreachable
  and there is no fresh copy of the database, every TV will need a fresh
  activation.
