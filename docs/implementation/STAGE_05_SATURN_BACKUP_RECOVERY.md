# Stage 5 — Saturn backup and recovery

Status: `COMPLETE`

## Purpose

Protect the Gateway control plane independently from user-file bytes. A Saturn
backup is a bounded, manifested ZIP containing a PostgreSQL logical dump and
safe operational material. It does not copy Drive data and it never contains a
plaintext credential, session, cache, build output or temporary upload.

## State contract

### Entry state

- Stages 0–4 are `COMPLETE` and their verification reports are accepted.
- PostgreSQL is authoritative for resources, versions, operations and audit.
- Storage reconciliation, version restore and trash restore pass.
- A writable local spool with an explicit byte limit is available.

### Intermediate state

- `BACKUP_PREPARING`: members are written beneath one random private spool
  directory; no archive is published.
- `BACKUP_VALIDATING`: the ZIP is closed and independently read, bounded and
  checked against its manifest.
- `BACKUP_COMMITTED`: the verified ZIP has been atomically renamed locally and,
  when configured, copied to `backups/gateway/` through
  `StorageAdapter`.
- `RESTORE_VALIDATING`: every ZIP entry, size, path, digest and allow-list rule
  is checked before a database command can run.
- `RESTORE_SNAPSHOTTING`: replacement restore creates and validates a
  pre-restore backup.
- `RESTORE_APPLYING`: `pg_restore` uses one PostgreSQL transaction. A failed
  command rolls back; a later validation/migration failure restores the
  pre-restore snapshot.
- `RESTORE_COMPLETE`: migrations and post-restore database checks pass and an
  evidence record contains measured RPO/RTO.

### Exit state

- A compatible empty database can be restored from a verified archive.
- Replacement restore has both PostgreSQL transaction rollback and a verified
  pre-restore snapshot fallback.
- Corrupt and hostile archives fail before database mutation.
- Archive bytes do not contain the configured known-secret corpus.
- Peak archive size, extracted spool size, entry count and elapsed recovery time
  are recorded in machine-readable evidence.
- The independent second-copy target and offline recovery-key procedure are
  documented as production provisioning dependencies.

## Archive contract

The ZIP has exactly these member classes:

| Member | Required | Meaning |
| --- | --- | --- |
| `manifest.json` | yes | Canonical manifest, schema and member digests |
| `database/database.dump` | yes | PostgreSQL custom-format logical dump |
| `metadata/*.jsonl` | yes | Portable, paged projections of authoritative tables |
| `config/public.json` | yes | Redacted effective configuration only |
| `deployment/compose.yaml` | yes | Deployment topology, without runtime secrets |
| `migrations/*.sql` | yes | Exact schema migration sources |
| `secrets/recovery.age` | optional | Operator-supplied already-encrypted bundle only |

`manifest.json` is not self-listed. Every other member has its exact uncompressed
size, SHA-256 and media type in the manifest. Unknown and duplicate members are
invalid.

## Safety limits

- ZIP paths must be NFC relative POSIX paths without `..`, backslashes, control
  characters or empty segments.
- Entry count, member size, total extracted size, archive size and compression
  ratio are hard limits loaded from validated configuration.
- CRC, declared size and SHA-256 are checked while streaming to a private spool.
- Validation completes before `pg_restore`, migrations or any database write.
- Partial archives use a random `.part` name and are never published.
- Spool directories are random, permission-restricted and removed on every exit.
- Secret input is accepted only as an already-encrypted `.age` file. The backup
  process never opens the corresponding plaintext secret source.

## Backup and restore schedules

- PostgreSQL logical backup: every 6 hours.
- Full manifested Saturn backup: nightly.
- Portable metadata export: daily (included in each full backup).
- Automated isolated restore drill: weekly.
- Metadata RPO target: 6 hours.
- Gateway RTO target: 4 hours.

Only one scheduled backup or restore may run at a time. Production publication
uses the Gateway's PROD `StorageAdapter`; services never receive Storage Box
credentials.

## Verification

1. Quality gates and migration `0004_recovery` apply/down/apply.
2. Clean restore into an empty compatible database.
3. Replacement restore after a pre-restore snapshot.
4. Injected restore failure leaves the original database unchanged.
5. Traversal, duplicate, unknown-member, oversized member, excessive ratio,
   corrupt ZIP and digest mismatch rejection before mutation.
6. Known-secret byte scan over the final ZIP and extracted safe members.
7. Archive/spool byte accounting and process-RSS delta evidence.
8. Local `StorageAdapter` publication/read-back checksum and cleanup.

The accepted report is written to
`artifacts/verification/stage-05-vault-backup-recovery.json` and its SHA-256 is
`407af1310cc38aadde170a71f62c872088853f094a742ac0d3d459b472d7d37f`.

Accepted evidence: 9/9 aggregate checks, including frozen install, lint,
typecheck, all workspace tests, production builds, migration apply/down/apply,
20-member archive validation, StorageAdapter publication/read-back, clean and
replacement PostgreSQL restores, injected-failure rollback, hostile archive
matrix and complete spool cleanup. The fixture measured 229 ms clean-restore
RTO, 607 ms replacement-restore RTO, 51,820 extracted bytes and a 13,828,096
byte process-RSS delta. These fixture measurements prove instrumentation and
bounds; they are not production capacity claims.

Operator entry points:

- `pnpm recovery backup`
- `pnpm recovery validate <archive>`
- `pnpm recovery restore-clean <archive>`
- `pnpm recovery restore-replace <archive> --confirm-replace`

## Rollback and recovery sequence

1. Stop mutating Gateway traffic.
2. Validate the selected backup fully.
3. Create and validate a pre-restore snapshot.
4. Apply the logical dump in one PostgreSQL transaction.
5. Apply forward migrations and run schema/count/integrity checks.
6. On failure, restore the verified snapshot and record a failed drill.
7. Run storage reconciliation in dry-run/metadata mode.
8. Verify critical resources, audit continuity and health before traffic resumes.

## Production dependencies not fabricated by development

- A second encrypted copy target independent from Hetzner Storage Box.
- An offline recovery key held separately from both copies.
- A PROD PostgreSQL client version compatible with the server (`pg_dump` and
  `pg_restore`).
- Operator-approved retention and periodic restore-drill schedule.

DEV proves the mechanism with disposable databases and storage namespaces. It
does not convert the DEV sub-account into PROD and does not manufacture or store
production recovery keys.
