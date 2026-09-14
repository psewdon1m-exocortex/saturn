# Saturn production operations

This document specializes [Part 04 — bootstrap and deployment](https://github.com/psewdon1m-exocortex/general/blob/main/PART_04_BOOTSTRAP_AND_DEPLOYMENT.md); that central contract remains authoritative.

## Promotion boundary

DEV and PROD are independent installations. PROD requires its own Storage Box
sub-account, SSH key, host fingerprint, database, secret set and canonical
HTTPS domain. Never copy the DEV `.env`, database, key or sub-account into PROD.
The main Storage Box account is offline break-glass only.

The repository has two separate pipelines. `.github/workflows/verify.yml` runs
the complete production-like gate for pull requests, `main` and legacy
unscoped `v*` tags. The release workflow accepts only protected
`saturn-vMAJOR.MINOR.PATCH` tag pushes, builds candidate OCI images once with
SBOM/provenance, tests those exact digests, signs the release manifest and
refuses replacement of existing version tags/releases. Publish the pinned
Updater release first. Updater 0.4.0 introduced module-scoped Saturn tag
resolution; the current coordinated deployment baseline requires 0.4.4 or
newer.
The Ed25519 and RSA private keys exist only in GitHub Secrets and are exposed
only to the protected release-signing job. CI derives the public counterparts
and embeds them in the exact versioned `bootstrap.sh`. On a clean host bootstrap
creates `/etc/exocortex/release-trust/saturn.pem` and
`/etc/vault/release-public-key.pem`, verifies the signed manifest before any
service download and never replaces an existing mismatching key automatically.
No `scp`, manual release-key fingerprint or separately downloaded public key is
part of this trust path.
Every signed Saturn bundle also contains the checksum-verified Updater version
pinned in `.release/updater.version`; CI refuses to build with another version.

## First installation

1. Select an explicit immutable `saturn-vX.Y.Z` release and run that release's
   HTTPS `bootstrap.sh` as root. Its embedded Ed25519 and RSA public keys are
   written to the two local trust paths before bootstrap verifies the signed
   manifest; only after verification may it trust image digests or download
   service files. It writes the verified release version and immutable image
   digests into the machine-owned release lock, generates the database password,
   six application peppers, a dedicated production SFTP key, the Updater token
   and socket group IDs, and preserves existing values. If
   `/root/saturn-storage-ed25519` already contains a dedicated SFTP key, it is
   imported; otherwise a new key is generated. Release-signing keys are never
   used for storage. Kernel's installer supplies its URL and service token in a
   one-time root-only Saturn handoff. Saturn consumes and deletes that file; it
   never reads Kernel's `.env`. Run `kernel-install credentials` first when
   Kernel was installed before this handoff contract.
2. Confirm the bootstrap reported the verified manifest and immutable image
   digests and that neither trust file conflicts with an existing key.
3. Edit only `VAULT_DOMAIN`, `PUBLIC_ORIGIN`, `OWNER_ACCESS_KEY`, `KERNEL_URL`,
   an otherwise automatically imported `KERNEL_SERVICE_TOKEN`, and the five
   `STORAGE_*` values in `/etc/vault/.env.production`; keep mode `0600`.
   `OWNER_ACCESS_KEY` is the exact opaque value entered on the login page. It
   must be explicitly present but has no minimum/maximum length, character-set,
   URL-safe/ASCII, strength/entropy or value-denylist policy and must not be
   trimmed or normalized. The current 32-character/URL-safe validator is a
   release-blocking `BST-13` implementation gap, not an operator requirement.
   Set `VAULT_DOMAIN` and
   `PUBLIC_ORIGIN=https://VAULT_DOMAIN` to the same canonical hostname.
4. Authorize the output of `vaultctl storage-public-key` once on the production
   Storage Box sub-account if that dedicated key was not already authorized.
   The command emits RFC4716 for Hetzner SFTP port 22 and OpenSSH format for
   other configured ports.
   Do not copy or install a release-signing private key on the server.
5. Run `vaultctl validate`, then `vaultctl install`. Validation materializes the
   owner Access Key as a protected file secret. The latter installs or
   safely upgrades the bundled Updater and registers the `saturn` head before
   starting Saturn API and web processes on loopback only. Host secret files
   remain `root:root 0600`; a root-only, networkless validation container reads
   them, and a one-shot initializer copies application-readable forms into a
   Docker-owned volume so the long-running containers remain non-root.
6. Copy `infra/production/nginx.saturn.conf.example` into the server Nginx
   configuration, replace the domain and certificate paths, run `nginx -t`,
   and reload Nginx. Keep upstreams aligned with `SATURN_API_BIND_PORT` and
   `SATURN_WEB_BIND_PORT`. The owner login and authenticated UI/API are
   reachable from every client IP; do not add `OPERATOR_CIDR`, a VPN prerequisite
   or a source-IP allow-list. Detailed health remains loopback-only; the
   redacted `/api/v1/public/reachability` route exposes only the aggregate
   readiness result. Preserve the
   fail-closed HTTP/HTTPS `default_server` blocks. The global
   `client_max_body_size 16m` remains in force except in the exact `/dav` and
   prefix `/dav/` locations, where `0` permits a streaming whole-file PUT and
   Saturn remains the authoritative size limit.
7. Run `vaultctl bootstrap-storage` and `vaultctl smoke` with the production
   environment. The smoke object must be deleted automatically.
8. Verify canonical HTTPS, DNS and unauthorised external exposure before loading
   real data. Independent second-copy delivery and restore evidence remain a
   separate disaster-recovery procedure; they are not Saturn runtime variables.

For a host with an older prepared release, run the `0.1.12` bootstrap with
`--refresh`. It preserves
`/etc/vault/.env.production`, removes the obsolete `VAULT_DEV_STORAGE_*` and
`VAULT_SECOND_COPY_ID` entries, repairs the absolute runtime env path, writes
the new release lock, and preserves the old bundle under
`/opt/vault.previous-<timestamp>`:

```sh
curl -fsSL https://github.com/psewdon1m-exocortex/saturn/releases/download/saturn-v0.1.12/bootstrap.sh | sudo sh -s -- --refresh
```

`READINESS_TIMEOUT_MS` defaults to 3000 ms and bounds database, storage and
worker checks in parallel. `STORAGE_HEALTH_TIMEOUT_MS` defaults to 3000 ms and
must not exceed either readiness or ordinary storage-operation timeout. The
production Compose healthcheck allows 5 seconds; do not raise readiness beyond
its validated 4500 ms ceiling.

## Update and rollback

Before every migration, create and validate a Saturn recovery archive and a
logical PostgreSQL snapshot. Start the candidate API/worker/web processes
before switching server Nginx. Retain the prior image digests and snapshot until the new release has
passed readiness, authenticated E2E and recovery verification.

If a candidate gate fails, do not switch traffic. If post-switch health fails,
restore the prior image references and server Nginx upstream configuration. Use a database
rollback only when the release manifest declares the migration reversible;
otherwise restore the verified pre-update snapshot. Preserve bounded redacted
logs and reconciliation evidence.

## Backup and disaster recovery

- The baseline metadata RPO/RTO values are machine defaults. Change them only as
  part of an approved disaster-recovery policy review.
- The worker publishes portable Saturn recovery archives through the Gateway
  storage adapter. A separate independent second-copy system must copy and
  verify those archives outside the primary Storage Box. This evidence is
  checked operationally and is not faked by a string in the runtime `.env`.
- Quarterly, restore to a clean PostgreSQL instance and isolated Gateway,
  reconcile metadata/bytes, and record elapsed RPO/RTO evidence.
- Deployment secrets are not part of application backup. Restore them from the
  separately encrypted operator procedure and rotate them after a suspected
  disclosure.

## Exposure and incidents

Saturn publishes only `127.0.0.1:3000` for API and `127.0.0.1:8080` for its
static web process by default. The independently managed server Nginx is the
only component that owns public ports 80/443 and TLS certificates. PostgreSQL,
worker health and SFTP transport remain on internal networks. Verify this from
an unauthorized external network; an internal scan is insufficient evidence.
After every ingress change, verify that an unknown HTTP Host is closed without
a response, an unknown TLS SNI is rejected during the handshake, spoofing
`X-Forwarded-For: 127.0.0.1` does not expose host-local health, the login page
is reachable externally, and an anonymous protected API request returns
`401`. All routes are non-indexable by default and unknown paths on the
canonical host return bounded `404` responses.

If a secret enters a log, screenshot, cache, image or archive, treat it as
disclosed: stop promotion, revoke/rotate it from a clean environment,
quarantine evidence, rebuild from clean bytes, verify runtime state and add a
regression test.

## Provider exit

Quiesce writes, set `VAULT_EXIT_QUIESCED=true`, then run
`node scripts/storage-exit.mjs <empty-local-root> <manifest.json>`. The command
uses `StorageAdapter` only, enforces a byte cap and compares SHA-256 after every
copy. Import the resulting tree into another adapter and compare the manifest,
database stable IDs and active Gateway URLs before changing the
backend configuration.

## Runtime target change

Use Settings → Security → Advanced security → Storage connection for an
operator-approved target change. Recent owner proof, exact host fingerprint and
a successful connection test are mandatory. A switch rebuilds the active
catalog from the target and migrates no bytes; it also revokes active shares,
devices and pending transfers so capabilities cannot cross file sets. API and
worker must mount the same mode-`0700` `STORAGE_RUNTIME_CONFIG_DIR`. To return,
select the prior target and submit its credential again.
