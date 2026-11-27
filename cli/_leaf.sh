#!/usr/bin/env bash
# Generic leaf-command implementation: the leaf sets OP and sources this file;
# its usage line is the first-line "# usage: ..." comment (parsed for help).
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
