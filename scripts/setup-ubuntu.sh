#!/bin/sh
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SYSTEMD_DIR=/etc/systemd/system
RACE=botbookyoucourt-race
FALLBACK=botbookyoucourt-fallback

log() { printf '%s\n' "==> $*"; }
fail() { printf '%s\n' "error: $*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || fail "this setup script is for Linux"
command -v docker >/dev/null 2>&1 || fail "Docker Engine is required: https://docs.docker.com/engine/install/ubuntu/"
docker compose version >/dev/null 2>&1 || fail "the Docker Compose v2 plugin is required"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"
command -v flock >/dev/null 2>&1 || fail "flock (util-linux) is required"
DOCKER=$(command -v docker)
FLOCK=$(command -v flock)
[ -f "$REPO/.env" ] || fail "missing $REPO/.env; copy .env.example and add credentials first"
[ -f "$REPO/config.json" ] || fail "missing $REPO/config.json"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=
else
  command -v sudo >/dev/null 2>&1 || fail "sudo is required to install systemd units"
  SUDO=sudo
fi

log "repository: $REPO"
chmod 600 "$REPO/.env"
mkdir -p "$REPO/logs" "$REPO/state"

log "validating Compose configuration"
(cd "$REPO" && docker compose config --quiet)

log "building bot image"
(cd "$REPO" && docker compose build)

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

install_service() {
  name=$1
  template=$2
  temp_file=$(mktemp)
  escaped_repo=$(escape_sed_replacement "$REPO")
  escaped_docker=$(escape_sed_replacement "$DOCKER")
  escaped_flock=$(escape_sed_replacement "$FLOCK")
  sed -e "s|@REPO@|$escaped_repo|g" \
      -e "s|@DOCKER@|$escaped_docker|g" \
      -e "s|@FLOCK@|$escaped_flock|g" \
      "$template" > "$temp_file"
  $SUDO install -m 0644 "$temp_file" "$SYSTEMD_DIR/$name.service"
  rm -f "$temp_file"
}

log "installing systemd services and timers"
install_service "$RACE" "$REPO/deploy/systemd/$RACE.service.in"
install_service "$FALLBACK" "$REPO/deploy/systemd/$FALLBACK.service.in"
$SUDO install -m 0644 "$REPO/deploy/systemd/$RACE.timer" "$SYSTEMD_DIR/$RACE.timer"
$SUDO install -m 0644 "$REPO/deploy/systemd/$FALLBACK.timer" "$SYSTEMD_DIR/$FALLBACK.timer"
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "$RACE.timer" "$FALLBACK.timer"

log "running safe status smoke test (authenticates and reads availability; never books)"
if ! (cd "$REPO" && docker compose run --rm status); then
  printf '%s\n' "warning: status smoke test failed; check credentials, Thai IP connectivity, and logs" >&2
fi

log "installed successfully"
$SUDO systemctl list-timers "$RACE.timer" "$FALLBACK.timer" --no-pager
printf '%s\n' \
  "Inspect: sudo systemctl status $RACE.timer $FALLBACK.timer" \
  "Logs:    sudo journalctl -u $RACE.service -u $FALLBACK.service" \
  "Test:    cd '$REPO' && docker compose run --rm dry-run"
