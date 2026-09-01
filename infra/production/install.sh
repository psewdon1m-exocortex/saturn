#!/bin/sh
set -eu
umask 077

INSTALL_ROOT=${VAULT_INSTALL_ROOT:-/opt/vault}
CONFIG_FILE=${VAULT_CONFIG_FILE:-/etc/vault/.env.production}
COMPOSE_FILE="$INSTALL_ROOT/compose.production.yaml"

die() { printf '%s\n' "saturn install: $1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"; }
bounded_logs() { docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" logs --tail 100 --no-color 2>/dev/null || true; }

prepare() {
  [ "$(id -u)" -eq 0 ] || die "prepare requires root"
  [ ! -e "$CONFIG_FILE" ] || die "configuration already exists; use the updater/repair workflow"
  install -d -m 0700 "$(dirname "$CONFIG_FILE")"
  install -m 0600 "$INSTALL_ROOT/infra/production/.env.production.example" "$CONFIG_FILE"
  printf '%s\n' "Prepared $CONFIG_FILE"
  printf '%s\n' "Edit only OPERATOR INPUT, then run: vaultctl install"
}

validate() {
  need docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
  [ -f "$CONFIG_FILE" ] || die "missing $CONFIG_FILE"
  [ "$(stat -c '%a' "$CONFIG_FILE")" = 600 ] || die "configuration mode must be 0600"
  set -a; . "$CONFIG_FILE"; set +a
  docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" config --quiet
  docker pull "$VAULT_APP_IMAGE" >/dev/null
  docker run --rm --env-file "$CONFIG_FILE" -e VAULT_SECRET_ROOT=/run/secrets -v "$CONFIG_FILE:/config/.env.production:ro" -v "$VAULT_SECRET_ROOT:/run/secrets:ro" "$VAULT_APP_IMAGE" node /app/scripts/validate-production.mjs /config/.env.production >/dev/null
}

install_release() {
  [ "$(id -u)" -eq 0 ] || die "install requires root"
  validate
  set -a; . "$CONFIG_FILE"; set +a
  docker pull "$VAULT_APP_IMAGE"
  docker pull "$VAULT_WEB_IMAGE"
  docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" up -d postgres
  docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" run --rm migrate
  docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" up -d worker api
  attempts=0
  until docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" exec -T api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
    attempts=$((attempts+1)); [ "$attempts" -lt 60 ] || { bounded_logs; die "candidate readiness timed out"; }; sleep 2
  done
  docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" up -d edge
  printf '%s\n' "Saturn candidate is healthy. Run vaultctl smoke before loading real data."
}

status() { docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" ps; }
bootstrap_storage() { docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" run --rm migrate node /app/scripts/storage-bootstrap.mjs; }
smoke() { docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" run --rm migrate node /app/scripts/storage-smoke.mjs; }

case "${1:-}" in
  prepare) prepare ;;
  validate) validate ;;
  install) install_release ;;
  status) status ;;
  bootstrap-storage) bootstrap_storage ;;
  smoke) smoke ;;
  *) die "usage: install.sh prepare|validate|install|status|bootstrap-storage|smoke" ;;
esac
