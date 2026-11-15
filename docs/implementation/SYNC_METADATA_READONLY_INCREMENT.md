# Read-only sync metadata increment (PERF-04/05)

This is an additive preparation step for Windows Neptune and Pluto. Current
clients still transfer through their existing WebDAV/Pluto routes. This step
does not enable a new synchronization engine or claim that initial/repeated
sync performance gates are complete.

## HTTP contract

Existing device Bearer/Basic tokens authenticate both routes:

- `GET /api/v1/sync/roots/:rootId/capabilities`
- `POST /api/v1/sync/roots/:rootId/metadata/batch`

POST JSON is strictly `{ "nodeIds": ["UUID", "..."] }`, with 1–500 entries.
Unknown properties and invalid UUIDs fail with 400. Input duplicates count
towards the limit; their results preserve the original order. Lookup IDs are
deduplicated inside SQL. Valid UUIDs accept upper/lowercase; descriptors use
PostgreSQL's canonical lowercase IDs. Successful reads return HTTP 200.

```json
{
  "rootId": "11111111-1111-4111-8111-111111111111",
  "results": [
    {
      "nodeId": "11111111-1111-4111-8111-111111111112",
      "status": "found",
      "metadata": {
        "nodeId": "11111111-1111-4111-8111-111111111112",
        "parentId": "11111111-1111-4111-8111-111111111111",
        "name": "file.bin",
        "type": "file",
        "sizeBytes": "8192",
        "sha256": null,
        "legacyETag": "\"resource-11111111-1111-4111-8111-111111111112-1791820800000\""
      }
    }
  ]
}
```

`sizeBytes` is the exact nonnegative PostgreSQL bigint as a decimal string,
never converted through a JavaScript number. `sha256` is nullable; a folder has
no content hash. `legacyETag` preserves existing WebDAV observation semantics.
It is **not** a monotonic metadata version, conditional write token, epoch or
feed sequence. A scoped root descriptor has `parentId: null`.

An unavailable item returns only `{ "nodeId": "UUID", "status": "not_found" }`.
Foreign, nonexistent, inactive/trashed nodes and invalid ancestor chains share
that result. Responses never expose storage locators, classification, version
archive paths, credentials or device records. No global hash lookup is added.

## Scope and query bounds

Only `windows_sync` and `pluto` devices with read rights, an active token, and
the exact single assigned `syncRootId` scope may use these routes. The device
record is re-read before metadata access, so a captured context does not bypass
revocation, token rotation, expiry or scope/right changes. A peer or invalid
assigned root returns 404. Generic devices/unreadable devices return 403.

The PostgreSQL repository executes **one metadata SELECT** for the whole batch.
It checks the active folder root's expected anchor (`sync windows` or `sync
outdoor connections`), then proves an active folder chain from each requested
node to that root in the same MVCC statement. At most 128 ancestor hops are
examined per origin, with a visited-ID cycle guard. Depth overflow, cycles,
inactive ancestors and file-as-parent chains have no root witness and return
`not_found`. This bounded observation does not authorize deletion of missing
items by a new engine. It does not establish complete remote-tree absence;
a future planner must keep negative results UNKNOWN until absence is proven.

Ancestor lookups use a lateral primary-key lookup with `LIMIT 1`, avoiding a
planner choice that would scan the complete resource catalog at each recursive
step. There are no per-node directory listings, ACL graph reads or backend I/O.
The existing primary-key index is reused; no schema/index/name/collation change
is needed. Normal authentication still has its constant transaction overhead,
plus one fresh device-binding read; the metadata SELECT count is independent
of the item count.

Admission allows four concurrent metadata SELECTs per DeviceService
instance/process. Excess reads get immediate 429 without a waiting queue;
slots release in `finally`, including query errors. This is not a shared
API/worker/storage budget or SQL cancellation policy.

The Fastify route body limit is 4 MiB, enforced during parsing for both known
Content-Length and chunked bodies. The actual Nest `RouteConfig` is only custom
configuration, so `registerSyncMetadataLimits` sets the real `bodyLimit` in an
`onRoute` hook before Nest registers routes. Non-identity content encodings
receive 415; there is no decompression path. Metadata responses have the same
4 MiB bound. An authorized malformed stored name exceeding 1020 UTF-8 bytes
fails the whole read with 413 rather than being silently truncated or treated
as absence. This guard does not change namespace write rules. Responses are
`Cache-Control: no-store`.

## Honest handshake and compatibility

`protocol` is `saturn-sync-metadata/1`, `nameCodec` is `legacy`. Only
`metadataBatch` (when implemented by the repository) and `stableNodeIds` are
advertised. `snapshot`, `deltaFeed`, `batchResolve`, `batchDirectories`,
`smallFileBatches`, `conditionalVersions`, `newSyncEngine` and
`compressedMetadata` are false. Limits disclose 500 items, decimal
`"4194304"` uncompressed bytes, 128 ancestor hops and four concurrent batches
per process. There is no invented epoch/version/cursor.

The repository method is optional for legacy adapters; absence is advertised
as `metadataBatch: false`, and metadata requests never fall back to N+1 tree
reads. Existing token formats, root enrollment, legacy routes and data/state
schemas are retained. Deployment/rollback needs no data migration for this
read-only increment. Neither installed nor portable client profiles are changed.

## Evidence and remaining gates

Local evidence is kept separately in
`.audit/2026-10-12/sync-performance-implementation-2026-10-12T14-48-22Z/saturn-metadata`:
baseline hashes/diff, owned patch/cohort, seven unit checks, HTTP/PG integration,
4 MiB boundary responses, query-count proof and PostgreSQL EXPLAIN. A generated
100k-child catalog exercises 500-node batches; three DB-only timings include
cold JIT overhead. It is not an SFTP/content throughput benchmark. The generated
database schema is dropped after every attempt, including fixture failures.

The initial oversized fetch experiment saw ECONNRESET with pooled keep-alive
connections; that was not accepted as a successful rejection. The final checks
read HTTP413 for Content-Length +1, fetch chunked and a raw paced chunked client
that stops writing when the response arrives; a following capability request
succeeds. Gzip receives 415 and exact 4 MiB receives 200.

Still open: shared C#/Go/TypeScript full protocol schemas/golden vectors (including
duplicate JSON-key validation), client consumption/fallback integration,
parent/name batch resolve, directory ensure, operation registry/receipts,
backend executor/CAS, atomic root journal, coherent snapshot/feed, new engine,
native installed/portable migration qualification and end-to-end performance
gates. The read-only results must not be interpreted as a coherent snapshot.
