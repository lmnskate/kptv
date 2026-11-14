#!/usr/bin/env bash
# Generic leaf-command implementation for the kptv.sh admin command tree.
#
# A leaf script (e.g. cli/admin-delete) sets OP — "delete" or "reset" (both
# require a device id) — and sources this file. The leaf's own help/usage
# comes from its first-line comment:
#
#   # usage: delete <id> — one-line description
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

print_usage() {
    local me parent usage
    me="$(basename "$0")"
    parent="${me%-*}"
    usage=$(sed -n 's/^# usage: //p' "$0" | head -1)
    echo "Usage: ./kptv.sh ${parent//-/ } $usage"
}

if [ "${1:-}" = -h ] || [ "${1:-}" = --help ]; then
    print_usage
    exit 0
fi

if [ -z "${1:-}" ]; then
    echo "ERROR: missing device id." >&2
    print_usage >&2
    exit 1
fi

check_running
compose exec -T server python -c "$ADMIN_PY" "$OP" "$1"
