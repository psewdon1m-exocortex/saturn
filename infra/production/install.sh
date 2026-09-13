#!/bin/sh
set -eu
umask 077

INSTALL_ROOT=${VAULT_INSTALL_ROOT:-/opt/vault}
CONFIG_FILE=${VAULT_CONFIG_FILE:-/etc/vault/.env.production}
COMPOSE_FILE="$INSTALL_ROOT/compose.production.yaml"
UPDATER_BUNDLE="$INSTALL_ROOT/updater"
SECRET_ROOT=/etc/vault/secrets
LEGACY_STORAGE_KEY=/root/saturn-storage-ed25519
STORAGE_PUBLIC_KEY=/etc/vault/storage_public_key.pub
STORAGE_PUBLIC_KEY_RFC4716=/etc/vault/storage_public_key.rfc4716.pub
GRYPHON_VALIDATION_SECRET="$SECRET_ROOT/gryphon_service_token"

die() { printf '%s\n' "saturn install: $1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"; }
bounded_logs() { docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" logs --tail 100 --no-color 2>/dev/null || true; }

get_config() {
  sed -n "s/^$1=//p" "$CONFIG_FILE" | tail -n 1
}

set_config() {
  key=$1; value=$2; temporary="$CONFIG_FILE.tmp"
  awk -v key="$key" -v value="$value" 'BEGIN { found=0 } index($0,key "=")==1 { print key "=" value; found=1; next } { print } END { if (!found) print key "=" value }' "$CONFIG_FILE" >"$temporary"
  chmod 0600 "$temporary"; mv -f "$temporary" "$CONFIG_FILE"
}

remove_config() {
  key=$1; temporary="$CONFIG_FILE.tmp"
  awk -v key="$key" 'index($0,key "=")!=1 { print }' "$CONFIG_FILE" >"$temporary"
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

apply_release_lock() {
  [ -n "${SATURN_BOOTSTRAP_RELEASE_VERSION:-}" ] || die "verified release version was not supplied by bootstrap"
  [ -n "${SATURN_BOOTSTRAP_APP_IMAGE:-}" ] || die "verified application image was not supplied by bootstrap"
  [ -n "${SATURN_BOOTSTRAP_WEB_IMAGE:-}" ] || die "verified web image was not supplied by bootstrap"
  set_config VAULT_RELEASE_VERSION "$SATURN_BOOTSTRAP_RELEASE_VERSION"
  set_config VAULT_APP_IMAGE "$SATURN_BOOTSTRAP_APP_IMAGE"
  set_config VAULT_WEB_IMAGE "$SATURN_BOOTSTRAP_WEB_IMAGE"
}

migrate_operator_config() {
  for obsolete in VAULT_DEV_STORAGE_USER VAULT_DEV_STORAGE_FINGERPRINT VAULT_SECOND_COPY_ID; do
    remove_config "$obsolete"
  done
  if ! grep -q '^OWNER_ACCESS_KEY=' "$CONFIG_FILE"; then
    temporary="$CONFIG_FILE.tmp"
    awk 'BEGIN { inserted=0 } { print } /^PUBLIC_ORIGIN=/ && !inserted { print "OWNER_ACCESS_KEY=replace-me-with-owner-access-key"; inserted=1 } END { if (!inserted) print "OWNER_ACCESS_KEY=replace-me-with-owner-access-key" }' "$CONFIG_FILE" >"$temporary"
    chmod 0600 "$temporary"; mv -f "$temporary" "$CONFIG_FILE"
  fi
  # 0.1.4 used a Compose-relative runtime env file. A refresh must make the
  # preserved machine config explicit before the new Compose file is evaluated.
  set_config VAULT_RUNTIME_ENV_FILE "$CONFIG_FILE"
}

prepare_generated_secrets() {
  need openssl; need ssh-keygen
  install -d -o root -g root -m 0700 "$SECRET_ROOT"
  for name in database_password auth_pepper drop_pepper share_pepper device_pepper backup_pepper laboratory_pepper; do
    target="$SECRET_ROOT/$name"
    if [ -e "$target" ]; then
      [ -f "$target" ] && [ ! -L "$target" ] && [ -s "$target" ] || die "invalid existing secret: $target"
    else
      random_hex 32 >"$target"
    fi
    chown root:root "$target"; chmod 0600 "$target"
  done

  storage_key="$SECRET_ROOT/storage_private_key"
  if [ -e "$storage_key" ]; then
    [ -f "$storage_key" ] && [ ! -L "$storage_key" ] && [ -s "$storage_key" ] || die "invalid existing SFTP private key: $storage_key"
  elif [ -f "$LEGACY_STORAGE_KEY" ] && [ ! -L "$LEGACY_STORAGE_KEY" ] && [ -s "$LEGACY_STORAGE_KEY" ]; then
    ssh-keygen -y -f "$LEGACY_STORAGE_KEY" >/dev/null 2>&1 || die "$LEGACY_STORAGE_KEY is not a valid OpenSSH private key"
    install -o root -g root -m 0600 "$LEGACY_STORAGE_KEY" "$storage_key"
    printf '%s\n' "Imported the dedicated Saturn SFTP key from $LEGACY_STORAGE_KEY."
  else
    temporary_key="$SECRET_ROOT/.storage_private_key.new"
    rm -f "$temporary_key" "$temporary_key.pub"
    ssh-keygen -q -t ed25519 -N '' -C saturn-production-storage -f "$temporary_key"
    install -o root -g root -m 0600 "$temporary_key" "$storage_key"
    rm -f "$temporary_key" "$temporary_key.pub"
    printf '%s\n' "Generated a dedicated Saturn production SFTP key."
  fi
  chown root:root "$storage_key"; chmod 0600 "$storage_key"
  public_key_temporary="$STORAGE_PUBLIC_KEY.tmp"
  ssh-keygen -y -f "$storage_key" >"$public_key_temporary"
  chmod 0644 "$public_key_temporary"; mv -f "$public_key_temporary" "$STORAGE_PUBLIC_KEY"
  rfc4716_temporary="$STORAGE_PUBLIC_KEY_RFC4716.tmp"
  ssh-keygen -e -m RFC4716 -f "$STORAGE_PUBLIC_KEY" >"$rfc4716_temporary"
  chmod 0644 "$rfc4716_temporary"; mv -f "$rfc4716_temporary" "$STORAGE_PUBLIC_KEY_RFC4716"
}

sync_owner_access_key() {
  owner_access_key=$(get_config OWNER_ACCESS_KEY)
  case "$owner_access_key" in
    ""|CHANGE_ME*|change-*|replace-*) die "set OWNER_ACCESS_KEY in $CONFIG_FILE" ;;
    *[!A-Za-z0-9_-]*) die "OWNER_ACCESS_KEY must contain only URL-safe letters, digits, underscore or hyphen" ;;
  esac
  [ "${#owner_access_key}" -ge 32 ] || die "OWNER_ACCESS_KEY must contain at least 32 characters"
  owner_temporary="$SECRET_ROOT/.owner_access_key.new"
  printf '%s\n' "$owner_access_key" >"$owner_temporary"
  chown root:root "$owner_temporary"; chmod 0600 "$owner_temporary"
  mv -f "$owner_temporary" "$SECRET_ROOT/owner_access_key"
}

sync_gryphon_validation_secret() {
  source_file=$(get_config GRYPHON_SERVICE_TOKEN_HOST_FILE)
  case "$source_file" in
    ""|CHANGE_ME*|change-*|replace-*) die "set GRYPHON_SERVICE_TOKEN_HOST_FILE in $CONFIG_FILE" ;;
  esac
  [ -f "$source_file" ] && [ ! -L "$source_file" ] && [ -s "$source_file" ] || die "invalid Gryphon service token: $source_file"
  install -o root -g root -m 0600 "$source_file" "$GRYPHON_VALIDATION_SECRET"
}

prepare_runtime_secrets() {
  prepare_generated_secrets
  sync_owner_access_key
  # The canonical token is group-readable for the Gryphon client socket. Stage
  # a root-only copy because production validation intentionally sees only the
  # isolated Vault secret root mounted at /run/secrets.
  sync_gryphon_validation_secret
}

import_kernel_bootstrap_credentials() {
  credential_file=/etc/exocortex/bootstrap-credentials/saturn.env
  current_url=$(get_config KERNEL_URL)
  current_token=$(get_config KERNEL_SERVICE_TOKEN)
  needs_url=false; needs_token=false
  case "$current_url" in ""|*CHANGE_ME*|*replace-me*|*.example.*)
    needs_url=true ;;
  esac
  case "$current_token" in ""|CHANGE_ME*|change-*|replace-*)
    needs_token=true ;;
  esac
  [ "$needs_url" = true ] || [ "$needs_token" = true ] || return 0
  [ -f "$credential_file" ] && [ ! -L "$credential_file" ] || return 0
  [ "$(stat -c '%u:%a' "$credential_file" 2>/dev/null)" = "0:600" ] || die "$credential_file must be root-owned with mode 0600"
  handoff_url=$(sed -n 's/^KERNEL_URL=//p' "$credential_file" | tail -n 1)
  handoff_token=$(sed -n 's/^KERNEL_SERVICE_TOKEN=//p' "$credential_file" | tail -n 1)
  case "$handoff_url" in https://*.*) ;; *) die "Kernel bootstrap credential has an invalid URL" ;; esac
  case "$handoff_url" in *CHANGE_ME*|*.example.*) die "Kernel bootstrap credential still contains an example URL" ;; esac
  [ "${#handoff_token}" -ge 24 ] || die "Kernel bootstrap credential has an invalid token"
  case "$handoff_token" in CHANGE_ME*|change-*|replace-*) die "Kernel bootstrap credential still contains a placeholder token" ;; esac
  [ "$needs_url" = false ] || set_config KERNEL_URL "$handoff_url"
  [ "$needs_token" = false ] || set_config KERNEL_SERVICE_TOKEN "$handoff_token"
  rm -f "$credential_file"
  unset handoff_token
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
  set_config NEPTUNE_CONTROL_TOKEN_FILE /run/neptune-control.token
  set_config NEPTUNE_EXPORT_TOKEN_FILE /run/neptune-export.token
  set_config GRYPHON_SERVICE_TOKEN_HOST_FILE "$gryphon_token_file"
  needs_generation UPDATER_CONTROL_TOKEN && set_config UPDATER_CONTROL_TOKEN "$(random_hex 32)"
  set_config UPDATER_COMPOSE_PROJECT_DIR "$INSTALL_ROOT"
}

verify_updater_bundle() {
  [ -x "$UPDATER_BUNDLE/install.sh" ] || die "verified release is missing updater/install.sh"
  [ -x "$UPDATER_BUNDLE/updater-linux-amd64" ] || die "verified release is missing updater/updater-linux-amd64"
  [ -f "$UPDATER_BUNDLE/systemd/updater.service" ] || die "verified release is missing updater/systemd/updater.service"
  for service in updater neptune gryphon; do
    [ -f "$UPDATER_BUNDLE/release-trust/$service.pem" ] || die "verified release is missing updater/release-trust/$service.pem"
  done
}

prepare() {
  [ "$(id -u)" -eq 0 ] || die "prepare requires root"
  [ ! -e "$CONFIG_FILE" ] || die "configuration already exists; use the updater/repair workflow"
  verify_updater_bundle
  install -d -m 0700 "$(dirname "$CONFIG_FILE")"
  install -m 0600 "$INSTALL_ROOT/infra/production/.env.production.example" "$CONFIG_FILE"
  apply_release_lock
  prepare_agent_mounts
  prepare_generated_secrets
  import_kernel_bootstrap_credentials
  printf '%s\n' "Prepared $CONFIG_FILE"
  printf '%s\n' "Runtime secrets, a dedicated SFTP key, Updater token and socket groups were prepared automatically."
  printf '%s\n' "Show the SFTP public key with: vaultctl storage-public-key"
  printf '%s\n' "Edit only OPERATOR INPUT, then run: vaultctl install"
}

refresh() {
  [ "$(id -u)" -eq 0 ] || die "refresh requires root"
  [ -f "$CONFIG_FILE" ] || die "missing existing $CONFIG_FILE"
  [ "$(stat -c '%a' "$CONFIG_FILE")" = 600 ] || die "configuration mode must be 0600"
  verify_updater_bundle
  migrate_operator_config
  apply_release_lock
  prepare_agent_mounts
  prepare_generated_secrets
  import_kernel_bootstrap_credentials
  printf '%s\n' "Refreshed the prepared Saturn release and preserved $CONFIG_FILE."
  printf '%s\n' "Deprecated DEV/second-copy fields were removed; set OWNER_ACCESS_KEY, then run: vaultctl validate && vaultctl install"
}

validate() {
  [ "$(id -u)" -eq 0 ] || die "validate requires root"
  need docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
  [ -f "$CONFIG_FILE" ] || die "missing $CONFIG_FILE"
  [ "$(stat -c '%a' "$CONFIG_FILE")" = 600 ] || die "configuration mode must be 0600"
  prepare_runtime_secrets
  set -a; . "$CONFIG_FILE"; set +a
  docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" config --quiet
  docker pull "$VAULT_APP_IMAGE" >/dev/null
  docker run --rm --user 0:0 --network none --read-only --security-opt no-new-privileges --cap-drop ALL --env-file "$CONFIG_FILE" -e OWNER_ACCESS_KEY= -e VAULT_SECRET_ROOT=/run/secrets -v "$CONFIG_FILE:/config/.env.production:ro" -v "$VAULT_SECRET_ROOT:/run/secrets:ro" "$VAULT_APP_IMAGE" node /app/scripts/validate-production.mjs /config/.env.production >/dev/null
}

refresh_runtime_secrets() {
  docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" run --rm --no-deps secret-runtime-init
}

install_release() {
  [ "$(id -u)" -eq 0 ] || die "install requires root"
  [ -f "$CONFIG_FILE" ] || die "missing $CONFIG_FILE; run the signed bootstrap first"
  verify_updater_bundle
  prepare_agent_mounts
  validate
  "$UPDATER_BUNDLE/install.sh" saturn "$CONFIG_FILE" "$UPDATER_BUNDLE/updater-linux-amd64"
  set -a; . "$CONFIG_FILE"; set +a
  docker pull "$VAULT_APP_IMAGE"
  docker pull "$VAULT_WEB_IMAGE"
  docker network inspect exocortex-services >/dev/null 2>&1 || docker network create exocortex-services >/dev/null
  refresh_runtime_secrets
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
bootstrap_storage() { refresh_runtime_secrets; docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" run --rm migrate node /app/scripts/storage-bootstrap.mjs; }
smoke() { refresh_runtime_secrets; docker compose --env-file "$CONFIG_FILE" -f "$COMPOSE_FILE" run --rm migrate node /app/scripts/storage-smoke.mjs; }
storage_public_key() {
  storage_port=$(get_config STORAGE_PORT)
  if [ "$storage_port" = 22 ]; then
    [ -s "$STORAGE_PUBLIC_KEY_RFC4716" ] || die "missing $STORAGE_PUBLIC_KEY_RFC4716; run the signed bootstrap first"
    cat "$STORAGE_PUBLIC_KEY_RFC4716"
  else
    [ -s "$STORAGE_PUBLIC_KEY" ] || die "missing $STORAGE_PUBLIC_KEY; run the signed bootstrap first"
    cat "$STORAGE_PUBLIC_KEY"
  fi
}

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
  refresh) refresh ;;
  validate) validate ;;
  install) install_release ;;
  status) status ;;
  bootstrap-storage) bootstrap_storage ;;
  smoke) smoke ;;
  storage-public-key) storage_public_key ;;
  backup) enable_backup ;;
  *) die "usage: install.sh prepare|refresh|validate|install|status|bootstrap-storage|smoke|storage-public-key|backup" ;;
esac
