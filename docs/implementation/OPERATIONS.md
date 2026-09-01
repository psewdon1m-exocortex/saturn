# Saturn production operations

## Promotion boundary

DEV and PROD are independent installations. PROD requires its own Storage Box
sub-account, SSH key, host fingerprint, database, secret set and canonical
HTTPS domain. Never copy the DEV `.env`, database, key or sub-account into PROD.
The main Storage Box account is offline break-glass only.

The repository has two separate pipelines. `.github/workflows/verify.yml` runs
the complete production-like gate for pull requests and `main`. The release
workflow accepts only protected semantic-version tag pushes, builds candidate
OCI images once with SBOM/provenance, tests those exact digests, signs the
release manifest and refuses replacement of existing version tags/releases.
The Ed25519 private key exists only in the protected release environment; the
installer receives the public key through an independent trust channel.

## First installation

1. Verify the signed release manifest and immutable image digests.
2. Run the pinned HTTPS bootstrap as root. It prepares files and stops.
3. Edit only `OPERATOR INPUT` in `/etc/vault/.env.production`; keep mode `0600`.
4. Place the nine distinct secret files in `VAULT_SECRET_ROOT`, each mode
   `0600`, and keep the release signing private key outside the host.
5. Run `vaultctl validate`, then `vaultctl install`.
6. Run `pnpm prod:bootstrap-storage` and `vaultctl smoke` with the production
   environment. The smoke object must be deleted automatically.
7. Verify canonical HTTPS, DNS, unauthorised external exposure and second-copy
   delivery before loading real data.

`READINESS_TIMEOUT_MS` defaults to 3000 ms and bounds database, storage and
worker checks in parallel. `STORAGE_HEALTH_TIMEOUT_MS` defaults to 3000 ms and
must not exceed either readiness or ordinary storage-operation timeout. The
production Compose healthcheck allows 5 seconds; do not raise readiness beyond
its validated 4500 ms ceiling.

## Update and rollback

Before every migration, create and validate a Saturn recovery archive and a
logical PostgreSQL snapshot. Start the candidate API/worker before switching
the edge. Retain the prior image digests and snapshot until the new release has
passed readiness, authenticated E2E and recovery verification.

If a candidate gate fails, do not switch traffic. If post-switch health fails,
restore the prior image references and edge configuration. Use a database
rollback only when the release manifest declares the migration reversible;
otherwise restore the verified pre-update snapshot. Preserve bounded redacted
logs and reconciliation evidence.

## Backup and disaster recovery

- RPO and RTO are operator inputs checked by the production validator.
- The worker publishes portable Saturn recovery archives through the Gateway
  storage adapter. A separate independent second-copy system must copy and
  verify those archives outside the primary Storage Box.
- Quarterly, restore to a clean PostgreSQL instance and isolated Gateway,
  reconcile metadata/bytes, and record elapsed RPO/RTO evidence.
- Deployment secrets are not part of application backup. Restore them from the
  separately encrypted operator procedure and rotate them after a suspected
  disclosure.

## Exposure and incidents

Only the edge publishes ports 80/443. PostgreSQL, API, worker health and SFTP
transport remain on internal networks. Verify this from an unauthorized
external network; an internal scan is insufficient evidence. All routes are
non-indexable by default and unknown paths return bounded `404` responses.

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
