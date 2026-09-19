# Saturn

> Documentation authority: the workspace-wide [Part 00](https://github.com/psewdon1m-exocortex/general/blob/main/PART_00_SYSTEM_UNIFICATION_SPECIFICATION.md)
> and its applicable Parts are normative. This repository documents
> Saturn-specific details only; a conflict is corrected here and a material
> implementation difference follows the Part 00 divergence protocol.

## Required pre-push gate

After native checks and before every push, complete the checks required by
[Part 06 — Unified acceptance checklist](https://github.com/psewdon1m-exocortex/general/blob/main/PART_06_UNIFIED_ACCEPTANCE_CHECKLIST.md) and run the versioned policy in
`.github/pre-push-gate.json` through `scripts/pre-push-gate.py`. CI repeats the
gate on `main`. Security is always reviewed; backup/restore, updater, embedded
Documentation and affected technical docs are reviewed when relevant. Apply
SEO/GEO checks to intentionally public/indexable surfaces and concealment,
crawler and probe-resistance checks to private or authenticated surfaces.
Every area requires `PASS` evidence or a reasoned `N/A`.

## Required pre-release known-problem gate

Before a service-qualified release is finalized, evaluate every active ID in
[Part 12](https://github.com/psewdon1m-exocortex/general/blob/main/PART_12_KNOWN_DEPLOYMENT_AND_OPERATIONS_PROBLEMS.md) against the exact candidate. Retain
`known-problems-report.json` bound to the service revision, qualified tag,
immutable central-documentation revision and catalog digest. Missing, stale,
failed, unknown or unsupported `N/A` evidence blocks publication. The workflow
records exact-candidate Stage 13 evidence before signing, stages assets as a
prerelease, verifies their anonymous bytes and trust chain, attaches the final
report and only then makes the release discoverable.

Saturn is the Exocortex storage gateway and operator-facing file service. The
implementation entry point is [docs/implementation/README.md](docs/implementation/README.md);
the complete target architecture is documented in
[docs/technical_solution_storage_gateway.md](docs/technical_solution_storage_gateway.md).

После обычной установки создайте в Synchronization pipeline для namespace
`saturn` и одноразовый Neptune setup code. В Settings → Backup нажмите
**Initialize Neptune** и введите код. Updater установит отсутствующий агент
или подключит существующий. Neptune и Gryphon также устанавливаются автоматически
после регистрации Saturn, настройки Kernel Register и доверия к релизам. `sudo saturn-install backup` (старое имя `vaultctl backup` также
поддерживается) устанавливает отсутствующий агент и остаётся резервным
CLI-сценарием. Расписание задаётся только в Synchronization.

## Verification

Install the pinned workspace dependencies and run the production-like suite:

```sh
corepack enable
corepack prepare pnpm@11.24.0 --activate
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
python3 scripts/test-known-problems-gate.py
python3 scripts/known-problems-gate.py --phase structure
pnpm verify:stage:13
python3 scripts/pre-push-gate.py --upstream-result success
```

The final command evaluates the versioned seven-area policy in
[.github/pre-push-gate.json](.github/pre-push-gate.json). GitHub Actions runs the
same policy after native verification on every push to `main` and before a tag
release can publish artifacts.

## Release identity

Production releases are created only by tags matching
`saturn-vMAJOR.MINOR.PATCH`. The current fix identity is `saturn-v0.1.16`; its
versioned OCI repositories are `saturn-app` and `saturn-web`, and its
installation bundle is `saturn-0.1.16.zip`. Legacy unscoped tags such as
`v0.0.1` run verification only and cannot publish a Saturn release. Publish
the pinned `updater-v0.5.0` dependency before the Saturn tag. The existing
`saturn-v0.1.0` through `saturn-v0.1.15` releases remain immutable.

## Production installation

Each service keeps its own bootstrap and environment. For Saturn:

```sh
curl -fsSL https://github.com/psewdon1m-exocortex/saturn/releases/download/saturn-v0.1.16/bootstrap.sh | sudo sh
sudoedit /etc/vault/.env.production
sudo chmod 600 /etc/vault/.env.production
sudo vaultctl validate
sudo vaultctl install
sudo vaultctl status
curl -fsS http://127.0.0.1:3000/health/ready
sudo vaultctl bootstrap-storage
sudo vaultctl smoke
```

If an older Saturn release was prepared, refresh the bundle without deleting
the existing configuration. This also repairs the earlier Linux file-secret
validation failures:

```sh
curl -fsSL https://github.com/psewdon1m-exocortex/saturn/releases/download/saturn-v0.1.16/bootstrap.sh | sudo sh -s -- --refresh
```

Edit only these values in `/etc/vault/.env.production`:

```dotenv
VAULT_DOMAIN=exocortex-saturn.shmoza.net
PUBLIC_ORIGIN=https://exocortex-saturn.shmoza.net
OWNER_ACCESS_KEY=<operator-chosen-value>
KERNEL_URL=https://exocortex-kernel.shmoza.net
KERNEL_SERVICE_TOKEN=<normally-imported-from-the-local-Kernel-install>
STORAGE_HOST=<production-SFTP-host>
STORAGE_PORT=22
STORAGE_USER=<production-SFTP-user>
STORAGE_ROOT=.
STORAGE_HOST_FINGERPRINT=SHA256:<verified-fingerprint>
```

Bootstrap generates the database password and six independent application
peppers. It imports `/root/saturn-storage-ed25519` when that dedicated key
already exists; otherwise it generates a new production-only Ed25519 SFTP key.
The public counterpart is available with `sudo vaultctl storage-public-key` in
the format required by the configured SFTP port (RFC4716 for Hetzner port 22)
and must be authorized once on the Storage Box sub-account. The release-signing
key is never used for SFTP. `vaultctl validate` materializes `OWNER_ACCESS_KEY` as a
mode-`0600` Compose secret without exposing the plaintext value to application
containers. DEV identity and second-copy evidence are not runtime configuration
and do not block installation.

`OWNER_ACCESS_KEY` must be explicitly supplied but is otherwise an opaque exact
value. It has no minimum/maximum length, required or forbidden character class,
URL-safe/ASCII restriction, strength/entropy check or known/example/placeholder
denylist. Bootstrap, login, rotation and restore must not trim, normalize, fold
case or truncate it.

> Implementation gap (2026-09-14): the current installer restricts the key to
> at least 32 URL-safe characters, while the API and web rotation workflow
> enforce a 32–512-character range. These `BST-13` behaviors are not normative
> and block the next production release until code and tests are corrected.

On a same-host deployment, Kernel creates a one-time root-only
`/etc/exocortex/bootstrap-credentials/saturn.env`. Saturn imports and deletes
that file during prepare/refresh; it never reads `/opt/exocortex/kernel/.env`.
For an already installed Kernel, run `sudo kernel-install credentials` before
the Saturn bootstrap. If Kernel is on another host, fill `KERNEL_URL` and
`KERNEL_SERVICE_TOKEN` manually in Saturn's own `.env.production`.

Saturn's private signing keys remain only in GitHub Secrets and are exposed only to the protected
release job. CI derives and embeds the public counterparts in that versioned
bootstrap. On a clean host bootstrap creates
`/etc/exocortex/release-trust/saturn.pem` and
`/etc/vault/release-public-key.pem`, verifies the manifest before downloading
Saturn, and prepares only Saturn and `/etc/vault/.env.production`. An existing
mismatching trust key fails closed. No `scp`, manual release-key fingerprint or
separate public-key preparation is required. Kernel and Volt are installed by
their own bootstraps. All three expose loopback listeners and share the single
server-managed Nginx on ports 80/443.

## Production ingress

Saturn does not launch a reverse proxy and never binds host ports 80/443. The
production Compose file exposes API on `127.0.0.1:3000` and the static web
process on `127.0.0.1:8080` by default. Install
[`infra/production/nginx.saturn.conf.example`](infra/production/nginx.saturn.conf.example)
in the server-managed Nginx, set the real domain, certificate paths and exact
upstream ports, then require `nginx -t` before reload. The example exposes the
login and authenticated UI/API from every client IP while keeping health
host-local. Do not add `OPERATOR_CIDR`, a VPN prerequisite or a source-IP
allow-list: the Access Key and bounded Saturn session protect all owner data.
Saturn ships no embedded Nginx and uses no coturn; its HTTP/WebDAV/WebSocket
traffic stays behind server Nginx. It keeps
the global request-body limit at 16 MiB, exempts only streaming WebDAV PUTs so
Saturn enforces their configured size, and rejects unknown Host/SNI values in a
fail-closed default server.

## Runtime storage profile

The bootstrap `STORAGE_*` values remain the first-start fallback. API and worker
also require the same protected writable `STORAGE_RUNTIME_CONFIG_DIR` (default
`data/storage-runtime`; production `/var/lib/vault/storage-runtime`). An owner
may validate and select another SFTP target in Settings → Security. This rebuilds
the active catalog for that independent target and migrates no file bytes. See
[runtime storage switching](docs/implementation/RUNTIME_STORAGE_SWITCHING.md).

## Gryphon integration

Saturn does not connect to Telegram directly. Gryphon owns bot tokens and
webhooks, then calls Saturn's authenticated `POST /internal/gryphon/command`
adapter. Connect bot tokens with `sudo gryphon bot connect ALIAS`; **Link Saturn function**
in the Bot connection Settings card selects one of those bots through the
service-scoped `GRYPHON_SOCKET_PATH`. The installer provisions
`/etc/gryphon/clients/saturn.token`; Saturn never receives a bot token. When the
function is connected but no Telegram user is bound, **Initialize bot** creates
the one-time `/link CODE` challenge directly in Settings; `gryphon link issue
saturn` remains the equivalent CLI fallback.
The same Settings card can ask the privileged Updater to check or install a
verified Gryphon Linux release.
After linking, `/drop` creates a one-time Drop Point code immediately;
`/drop_status` and `/drop_revoke` inspect or revoke access.

The current six-service deployment, trust, recovery and acceptance contract is documented in [Deployment readiness](DEPLOYMENT_READINESS.md).

## Unified updates (protocol 2)

See [Update protocol, saved ZIP and first migration](docs/UPDATE-PROTOCOL.md).
The UI uses Updater **0.5.0**, an exact selected version, the standard ZIP saved
on the operator PC, and durable status/progress. Helper updates use the same
dialog without a backup. No update ZIP is retained on the application host.

Release builds pin the published Updater 0.5.0 installer by the SHA-256 in
`.release/updater.sha256` and verify it before extraction. This digest was
verified against the production-signed Updater manifest and existing trust key.
