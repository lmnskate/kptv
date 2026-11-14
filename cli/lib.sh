#!/usr/bin/env bash
# Shared helpers for the kptv.sh subcommand tree. Sourced by the command
# scripts in this directory, never executed directly.
KPTV_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$KPTV_ROOT"

compose() {
    docker compose "$@"
}

die() {
    echo "ERROR: $*" >&2
    exit 1
}

check_running() {
    if ! compose ps --status running --services 2>/dev/null | grep -qx server; then
        die "the stack is not running — start it with: ./kptv.sh start"
    fi
}

# Directories bind-mounted into containers must exist beforehand and be
# writable by uid 1000 (the container user).
ensure_mount_dirs() {
    for dir in data backups; do
        mkdir -p "$dir"
        if [ "$(id -u)" = "0" ]; then
            [ "$(stat -c '%u' "$dir")" = "1000" ] || chown -R 1000:1000 "$dir"
        elif [ "$(stat -c '%u' "$dir" 2>/dev/null)" != "1000" ] || [ ! -w "$dir" ]; then
            echo "NOTE: ./$dir must be writable by uid 1000 (the container user)." >&2
            echo "      Fix with:  sudo chown -R 1000:1000 $dir" >&2
        fi
    done
    mkdir -p data/letsencrypt
}

# Device listing, executed by python inside the app container against the
# live SQLite file. Single-quoted for the shell, so the Python code must use
# double quotes only.
ADMIN_PY='
import json
import sqlite3

connection = sqlite3.connect("/data/kp-sqlite.db")
rows = connection.execute(
    "SELECT id, refresh, token, settings, user_agent FROM devices ORDER BY rowid"
).fetchall()
connection.close()

if not rows:
    print("No devices.")
    raise SystemExit(0)


def summary(raw):
    if raw is None:
        return "-"
    try:
        settings = json.loads(raw)
    except ValueError:
        return "-"
    parts = []
    if settings.get("uhd"):
        parts.append("uhd")
    if settings.get("hdr"):
        parts.append("hdr")
    if settings.get("hevc"):
        parts.append("hevc")
    size = settings.get("poster_size")
    if size and size != "medium":
        parts.append("posters=" + size)
    return " ".join(parts) if parts else "defaults"


table = []
for device_id, refresh, token, raw_settings, user_agent in rows:
    ua = user_agent or "-"
    if len(ua) > 50:
        ua = ua[:47] + "..."
    table.append((
        device_id,
        ua,
        "yes" if (refresh or token) else "no",
        summary(raw_settings),
    ))

headers = ("ID", "USER-AGENT", "REGISTERED", "SETTINGS")
widths = [
    max(len(str(value)) for value in column)
    for column in zip(headers, *table)
]


def line(columns):
    print("  ".join(
        str(value).ljust(width)
        for value, width in zip(columns, widths)
    ))


line(headers)
line(tuple("-" * width for width in widths))
for row in table:
    line(row)
'
