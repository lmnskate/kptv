#!/usr/bin/env bash
# Generic context help/dispatch for the kptv.sh subcommand tree (git-style).
# Subcommands are executable siblings named "<context>-<name>" carrying a
# first-line "# usage: <name> [<args>] — description" comment (parsed for help).
set -euo pipefail

CMD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

subcommands() {
    local file name
    for file in "$CMD_DIR/$CONTEXT"-*; do
        [ -x "$file" ] || continue
        name="${file##*/$CONTEXT-}"
        case "$name" in
            *-*) continue ;;  # deeper tree level, not an immediate subcommand
        esac
        printf '%s\n' "$name"
    done
}

usage_of() {
    sed -n 's/^# usage: //p' "$CMD_DIR/$CONTEXT-$1" | head -1
}

show_help() {
    echo "Usage: ./kptv.sh ${CONTEXT//-/ } <command>"
    echo
    echo "$DESCRIPTION"
    echo
    echo "Commands:"
    local c
    for c in $(subcommands); do
        printf '  %s\n' "$(usage_of "$c")"
    done
}

cmd="${1:-}"
case "$cmd" in
    ''|help|-h|--help)
        show_help
        exit 0
        ;;
esac

target="$CMD_DIR/$CONTEXT-$cmd"
if [ -x "$target" ]; then
    shift
    exec "$target" "$@"
fi

echo "Unknown command: $cmd" >&2
show_help >&2
exit 1
