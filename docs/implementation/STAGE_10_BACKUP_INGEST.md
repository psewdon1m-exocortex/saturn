# Stage 10 — Backup ingest for internal services

Status: `COMPLETE`

## Purpose

Accept producer-encrypted service backups over HTTPS through Gateway without
ever giving a producer Storage Box credentials, Drive access, historic backup
read access or authority over another producer. Make every accepted run
resumable, checksum-verified, receipted, retention-aware and observable to the
owner.

## State contract

### Entry state

- Stages 0–9 are `COMPLETE`.
- The upload state machine, SFTP adapter, audit, owner recent proof and Saturn
  metadata recovery are proven.
- No producer is enabled by default; the owner provisions each service with an
  explicit slug, limits and retention policy.
- Token authentication is the initial mandatory control. Optional mTLS
  fingerprint binding is supported by the identity model and enforced when a
  service is configured with one; certificate termination must pass the
  verified fingerprint to Gateway from a trusted proxy in production.

### Intermediate state

- `SERVICE_PROVISIONED`: owner recent proof creates an enabled service; a
  256-bit token is disclosed once and only a domain-separated HMAC verifier is
  stored.
- `RUN_PENDING`: an authenticated producer submits filename, source timestamp,
  type, expected size, SHA-256, source version and encryption declaration.
  Gateway derives the namespace from the authenticated identity, reserves
  quota atomically and returns an opaque `run_id`.
- `RUN_UPLOADING`: HEAD exposes only the producer's own offset; PATCH requires
  the exact offset and streams a bounded chunk to an `_system/incoming`
  object. Retries at an already committed offset are rejected without
  duplicating bytes.
- `RUN_VERIFYING`: complete closes the upload, verifies size and streaming
  SHA-256 and commits to the derived dated service path.
- `RUN_COMPLETE`: Gateway records an immutable receipt containing run/service
  identity, final logical path, size, digest and commit time. The producer may
  read status/receipt metadata for that run but never backup bytes.
- `RUN_FAILED`: checksum, limit, interruption or policy failures keep an
  explicit retryable/terminal state and release or preserve quota according to
  the documented reconciliation rule.
- `RESTORE_EVIDENCED`: owner records or executes an isolated restore/check drill
  for a completed run; freshness and last result appear in the dashboard.
- `SERVICE_REVOKED`: token rotation/revocation stops the next request without
  affecting other producers or committed backups.

### Exit state

- Producers communicate only with Gateway and cannot name or infer SFTP paths.
- Service identity, never a URL-supplied slug alone, selects the namespace.
- A producer can create/resume/complete/status only its own runs and cannot
  list, download, delete or change retention.
- Size, concurrent-run, daily-ingest and stored-byte quotas are transactionally
  enforced independently per service.
- Completed backup bytes match the declared SHA-256 and live under
  `/backups/<service>/<YYYY>/<MM>/<DD>/...` through `StorageAdapter`.
- Owner dashboard shows last success, freshness, usage, failures and last
  restore-test evidence; retention candidates are deterministic and owner/worker
  controlled, never producer controlled.
- Stable service/run/receipt/restore evidence is present in logical Saturn
  recovery exports; tokens, reservations and temporary paths are absent.

## API contract

Owner routes (cookie session + CSRF; mutations require recent proof):

```text
POST   /api/v1/backup-services
GET    /api/v1/backup-services
PATCH  /api/v1/backup-services/{id}
POST   /api/v1/backup-services/{id}/rotate-token
DELETE /api/v1/backup-services/{id}
GET    /api/v1/backup-services/{id}/runs
POST   /api/v1/backup-runs/{run_id}/restore-tests
```

Producer routes (`Authorization: Bearer <service-token>`; no browser cookies):

```text
POST  /api/v1/backups/{service_id}/runs
HEAD  /api/v1/backups/{service_id}/runs/{run_id}/upload
PATCH /api/v1/backups/{service_id}/runs/{run_id}/upload
POST  /api/v1/backups/{service_id}/runs/{run_id}/complete
GET   /api/v1/backups/{service_id}/runs/{run_id}
```

`service_id` in the path must exactly match the authenticated service and is
never used as the authorization source. There is deliberately no producer
list, content-download, delete or retention endpoint.

## Safety defaults

- token: 32 random bytes, base64url, one-time disclosure, HMAC verifier;
- service slug: lowercase DNS-label style, immutable and unique;
- encrypted archives required by default; accepted suffixes remain opaque;
- per-run maximum: validated configuration, never larger than global upload;
- exact `Upload-Offset` and bounded `Content-Length` required for PATCH;
- one active upload by default, with atomic daily/stored quota reservations;
- default retention: daily 7, weekly 4, monthly 12, yearly 3;
- incomplete runs expire after 24 hours and are reconciled before deletion;
- producer responses and logs never expose final physical storage paths,
  token verifiers, peer service data or backup bytes;
- mTLS identity headers are ignored unless the deployment marks its proxy hop
  trusted and a service explicitly binds a certificate fingerprint.

## Verification

1. Migration apply/down/apply and portable stable/ephemeral recovery policy.
2. One-time token, HMAC storage, rotation overlap policy, immediate revoke and
   optional mTLS mismatch.
3. Two services concurrently prove namespace, run-status and token isolation;
   forged path IDs and run IDs return indistinguishable denial.
4. Resumable HEAD/PATCH, restart continuation, wrong offset, oversize chunk and
   duplicate-complete/idempotency behavior.
5. Exact SHA-256 commit and checksum/size mismatch cleanup with no visible
   partial final object.
6. Atomic max-run, concurrent, daily and stored quota boundaries under races.
7. Producer privilege matrix proves no list/read/delete/Drive/retention access.
8. Deterministic GFS retention selection without producer deletion authority.
9. Isolated generated archive restore/check fixture records success and failure
   evidence without executing untrusted content.
10. Owner dashboard browser/Axe checks plus audit, log, backup and built-artifact
    secret scans.

## Rollback

1. Disable the producer API globally or revoke one service token.
2. Stop new run creation; let verified completions finish or reconcile
   incomplete `_system/incoming` objects by journal state.
3. Preserve committed backup objects and receipt metadata; rollback does not
   route them through Drive trash.
4. Export service/run/receipt/restore evidence before rolling back the schema.

## Implemented result and evidence

- Migration `0009_backup_ingest` adds service identities, resumable run/receipt
  state and restore-test evidence without creating producer-readable resources.
- `@saturn/backup-ingest` derives every namespace from authenticated identity,
  streams through `StorageAdapter`, atomically reserves concurrent/daily/stored
  quota and publishes only after exact size/SHA-256 verification.
- Producer API exposes only create, offset/resume, append, complete and own-run
  status. Owner UI provisions, rotates and revokes one-time tokens and displays
  freshness, usage, failures and restore status.
- `pnpm verify:stage:10` passed 14 aggregate checks on 2026-08-26: 67 tests and
  builds, migration rollback, restart/resume, upload-only isolation, bounds,
  isolated gzip restore, checksum cleanup, quota races, optional mTLS, GFS
  preview, rotation/revoke, browser/Axe and secret/recovery scans.
- Machine report: `artifacts/verification/stage-10-backup-ingest.json`
  (SHA-256 `b19ea864e95436c07935c80c4ef8ec3ef278e7383fd140015bc00932ed2e6cf0`).
