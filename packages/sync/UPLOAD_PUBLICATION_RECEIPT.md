# Immutable Windows resumable publication receipt

This increment adds an immutable **historical** publication result to the existing
`/api/v1/sync/uploads` creation, status and completion responses. The legacy
`resource` and `etag` fields keep their existing current-resource meaning.
`features.immutableUploadReceipt` remains **false** pending rollout qualification.
Root journal writers, delta feed, snapshot API and the new sync engine remain
disabled. A receipt is neither current remote state nor a compare-and-swap token,
continuous root cut, proof of current presence, or client trusted-base adoption.

## Two different operation identities

* Client work key: the existing 64-hex `idempotencyKey` supplied by Windows. A
  local execution ledger may call this `OperationId`; it is not a server UUID.
* Server upload identity: the existing UUID `upload_sessions.id`, also the UUID
  `operation_journal.id`. `publicationReceipt.uploadId` and `.operationId` both
  refer to this UUID. Clients compare them to their persisted server `UploadId`.

The existing server key is `sync-resume-<HMAC(deviceId,NUL,clientWorkKey)>`. The
operation journal retains its existing `upload:<serverKey>` lookup key. No
second operation registry, fabricated epoch or sequence is introduced.

## Additive response fields

`receiptState` is `pending`, `published` or `legacy_unqualified`. It classifies
receipt qualification, not the presence of the current remote file. The existing
upload `status` still describes lifecycle (`committing`, `failed_retryable`,
`abandoned`, etc.). A pending receipt with `committing` and reconciliation state
must be treated as **UNKNOWN**, not absent or safely retryable under a new key.

Newly sealed sessions return a 64-hex `intentHash` from creation. Successful
publication adds:

```json
{
  "schema": "saturn.upload-publication.v1",
  "uploadId": "<server upload UUID>",
  "operationId": "<the same server UUID>",
  "intentHash": "<original sealed SHA-256>",
  "rootId": "<actual assigned Windows root UUID>",
  "resourceId": "<original resource UUID>",
  "versionId": "<original published version UUID>",
  "parentId": "<original parent UUID>",
  "name": "original-name.txt",
  "sizeBytes": "13",
  "sha256": "<original content SHA-256>",
  "etag": "\"sha256-<original SHA-256>\"",
  "publishedAt": "2026-10-12T12:00:00.000Z"
}
```

The new receipt `sizeBytes` is an exact decimal string. Existing `expectedSize`
and `receivedSize` fields keep their legacy numeric representation. No backend paths, credentials,
epoch or cursor are emitted. The creation hash is persisted by the client and
compared on later receipt reads; clients must not guess resolved server IDs.
Legacy sessions remain explicitly unqualified, including active sessions whose
resource now has later versions. Historical backfill from current metadata is
forbidden by a database trigger.

## Sealed intent and authorization

`uploadIntentHash` hashes a fixed ordered UTF-8 JSON array containing schema,
device kind, server key, device UUID, assigned root UUID, normalized requested
path, resolved parent UUID, actual name, selected target UUID/null, exact size,
content hash, original `ifMatch`/`ifNoneMatch` strings/null, require-absent flag
and selected expected version UUID/null. These fields cannot be modified after
creation. Reusing the same key with changed wire conditions, identity, path,
size or hash is rejected before mutable parent/target resolution.

Each request still requires the current token, active Windows device, write
right and assigned root. A final SQL commit rechecks current device/root,
optional current HTTP credential hash, and a complete active folder ancestry
to the assigned root. The ancestry is bounded to 128 hops with cycle detection.
Workers do not persist credentials but still validate current device/root and
ancestry. Historical replay checks current access and the sealed root; it does
not require the old file or parent to remain present at its original path.
Existing access errors are preserved: peer/rebound roots are hidden, revoked
tokens are unauthorized, disabled writes/inactive assigned roots are forbidden.

## Commit, replay and physical uncertainty

The immutable receipt is written in the **same PostgreSQL transaction** as the
actual version/catalog/session publication. Backend byte verification and
rename remain the existing FileService workflow outside that transaction.
Short final SQL locks have a two-second lock timeout and ten-second statement
timeout for sealed sessions only. Ancestors are locked in UUID order with
`NO KEY UPDATE`, because the same transaction subsequently adjusts their size.
`SHARE` followed by a size update caused a reproduced PostgreSQL `40P01`; the
independent-parent concurrent completion test protects the corrected behavior.

After a lost successful response, the same upload UUID returns the original
receipt even if another actor publishes V2. It creates no new backend effect
or version. Legacy `etag` can therefore describe V2 while receipt `etag`
describes V1. Moving, trashing, purging or expiring version bytes does not turn
the receipt into a new publication or claim that the file remains available.

When a final authorization/SQL check fails, the existing workflow attempts to
restore verified bytes to temp. If physical rollback is uncertain, it retains
the `committing` operation, recovery marker and bytes, with no success receipt.
Cleanup and cancellation cannot discard that UNKNOWN state. There is no claim
of atomicity between PostgreSQL and SFTP or qualification of all journal writers.

## Retention, migration and recovery

Migration `0049_upload_publication_receipt` adds fields to the existing journal,
one metadata version FK and identity/receipt/session lifecycle guards. It does
not rewrite catalog objects, enrolled profile IDs or tokens. Pending abandon,
retry and deferred temp cleanup remain permitted. Accepted keys and final
receipts cannot be deleted, truncated or forgotten by downgrade/reset. Version
retention still removes bytes; the FK retains metadata identity only.

Metadata identities are currently retained indefinitely. A bounded compact
retention/explicit retirement protocol is an **open gate**; generic TTL cleanup
must not silently forget an accepted key. Storage switching performs an early
preflight before candidate credentials/backend writes and rechecks under the
exclusive reset transaction. Database guards provide a secondary boundary.

The coherent logical backup detects sealed keys even with zero registered feed
roots. Its single snapshot retains the journal, upload sessions and referenced
versions, and records exact intent/receipt counts. Unknown/partial schema or
missing guards fail closed. Current replacement, restored inspection, commit
and restart checks block automatic activation where sealed keys exist; explicit
backend reconciliation is still required. Logical receipt preservation does
not establish availability of pending temp/history bytes on the recovered host.

## Qualification boundary

Focused actual PostgreSQL and loopback HTTP tests cover lost V1 completion
response then independent V2, create/overwrite, concurrent duplicate and
independent-parent completion, rollback/lost SQL acknowledgement, current-token
rotation, actual cross-root folder move, bounded/cyclic/inactive ancestry,
UNKNOWN physical rollback, mixed legacy/sealed cleanup, version byte expiry,
move/trash/purge, legacy non-backfill, revoke/rebind/peer, additive native profile
migration, reset/delete/truncate/down guards and real coherent dump/restore.
Raw results, failed attempts and frozen cohort identities are recorded under
the implementation audit's `upload-receipt` directory.

Full SFTP mixed-client qualification, protocol rollout, compact metadata
retirement, activated-root recovery/takeover, client execution-ledger adoption,
Windows installer/update migration and the later six-hour endurance run remain
separate acceptance gates. No production/native client or old endurance run is
modified by these fixtures.
