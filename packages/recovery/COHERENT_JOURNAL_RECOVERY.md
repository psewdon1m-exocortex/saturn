# Coherent journal backup and guarded recovery

This increment supports the **inactive** `0048_sync_root_journal` foundation. It does not qualify writer coverage, enable snapshot/feed/new-engine capabilities, or resume an activated root after a logical restore.

## One database cut

`PostgresCommandToolchain.createCoherentBackup` opens one `REPEATABLE READ READ ONLY` transaction, inspects the journal shape and counts there, exports `pg_export_snapshot()`, and passes that exact identity to `pg_dump --snapshot`. The metadata exporter receives the same SQL transaction; it must not call its own `exportTo` or select another connection/snapshot. The transaction ends after dump/JSONL construction and dump hashing. ZIP validation, archive publication, HTTP and SFTP run outside it.

`metadata/coherence.json` binds the snapshot identity/time, decimal counts, dump policy and dump SHA-256. Its clock-cut reference names the streamed `sync_root_clock.jsonl`; it does not accumulate all roots in a manifest array. JSONL is **diagnostic material from the same cut**, not an independent restore authority. The custom-format PostgreSQL dump remains the authoritative logical database artifact. The transient snapshot identity is not a durable feed cursor or epoch.

The design uses PostgreSQL's documented [snapshot synchronization](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION) and [`pg_dump --snapshot`](https://www.postgresql.org/docs/16/app-pgdump.html). Table selection and policy are determined inside that snapshot, before invoking the external command or creating export members. A partial/unknown journal shape fails closed.

## Durable dependency policy

For an unregistered catalog, the existing exclusions remain: `operation_journal` and `upload_sessions` data are excluded together with other transient tables. Empty clock/change tables are retained as additive schema. For **any registered root**, the dump retains the complete operation journal **and** upload sessions, alongside resources, versions, devices, clock rows and historical change rows. This deliberately retains the dependency closure rather than independently dropping upload rows referenced by journal FKs. Locks and unrelated transient sessions remain excluded.

Root/epoch/operation IDs, intent fingerprints, final receipts and old-epoch history are copied unchanged. Pending uploads keep received sizes, temp/target identity and their existing state. A dump does not capture backend temporary/history bytes. Neither absence nor a matching catalog row establishes that an unfinished backend effect completed, disappeared, or may be repeated. Those rows require an explicit qualified reconciliation procedure.

## Restore fence

The service rejects a new archive declaring registered roots **before** schema/configuration mutation. `beginReplacement` also checks the current source catalog; even an old archive with zero roots cannot replace a database that now contains registered roots/receipts. A short SQL `SHARE` table lock prevents registration or receipt writes from committing between the check and schema preservation. Production callers must retain their existing exclusive maintenance barrier; this check is not a replacement for that writer barrier.

Post-restore inspection and `commitReplacement` reject registered/unknown state even for an older archive without `coherence.json`. The profile is not applied after that inspection fails. A replacement rolls back through the existing `_saturn_restore_guard` and original schema. Clean restores now preserve an **empty** original schema using the same guard. Relations/functions/custom types/extensions are checked before and after the rename inside the preservation transaction, and the renamed namespace OID must match the original. This catches intervening committed DDL; it does not replace offline/exclusive maintenance against arbitrary DDL. A raw clean restore of registered state is inspection-only until explicitly rolled back. Restarted `checkReady` sees the persisted guard and blocks. No destructive rollback of a registered source or automatic activation was introduced.

Legacy profile IDs/token verifiers, acknowledged catalog state and physical file verification retain their existing semantics. `RecoveryCommitUncertainError` handling still preserves the active configuration when the final SQL commit cannot be inspected.

## Bounds

- At most one construction snapshot per toolchain instance; this is not a cross-process/global storage admission budget.
- Default snapshot deadline for a bare toolchain: 60 seconds. An explicit existing `commandTimeoutMs` also controls the default snapshot deadline, capped at 600 seconds; a direct `snapshotTimeoutMs` override is limited to 600 seconds. Production configuration already supplies `PG_COMMAND_TIMEOUT_MS` (default 900 seconds), giving a 600-second construction cap. That setting can lower the cap without changing API/worker/CLI constructors. This is a backup construction deadline, not the duration of synchronization or a lease for a future sync snapshot API.
- SQL statement timeout at most 10 seconds per query; snapshot idle timeout and total cancellation deadline; in-flight metadata SQL is cancelled and late queries are rejected. Existing external command/idle/output-byte limits and process reaping remain in force.
- Keyset pages: at most 500 candidates, at most 4 MiB transferred JSON text including newlines. Changes use native composite `(root_id,epoch,seq)` ordering/predicate. An oversize first row fails rather than being skipped.
- SQL computes byte sizes before transporting values, materializes only cursor/size records for prefix selection, then uses `LATERAL` exact PK lookups with `LIMIT 1` for the chosen rows. Top-level PostgreSQL bigint fields are cast to decimal strings in the JSON projection, before Node can parse or lose precision. JSONB documents/receipts already use the journal's string sequence representation.
- Production backup metadata disk bounds derive from `RecoveryLimits`: static configuration/deployment/migrations/encrypted-bundle sizes and the actual dump size are deducted from `maxExtractedBytes`; 64 KiB is reserved within that allowance for the coherence member. Each JSONL also obeys `maxMemberBytes`. The archive writer still enforces the exact combined uncompressed and compressed limits. No free-space reservation is claimed.
- Standalone diagnostic `exportTo` defaults to a configurable 256 MiB total bound and 60-second deadline. A backup snapshot context uses the configured recovery allowance, so that diagnostic default does not cap production backup metadata. Explicit exporter limits may lower the allowance.
- Failed exports remove only files created by that attempt; existing destination files are not removed. Failed/cancelled dumps remove their partial output. Guarded restore failures preserve the original schema until rollback.

## Qualification and remaining gates

The dedicated test uses a new owned loopback PostgreSQL 16 container, CPU 1/RAM 512 MiB. It verifies real custom dump/restore, 1,202 journal events across epochs, concurrent post-cut publication, pending/final receipts and upload FKs, `9007199254740993`, final-response replay without a second callback, old-epoch ID rejection, profile/byte verification, legacy clean/replace/configuration rollback, persisted clean inspection guard, source fencing, unknown shape and failure/cancellation cleanup. A separate synthetic query-plan fixture has 100,000 resources and 100,000 changes; this measures read plans, not physical SFTP or publication guarantees. A mocked streaming export verifies a configured allowance above 256 MiB without allocating the entire export.

**OPEN:** activated-root reconciliation and takeover, backend temp/history verification and byte restoration, writer coverage, restoring an older epoch safely against a live backend, snapshot/feed APIs, retention leases, global recovery admission/free-space policy, and full host/Windows upgrade qualification. No capability is enabled by the existence of these tables or backup members.
