# Scale transfer v2 — implementation and activation

Updated 2026-10-18. This is an additive protocol and migration set for Saturn and the Windows Neptune client. Production deployments are not automatically opted in.

## Implemented behavior

| Area | Change | Preserved gate |
| --- | --- | --- |
| Partial small batches | Explicit per-file pending outcomes no longer stop independent files in the same pass or add a second global pressure backoff. Equivalent JSON encodings of an immutable receipt are accepted. | Per-original retry deadlines, operation/intent/receipt contents and spool admission remain enforced; duplicate JSON properties are rejected. Transport uncertainty and backend UNKNOWN remain fenced. |
| Remote tree | Snapshot steps process up to 16 parents and 500 children; grouped frontier/SQL updates. SQLite remote pages resolve qualification once and apply grouped writes. | Exact actor, root binding, epoch, cut, event sequence and projection; existing lease and retained-byte admission. |
| Native tree | Pages of up to 128 entries/aliases use indexed grouped checks and writes; child directories are inserted in pages of 120. Import reads 40 retained native/logical identities together; absence restoration and version activation use grouped SQL. | Same native incarnation, dual enumeration, alias ambiguity, hardlink membership and journal closure. Completed parent checkpoints are reused only within their qualified retained plan. Interrupted parents are reset. |
| SQL upload commands | Up to 16 concurrent commands share one transaction/round trip, with separate subtransaction results per file. No batching timer. | Current credentials and all original CAS/state checks execute per command. Unexpected SQL faults abort the whole transaction. |
| Payload storage | New scaled deployments fsync bounded block files in a persistent generation-scoped directory; SQL stores UUID reference, length, SHA-256. | Reference/path/size/hash verified before storage effects. Terminal successful ACK permits deletion; unresolved and ambiguous payloads remain. |
| Concurrency | Negotiated client data jobs up to 8; 2 large streams; 4 blocks per stream; backend 4 writes plus 4 read slots. | One durable backend owner/fence. Conflicting paths, overlapping byte ranges, creation/truncation and rename are ordered. UNKNOWN blocks further claims. |
| Large files | `saturn.stream-upload.v2`: indexed immutable part ledger, 256 ACKs per status page, 4 MiB blocks. Read/hash/send overlap under one pinned native source version. | First block establishes the file; per-part SHA, exact offsets, native final proof and complete whole-file readback remain mandatory. |

The v2 maximum file representation is 9,007,199,254,740,991 bytes (safe integer); the operator's configured maximum may be lower. The old 1 GiB / 256-part ceiling remains only for retained v1 operations and old negotiated clients. It does not apply to new v2 operations. Memory/spool reservations are bounded by in-flight blocks, not by the entire file size.

The snapshot's 1,000,000-entry constraint is removed by migration 0071. It remains subject to the existing 4 GiB retained-document budget, page bounds, depth and lease limits. Removing the entry-count ceiling is not a claim of unlimited resources.

On restart, the client fetches all ACK pages and sends only parts not acknowledged. It rereads the same source version to recompute the complete SHA and native proof. If that version changed, it refuses to silently combine versions. An unresolved physical write remains a reconciliation condition.

## Activation and persistence

1. Drain and fence the previous backend owner using the existing handoff procedure; retain the SQL database, original operation IDs, source profile and storage generation. Back up databases and persistent payload storage together.
2. Apply migrations 0071–0074. Requalify the exact changed fixed-function hashes; do not edit a live runtime's approved hashes to bypass qualification.
3. Deploy the compatible Neptune client and verifier (if enabled). Set the explicit `maximumFileBytes` on the qualified activation/manifest, and verifier `maximumBytes`, for the intended large-file limit.
4. In the v3 manifest, include `stream-upload-v1` and `scale-transfer-v2` in `extensions.features`, and set `extensions.payloadDirectory` to an absolute persistent writable directory, for example `/var/lib/saturn/backend-payloads`. Include the same qualified feature policy for the managed root. A scaled manifest without a payload directory is rejected.
5. Keep that directory outside user vaults and disposable container layers. The executor stores `<backend-identity-sha256>/<generation>/<uuid>.payload`; only the service account may modify it. Symlink/junction ancestors are rejected. The local staging free-space reserve is 256 MiB. Preserve it across restarts, upgrades and owner handoff.
6. For SFTP, keep the connection pool consistent with the eight-operation budget (default `STORAGE_MAX_CONNECTIONS=8`). Smaller operator limits remain valid but reduce attainable overlap. No automatic unbounded pool or worker growth is introduced.

Legacy manifests without the new feature/payload directory retain their previous protocol and inline queue compatibility. Existing inline rows are readable by the new executor. Once opted in, do not remove payload storage or silently revert to an old writer.

Node supports file fsync on Windows and POSIX; POSIX also fsyncs the payload directory. Windows Node cannot fsync a directory entry. A missing/corrupt staged object fails before physical publication; no receipt is invented. Ambiguous/orphan staging files are deliberately retained for reconciliation. Do not garbage-collect them solely by age. This change does not introduce automatic orphan collection.

## Migration and rollback

- 0071 removes the snapshot cardinality cap. Down refuses if a retained stage exceeds the old limit.
- 0072 installs conflict-aware parallel claims. Down requires STOPPED owners and no unfinished payload references; it restores the exact saved prior function definition.
- 0073 installs SQL command coalescing and restores its exact predecessor on down after draining.
- 0074 adds indexed stream parts, v2 commands and bounded-window admission, and raises numeric file/verifier limits. Down refuses retained v2 originals or roots above the old file-size limit.
- Neptune lazily creates `client_stream_parts` when using v2, after a consistent backup and hash manifest. It marks `minimum_writer=neptune.client-evolution.v2`; older clients must refuse this profile. The backup is a separate rollback artifact, never an instruction to overwrite new state.

## Verification evidence

The audit directory is `C:/.projects/exocortex/.audit/2026-10-18/endurance-6h/supplemental/scale-repair`.

- Real PostgreSQL + storage: 2 GiB + 17 bytes / 513 parts, peak four writes, retained handler restart and paged ACKs, duplicate-part replay with no write, full SHA readback and one publication.
- Windows native engine: real 2 GiB + 17 bytes, 513 parts, peak four sends; source and destination fully read and SHA compared; no extra source file.
- Loss of ACK, source edit after interruption, wrong final hash, malformed ACK pages, receipt changes, legacy stream compatibility and negotiated limits.
- Partial batch regression: before the fix only 32 of 40 sources were captured; afterwards all 40 were captured, 25 independent publications completed, and the 15 pending originals recovered without recapture or changed intents.
- Native parent restart reuses a completed qualified parent while rerunning the interrupted branch. Existing parent/native safety tests pass after grouped SQL.
- Real schema up/down/reapply restores exact SQL definitions; a v1 original survives upgrade and publishes; v2 state blocks unsafe rollback.
- Corrupt staged bytes cause zero raw writes; overlapping ranges, truncate, ancestor paths and rename stay ordered; UNKNOWN stays fenced.

64 GiB was tested for admission and numeric/protocol configuration only. This is not a full 64 GiB transfer qualification. The >1,000,000 snapshot boundary was tested at the schema/header boundary; no million-object end-to-end benchmark is claimed. The ongoing 500k campaign remains separate, with its original deadline and full-readback gate.

Final addressed client selection: 41/41, followed by 3/3 targeted repetitions. The two native exact-capture fixtures now wait for the production watcher quiet deadline instead of polling before it; their exact publication/capture assertions remain. API/verifier typechecks and the Windows Release build pass. See the audit `SCALE_TRANSFER_IMPLEMENTATION.md` for separate test selections and original failure evidence.

At this checkpoint the 500k campaign uses the new frozen client (`native-repair-21`); server migrations 0071–0074 and `scale-transfer-v2` have been exercised only on isolated fixtures. They are not silently enabled on its existing qualified server or on production.
