#!/bin/sh
set -eu
umask 077

INSTALL_ROOT=${VAULT_INSTALL_ROOT:-/opt/vault}
CONFIG_FILE=${VAULT_CONFIG_FILE:-/etc/vault/.env.production}
COMPOSE_FILE="$INSTALL_ROOT/compose.production.yaml"
UPDATER_BUNDLE="$INSTALL_ROOT/updater"

die() { printf '%s\n' "saturn install: $1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"; }
bounded_logs() { docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" logs --tail 100 --no-color 2>/dev/null || true; }

get_config() {
  sed -n "s/^$1=//p" "$CONFIG_FILE" | tail -n 1
}

get_config_from() {
  source_file=$1; source_key=$2
  sed -n "s/^$source_key=//p" "$source_file" | tail -n 1
}

set_config() {
  key=$1; value=$2; temporary="$CONFIG_FILE.tmp"
  awk -v key="$key" -v value="$value" 'BEGIN { found=0 } index($0,key "=")==1 { print key "=" value; found=1; next } { print } END { if (!found) print key "=" value }' "$CONFIG_FILE" >"$temporary"
  chmod 0600 "$temporary"; mv -f "$temporary" "$CONFIG_FILE"
}

needs_generation() {
  current=$(get_config "$1")
  case "$current" in
    ""|CHANGE_ME*|change-*|replace-*|generated-by-*) return 0 ;;
    *) return 1 ;;
  esac
}

random_hex() {
  openssl rand -hex "$1"
}

copy_local_kernel_bootstrap() {
  kernel_env=/opt/exocortex/kernel/.env
  [ -r "$kernel_env" ] || return 0
  current_url=$(get_config KERNEL_URL)
  current_token=$(get_config KERNEL_SERVICE_TOKEN)
  case "$current_url" in ""|*CHANGE_ME*|*replace-me*|*.example.*)
    local_url=$(get_config_from "$kernel_env" KERNEL_URL)
    [ -n "$local_url" ] && set_config KERNEL_URL "$local_url"
    ;;
  esac
  case "$current_token" in ""|CHANGE_ME*|change-*|replace-*)
    local_token=$(get_config_from "$kernel_env" KERNEL_SERVICE_TOKEN)
    [ -n "$local_token" ] && set_config KERNEL_SERVICE_TOKEN "$local_token"
    ;;
  esac
}

prepare_agent_mounts() {
  need openssl
  getent group updater >/dev/null 2>&1 || groupadd --system updater
  getent group neptune-clients >/dev/null 2>&1 || groupadd --system neptune-clients
  getent group gryphon-clients >/dev/null 2>&1 || groupadd --system gryphon-clients
  updater_gid=$(getent group updater | cut -d: -f3)
  neptune_gid=$(getent group neptune-clients | cut -d: -f3)
  gryphon_gid=$(getent group gryphon-clients | cut -d: -f3)
  install -d -o root -g updater -m 0770 /run/exocortex
  install -d -o root -g neptune-clients -m 0770 /run/neptune
  install -d -o root -g gryphon-clients -m 0770 /run/gryphon
  install -d -o root -g neptune-clients -m 0750 /etc/neptune/clients
  install -d -o root -g gryphon-clients -m 0750 /etc/gryphon/clients
  for token_file in /etc/neptune/clients/saturn.control.token /etc/neptune/clients/saturn.export.token; do
    if [ ! -s "$token_file" ]; then random_hex 32 >"$token_file"; fi
    chown root:neptune-clients "$token_file"; chmod 0640 "$token_file"
  done
  gryphon_token_file=/etc/gryphon/clients/saturn.token
  if [ ! -s "$gryphon_token_file" ]; then random_hex 32 >"$gryphon_token_file"; fi
  chown root:gryphon-clients "$gryphon_token_file"; chmod 0640 "$gryphon_token_file"
  set_config UPDATER_SOCKET_GID "$updater_gid"
  set_config NEPTUNE_SOCKET_GID "$neptune_gid"
  set_config GRYPHON_CLIENTS_GID "$gryphon_gid"
  set_config NEPTUNE_CONTROL_TOKEN_HOST_FILE /etc/neptune/clients/saturn.control.token
  set_config NEPTUNE_EXPORT_TOKEN_HOST_FILE /etc/neptune/clients/saturn.export.token
  set_config GRYPHON_SERVICE_TOKEN_HOST_FILE "$gryphon_token_file"
  needs_generation UPDATER_CONTROL_TOKEN && set_config UPDATER_CONTROL_TOKEN "$(random_hex 32)"
  set_config UPDATER_COMPOSE_PROJECT_DIR "$INSTALL_ROOT"
}

verify_updater_bundle() {
  [ -x "$UPDATER_BUNDLE/install.sh" ] || die "verified release is missing updater/install.sh"
  [ -x "$UPDATER_BUNDLE/updater-linux-amd64" ] || die "verified release is missing updater/updater-linux-amd64"
  [ -f "$UPDATER_BUNDLE/systemd/updater.service" ] || die "verified release is missing updater/systemd/updater.service"
}

prepare() {
  [ "$(id -u)" -eq 0 ] || die "prepare requires root"
  [ ! -e "$CONFIG_FILE" ] || die "configuration already exists; use the updater/repair workflow"
  verify_updater_bundle
  install -d -m 0700 "$(dirname "$CONFIG_FILE")"
  install -m 0600 "$INSTALL_ROOT/infra/production/.env.production.example" "$CONFIG_FILE"
  prepare_agent_mounts
  copy_local_kernel_bootstrap
  printf '%s\n' "Prepared $CONFIG_FILE"
  printf '%s\n' "Updater token and socket groups were generated automatically."
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
  [ -f "$CONFIG_FILE" ] || die "missing $CONFIG_FILE; run the signed bootstrap first"
  verify_updater_bundle
  prepare_agent_mounts
  copy_local_kernel_bootstrap
  validate
  "$UPDATER_BUNDLE/install.sh" saturn "$CONFIG_FILE" "$UPDATER_BUNDLE/updater-linux-amd64"
  set -a; . "$CONFIG_FILE"; set +a
  docker pull "$VAULT_APP_IMAGE"
  docker pull "$VAULT_WEB_IMAGE"
  docker network inspect exocortex-services >/dev/null 2>&1 || docker network create exocortex-services >/dev/null
  docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" up -d postgres
  docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" run --rm migrate
  docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" up -d worker api web
  attempts=0
  until docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" exec -T api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
    attempts=$((attempts+1)); [ "$attempts" -lt 60 ] || { bounded_logs; die "candidate readiness timed out"; }; sleep 2
  done
  attempts=0
  until docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" exec -T web node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
    attempts=$((attempts+1)); [ "$attempts" -lt 60 ] || { bounded_logs; die "web readiness timed out"; }; sleep 2
  done
  printf '%s\n' "Saturn API and web are healthy on loopback and registered with updater. Validate and reload the server Nginx configuration, then run vaultctl smoke before loading real data."
}

status() { docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" ps; }
bootstrap_storage() { docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" run --rm migrate node /app/scripts/storage-bootstrap.mjs; }
smoke() { docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" run --rm migrate node /app/scripts/storage-smoke.mjs; }

enable_backup() {
  [ "$(id -u)" -eq 0 ] || die "backup setup requires root"
  need updater; need openssl; [ -f "$CONFIG_FILE" ] || die "missing $CONFIG_FILE"
  prepare_agent_mounts
  updater register-head saturn "$CONFIG_FILE"
  updater neptune install --head saturn
  enrollment_code=${NEPTUNE_ENROLLMENT_CODE:-}
  if [ -z "$enrollment_code" ]; then printf 'Saturn one-time setup code: ' >&2; stty -echo; trap 'stty echo' EXIT HUP INT TERM; IFS= read -r enrollment_code; stty echo; trap - EXIT HUP INT TERM; printf '\n' >&2; fi
  printf '%s\n' "$enrollment_code" | updater neptune enroll --head saturn --project saturn --export-url http://127.0.0.1:3000/api/v1/internal/neptune/backup
  unset enrollment_code
  printf '%s\n' "Saturn automatic backup is connected. Manage its schedule in Synchronization."
}

case "${1:-}" in
  prepare) prepare ;;
  validate) validate ;;
  install) install_release ;;
  status) status ;;
  bootstrap-storage) bootstrap_storage ;;
  smoke) smoke ;;
  backup) enable_backup ;;
  *) die "usage: install.sh prepare|validate|install|status|bootstrap-storage|smoke|backup" ;;
esac
