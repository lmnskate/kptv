#!/usr/bin/env bash
#
# kptv.sh — manage the KPTV Docker deployment.
#
# Usage: ./kptv.sh <command>
#
#   install                Build/pull the images and prepare the data dirs.
#                          Creates .env from .env.example if missing — edit it!
#   start                  Start the stack (requires: install)
#   stop                   Stop and remove the containers (data in ./data is kept)
#   restart                Recreate the containers, re-reading .env and compose config
#   status                 Show container status (state, health, uptime, ports)
#   backup                 Back up the database into ./backups/ (safe on a live DB)
#   admin ...              Device management — a command tree of its own:
#                          './kptv.sh admin' lists its commands and their help
#   help                   Show this help

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
cd "$ROOT_DIR"

compose() {
    docker compose "$@"
}

check_env() {
    if [ ! -f .env ]; then
        echo "ERROR: .env not found." >&2
        echo "Create it first:  ./kptv.sh install  (generates one to edit)" >&2
        exit 1
    fi
}

check_installed() {
    while read -r image; do
        if ! docker image inspect "$image" >/dev/null 2>&1; then
            echo "ERROR: image '$image' is not available yet." >&2
            echo "Run:  ./kptv.sh install" >&2
            exit 1
        fi
    done < <(compose config --images)
}

# fail before docker starts: nginx references the certificate by its fixed
# certbot name "kptv" (conf/nginx.conf) and will not boot without it
check_certs() {
    if [ ! -f data/letsencrypt/live/kptv/fullchain.pem ] || [ ! -f data/letsencrypt/live/kptv/privkey.pem ]; then
        echo "ERROR: no TLS certificate at ./data/letsencrypt/live/kptv/" >&2
        echo "Issue one (README, \"Domain and TLS\"):" >&2
        echo "  sudo certbot certonly --standalone -d <your-domain> --cert-name kptv \\" >&2
        echo "      --config-dir \"\$PWD/data/letsencrypt\" \\" >&2
        echo "      --work-dir \"\$PWD/data/letsencrypt/work\" \\" >&2
        echo "      --logs-dir \"\$PWD/data/letsencrypt/logs\" \\" >&2
        echo "      --pre-hook \"docker compose stop nginx\" \\" >&2
        echo "      --deploy-hook \"docker compose restart nginx\"" >&2
        exit 1
    fi
}

# Directories bind-mounted into containers must exist beforehand and be
# writable by uid 1000 (the container user). When Docker creates them itself
# they end up owned by root, and the app then dies at startup with a SQLite
# "readonly database" error — so fix the ownership right here when we can.
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

cmd_install() {
    if [ ! -f .env ]; then
        cp .env.example .env
        echo "WARNING: .env did not exist — created it from .env.example."
        echo "         EDIT .env BEFORE STARTING THE STACK: set at least"
        echo "         SERVER_HOST, KP_CLIENT_ID, KP_CLIENT_SECRET."
        echo
    fi
    ensure_mount_dirs
    compose build
    # compose build only covers services with a build section — pull the rest
    # (nginx) so start never has to download anything.
    compose pull --ignore-buildable
    echo
    echo "Installed. Edit .env if you have not yet, then start:  ./kptv.sh start"
}

cmd_start() {
    check_env
    ensure_mount_dirs
    check_installed
    check_certs
    compose up -d
    echo "KPTV is starting."
}

cmd_stop() {
    compose down
}

cmd_restart() {
    check_env
    ensure_mount_dirs
    check_installed
    check_certs
    compose down
    compose up -d
}

cmd_backup() {
    mkdir -p backups
    file="kp-sqlite-$(date +%Y%m%d-%H%M%S).db"

    if compose ps --status running --services 2>/dev/null | grep -qx server; then
        # A live DB must not be copied raw — use SQLite's online backup API
        compose exec -T server python -c "
import sqlite3
source = sqlite3.connect('/data/kp-sqlite.db')
target = sqlite3.connect('/backups/$file')
source.backup(target)
target.close()
source.close()
"
    elif [ -f data/kp-sqlite.db ]; then
        cp data/kp-sqlite.db "backups/$file"
    else
        echo "ERROR: no database found to back up." >&2
        exit 1
    fi

    echo "Backup saved: backups/$file"
}

cmd_status() {
    local rows
    if ! rows=$(compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.Status}}|{{.Ports}}' 2>/dev/null); then
        echo "ERROR: docker is not responding — is the daemon running?" >&2
        exit 1
    fi
    if [ -z "$rows" ]; then
        echo "KPTV: no containers yet — create the stack with: ./kptv.sh start"
        return 0
    fi

    printf '%-9s %-9s %-9s %-22s %s\n' SERVICE STATE HEALTH UPTIME PORTS
    printf '%-9s %-9s %-9s %-22s %s\n' ------- ----- ------ ------ -----
    local service state health status ports uptime up total
    up=0
    total=0
    while IFS='|' read -r service state health status ports; do
        total=$((total + 1))
        [ "$state" = "running" ] && up=$((up + 1))
        [ -z "$health" ] && health="-"
        uptime=$(printf '%s' "$status" | sed -e 's/ *(healthy)$//' -e 's/ *(unhealthy)$//' -e 's/ *(health: starting)$//')
        # show only the public IPv4 mappings; expose-only ports are noise
        ports=$(printf '%s' "$ports" | tr ',' '\n' | grep -oE '0\.0\.0\.0:[0-9]+->[0-9]+/tcp' | tr '\n' ' ' || true)
        ports=${ports% }
        [ -z "$ports" ] && ports="-"
        printf '%-9s %-9s %-9s %-22s %s\n' "$service" "$state" "$health" "$uptime" "$ports"
    done <<EOF
$rows
EOF

    echo
    if [ "$up" = "$total" ]; then
        echo "Stack is up: $up/$total containers running."
    else
        echo "WARNING: $up/$total containers running — see: docker compose logs"
    fi
    if [ -f .env ]; then
        local host
        host=$(sed -n 's/^SERVER_HOST=//p' .env | tail -n 1)
        [ -n "$host" ] && echo "URL: https://$host/"
    fi
}

cmd_help() {
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

case "${1:-help}" in
    install) cmd_install ;;
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_restart ;;
    status)  cmd_status ;;
    backup)  cmd_backup ;;
    admin)   shift; exec "$ROOT_DIR/cli/admin" "$@" ;;
    help|-h|--help) cmd_help ;;
    *)
        echo "Unknown command: $1" >&2
        cmd_help >&2
        exit 1
        ;;
esac
