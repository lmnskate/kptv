#!/usr/bin/env bash
#
# kptv.sh — manage the KPTV Docker deployment.
#
# Usage: ./kptv.sh <command>
#
#   start            Start the stack (builds the image on first run)
#   stop             Stop and remove the containers (data in ./data is kept)
#   restart          Recreate the containers, re-reading .env and compose config
#   status           Show stack status and the TV entry point
#   logs [service]   Follow logs (optionally only of 'server' or 'nginx')
#   build            Build the app image
#   update           Rebuild the app image from source and restart the stack
#   backup           Back up the database into ./backups/ (safe on a live DB)
#   shell            Open a shell inside the app container
#   help             Show this help

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

compose() {
    docker compose "$@"
}

check_env() {
    if [ ! -f .env ]; then
        echo "ERROR: .env not found." >&2
        echo "Create it first:  cp .env.example .env  (then edit it)" >&2
        exit 1
    fi
}

# Directories bind-mounted into containers must exist beforehand and be
# writable by uid 1000 — otherwise Docker creates them owned by root.
ensure_mount_dirs() {
    for dir in data backups; do
        mkdir -p "$dir"
        if [ "$(id -u)" != "1000" ] || [ ! -w "$dir" ]; then
            echo "NOTE: ./$dir must be writable by uid 1000 (the container user)." >&2
            echo "      Fix with:  sudo chown -R 1000:1000 $dir" >&2
        fi
    done
}

cmd_start() {
    check_env
    ensure_mount_dirs
    compose up -d
    echo "KPTV is starting. Check status with:  ./kptv.sh status"
}

cmd_stop() {
    compose down
}

cmd_restart() {
    check_env
    ensure_mount_dirs
    compose down
    compose up -d
}

cmd_status() {
    local green='' red='' dim='' reset=''
    if [ -t 1 ]; then
        green=$'\033[32m'; red=$'\033[31m'; dim=$'\033[2m'; reset=$'\033[0m'
    fi

    local rows
    rows=$(compose ps --format '{{.Service}}|{{.State}}|{{.Status}}|{{.Ports}}' 2>/dev/null)

    if [ -z "$rows" ]; then
        printf '%b stack is not running — start it with: ./kptv.sh start\n' "${red}●${reset}"
        return
    fi

    local dot service state status ports published
    echo "$rows" | while IFS='|' read -r service state status ports; do
        dot="$red●"
        [ "$state" = 'running' ] && dot="$green●"
        published=$(
            echo "$ports" | tr ',' '\n' | grep -F -- '->' | grep -v '\[::\]' \
                | sed 's|/tcp||g' | paste -sd' ' - || true
        )
        [ -z "$published" ] && published="${dim}internal only${reset}"
        printf '%b %-8s %-26s %s\n' "$dot" "$service" "$status" "$published"
    done

    if [ -f .env ]; then
        local scheme host port
        scheme=$(sed -n 's/^SERVER_SCHEME=//p' .env | head -1)
        host=$(sed -n 's/^SERVER_HOST=//p' .env | head -1)
        port=$(sed -n 's/^SERVER_PORT=//p' .env | head -1)
        echo
        echo "TV entry point: ${scheme:-http}://${host:-<not set>}:${port:-1234}"
    fi
}

cmd_logs() {
    compose logs -f "$@"
}

cmd_build() {
    compose build
}

cmd_update() {
    check_env
    ensure_mount_dirs
    compose build
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

cmd_shell() {
    compose exec server bash
}

cmd_help() {
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

case "${1:-help}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_restart ;;
    status)  cmd_status ;;
    logs)    shift; cmd_logs "$@" ;;
    build)   cmd_build ;;
    update)  cmd_update ;;
    backup)  cmd_backup ;;
    shell)   cmd_shell ;;
    help|-h|--help) cmd_help ;;
    *)
        echo "Unknown command: $1" >&2
        cmd_help >&2
        exit 1
        ;;
esac
