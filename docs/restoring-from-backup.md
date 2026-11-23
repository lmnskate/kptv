# Restoring from a Backup

Use this when the server was reinstalled, the database got corrupted, or you are
standing up a fresh copy. Everything — devices, KinoPub tokens, settings,
history — lives in a single SQLite file, so restoring is one import.

## What you need

- A backup file, e.g. `backups/kp-sqlite-20261104-110206.db`. Backups are made
  with `./kptv.sh backup` (safe on a running server).
- A clean copy of the project on the target server: `./kptv.sh install` already
  done, `.env` filled in.

## Steps

1. Copy the backup into the project folder on the target server:

   ```bash
   scp kp-sqlite-20261104-110206.db user@server:/path/to/kptv/
   ```

2. Import it (replaces `data/kp-sqlite.db` and restarts the stack):

   ```bash
   ./kptv.sh admin import kp-sqlite-20261104-110206.db
   ```

3. Check the devices are there:

   ```bash
   ./kptv.sh admin list
   ```

4. Open the client on the TV. Same address as before — everything just works,
   no re-activation. New address — point the TVs once, see
   [Changing IP or Domain](changing-ip-or-domain.md#pointing-the-tvs-at-a-new-address).

## Important

- Import **replaces** the current database entirely; anything already configured
  on the target server is gone.
- The backup holds every device's KinoPub tokens — it is a secret. `scp` is
  fine for moving it; messengers and email are not.
- If the old server is already unreachable and there is no fresh backup, every
  TV will need a fresh activation — tokens cannot be recovered without the file.
