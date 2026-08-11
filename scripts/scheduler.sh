#!/bin/sh
set -u

# Portainer persistent scheduler: runs immediately on start, then daily at 06:50 ICT.
# The booking code itself handles wait-until-fireAt internally.

while true; do
  echo "[scheduler] $(date -Iseconds) firing"
  /app/scripts/docker-run.sh run
  echo "[scheduler] $(date -Iseconds) done, sleeping until next run"

  # Calculate seconds until next 06:50 ICT (UTC+7 = 23:50 UTC)
  now=$(date +%s)
  target=$(date -d "23:50" +%s 2>/dev/null || date -j -f "%H:%M" "23:50" +%s 2>/dev/null)
  if [ "$target" -le "$now" ]; then
    target=$((target + 86400))
  fi
  sleep $((target - now))
done
