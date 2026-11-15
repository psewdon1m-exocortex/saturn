# Inactive root journal foundation

This increment supplies a PostgreSQL metadata transaction primitive for S04/S05. It does **not** activate runtime writers, snapshots, a feed, a new sync engine, or a claim about backend bytes. Existing capabilities remain `snapshot=false`, `deltaFeed=false`, `newSyncEngine=false`. Existing roots are not automatically registered by migration 0048.

## Data and transaction boundary

`sync_root_clock` references the existing catalog root and stores an epoch UUID, an ordinary `bigint published_seq`, and `retained_after_seq`. `sync_root_changes` stores a contiguous event range keyed by `(root_id,epoch,seq)`, full projected descriptors or tombstones, author, reason, and the **existing** `operation_journal.id`.

The existing operation registry receives nullable durable intent binding and receipt columns. No second idempotency registry is introduced. `bindOperation` verifies an active in-root resource witness (or the existing upload's parent) and binds root, epoch and intent hash before backend work. Final receipts are immutable. A captured operation cannot be rebound to another root, intention, or epoch, including after epoch rotation. Replaying a final receipt with the same binding returns the saved result without invoking the catalog callback. Current restore/cross-root operations that cannot supply this active witness require an explicit writer adapter; they are not silently enabled.

The commit order is root clock row lock, existing operation row lock, bounded catalog SQL callback, projected catalog verification, set-based event insertion, receipt and clock update, commit. Rollback restores all changes, including the ordinary counter. `BIGSERIAL`, `nextval`, timestamps, or `MAX(seq)` do not allocate the published prefix. No backend request, SFTP rename, storage verification, HTTP request, hashing, or stream delivery belongs inside this transaction.

The callback receives only a parameterized `query` interface. It has no exposed transaction/session/connection/storage handle. The interface permits a single SELECT/INSERT/UPDATE/DELETE/WITH statement, at most 64 KiB of SQL, 2,000 parameters, and 1,000 queries. It is a **trusted internal SQL-only contract**, not an SQL sandbox: JavaScript closures can technically access external services and SQL can call functions. Callers must not perform such work or alter journal/clock/binding tables. Public/plugin callbacks are prohibited.

A callback deadline of 1 second expires the query interface before rollback. Fire-and-forget in-flight queries are joined before a successful result. SQL `statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout` are each 2 seconds. SQL already running when the callback expires can take until its statement timeout to release the transaction; no late callback/query can commit the expired transaction. Pool admission is the existing Database boundary; a future public writer API needs its own bounded admission budget. This is not a cross-process storage budget.

Each commit accepts 1–500 distinct node IDs, bounded full descriptors (4 KiB serialized per event, names at most 1,020 UTF-8 bytes), a 4 MiB aggregate limit and a 64 KiB receipt. Input is sealed before awaiting a lock. Root existence/type/active status is checked under a shared resource lock. Active ancestor membership is proved with a bounded 128-hop, cycle-safe set-based query. Upserts must match the final catalog projection; tombstones must match an active in-root pre-state and leave no active in-root node. Additional catalog changes made by a trusted callback are not automatically discovered: writer adapters must enumerate every effect, including subtree membership, ancestors' aggregates and cross-root moves.

`preparedBackend` is an explicit internal attestation (`stored_verified`, `metadata_only`, or `isolated_metadata_fixture`). It does not prove physical persistence. File upserts cannot use `metadata_only`. Tests with synthetic catalog entries use `isolated_metadata_fixture` explicitly and do not count as byte publication qualification.

## Reading, epochs and retention

An internal keyset read uses one SQL statement snapshot for both the current clock and events. `afterSeq` is exclusive; `throughSeq` is inclusive and may pin a previously observed prefix. Both are exact decimal strings, including values beyond JavaScript's safe integer range. Limits are 500 records and 4 MiB; contiguity is checked before returning a page. Empty pages access PostgreSQL only. Missing/inactive roots, stale epochs, expired cursors, cursors beyond the published prefix and unexpected gaps have distinct internal typed errors; no external API/error mapping is activated.

`advanceRetentionFloor` monotonically expires a prefix without deleting records. `rotateEpoch` changes the clock epoch and resets its new counter in the same locked transaction, while preserving old events and receipts. This is a primitive, not a complete snapshot lease/30-day retention/rebuild authorization policy. Old bound operations cannot execute again under a new epoch. Physical retention, cursor mapping and snapshot construction remain open. A later coherent recovery increment qualifies event-history export for an explicit PostgreSQL snapshot cut; it does not activate live writers or backend takeover.

## Upgrade, downgrade and existing journals

0048 adds tables/columns without changing existing catalog, device profiles, upload sessions or legacy operation rows. All original unbound operation behavior remains available. An additive receipt guard prevents deletion or intent rebinding of a bound operation and prevents changing a published receipt back to a retryable state. Empty schema rollback is supported. Once any durable binding/events/publication exists, the down migration raises an explicit error and preserves the schema/data. Application binary downgrade should leave this additive schema intact.

No periodic `operation_journal` TTL deletion was found in the reviewed runtime sources. The initial inventory identified these cleanup/recovery boundaries; later increments qualify the limited behavior described here:

1. `Database.reconcileInactiveFileLocks` changes verifying/abandoned upload states. Its unbound legacy behavior was exercised. Bound final receipts are protected and must not be targeted by future recovery status rewrites.
2. `StorageConnectionService` deletes `operation_journal` during a catalog switch. That deletion works on the unbound fixture and is deliberately blocked for durable bindings. A qualified switch must preserve/invalidate epochs and receipts explicitly before activation; catching the guard and silently continuing is prohibited.
3. The later coherent recovery increment exports root clocks/changes and their durable operation dependencies using the same `pg_export_snapshot` cut as the dump. A real concurrent-publication fixture qualifies 1202 events across bounded JSONL pages and clean restore. Migration0049 also preserves sealed upload intent/receipt dependencies, including unregistered roots. [Receipt acceptance](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/upload-receipt/acceptance.md) and [independent review](C:/.projects/exocortex/.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/orchestrator-upload-receipt-review.json) identify the exact current cohort. This qualifies coherent metadata recovery only: pending/history bytes, activated-root backend takeover, all runtime writers and new engine activation remain open.

## Writer inventory and activation gates

All entries below are **unconnected** in this increment. A writer adapter must combine its catalog effect, complete event set and existing operation receipt in the journal transaction only after its existing backend/recovery work has completed.

| Mutation path | Current catalog commit / entry point | Required next qualification |
|---|---|---|
| Folder creation | `FileService.createFolder` → `PostgresFileRepository.createFolder` | Existing mkdir before commit; add durable folder operation identity and parent proof |
| Initial upload / overwrite | `FileService.completeUpload` → `commitUpload` / `commitOverwrite` | Use existing upload operation ID/verification/recovery; include current version and ancestor aggregate changes |
| File adoption / adopted purge | `adoptExistingFile` / `purgeAdoptedFile` → `adoptExistingFile` / `removeAdoptedFile` | Existing backend stat/hash proof and idempotent receipt adapter; backup ingestion callbacks use these |
| Classification | `setSecurityClassification`, ShareService | Authorization scope/epoch semantics and metadata visibility |
| Move / rename | `moveResource` → `moveTree`, rewritten subtree/version paths | All source/destination root memberships, ordered multi-root clocks, aggregates; no SFTP under lock |
| Copy / archive extraction | `copyResource` → `createCopiedTree`; ArchiveRunner through FileService | Full subtree event set and existing copied version IDs; split bounded metadata batches safely |
| Trash / restore / permanent purge | `trashResource` / `restoreResource` / purge → `trashTree` / `restoreTree` / `purgeTrashTree` | Tombstones/subtree scope, restoring inactive witness, retained delete history and recovery |
| Version restore / version expiration | `restoreVersion` → `commitVersionRestore`; `limitVersions` → `expireVersion` | Current version event vs historical retention; existing restore operation ID |
| Web UI / REST | `apps/api/src/file.controller.ts` | Routes funnel through the listed FileService adapters; no blanket controller activation |
| Windows Neptune / Pluto / WebDAV | DeviceService mkdir/PUT/MOVE/COPY/DELETE and upload completion | Exact device root, rights, endpoint admission and same publication core |
| Drop direct / buffered worker drain | DropService, DropDrainService → FileService completion | Existing drop/core upload recovery receipts; don't add a competing operation identity |
| Backup ingestion | API `app.module` catalog publish/purge callbacks | Backup root membership, adoption/purge receipts, writer-device policy |
| Worker lifecycle | worker `main.ts`, upload recovery, archive jobs, Drop drain | Same catalog primitive, no separate in-memory journal or worker prefix |
| Protection catalog scan/adoption | `storage-catalog.service.ts` direct INSERT/UPDATE resources/version/aggregate totals | External backend uncertainty, adoption proof, many-root effects and rebuild epoch |
| Protection reconciliation/purge/scrub | direct resource status writes in postgres-reconciliation.repository, purge.service, integrity-scrub.service | Missing/quarantined/purged events, existing purge receipts, scope-safe status changes |
| Storage connection switch | direct detach/rebuild/resource/version updates, operation_journal deletion | Explicit global switch/epochs/receipt preservation and recovery qualification |
| Bootstrap / migrations / logical restore | root-layout initialization, catalog migrations and PostgreSQL restore | Coordinated maintenance/rebuild invalidation, durable clock/event/receipt export |

The initial upload path currently performs chunk `write` (SFTP write-stream followed by remote open/fsync/close), completion `stat(temp)`, full SHA-256 readback, a separate MIME-prefix read, final destination `exists`, rename, and SQL catalog commit. Folder creation calls physical mkdir before SQL. Overwrite/restore prepare archive directories and rename old/new bytes before SQL. Recovery compares temp/final/archive presence and may rehash stored bytes. These physical checks are outside the proposed root-clock boundary and must remain there. The separate SFTP lease-reuse fix removes unnecessary handshakes after semantic missing/collision/permission responses without removing integrity reads or fsync requirements.

The foundation acceptance evidence is stored under `.audit/.../saturn-journal`: 100 concurrent delayed transactions, three simultaneous readers, rollback/receipt/event atomicity, lost-response replay, foreign ID binding, 500-item range and page limits, exact large bigint sequence, callback timeout/late query, independent roots, epoch/retention invalidation, populated migration preservation and guarded downgrade. These tests qualify the **inactive SQL foundation only**. Later metadata recovery evidence has its own cohort and scope above. Complete S04/S05 writer coverage, physical backend recovery, full field semantics, production performance and feed API remain open.
