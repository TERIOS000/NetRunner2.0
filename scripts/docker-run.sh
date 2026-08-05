#!/bin/sh
set -u

ping_healthcheck() {
  [ -n "${HEALTHCHECK_URL:-}" ] || return 0
  curl --fail --silent --show-error --max-time 10 "${HEALTHCHECK_URL}$1" >/dev/null 2>&1 || true
}

ping_healthcheck /start

bun src/index.ts "$@" &
child_pid=$!
trap 'kill -TERM "$child_pid" 2>/dev/null || true' TERM INT HUP
if wait "$child_pid"; then
  exit_code=0
else
  exit_code=$?
fi

if [ "$exit_code" -eq 0 ]; then
  ping_healthcheck ""
else
  ping_healthcheck "/$exit_code"
fi

exit "$exit_code"
