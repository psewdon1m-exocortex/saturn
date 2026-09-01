# Stage 4 — Versions, trash, reconciliation and audit

Status: `COMPLETE`  
Aggregate command: `pnpm verify:stage:4`  
Machine-readable evidence: `artifacts/verification/stage-04-protection-audit.json`  
Evidence SHA-256: `e396bf55e631a3df2fd81e63929eb5615cb4cc2e205b040bcdf48f56de1704ac`

## Entry state

- Stage 3 is `COMPLETE` with a successful 13-check aggregate report.
- Verified file commits are checksum-gated, mutations are locked and journaled,
  and soft-delete already moves bytes to the normative trash tree.
- The local PostgreSQL/SFTP fixture and the real DEV `StorageAdapter` contract
  both pass.

## Work and intermediate states

1. **Schema ready:** version policy, overwrite target, append-only audit and
   reconciliation run/issue tables have paired migrations.
2. **Reversibility ready:** overwrite archives the previous current version;
   version restore and trash restore pass round trips.
3. **Reconciliation ready:** missing, orphaned, size mismatch, checksum mismatch
   and interrupted journal states produce deterministic database state.
4. **Audit ready:** security-relevant actions emit structured events through a
   single recursive redactor; update/delete of audit rows is denied.
5. **Retention ready:** category count/age boundaries and purge eligibility are
   deterministic; physical purge remains fail-closed until all restore tests
   pass and an explicit configuration switch is enabled.
6. **Verified:** aggregate local/DEV tests and secret-corpus scans are accepted.

## Required output state

- Overwrite and delete are reversible under their configured policies.
- The current file is distinct from archived immutable versions.
- Stable `resource_id` survives overwrite, version restore and trash restore.
- Database/storage divergence is recorded as a typed reconciliation issue;
  orphans are moved only into a run-specific `_system/orphans` namespace.
- Audit is append-only, bounded on read/export and free of raw secrets.
- Operational logs are bounded by container byte/count limits and audit/export
  queries are bounded by count and time window.
- Purge cannot run early, cannot run while disabled and has explicit audit.

All output conditions were accepted in a single 10-check aggregate run. The
workspace contained 29 passing automated tests at acceptance. The live DEV
round-trip used a generated `_vault-stage4-live-*` namespace and confirmed
overwrite, version restore, trash restore and exact cleanup.

## Verification contract

- migration apply/rollback/re-apply;
- overwrite → inspect versions → restore old → checksum equality;
- trash → restore → same `resource_id` and bytes;
- retention edge fixtures for general, Mastermind and KeePass policies;
- missing, orphan, size mismatch, hash mismatch and interrupted-operation
  reconciliation fixtures;
- audit immutability, recursive redaction and known-secret corpus scan;
- bounded activity page and streaming export memory check;
- exact cleanup of local and live DEV verification namespaces.

## Rollback

- Before a new version becomes current, the old current file is archived. A
  metadata failure triggers inverse storage renames; an inverse failure remains
  journaled for reconciliation.
- Restore uses the same lock/journal/rollback pattern and never deletes the
  previously current bytes before the transaction commits.
- Reconciliation never destroys unknown bytes: it marks, alerts or moves an
  orphan into a generated quarantine namespace.
- Purge defaults to disabled. Rollback of application code does not require
  destructive schema rollback after real Stage 4 metadata exists.

## Stage 5 handoff

Stage 5 may start only after restore paths and reconciliation are accepted,
because Saturn-level backup/restore must preserve versions, trash, audit and
operation journals as authoritative state.
