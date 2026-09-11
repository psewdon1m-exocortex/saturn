# Stage 13 — Production hardening, deployment and exit

Status: `BLOCKED` on external production inputs  
Implementation result: `READY_FOR_PRODUCTION_ACTIVATION`

## Purpose

Promote the verified Gateway as an immutable production release, prove the
DEV/PROD/storage/exposure boundaries, exercise rollback and disaster recovery,
and hand over a reproducible operating system rather than a developer setup.

## State contract

### Entry state

- Stages 0–12 are `COMPLETE` with machine-readable reports.
- Operator supplies a dedicated PROD Storage Box sub-account, separate PROD
  SSH key, verified host fingerprint, canonical HTTPS domain and VPS/reverse
  proxy target. DEV credentials and data remain separate and are never promoted.
- Independent second-copy destination and acceptable production RPO/RTO are
  explicitly recorded; break-glass main-account credentials remain offline.
- No real data is loaded until empty-PROD smoke and rollback gates pass.

### Intermediate state

- `RELEASE_BUILT`: source/dependency lock produces immutable API, worker and web
  artifacts plus image digests and SBOM/provenance evidence.
- `PROD_BOOTSTRAPPED`: restricted secret files, PostgreSQL, server Nginx and
  the PROD Gateway sub-account exist; canonical `drive`, `backups` and `_system`
  structure is created through the Gateway/storage bootstrap only.
- `CANDIDATE_HEALTHY`: new release runs on a secondary port, migrations and
  readiness pass, storage identity is pinned and no public route is switched.
- `TRAFFIC_SWITCHED`: server Nginx atomically directs traffic to the healthy
  candidate; prior immutable image and pre-migration database backup remain.
- `ROLLBACK_PROVEN`: application/proxy rollback and compatible database restore
  return the previous release without silent data loss.
- `DR_PROVEN`: a clean host restores PostgreSQL/metadata, reconnects ordinary
  files through `StorageAdapter`, reconciles and meets recorded RPO/RTO.
- `EXIT_PROVEN`: independent export/import to an alternative backend preserves
  bytes, hashes, stable IDs and Laboratory URLs.

### Exit state

- Saturn API/web listeners remain on host loopback; only the server-managed
  Nginx exposes approved HTTPS routes. PostgreSQL, worker and SFTP transport are
  not publicly reachable from an unauthorized vantage.
- PROD uses only its own sub-account/key/secrets/database; DEV remains a test
  sandbox and main account remains offline break-glass.
- upload/read/download/checksum/delete smoke passes on generated PROD data
  before real data; no smoke object remains.
- backup, second copy, clean-host restore, failed-restore rollback, update
  rollback, reconciliation and alert delivery are evidenced.
- load and failure injection stay within measured CPU/RAM/connection/spool
  limits; public asset traffic has an explicit Gateway-only or CDN decision.
- all applicable unified acceptance items pass; exclusions, residual risks,
  secret-rotation steps and operator commands are documented.

## Deployment order

1. Verify PROD hostname, SSH fingerprint, key-only path and empty namespace.
2. Install restricted secret files; validate production config offline.
3. Build once, record image/artifact digests, scan dependencies and artifacts.
4. Back up PostgreSQL and portable metadata; verify the backup before mutation.
5. Start candidate API/worker on secondary ports and run migrations.
6. Run readiness plus generated upload → read → Range → checksum → delete smoke.
7. Switch the server Nginx upstream and run authenticated/public
   external-vantage tests.
8. Observe bounded logs/metrics and execute a non-destructive failure drill.
9. Retain previous image and execute the documented rollback rehearsal.
10. Load real data only after the release gate is signed off; keep DEV intact.

## Verification

1. Frozen install, reproducible build/digest, SBOM and known-secret/vulnerability
   gates with documented severity policy.
2. Production configuration rejects HTTP origin, password SFTP, placeholders,
   world-readable secrets and DEV credential/path reuse.
3. Network exposure scan from authorized and unauthorized vantage points.
4. Empty-PROD directory bootstrap and exact smoke cleanup.
5. Blue/green candidate health, migration compatibility, proxy switch and
   application/database rollback.
6. Storage timeout, PostgreSQL loss after rename, process restart during upload,
   checksum mismatch, spool pressure and client disconnect injection.
7. Complete owner/Drop/share/WebDAV/backup/Laboratory functional E2E, including
   a whole-file WebDAV PUT larger than the global 16 MiB Nginx limit.
8. Full backup plus independent second-copy verification and clean-host restore
   with measured RPO/RTO.
9. Alternative-backend exit import/compare for bytes, SHA-256, stable IDs,
   active links.
10. Final audit/log/recovery/image secret scan, residual-risk register and
    operator handoff checklist.

## Rollback

1. Stop traffic promotion when any candidate gate fails; PROD remains on the
   prior release.
2. If post-switch health fails, return proxy to the prior immutable image and
   follow the migration-specific rollback/restore decision recorded in release
   metadata.
3. Never substitute DEV sub-account, DEV database or main break-glass
   credentials into PROD as an emergency shortcut.
4. Preserve failed-release logs, database snapshot and reconciliation evidence;
   rotate any credential suspected of exposure before retry.

## External prerequisites not fabricated by development

- PROD sub-account and verified key/fingerprint;
- DNS and TLS control for the canonical domain;
- VPS/server Nginx target and authorized external test vantage;
- independent second-copy target;
- operator-approved public Laboratory mode, RPO/RTO and maintenance window.

## Local implementation evidence

The production implementation and isolated production-like gate pass locally.
The machine report `artifacts/verification/stage-13-production-hardening.json`
contains 13 passing checks, including the complete workspace test suite,
hardened immutable images,
signed release tamper rejection, exact storage smoke cleanup, HTTPS Gateway
E2E through server Nginx, a verified 17 MiB WebDAV PUT, fail-closed unknown
Host/SNI and simulated outside-CIDR/spoofed-forwarding-header denial,
loopback/probe isolation, SFTP/PostgreSQL outage recovery, rejected bad candidate,
clean-host database restore, alternative-backend exit and final secret scans.

This evidence does not claim a real PROD deployment, independent second-copy
restore or unauthorized external-vantage scan. Those require the operator-owned
inputs above and are tracked in `PRODUCTION_READINESS.md`. Until those gates are
attached, Stage 13 remains `BLOCKED` and real data must not be loaded.
