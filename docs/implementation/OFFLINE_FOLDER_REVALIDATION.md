# Offline revalidation of the retained aggregate-only UNKNOWN defect

This command is restricted to the isolated local Windows backend and a populated
`QUALIFYING` root. It does not activate a deployment or qualify general physical
reconciliation. Migration 0058 prevents the old aggregate-size invalidation from
recurring; 0059 adds an explicit, separately authorized repair of existing rows.
The additive 0060 successor admits a complete tree of up to 1024 nodes; it keeps
the same custody, history, physical-byte, evidence-lifetime and SQL limits.

The original root, epoch, binding, guard revision, device, token, namespace state,
file versions and historical receipts remain unchanged. A successful operation
records one immutable `folder_revalidate` original, renews metadata UUIDs for the
selected folders, appends complete `availability.revalidated` events, and advances
the root sequence in one transaction. No backend write occurs.

## Qualified limits

- Complete tree: at most 1024 nodes with 0060 (500 with 0059), depth 128,
  encoded intent at most 4 MiB. Oversized trees are refused before physical work.
- Complete retained event prefix: `retained_after_seq=0`, published sequence at
  most 4096, no unresolved scoped operation. This is an explicit repair bound.
- Physical verification and backup: at most 128 MiB of current file bytes; one
  hash stream. Evidence expires within 30 seconds of its observation.
- SQL statements and locks: 2 seconds; native helper: 90-second hard lifetime,
  EOF cleanup, backend-wide mutex. File handles deny write/delete sharing.
- Paths are local Windows paths. Reparse points, unknown members, missing files,
  hardlinks, SHA/size drift and stale native identities refuse admission.
- Every selected descendant needs its retained CREATED result. Subsequent events
  may only be qualified `upload.ancestor` changes with the original PUBLISHED
  operation. The assigned root additionally needs the accepted historical empty
  bootstrap record and independently established current backend custody.

Current stat/list/SHA observations do not establish historical directory ownership.
Neither a serialized actor nor the native helper output alone supplies authority.

## Offline sequence

1. Verify the exact owned server/client process and container identities. Stop
   and join those writers; retain their state and original keys. Leave unrelated
   user mappings and resources alone. Preserve the accepted construction lineage,
   private configuration, device associations and full seven-field binding.
2. Take a coherent logical dump and a complete physical copy while those writers
   are drained. Record the expected sequence, canonical tree digest, copy paths
   and hashes. Keep the dump, physical copy, bootstrap evidence and drain records
   in protected operator storage. A live logical test clone is insufficient.
3. Qualify 0058, 0059 and any required 0060 successor on a separate clone first. Record before/after data hashes,
   function sources, owners and ACLs. Installing either migration does not itself
   restore UNKNOWN. `catalog_guard_activate_empty` must not be used here.
4. Apply the reviewed additive SQL while writers remain stopped. Do not modify
   existing 0058 text, historical originals, binding or configuration. Initially
   0059's definer belongs to the migrator and has no PUBLIC execute grant.
5. For the private offline window only, transfer
   `public.catalog_folder_revalidation_command(text,jsonb,jsonb)` to the existing
   qualified NOLOGIN writer owner and grant EXECUTE to the existing writer login.
   Qualify every owner function and runtime/writer role with its pinned source
   hash. The ordinary runtime must remain stopped during this window.
6. Persist the complete new intent before invoking the CLI. Its UUID/key, binding,
   preimages, times and evidence hashes are immutable. Provision and review the
   protected plan; pin its SHA-256 separately. No secrets belong on the command
   line. Run:

   ```powershell
   node node_modules/tsx/dist/cli.mjs --tsconfig apps/api/tsconfig.json scripts/revalidate-guarded-folders.mts <protected-plan.json> <reviewed-plan-sha256>
   ```

7. Inspect the original operation after any SQL/transport/ACK uncertainty. Repeat
   the same plan and original; do not generate another key or infer rollback from
   an exit code. A committed original can be returned after its physical evidence
   expires, without another scan. Its result remains historical after later edits.
8. Before restarting any writer, revoke the private function grant and transfer
   its owner back to the migrator. This is required even after failure. Requalify
   the previous runtime function policy: an extra function still owned by the
   writer owner would correctly block ordinary startup. Preserve failed attempts
   and the original intent until the outcome is known.
9. Pin the successor server source/function lineage without changing its original
   configuration or binding. Verify fresh authenticated snapshot/feed results and
   original client state before resuming those exact clients. Do not clear B,
   dirty/verification work, source incarnation, journal gaps or pending originals.

The CLI deliberately does not grant privileges, install migrations, stop writers,
restart services, enroll devices, activate roots or edit the original intent.
It performs real device authentication; normal device last-used timestamps can
change during authentication before a later admission refusal.

0060 does not make an unresolved upload safe. Complete or otherwise establish
the original upload's terminal outcome before taking the final repair preimage.
Its down migration refuses once a stored revalidation original exceeds 500 nodes,
because the 0059 reader cannot validate that immutable history. A failed down must
leave both functions and data unchanged; never delete the original to enable it.

## Protected plan and receipts

The exact executable types are in `scripts/revalidate-guarded-folders.mts`.
`Plan` has schema `saturn.offline-folder-revalidation-plan.v1`, an `original`
`{file,sha256}` reference, the full binding and guard/backend identities, private
runtime/writer URL and authorization/pepper files, native helper path/hash,
evidence directory, expected roles and all approved definer function hashes.
All database URLs must identify the same loopback database. The plan includes
three pinned `{file,sha256}` receipts:

- `saturn.offline-folder-bootstrap.v1`: binding, backend identity/root/generation,
  one to sixteen accepted construction references and the accepted root proof.
  The supported historical proof is the isolated fixture's existing root bootstrap
  document. Do not manufacture an empty-root receipt for a populated root.
- `saturn.offline-folder-drain.v1`: the same context, backend native identity,
  `nativeProcesses` with PID and exact native creation FILETIME, and `containers`
  with full ID, Created and run label. Native liveness and stopped container
  identity are checked again before SQL. The protected qualification must name
  every known writer; an incomplete inventory is not a drain proof.
- `saturn.offline-folder-backup.v1`: the same context, decimal `expectedSeq`,
  canonical `treeSha256`, a pinned `databaseDump`, and `physicalRoot`. The CLI
  verifies the dump hash, complete copied directory membership and file bytes.

Receipts require independent operator qualification and protected provenance.
They are not synchronization-request inputs. The typed library compares all seven
binding fields; SQL independently validates stored root/epoch/binding/guard/backend,
real session/owner roles, current device authority, clock and descriptor preimages.

## Rollback and recovery

Unused 0059 down removes only its own functions, trigger and constraint. Once a
revalidation original exists, down refuses. Do not drop that original or its events
to make down succeed. Bound originals retain existing cleanup/TRUNCATE protection
and an additional immutable-result guard.

Coherent recovery records `folderRevalidationShape` and exact decimal operation
counts, checks all five functions and receipt protection, and keeps operations and
events in the same durable dump. Automatic restore of registered roots remains
blocked pending backend reconciliation. An old UNKNOWN event or a successful
historical receipt is never a current availability or target-CAS proof.

## Qualification status

The 2026-10-13 isolated clone covers actual PostgreSQL atomic faults/timeouts,
metadata/history/authority refusals, new-PID CLI and replay, Windows native handles,
physical mismatch and writer contention, and recovery shape checks. Test artifacts
and limitations are recorded in the implementation handoff and `.history` journal.
Original fixture application, its authenticated metadata/readback and final common
release qualification are separate gates. This command does not authorize or start
the six-hour campaign.
