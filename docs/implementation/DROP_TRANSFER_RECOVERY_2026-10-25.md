# Drop: recovery after worker interruption

## Behavior

Drop previously reclaimed `transferring` / `verifying` uploads only after `updated_at` was 30 minutes old. A worker crash therefore left an accepted, buffered upload waiting even when storage was available.

The drain now obtains a per-upload UUID lease, valid for 60 seconds. It renews the lease every 10 seconds independently of storage I/O and checks ownership before further writes. Every verification, stored, failure and retry transition compares the original lease token; expired or replaced owners cannot change the successor's state. Failed lease renewal stops further work and preserves the buffer for recovery. The existing advisory upload lock remains in use.

Recovery uses the original Drop ID and `drop-drain:<id>` idempotency key. The same core upload is reopened, its confirmed offset is read, and only unconfirmed bytes are sent. Full completion checksum validation remains mandatory when the buffered checksum is present. Cleanup happens after the stored receipt; a cleanup failure is retried as cleanup and does not schedule another publication.

Fixed failure codes identify create/resume/read/append/verify/complete/commit stages without persisting raw exception text or secrets. Successful completion clears the previous failure and retry deadline.

The lease bounds eligibility for another attempt; it does not guarantee total completion within 60 seconds when the database or storage is unavailable, the worker scheduler is busy, or an advisory lock remains held. Ordinary storage-failure retry backoff is unchanged.

## Migration and deployment order

- `0112_drop_transfer_lease.up.sql` adds the lease token and deadline plus a partial index. It keeps original IDs, content, retry deadlines, attempts and receipts. Existing interrupted transfers receive a 60-second recovery deadline.
- Stop API/worker processes before applying migrations, then start the matching new binaries. Concurrent old/new Drop workers are not qualified: the old worker does not enforce lease ownership.
- The new runtime requires migration0112. Do not start it against the old schema.
- Down migration is provided. Stop workers first; rollback refuses active token-bearing transfers. Drain them with the matching runtime before rollback. There is no forced queue reset or buffer deletion.

## Verification on25October2026

- Drop package:55/55 tests,9 files,0 skipped; typecheck and isolated ESM build passed.
- New checks: long append heartbeat, stale-owner fencing, renewal DB failure, original confirmed-offset resume, checksum mismatch, cleanup failure, concurrent SQL claims, exact60-second eligibility, migration preservation/idempotence/rollback and unchanged retry backoff.
- Separate OS worker processes with real PostgreSQL and FileService/local storage were abruptly terminated after durable partial append and after durable core publication before the Drop receipt. Both originals recovered in62.298s /61.542s. Each retained one core upload, one resource and one version; all3 test files passed full physical SHA/size readback.
- A third worker's75-second append remained alive and was not reclaimed by the competing recovery worker; its transfer attempt count remained1.
- These are local production-component tests, not a full HTTP/SFTP/browser rerun or a renewed six-hour acceptance campaign. B2 and general release acceptance are not closed by this change.

Evidence: `C:/.projects/exocortex/.audit/2026-10-24/endurance-6h-solo01/drop-recovery-2026-10-25/REPORT.md`.

For PostgreSQL tests, explicitly provide an isolated loopback `SATURN_DROP_TEST_DATABASE_URL` with a `saturn_test_` database name. `SATURN_DROP_TEST_MIGRATIONS_DIR` optionally selects the matching migration directory. The integration tests must be selected and execute; skipped tests do not qualify SQL recovery.
