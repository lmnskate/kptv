**English** · [Русский](restoring-from-backup.ru.md)

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

1. Copy the backup to a machine that can open the admin panel (any machine with
   SSH access to the server will do):

   ```bash
   scp kp-sqlite-20261104-110206.db user@workstation:~/
   ```

2. Open the admin panel. Its port is loopback-only, so open an SSH tunnel first
   and keep it open:

   ```bash
   ssh -L 8001:localhost:8001 user@<server>
   # then visit http://localhost:8001 in your browser
   ```

3. Press **«Импорт БД»** and pick the backup. The import replaces the server's
   database entirely; a safety copy of the previous database is saved next to
   the main file. No stack restart is needed.

4. Check the devices are listed in the panel.

5. Open the client on the TV. Same address as before — everything just works,
   no re-activation. New address — point the TVs once, see
   [Changing IP or Domain](changing-ip-or-domain.md#pointing-the-tvs-at-a-new-address).

## Important

- Import **replaces** the current database entirely; anything already configured
  on the target server is gone.
- The backup holds every device's KinoPub tokens — it is a secret. `scp` is
  fine for moving it; messengers and email are not.
- If the old server is already unreachable and there is no fresh backup, every
  TV will need a fresh activation — tokens cannot be recovered without the file.
