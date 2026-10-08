# Candidate qualification after the 2026-10-06 audit

This is a working candidate, not a published release or production approval.
Saturn, Neptune and Pluto evidence must identify one coherent source/image/helper
tuple. Current workspace remediation evidence is under
`.audit/2026-10-06/remediation/` in Exocortex.

## Policy identity

All three Part 12 plans pin general revision
`3415ca3eac2191b623928733d3f7ee996f505c84`, catalog SHA-256
`413cd04e0a7c082a9d1cd3b33236230f4047338321e5f5f44230e8f356c45d65`:
116 published requirements. The local unpublished INT-16 is separately vendored
in `.release/known-problems-supplement.json`, whose checksum is in each policy and
every new receipt. This yields 117 IDs without inventing a published revision.
Revision-specific caches prevent old linked policy documents being reused.

Structure validation proves inventory/applicability only. It never qualifies a
release. Missing, stale, altered or failed command receipts block pre-signing and
final qualification. The Kernel INT-16 receipt must cover the actual Kernel
revision/credential contract. Native Pluto lifecycle/integration receipts are
required; its current publication workflow deliberately blocks while they are
absent. No production signing key or repository is implicitly provisioned.

## Standalone builds and consumer contracts

Saturn's production build and ordinary tests require only its own checkout.
Volt/Mastermind compatibility tests live outside production TypeScript source.
Run them explicitly with `EXOCORTEX_CONSUMER_SOURCE_ROOT` pointing to qualified
consumer checkouts, and record their exact revisions. CI's reusable verification
workflow accepts `volt-ref` and `mastermind-ref` for that purpose.

## PostgreSQL restore budgets

`PG_COMMAND_TIMEOUT_MS` bounds every PostgreSQL tool (default 15 minutes, range
1 second–2 hours). `PG_DUMP_IDLE_TIMEOUT_MS` bounds lack of dump output (default
2 minutes). Native tools also receive a 10-second connection budget, and restore
statement/lock budgets. Cancellation/timeout terminates and reaps the child and
removes the incomplete dump. Existing schema guard/reconciliation rules still
apply. Wrapper executables must forward libpq settings to their real tools; the
native production image invokes tools directly.

## Upload lifecycle

Worker cleanup includes expired ordinary created/uploading/failed sessions.
An unexpired upload lease, committing/verifying state or recovery journal prevents
cleanup. Expiry cannot erase an accepted payload awaiting reconciliation.
Validation errors do not overwrite recovery intent or truncate accepted bytes.
An acknowledged durable Drop buffer also protects its partial remote delivery
attempt beyond ordinary upload TTL. This exception requires the matching live
Drop buffer record, worker actor, complete received payload and Drop destination;
it ends when that delivery is cancelled/stored. Cleanup and explicit abandonment
cannot discard accepted pending delivery bytes.

Windows persists the scoped upload key before creation and its checkpoint after
each acknowledged step. Source changes/removal cancel the old key through
`POST /api/v1/sync/uploads/cancel` before starting a replacement. Lost cancellation
acknowledgements retain local intent. Only that device can cancel its key; an
already committed file is preserved. Legacy clients eventually benefit from
server expiry cleanup, but require the new Neptune release for immediate
supersede cancellation. Roll out Saturn before that client.

## Complete disaster recovery

Saturn recovery ZIP restores metadata/configuration; it does not include user
file bytes. Pluto/Neptune deliveries into the primary SFTP are not independent
storage copies. A complete recovery set needs a coherent catalog dump, all
current **and retained** file-version bytes, protected deployment inputs and a
separately protected secret recovery set.

Stop API/worker and all writers before capturing catalog and bytes. Use the
existing `storage-exit.mjs` with `VAULT_EXIT_QUIESCED=true` to export the complete
physical tree to an empty protected destination and compare hashes. That flag is
an operator assertion, not a substitute for quiescing writers. Capture a matching
database dump while they remain stopped; record identities/digests together.
Store the set in a demonstrably independent failure/access domain and monitor
freshness/integrity. Retain the original until destination restore verifies.

Restore into empty isolated database/storage targets. Verify catalog IDs,
versions, sizes and SHA-256 of every active/retained version before opening writes.
Exercise this while the original backend is unavailable. The local rehearsal
does this with source SFTP stopped and a fresh database; it shares a physical QA
host and therefore does not prove provider independence or production RPO/RTO.

Production requires remote file fsync. Provider parent-directory/rename semantics
and power-loss durability remain an external qualification. Native systemd/WPF,
real exporter-domain restores, final production image OS scanning, long soak and
the exact installed baseline → candidate → rollback must also pass before GO.
