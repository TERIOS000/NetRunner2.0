#!/bin/sh
set -eu

# ── scheduler.sh ────────────────────────────────────────────
# Persistent entrypoint for Portainer / docker compose up.
# Fires once on startup (post-reboot catch-up) then loops
# daily at 06:50 ICT.  The bot itself handles pre-auth,
# fireAt timing, and the race loop.
# ─────────────────────────────────────────────────────────────

FIRE_HOUR=6
FIRE_MIN=50
TZ="Asia/Bangkok"

log() { printf '[scheduler %s] %s\n' "$(date -Iseconds)" "$*"; }

fire() {
  log "firing — docker-run.sh run"
  sh /app/scripts/docker-run.sh run || log "race exited with code $?"
}

# ── Startup: fire once (post-reboot catch-up; idempotent
#    marker prevents double-booking) ─────────────────────────
fire

# ── Daily loop ──────────────────────────────────────────────
log "entering daily loop — fires at $(printf '%02d:%02d' "$FIRE_HOUR" "$FIRE_MIN") ICT"

while true; do
  NEXT=$(TZ="$TZ" date -d "$(printf '%02d:%02d' "$FIRE_HOUR" "$FIRE_MIN")" +%s 2>/dev/null)
  NOW=$(date +%s)

  if [ "$NEXT" -le "$NOW" ]; then
    NEXT=$((NEXT + 86400))
  fi

  SLEEP=$((NEXT - NOW))
  H=$((SLEEP / 3600))
  M=$(((SLEEP % 3600) / 60))
  log "next fire at $(TZ=$TZ date -d "@${NEXT}" '+%Y-%m-%d %H:%M:%S %Z'), sleeping ${H}h${M}m"

  sleep "$SLEEP"
  fire
done
